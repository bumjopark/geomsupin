// 한국식 수정요청서 엑셀. 열 구성은 실무자 QA 시트를 그대로 따른다.
import ExcelJS from 'exceljs';
import sharp from 'sharp';
import { reviewTerm, type Locale } from '../shared/locale.ts';

export interface ExportRow {
  no: number;
  roundNo: number;
  reviewerName: string;
  createdAt: Date;
  kind: string;
  priority: string;
  pageUrl: string;
  pageTitle: string;
  browser: string;
  os: string;
  viewportW: number | null;
  viewportH: number | null;
  body: string;
  asIs: string | null;
  toBe: string | null;
  assignee1: string;
  assignee2: string;
  status: string;
  resolvedAt: Date | null;
  resolutionNote: string;
  thumb: Buffer | null;
  originalUrl: string | null;
}

interface ExportInput {
  rows: ExportRow[];
  locale?: Locale;
  /** 요청서 마지막 줄의 출처 안내 */
  footerText: string | null;
}

const PX = 9525; // 1px = 9525 EMU
const IMG_COL_PX = 232;
const IMG_PAD = 6;
const MIN_ROW_PT = 30;

// 열: 너비는 엑셀 글자 수 기준
const COLS = [
  { key: 'no', ko: '번호', en: 'No.', width: 7 },
  { key: 'round', ko: '차수', en: 'Round', width: 7 },
  { key: 'reviewer', ko: '등록자', en: 'Reviewer', width: 12 },
  { key: 'created', ko: '등록일', en: 'Created (KST)', width: 17 },
  { key: 'kind', ko: '구분', en: 'Type', width: 8 },
  { key: 'priority', ko: '우선순위', en: 'Priority', width: 10 },
  { key: 'page', ko: '페이지', en: 'Page', width: 30 },
  { key: 'env', ko: '환경', en: 'Environment', width: 22 },
  { key: 'body', ko: '요청 내용', en: 'Request', width: 52 },
  { key: 'capture', ko: '캡처', en: 'Screenshot', width: (IMG_COL_PX - 5) / 7 },
  { key: 'original', ko: '캡처 원본', en: 'Original capture', width: 11 },
  { key: 'a1', ko: '1차 담당', en: '1st assignee', width: 11 },
  { key: 'a2', ko: '2차 담당', en: '2nd assignee', width: 11 },
  { key: 'status', ko: '상태', en: 'Status', width: 9 },
  { key: 'resolved', ko: '처리일', en: 'Resolved (KST)', width: 17 },
  { key: 'note', ko: '처리 메모', en: 'Resolution note', width: 32 },
] as const;

const WORKBOOK_TEXT = {
  ko: { creator: '검수핀', requests: '수정요청서', captures: '캡처 보기', captureHeading: '캡처 — 목록의 캡처 보기 링크로 이동하세요', viewCapture: '캡처 보기', viewOriginal: '원본 보기' },
  en: { creator: 'Geomsupin', requests: 'Review Requests', captures: 'Screenshots', captureHeading: 'Screenshots — follow a link from the request list', viewCapture: 'View screenshot', viewOriginal: 'View original' },
} as const;

const CENTERED = new Set<string>(['no', 'round', 'kind', 'priority', 'status']);
const KST = 9 * 3600 * 1000;
function fmtKst(d: Date | null): string {
  if (!d) return '';
  const k = new Date(d.getTime() + KST);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${k.getUTCFullYear()}-${p(k.getUTCMonth() + 1)}-${p(k.getUTCDate())} ${p(k.getUTCHours())}:${p(k.getUTCMinutes())}`;
}

/** 줄 수 추정: 한글은 영문의 약 2배 폭 */
function estimateLines(text: string, widthChars: number): number {
  let lines = 0;
  for (const para of text.split('\n')) {
    let w = 0;
    for (const ch of para) w += ch.charCodeAt(0) > 0x7f ? 2 : 1;
    lines += Math.max(1, Math.ceil(w / (widthChars * 1.05)));
  }
  return lines;
}

export async function buildWorkbook(input: ExportInput): Promise<Buffer> {
  const locale = input.locale ?? 'ko';
  const text = WORKBOOK_TEXT[locale];
  const wb = new ExcelJS.Workbook();
  wb.creator = text.creator;
  wb.created = new Date();
  const ws = wb.addWorksheet(text.requests, {
    views: [{ state: 'frozen', ySplit: 1, xSplit: 3 }],
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });
  // 떠 있는 그림은 앱마다 정렬 동작이 다르다. 정렬하는 표에는 셀 링크를 두고
  // 캡처는 고정된 별도 시트에 둬, 어떤 순서로 정렬해도 다른 요청의 그림과 섞이지 않는다.
  const captures = wb.addWorksheet(text.captures, { views: [{ state: 'frozen', ySplit: 1 }] });
  captures.columns = [
    { key: 'no', header: COLS[0][locale], width: 8 },
    { key: 'body', header: COLS[8][locale], width: 52 },
    { key: 'image', header: text.captureHeading, width: (IMG_COL_PX - 5) / 7 },
  ];
  captures.getRow(1).height = 32;
  captures.getRow(1).font = { bold: true, name: 'Malgun Gothic', size: 10 };
  captures.getRow(1).alignment = { vertical: 'middle', wrapText: true };
  let captureRow = 2;

  ws.columns = COLS.map((c) => ({ key: c.key, header: c[locale], width: locale === 'en' && c.key === 'status' ? 12 : c.width }));
  const head = ws.getRow(1);
  head.height = 26;
  head.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, name: 'Malgun Gothic', size: 10 };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F766E' } };
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    cell.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
  });

  const capCol = 2;
  let r = 2;

  for (const row of input.rows) {
    const env = [row.browser, row.os, row.viewportW && row.viewportH ? `${row.viewportW}×${row.viewportH}` : ''].filter(Boolean).join('\n');
    const body = [row.body, row.asIs ? `\n[AS-IS] ${row.asIs}` : '', row.toBe ? `[TO-BE] ${row.toBe}` : ''].filter(Boolean).join('\n');
    const excelRow = ws.addRow({
      no: row.no,
      round: locale === 'en' ? row.roundNo : `${row.roundNo}차`,
      reviewer: row.reviewerName,
      created: fmtKst(row.createdAt),
      kind: reviewTerm(row.kind, locale),
      priority: reviewTerm(row.priority, locale),
      page: row.pageTitle ? `${row.pageTitle}\n${row.pageUrl}` : row.pageUrl,
      env,
      body,
      capture: '',
      original: '',
      a1: row.assignee1,
      a2: row.assignee2,
      status: reviewTerm(row.status, locale),
      resolved: fmtKst(row.resolvedAt),
      note: row.resolutionNote,
    });

    // 페이지는 링크로
    const pageCell = excelRow.getCell('page');
    pageCell.value = { text: pageCell.value as string, hyperlink: row.pageUrl };
    pageCell.font = { color: { argb: 'FF0B5FFF' }, underline: true, name: 'Malgun Gothic', size: 9 };

    if (row.thumb) {
      const meta = await sharp(row.thumb).metadata();
      const iw = meta.width ?? 520;
      const ih = meta.height ?? 325;
      const maxW = IMG_COL_PX - IMG_PAD * 2;
      const maxH = 150;
      const scale = Math.min(maxW / iw, maxH / ih);
      const dw = Math.round(iw * scale);
      const dh = Math.round(ih * scale);
      const id = wb.addImage({ buffer: row.thumb as unknown as ExcelJS.Buffer, extension: 'jpeg' });
      const imageRow = captures.addRow({ no: row.no, body });
      imageRow.height = Math.ceil(Math.min(409, Math.max((dh + IMG_PAD * 2) * 0.75, estimateLines(body, 52) * 13.5 + 8)));
      imageRow.font = { name: 'Malgun Gothic', size: 10 };
      imageRow.alignment = { vertical: 'top', wrapText: true };
      captures.addImage(id, {
        tl: { nativeCol: capCol, nativeColOff: IMG_PAD * PX, nativeRow: captureRow - 1, nativeRowOff: IMG_PAD * PX } as unknown as ExcelJS.Anchor,
        br: { nativeCol: capCol, nativeColOff: (IMG_PAD + dw) * PX, nativeRow: captureRow - 1, nativeRowOff: (IMG_PAD + dh) * PX } as unknown as ExcelJS.Anchor,
        editAs: 'twoCell',
      });
      // ExcelJS의 일반 hyperlink는 내부 주소에도 외부 파일 관계를 만든다.
      // 고정된 시트명·정수로 만든 내부 HYPERLINK 수식은 재저장해도 파일 밖을 가리키지 않는다.
      const captureLabel = `#${row.no} ${text.viewCapture}`;
      excelRow.getCell('capture').value = { formula: `HYPERLINK("#'${text.captures}'!A${captureRow}","${captureLabel}")`, result: captureLabel };
      excelRow.getCell('capture').font = { color: { argb: 'FF0B5FFF' }, underline: true, name: 'Malgun Gothic', size: 9 };
      captureRow++;
    }
    if (row.originalUrl) {
      const c = excelRow.getCell('original');
      c.value = { text: text.viewOriginal, hyperlink: row.originalUrl };
      c.font = { color: { argb: 'FF0B5FFF' }, underline: true, name: 'Malgun Gothic', size: 9 };
    }

    const textLines = Math.max(estimateLines(body, 52), estimateLines(row.pageUrl, 30) + (row.pageTitle ? 1 : 0), env.split('\n').length, estimateLines(row.resolutionNote, 32));
    const heightPt = Math.min(409, Math.max(MIN_ROW_PT, (textLines * 13.5 + 8)));
    excelRow.height = Math.ceil(heightPt);

    const thin = { style: 'thin' as const, color: { argb: 'FFD0D7D5' } };
    COLS.forEach((c, i) => {
      const cell = excelRow.getCell(i + 1);
      cell.alignment = { vertical: 'top', wrapText: true, horizontal: CENTERED.has(c.key) ? 'center' : 'left' };
      cell.border = { top: thin, left: thin, bottom: thin, right: thin };
      if (!cell.font || !cell.font.name) cell.font = { name: 'Malgun Gothic', size: 10 };
    });
    r++;
  }

  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(1, r - 1), column: COLS.length } };
  // 캡처 시트는 표의 링크 대상이므로 위치를 고정한다. 수정·정렬은 첫 시트에서 한다.
  await captures.protect('', { selectLockedCells: true, selectUnlockedCells: true });

  if (input.footerText) {
    const fr = r + 1;
    ws.mergeCells(fr, 1, fr, 9);
    const cell = ws.getCell(fr, 1);
    cell.value = input.footerText;
    cell.font = { color: { argb: 'FF8A9A97' }, size: 9, name: 'Malgun Gothic' };
    cell.alignment = { vertical: 'middle' };
  }

  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out as ArrayBuffer);
}
