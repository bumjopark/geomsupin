// LibreOffice + python3-uno가 있는 환경에서 실제 문서를 열고 정렬·필터·편집·재저장한다.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import ExcelJS from 'exceljs';
import sharp from 'sharp';
import { buildWorkbook, type ExportRow } from '../server/excel.ts';

const dir = await mkdtemp(join(tmpdir(), 'gp-spreadsheet-'));
const rows: ExportRow[] = [];
for (let no = 1; no <= 3; no++) rows.push({
  no, roundNo: 1, reviewerName: '검수자', createdAt: new Date(), kind: '수정', priority: '보통', pageUrl: `http://example.test/${no}`, pageTitle: '한글 페이지', browser: 'Chrome', os: 'Windows', viewportW: 1440, viewportH: 900,
  body: no === 2 ? '=HYPERLINK("http://example.invalid","수식으로 실행되면 안 됨")' : `요청 ${no}\n줄바꿈 한글 내용`, asIs: null, toBe: null, assignee1: '', assignee2: '', status: no === 2 ? '완료' : '접수', resolvedAt: null, resolutionNote: '',
  thumb: await sharp({ create: { width: 160, height: 100, channels: 3, background: ['#ff0000', '#00ff00', '#0000ff'][no - 1]! } }).jpeg().toBuffer(), originalUrl: null,
});
await writeFile(join(dir, 'input.xlsx'), await buildWorkbook({ rows, footerText: null }));
const office = spawn(process.env.SOFFICE || 'libreoffice', ['--headless', `-env:UserInstallation=${pathToFileURL(join(dir, 'profile'))}`, '--accept=socket,host=127.0.0.1,port=8299;urp;StarOffice.ComponentContext', '--norestore', '--nodefault', '--nofirststartwizard'], { stdio: ['ignore', 'ignore', 'pipe'] });
office.stderr.on('data', (d) => process.stderr.write(d));
try {
  await new Promise<void>((resolve, reject) => {
    const python = spawn(process.env.PYTHON || 'python3', ['tests/spreadsheet.py', dir], { stdio: 'inherit' });
    office.once('error', reject); python.once('error', reject);
    python.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`스프레드시트 시험 실패: ${code}`)));
  });
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await readFile(join(dir, 'sorted.xlsx')) as unknown as ExcelJS.Buffer);
  const ws = wb.getWorksheet('수정요청서')!;
  assert.deepEqual([2, 3, 4].map((r) => ws.getCell(`A${r}`).value), [3, 2, 1]);
  for (let r = 2; r <= 4; r++) {
    const no = Number(ws.getCell(`A${r}`).value);
    const value = ws.getCell(`J${r}`).value as ExcelJS.CellFormulaValue;
    assert.ok(value.formula.replace(/\$/g, '').includes(`A${no + 1}`) && value.formula.includes('"#'), `정렬 후 다른 요청의 캡처 링크: ${JSON.stringify(value)}`);
    assert.equal(wb.getWorksheet('캡처 보기')!.getCell(`A${no + 1}`).value, no);
  }
  assert.equal(ws.getCell('L2').value, '수정 담당자');
  assert.equal(wb.getWorksheet('캡처 보기')!.getImages().length, 3);
  console.log('✓ 실제 스프레드시트에서 한글·줄바꿈·수식 문자열·정렬·필터·편집·재저장 검증');
  console.log('✓ 재저장 파일의 요청 번호와 캡처 링크·그림 3개 일치');
} finally { office.kill('SIGTERM'); await rm(dir, { recursive: true, force: true }); }
