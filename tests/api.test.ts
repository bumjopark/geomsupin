import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { unzipSync, strFromU8 } from 'fflate';
import { migrate } from '../server/db.ts';
import { REVIEW_URL_MIGRATION } from '../server/migrations/008_redact_review_urls.ts';
import { createSite, HOST, openReviewer, pngDataUrl, installManager, startTestApp, type TestApp } from './helpers.ts';

let t: TestApp;
const ORIGIN = 'http://staging.example-client.kr';
const tokenOf = (shareUrl: string) => shareUrl.split('/r/')[1]!;

beforeAll(async () => { t = await startTestApp(); });
afterAll(async () => { await t.close(); });

const json = (res: { body: string }) => JSON.parse(res.body);

describe('관리 접근', () => {
  it('초기 방문자와 기존 가입·로그인 URL은 관리 권한을 얻지 못한다', async () => {
    expect((await t.app.inject({ url: '/api/sites', headers: HOST })).statusCode).toBe(401);
    for (const url of ['/api/auth/signup', '/api/auth/login']) {
      expect((await t.app.inject({ method: 'POST', url, headers: HOST })).statusCode).toBe(404);
    }
  });

  it('다른 origin 에서 온 쓰기 요청은 CSRF 로 막는다', async () => {
    const { headers } = await installManager(t);
    const res = await t.app.inject({ method: 'POST', url: '/api/sites', headers: { ...headers, origin: 'https://evil.example' }, payload: { name: 'x' } });
    expect(res.statusCode).toBe(403);
  });
});

describe('전체 흐름: 사이트 → 링크 → 함께 보는 사람들의 요청 → 목록 → 엑셀', () => {
  let cookieHeaders: Record<string, string>;
  let siteId = '';
  let key = '';
  let token = '';
  let shareUrl = '';
  let sessionA = '';
  let requestId = '';
  const wh = (session?: string, origin = ORIGIN) => ({ ...HOST, 'x-gp-key': key, origin, ...(session ? { authorization: `Bearer ${session}` } : {}) });
  const open = async (name?: string, pid?: string) => json(await openReviewer(t, wh(), token, { name, pid }));

  it('프로젝트는 이름만으로 만들어지고, 초대 링크가 나온다 (주소·스크립트·허용 주소가 없다)', async () => {
    const { headers } = await installManager(t, '흐름');
    cookieHeaders = headers;
    const res = await t.app.inject({ method: 'POST', url: '/api/sites', headers, payload: { name: '오로라 브루어리' } });
    expect(res.statusCode).toBe(200);
    const site = json(res).site;
    siteId = site.id;
    key = site.widgetKey;
    for (const gone of ['snippet', 'origins', 'stagingUrl', 'installedAt', 'support', 'isDemo']) expect(site[gone], gone).toBeUndefined();
    expect(site.preview).toBeUndefined();
    expect(site.links).toHaveLength(1);
    shareUrl = site.links[0].shareUrl;
    token = tokenOf(shareUrl);
    expect((await t.app.inject({ url: `/api/share/${token}`, headers: HOST })).json().state).toBe('unconnected');
    expect((await t.app.inject({ method: 'PATCH', url: `/api/sites/${siteId}`, headers, payload: { previewUrl: ORIGIN } })).statusCode).toBe(200);
  });

  it('preflight 는 요청 origin 을 돌려주고 허용 헤더를 알린다', async () => {
    const res = await t.app.inject({ method: 'OPTIONS', url: '/api/w/requests', headers: { ...HOST, origin: ORIGIN, 'access-control-request-method': 'POST' } });
    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(ORIGIN);
    expect(String(res.headers['access-control-allow-headers'])).toContain('X-GP-Key');
    // 브라우저는 DELETE·PATCH 도 preflight 에서 허용 목록에 있어야 보낸다
    expect(String(res.headers['access-control-allow-methods'])).toMatch(/DELETE/);
    expect(String(res.headers['access-control-allow-methods'])).toMatch(/PATCH/);
  });

  it('사설 주소 서버로 가는 요청을 위한 preflight 허락(Private Network Access)을 알린다', async () => {
    const res = await t.app.inject({ method: 'OPTIONS', url: '/api/w/session', headers: { ...HOST, origin: ORIGIN, 'access-control-request-method': 'POST', 'access-control-request-private-network': 'true' } });
    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-private-network']).toBe('true');
    const plain = await t.app.inject({ method: 'OPTIONS', url: '/api/w/session', headers: { ...HOST, origin: ORIGIN, 'access-control-request-method': 'POST' } });
    expect(plain.headers['access-control-allow-private-network']).toBeUndefined();
  });

  it('초대로 별명 없는 세션을 열고 같은 브라우저는 같은 작성자로 이어진다', async () => {
    const pid = 'reviewer-a-test-browser';
    const a = await open(undefined, pid);
    sessionA = a.session;
    expect(a.reviewer.name).toBe('');
    expect((await open(undefined, pid)).reviewer.id).toBe(a.reviewer.id);
    expect((await open()).reviewer.id).not.toBe(a.reviewer.id);
  });

  it('잘못된 초대 토큰, 타 출처, 미등록 출처를 제한한다', async () => {
    expect((await openReviewer(t, wh(), 'x'.repeat(30))).statusCode).toBe(404);
    expect((await t.app.inject({ url: '/api/w/requests', headers: wh(sessionA, 'http://alien.example') })).statusCode).toBe(401);
    expect((await t.app.inject({ url: '/api/w/requests', headers: { ...HOST, 'x-gp-key': key, referer: ORIGIN + '/', authorization: `Bearer ${sessionA}` } })).statusCode).toBe(401);
    const preflight = await t.app.inject({ method: 'OPTIONS', url: '/api/w/requests', headers: wh(undefined, 'http://alien.example') });
    expect(preflight.statusCode).toBe(403);
    expect(preflight.headers['access-control-allow-origin']).toBeUndefined();
    expect((await t.app.inject({ method: 'POST', url: '/api/w/session', headers: wh(), payload: { token } })).statusCode).toBe(403);
  });

  const payload = async (extra: Record<string, unknown> = {}) => ({
    pageUrl: `${ORIGIN}/menu?gp_review=${token}#top`, pageTitle: '메뉴', selector: 'main > section:nth-of-type(2) h2', textHint: '시그니처 메뉴',
    offsetX: 0.4, offsetY: 0.5, pageX: 320, pageY: 1400, viewportW: 1440, viewportH: 900, scrollY: 1200, dpr: 2,
    browser: 'Chrome 149', os: 'macOS 15', body: '제목 글자가 시안보다 작습니다.', kind: '수정',
    screenshot: await pngDataUrl(1440, 900), captureNotes: { images: 1, iframes: 0, fonts: 0 }, ...extra,
  });

  it('요청 남기기: 이름은 이때 처음 받고(없으면 안내), 캡처를 검증·재인코딩해 저장하고 번호를 매긴다', async () => {
    const noName = await t.app.inject({ method: 'POST', url: '/api/w/requests', headers: wh(sessionA), payload: await payload() });
    expect(noName.statusCode).toBe(400);
    expect(json(noName).error.code).toBe('name_required');
    const res = await t.app.inject({ method: 'POST', url: '/api/w/requests', headers: wh(sessionA), payload: await payload({ name: '김고객' }) });
    expect(res.statusCode).toBe(200);
    expect(json(res).request.no).toBe(1);
    requestId = json(res).request.id;
    // 이름은 한 번 정하면 다음부터는 안 보내도 된다
    const second = json(await t.app.inject({ method: 'POST', url: '/api/w/requests', headers: wh(sessionA), payload: await payload({ body: '두 번째', screenshot: undefined }) }));
    expect(second.request.no).toBe(2);
  });

  it('요청 주소의 origin 이 실제 origin 과 다르면 거절한다', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/w/requests', headers: wh(sessionA), payload: { pageUrl: 'https://other.example/x', viewportW: 1000, viewportH: 800, body: '위조' } });
    expect(res.statusCode).toBe(400);
  });

  it('이미지가 아닌 데이터는 거절한다', async () => {
    const fake = `data:image/png;base64,${Buffer.from('<script>alert(1)</script>').toString('base64')}`;
    const res = await t.app.inject({ method: 'POST', url: '/api/w/requests', headers: wh(sessionA), payload: { pageUrl: `${ORIGIN}/`, viewportW: 1000, viewportH: 800, body: '가짜', screenshot: fake } });
    expect(res.statusCode).toBe(400);
    expect(json(res).error.code).toBe('bad_image');
  });

  it('세션 없이 요청을 남길 수 없다', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/w/requests', headers: wh(), payload: { pageUrl: `${ORIGIN}/`, viewportW: 1000, viewportH: 800, body: '무단' } });
    expect(res.statusCode).toBe(401);
  });

  describe('공유 보드: 링크를 받은 모두가 함께 본다', () => {
    let sessionB = '';
    it('다른 사람(B)도 링크만으로 들어와 A 의 요청을 모두 본다 (내 것은 표시된다)', async () => {
      const b = await open();
      sessionB = b.session;
      expect(b.reviewer.id).not.toBe('');
      const list = json(await t.app.inject({ method: 'GET', url: '/api/w/requests', headers: wh(sessionB) })).requests;
      expect(list).toHaveLength(2);
      expect(list[0].author).toBe('김고객');
      expect(list.every((r: { mine: boolean }) => r.mine === false)).toBe(true);
      expect(list[0].pageUrl).toBe(`${ORIGIN}/menu`);
      const mine = json(await t.app.inject({ method: 'GET', url: '/api/w/requests', headers: wh(sessionA) })).requests;
      expect(mine.every((r: { mine: boolean }) => r.mine === true)).toBe(true);
    });

    it('이름을 아직 안 정한 사람은 댓글·상태 변경을 할 수 없다(보드에 "손님"이 생기지 않게)', async () => {
      const guest = (await open()).session;
      const c = await t.app.inject({ method: 'POST', url: `/api/w/requests/${requestId}/comments`, headers: wh(guest), payload: { body: '이름 없이 댓글' } });
      expect(c.statusCode).toBe(400);
      expect(json(c).error.code).toBe('name_required');
      const st = await t.app.inject({ method: 'PATCH', url: `/api/w/requests/${requestId}`, headers: wh(guest), payload: { status: '완료' } });
      expect(st.statusCode).toBe(400);
      expect(json(st).error.code).toBe('name_required');
      // 이름은 PATCH /reviewer 로 정한다
      const named = await t.app.inject({ method: 'PATCH', url: '/api/w/reviewer', headers: wh(guest), payload: { name: '  박손님 ' } });
      expect(json(named).reviewer.name).toBe('박손님');
      const empty = await t.app.inject({ method: 'PATCH', url: '/api/w/reviewer', headers: wh(guest), payload: { name: '   ' } });
      expect(empty.statusCode).toBe(400);
    });

    it('B 도 이름을 정하고 요청을 남긴다', async () => {
      const res = await t.app.inject({ method: 'POST', url: '/api/w/requests', headers: wh(sessionB), payload: await payload({ name: '이디자인', body: 'B 가 남긴 요청', screenshot: undefined }) });
      expect(res.statusCode).toBe(200);
      expect(json(res).request.no).toBe(3);
    });

    it('누구나 상태를 바꾸면 "누가 바꿨는지" 기록이 남는다(완료 → 다시 열기)', async () => {
      const done = json(await t.app.inject({ method: 'PATCH', url: `/api/w/requests/${requestId}`, headers: wh(sessionB), payload: { status: '완료' } })).request;
      expect(done.status).toBe('완료');
      expect(done.resolvedAt).toBeTruthy();
      expect(done.updatedBy).toBe('이디자인');
      expect(done.comments.at(-1)).toMatchObject({ type: 'system', author: '이디자인' });
      expect(done.comments.at(-1).body).toContain('완료로 표시했어요');
      const reopened = json(await t.app.inject({ method: 'PATCH', url: `/api/w/requests/${requestId}`, headers: wh(sessionA), payload: { status: '재발생' } })).request;
      expect(reopened.status).toBe('재발생');
      expect(reopened.resolvedAt).toBeNull();
      expect(reopened.comments.at(-1).body).toContain('다시 열었어요');
      // 같은 상태로 다시 보내면 기록이 늘지 않는다
      const same = json(await t.app.inject({ method: 'PATCH', url: `/api/w/requests/${requestId}`, headers: wh(sessionA), payload: { status: '재발생' } })).request;
      expect(same.comments).toHaveLength(2);
    });

    it('댓글을 주고받는다 (글자는 그대로 저장되고, 개수가 목록에 보인다)', async () => {
      const r = json(await t.app.inject({ method: 'POST', url: `/api/w/requests/${requestId}/comments`, headers: wh(sessionB), payload: { body: '<img src=x onerror=alert(1)> 확인했어요' } })).request;
      const c = r.comments.at(-1);
      expect(c).toMatchObject({ type: 'reviewer', author: '이디자인', mine: true });
      expect(c.body).toBe('<img src=x onerror=alert(1)> 확인했어요');
      const fromA = json(await t.app.inject({ method: 'GET', url: `/api/w/requests/${requestId}`, headers: wh(sessionA) })).request;
      expect(fromA.comments.at(-1).mine).toBe(false);
      const list = json(await t.app.inject({ method: 'GET', url: '/api/w/requests', headers: wh(sessionA) })).requests;
      expect(list.find((x: { id: string }) => x.id === requestId).commentCount).toBe(1); // 시스템 기록은 세지 않는다
      const empty = await t.app.inject({ method: 'POST', url: `/api/w/requests/${requestId}/comments`, headers: wh(sessionB), payload: { body: '   ' } });
      expect(empty.statusCode).toBe(400);
    });

    it('내용 수정·삭제는 본인 것만 된다', async () => {
      const edit = await t.app.inject({ method: 'PATCH', url: `/api/w/requests/${requestId}`, headers: wh(sessionB), payload: { body: '남의 글을 고침' } });
      expect(edit.statusCode).toBe(403);
      const del = await t.app.inject({ method: 'DELETE', url: `/api/w/requests/${requestId}`, headers: wh(sessionB) });
      expect(del.statusCode).toBe(403);
      const mine = json(await t.app.inject({ method: 'PATCH', url: `/api/w/requests/${requestId}`, headers: wh(sessionA), payload: { body: '제목 글자가 시안보다 작습니다. (수정)' } })).request;
      expect(mine.body).toContain('(수정)');
      const list = json(await t.app.inject({ method: 'GET', url: '/api/w/requests', headers: wh(sessionB) })).requests;
      const b3 = list.find((x: { no: number }) => x.no === 3);
      const delOwn = await t.app.inject({ method: 'DELETE', url: `/api/w/requests/${b3.id}`, headers: wh(sessionB) });
      expect(delOwn.statusCode).toBe(200);
      expect(json(await t.app.inject({ method: 'GET', url: '/api/w/requests', headers: wh(sessionA) })).requests).toHaveLength(2);
    });

    it('다른 사이트의 링크로는 이 사이트의 요청을 볼 수도 건드릴 수도 없다', async () => {
      const other = await installManager(t);
      const { site: site2 } = await createSite(t, other.headers, '다른 사이트', 'http://staging.other-client.kr');
      const tok2 = tokenOf(site2.links[0].shareUrl);
      const h2 = { ...HOST, 'x-gp-key': site2.widgetKey, origin: 'http://staging.other-client.kr' };
      const s2 = json(await openReviewer(t, h2, tok2)).session;
      const list = json(await t.app.inject({ method: 'GET', url: '/api/w/requests', headers: { ...h2, authorization: `Bearer ${s2}` } })).requests;
      expect(list).toHaveLength(0);
      for (const [method, url] of [['GET', `/api/w/requests/${requestId}`], ['PATCH', `/api/w/requests/${requestId}`], ['DELETE', `/api/w/requests/${requestId}`], ['POST', `/api/w/requests/${requestId}/comments`]] as const) {
        const res = await t.app.inject({ method, url, headers: { ...h2, authorization: `Bearer ${s2}` }, payload: method === 'PATCH' ? { status: '완료' } : method === 'POST' ? { body: 'x' } : undefined });
        expect(res.statusCode, `${method} ${url}`).toBe(404);
      }
      // 이 사이트의 세션 토큰을 다른 사이트 키로 쓰는 것도 안 된다
      const cross = await t.app.inject({ method: 'GET', url: '/api/w/requests', headers: { ...h2, authorization: `Bearer ${sessionA}` } });
      expect(cross.statusCode).toBe(401);
    });
  });

  it('에이전시 목록: 필터·건수·선택지·댓글 수가 온다', async () => {
    const res = json(await t.app.inject({ method: 'GET', url: `/api/sites/${siteId}/requests`, headers: cookieHeaders }));
    expect(res.total).toBe(2);
    expect(res.counts['재발생']).toBe(1);
    expect(res.pages[0].url).toBe(`${ORIGIN}/menu`);
    const first = res.requests.find((r: { no: number }) => r.no === 1);
    expect(first.thumbUrl).toContain('/files/captures/');
    expect(first.captureNotes.images).toBe(1);
    expect(first.commentCount).toBe(1);
    const q = json(await t.app.inject({ method: 'GET', url: `/api/sites/${siteId}/requests?q=${encodeURIComponent('두 번째')}`, headers: cookieHeaders }));
    expect(q.total).toBe(1);
  });

  it('에이전시 상세에는 대화(댓글·상태 기록)가 보이고, 담당자도 댓글을 남기고 상태를 바꾼다', async () => {
    const d = json(await t.app.inject({ method: 'GET', url: `/api/requests/${requestId}`, headers: cookieHeaders })).request;
    expect(d.comments.map((c: { type: string }) => c.type)).toEqual(['system', 'system', 'reviewer']);
    const after = json(await t.app.inject({ method: 'POST', url: `/api/requests/${requestId}/comments`, headers: cookieHeaders, payload: { body: '폰트 키워서 반영할게요' } })).request;
    expect(after.comments.at(-1)).toMatchObject({ type: 'agency', author: '흐름' });
    const patched = json(await t.app.inject({ method: 'PATCH', url: `/api/requests/${requestId}`, headers: cookieHeaders, payload: { status: '진행' } })).request;
    expect(patched.comments.at(-1)).toMatchObject({ type: 'system', author: '흐름(담당자)' });
    // 다음 위젯 목록에도 보인다
    const board = json(await t.app.inject({ method: 'GET', url: '/api/w/requests', headers: wh(sessionA) })).requests.find((r: { id: string }) => r.id === requestId);
    expect(board.status).toBe('진행');
    expect(board.updatedBy).toBe('흐름(담당자)');
  });

  it('서명 주소로만 이미지를 열 수 있다', async () => {
    const detail = json(await t.app.inject({ method: 'GET', url: `/api/requests/${requestId}`, headers: cookieHeaders })).request;
    const u = new URL(detail.screenshotUrl);
    const ok = await t.app.inject({ method: 'GET', url: u.pathname + u.search, headers: HOST });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['content-type']).toBe('image/webp');
    // 위젯이 다른 사이트(고객 스테이징) 화면 안에서 캡처 미리보기를 보여 줄 수 있어야 한다
    expect(ok.headers['cross-origin-resource-policy']).toBe('cross-origin');
    const goodSig = u.searchParams.get('sig')!;
    const badSig = goodSig.slice(0, -1) + (goodSig.endsWith('A') ? 'B' : 'A'); // 항상 달라지게 마지막 글자를 바꾼다
    const tampered = await t.app.inject({ method: 'GET', url: `${u.pathname}?exp=${u.searchParams.get('exp')}&sig=${badSig}`, headers: HOST });
    expect(tampered.statusCode).toBe(403);
    const noSig = await t.app.inject({ method: 'GET', url: u.pathname, headers: HOST });
    expect(noSig.statusCode).toBe(403);
    const expired = await t.app.inject({ method: 'GET', url: `${u.pathname}?exp=1&sig=${u.searchParams.get('sig')}`, headers: HOST });
    expect(expired.statusCode).toBe(403);
  });

  it('담당·처리 메모를 바꾸고 완료하면 처리일이 기록된다', async () => {
    const res = json(await t.app.inject({ method: 'PATCH', url: `/api/requests/${requestId}`, headers: cookieHeaders, payload: { status: '완료', assignee1: '이디자인', assignee2: '최개발', priority: '높음', resolutionNote: '폰트 크기 32px 로 수정' } })).request;
    expect(res.status).toBe('완료');
    expect(res.resolvedAt).toBeTruthy();
    expect(res.assignee2).toBe('최개발');
  });

  it('엑셀 내보내기: 열·값·이미지 위치가 맞다', async () => {
    const res = await t.app.inject({ method: 'GET', url: `/api/sites/${siteId}/export.xlsx`, headers: cookieHeaders });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml');
    expect(String(res.headers['content-disposition'])).toContain("filename*=UTF-8''");
    const buf = res.rawPayload;

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ExcelJS.Buffer);
    const ws = wb.getWorksheet('수정요청서')!;
    const header = (ws.getRow(1).values as unknown[]).slice(1);
    expect(header).toEqual(['번호', '차수', '등록자', '등록일', '구분', '우선순위', '페이지', '환경', '요청 내용', '캡처', '캡처 원본', '1차 담당', '2차 담당', '상태', '처리일', '처리 메모']);
    const r2 = ws.getRow(2);
    expect(r2.getCell(1).value).toBe(1);
    expect(r2.getCell(2).value).toBe('1차');
    expect(r2.getCell(3).value).toBe('김고객');
    expect(r2.getCell(9).value).toContain('제목 글자');
    expect(r2.getCell(12).value).toBe('이디자인');
    expect(r2.getCell(14).value).toBe('완료');
    expect(String(r2.getCell(16).value)).toContain('32px');
    const last = ws.getRow(ws.rowCount);
    expect(String(last.getCell(1).value)).toContain('검수핀');
    const files = unzipSync(new Uint8Array(buf));
    const media = Object.keys(files).filter((n) => n.startsWith('xl/media/') && !n.endsWith('/'));
    expect(media).toHaveLength(1);
    const drawing = strFromU8(files['xl/drawings/drawing1.xml']!);
    expect(drawing).toContain('twoCellAnchor');
    expect(drawing).toMatch(/editAs="twoCell"/);
    expect(drawing).toMatch(/<xdr:from><xdr:col>2<\/xdr:col>[\s\S]*?<xdr:row>1<\/xdr:row>/);
    expect(ws.getImages()).toHaveLength(0);
    expect(ws.getCell('J2').value).toEqual({ formula: 'HYPERLINK("#\'캡처 보기\'!A2","#1 캡처 보기")', result: '#1 캡처 보기' });
    expect(wb.getWorksheet('캡처 보기')!.getImages()).toHaveLength(1);
  });

  it('exports English labels without translating reviewer content or breaking screenshot links', async () => {
    const res = await t.app.inject({ method: 'GET', url: `/api/sites/${siteId}/export.xlsx?lang=en`, headers: cookieHeaders });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toContain('Review_Requests_');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.rawPayload as unknown as ExcelJS.Buffer);
    const ws = wb.getWorksheet('Review Requests')!;
    expect((ws.getRow(1).values as unknown[]).slice(1)).toEqual(['No.', 'Round', 'Reviewer', 'Created (KST)', 'Type', 'Priority', 'Page', 'Environment', 'Request', 'Screenshot', 'Original capture', '1st assignee', '2nd assignee', 'Status', 'Resolved (KST)', 'Resolution note']);
    expect(ws.getCell('B2').value).toBe(1);
    expect(ws.getCell('C2').value).toBe('김고객');
    expect(ws.getCell('E2').value).toBe('Change');
    expect(ws.getCell('F2').value).toBe('High');
    expect(ws.getCell('I2').value).toBe('제목 글자가 시안보다 작습니다. (수정)');
    expect(ws.getCell('J2').value).toEqual({ formula: `HYPERLINK("#'Screenshots'!A2","#1 View screenshot")`, result: '#1 View screenshot' });
    expect(ws.getCell('K2').text).toBe('View original');
    expect(ws.getCell('L2').value).toBe('이디자인');
    expect(ws.getCell('N2').value).toBe('Resolved');
    expect(ws.getCell('P2').value).toBe('폰트 크기 32px 로 수정');
    expect(ws.getRow(ws.rowCount).getCell(1).value).toContain('Made with Geomsupin');
    expect(wb.getWorksheet('Screenshots')!.getImages()).toHaveLength(1);
  });

  it('다른 워크스페이스는 이 사이트를 볼 수 없다', async () => {
    const other = await installManager(t);
    for (const url of [`/api/sites/${siteId}`, `/api/sites/${siteId}/requests`, `/api/requests/${requestId}`, `/api/sites/${siteId}/export.xlsx`]) {
      const res = await t.app.inject({ method: 'GET', url, headers: other.headers });
      expect(res.statusCode, url).toBe(404);
    }
    expect((await t.app.inject({ method: 'PATCH', url: `/api/requests/${requestId}`, headers: other.headers, payload: { status: '보류' } })).statusCode).toBe(404);
    expect((await t.app.inject({ method: 'POST', url: `/api/requests/${requestId}/comments`, headers: other.headers, payload: { body: 'x' } })).statusCode).toBe(404);
  });

  it('링크를 새로 만들어도 비밀번호는 없다(필드가 있어도 무시된다)', async () => {
    const created = json(await t.app.inject({ method: 'POST', url: `/api/sites/${siteId}/links`, headers: cookieHeaders, payload: { label: '디자인팀', password: 'ignored' } }));
    const link = created.site.links.find((l: { label: string }) => l.label === '디자인팀');
    expect(link.hasPassword).toBeUndefined();
    const tk = tokenOf(link.shareUrl);
    expect((await openReviewer(t, wh(), tk)).statusCode).toBe(200);
  });

  describe('초대 링크 /r/<토큰>', () => {
    it('연결된 초대 링크는 미리보기 설정을 주고 캐시하지 않는다', async () => {
      const res = await t.app.inject({ method: 'GET', url: `/api/share/${token}`, headers: HOST });
      expect(res.statusCode).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(json(res)).toMatchObject({ state: 'ok', project: '오로라 브루어리', widgetKey: key, preview: { url: `${ORIGIN}/` } });
    });
    it('/r/<토큰> 화면 자체는 로그인 없이 열린다(관리 화면 SPA)', async () => {
      const page = await t.app.inject({ method: 'GET', url: `/r/${token}`, headers: HOST });
      expect(page.statusCode).toBe(200);
      expect(page.headers['content-type']).toContain('text/html');
      expect(page.body).toContain('<div id="root"></div>');
    });
    it('없는 토큰·잘린 주소는 404', async () => {
      for (const u of [`/api/share/${'z'.repeat(32)}`, '/api/share/abc']) {
        const res = await t.app.inject({ method: 'GET', url: u, headers: HOST });
        expect(res.statusCode, u).toBe(404);
        expect(res.headers['cache-control']).toBe('no-store');
      }
    });
    it('종료된 프로젝트는 state=done 이고 위젯 키를 주지 않는다', async () => {
      await t.app.inject({ method: 'PATCH', url: `/api/sites/${siteId}`, headers: cookieHeaders, payload: { status: 'done' } });
      const done = json(await t.app.inject({ method: 'GET', url: `/api/share/${token}`, headers: HOST }));
      expect(done).toEqual({ state: 'done', project: '오로라 브루어리' });
      await t.app.inject({ method: 'PATCH', url: `/api/sites/${siteId}`, headers: cookieHeaders, payload: { status: 'active' } });
    });
    it('설치 관리자만 스테이징 출처를 연결하거나 해제할 수 있다', async () => {
      const { site, token: invite } = await createSite(t, cookieHeaders, '연결 검증');
      const path = `/api/sites/${site.id}`;
      const patch = (previewUrl: string, headers = cookieHeaders) => t.app.inject({ method: 'PATCH', url: path, headers, payload: { previewUrl } });
      const readInvite = async () => (await t.app.inject({ url: `/api/share/${invite}`, headers: HOST })).json();
      await t.sql`update sites set staging_url = ${ORIGIN} where id = ${site.id}`;
      expect(await readInvite()).toEqual({ state: 'unconnected', project: '연결 검증' });
      const unconnectedSession = await t.app.inject({
        method: 'POST', url: '/api/w/session', headers: { ...HOST, origin: t.ctx.config.publicOrigin, 'x-gp-key': site.widgetKey },
        payload: { token: invite, pid: crypto.randomUUID(), previewId: crypto.randomUUID() },
      });
      expect(unconnectedSession.statusCode).toBe(403);
      expect((await patch(ORIGIN, (await installManager(t)).headers)).statusCode).toBe(404);
      const connected = (await patch('  http://staging.example.com/검수  ')).json().site;
      expect(connected.preview.url).toBe('http://staging.example.com/%EA%B2%80%EC%88%98');
      for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'ftp://stage.example/', 'stage.example', 'http://user:pw@example.com/', 'http://localhost:80/', 'http://stage;test/', `http://stage.example/${'가'.repeat(300)}`]) {
        const response = await patch(bad);
        expect(response.statusCode, bad).toBe(400);
        const { error } = response.json();
        expect(error.fields?.previewUrl ?? error.message, bad).toMatch(/[가-힣]/);
      }
      expect((await readInvite()).preview).toEqual(connected.preview);
      const renamed = await t.app.inject({ method: 'PATCH', url: path, headers: cookieHeaders, payload: { name: '연결 이름 수정' } });
      expect(renamed.json().site.preview).toEqual(connected.preview);
      const changed = (await patch('http://other.example/')).json().site;
      expect(changed.preview.url).toBe('http://other.example/');
      expect(changed.preview.id).not.toBe(connected.preview.id);
      expect((await patch('')).json().site.preview).toBeUndefined();
      expect(await readInvite()).toEqual({ state: 'unconnected', project: '연결 이름 수정' });
    });
  });

  it('목록 폴링: 바뀐 게 없으면 본문 없이 unchanged, 댓글이 달리면 다시 보내고 마지막 댓글을 알려 준다', async () => {
    const first = json(await t.app.inject({ method: 'GET', url: '/api/w/requests', headers: wh(sessionA) }));
    expect(first.requests.length).toBeGreaterThan(0);
    expect(first.version).toEqual(expect.any(String));
    expect(first.version.length).toBeGreaterThan(0);
    const same = json(await t.app.inject({ method: 'GET', url: `/api/w/requests?v=${first.version}`, headers: wh(sessionA) }));
    expect(same.unchanged).toBe(true);
    expect(same.requests).toBeUndefined();
    const target = first.requests[0];
    await t.app.inject({ method: 'POST', url: `/api/w/requests/${target.id}/comments`, headers: wh(sessionA), payload: { body: '버전 시험 댓글입니다' } });
    const after = json(await t.app.inject({ method: 'GET', url: `/api/w/requests?v=${first.version}`, headers: wh(sessionA) }));
    expect(after.unchanged).toBeUndefined();
    expect(after.version).not.toBe(first.version);
    const row = after.requests.find((r: { id: string }) => r.id === target.id);
    expect(row.lastText).toBe('버전 시험 댓글입니다');
    expect(row.lastBy.length).toBeGreaterThan(0);
    // 버전 입력 길이도 제한한다.
    const del = await t.app.inject({ method: 'GET', url: `/api/w/requests?v=${encodeURIComponent('x'.repeat(61))}`, headers: wh(sessionA) });
    expect(del.statusCode).toBe(400); // 길이 제한
  });

  it('동시에 초대 링크의 이름과 폐기를 바꾸면 두 변경이 모두 유지된다', async () => {
    const created = await t.app.inject({ method: 'POST', url: `/api/sites/${siteId}/links`, headers: cookieHeaders, payload: { label: '동시 변경용' } });
    expect(created.statusCode).toBe(200);
    const link = json(created).site.links.find((entry: { label: string }) => entry.label === '동시 변경용');
    const url = `/api/sites/${siteId}/links/${link.id}`;
    const update = (payload: { revoked: boolean } | { label: string }) =>
      t.app.inject({ method: 'PATCH', url, headers: cookieHeaders, payload });
    const pending: ReturnType<typeof update>[] = [];
    try {
      await t.sql.begin(async tx => {
        await tx`select id from review_links where id = ${link.id} for update`;
        pending.push(update({ revoked: true }), update({ label: '새 이름' }));
        await expect.poll(async () => {
          const [row] = await tx<{ waiting: number }[]>`
            select count(*)::int as waiting from pg_locks
            where database = (select oid from pg_database where datname = current_database())
              and relation = 'review_links'::regclass and mode = 'RowExclusiveLock'`;
          return row!.waiting;
        }).toBe(2);
      });
    } finally {
      for (const result of await Promise.all(pending)) expect(result.statusCode).toBe(200);
    }
    const res = await t.app.inject({ url: `/api/sites/${siteId}`, headers: cookieHeaders });
    expect(json(res).site.links.find((entry: { id: string }) => entry.id === link.id)).toMatchObject({ label: '새 이름', active: false });
  });

  it('링크를 폐기하면 초대 화면도 기존 세션도 더는 쓸 수 없다', async () => {
    const site = json(await t.app.inject({ method: 'GET', url: `/api/sites/${siteId}`, headers: cookieHeaders })).site;
    const base = site.links[0];
    const detail = json(await t.app.inject({ url: `/api/w/requests/${requestId}`, headers: wh(sessionA) })).request;
    const capture = new URL(detail.screenshotUrl);
    const getCapture = () => t.app.inject({ url: capture.pathname + capture.search, headers: HOST });
    const openCapture = await getCapture();
    expect(openCapture.statusCode).toBe(200);
    expect(openCapture.headers['cache-control']).toContain('no-store');
    await t.app.inject({ method: 'PATCH', url: `/api/sites/${siteId}/links/${base.id}`, headers: cookieHeaders, payload: { revoked: true } });
    expect((await getCapture()).statusCode).toBe(403);
    capture.searchParams.delete('session');
    expect((await getCapture()).statusCode).toBe(403);
    const res = await t.app.inject({ method: 'GET', url: '/api/w/requests', headers: wh(sessionA) });
    expect(res.statusCode).toBe(401);
    const short = json(await t.app.inject({ method: 'GET', url: `/api/share/${token}`, headers: HOST }));
    expect(short).toEqual({ state: 'revoked', project: '오로라 브루어리' }); // 닫힌 링크에는 위젯 키를 주지 않는다
  });
});

describe('보안 기본값', () => {
  it('알 수 없는 Host 는 421', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/healthz', headers: { host: 'evil.example' } });
    expect(res.statusCode).toBe(421);
  });

  it('파일 경로 이탈은 막는다 (내용이 새지 않고, 인코딩된 이탈은 403)', async () => {
    const plain = await t.app.inject({ method: 'GET', url: '/files/../../etc/passwd?exp=9999999999&sig=x', headers: HOST });
    expect(plain.body).not.toContain('root:');
    const encoded = await t.app.inject({ method: 'GET', url: '/files/captures%2F..%2F..%2F..%2Fetc%2Fpasswd?exp=9999999999&sig=x', headers: HOST });
    expect(encoded.statusCode).toBe(403);
    expect(encoded.body).not.toContain('root:');
  });
});

describe('퇴역한 공개 경로', () => {
  it('데모와 이전 가입·로그인 화면은 404 응답한다', async () => {
    for (const url of ['/demo/', '/demo-cdn/cors/work-1.jpg', '/login', '/signup', '/guide/quick-start.mp4']) {
      expect((await t.app.inject({ url, headers: HOST })).statusCode).toBe(404);
    }
  });
});

describe('위젯 파일 캐시', () => {
  it('로더는 no-store(Cloudflare 캐시 방지), 해시 파일은 immutable, 형식이 다른 이름은 위젯으로 서빙되지 않는다', async () => {
    const m = JSON.parse((await import('node:fs')).readFileSync(`${t.ctx.config.distDir}/widget/manifest.json`, 'utf8')) as { core: string; capture: string };
    const w = await t.app.inject({ method: 'GET', url: '/w.js', headers: HOST });
    expect(w.statusCode).toBe(200);
    expect(w.headers['cache-control']).toBe('no-store');
    expect(w.headers['access-control-allow-origin']).toBe('*');
    expect(w.body).toContain(m.core);
    const again = await t.app.inject({ method: 'GET', url: '/w.js', headers: { ...HOST, 'if-none-match': String(w.headers.etag) } });
    expect(again.statusCode).toBe(304);
    for (const f of [m.core, m.capture]) {
      const r = await t.app.inject({ method: 'GET', url: `/${f}`, headers: HOST });
      expect(r.statusCode, f).toBe(200);
      expect(r.headers['cache-control']).toContain('immutable');
    }
    for (const bad of ['/w-core.js', '/w-capture.js?v=old', '/w-core.zzzzzzzzzz.js', '/w-core.abc.js', '/w-evil.0123456789.js']) {
      const r = await t.app.inject({ method: 'GET', url: bad, headers: HOST });
      expect(r.statusCode, bad).toBe(404);
    }
  });
});


it('sensitive queries are dropped from new and legacy URLs while the ordinary page filter and Excel link stay usable', async () => {
  const owner = await installManager(t);
  const { site, token } = await createSite(t, owner.headers, 'URL privacy', ORIGIN);
  const reviewerHeaders = { ...HOST, origin: ORIGIN, 'x-gp-key': site.widgetKey };
  const session = (await openReviewer(t, reviewerHeaders, token, { name: 'Reviewer' })).json().session;
  const auth = { ...reviewerHeaders, authorization: `Bearer ${session}` };
  const raw = `${ORIGIN}/app?tab=orders&code=sample-auth&state=sample-state&X-Amz-Signature=sample-signature&access_token%5B0%5D=sample-token#!/detail?id=32&%61uth_token=sample-spa&view=summary`;
  const safe = `${ORIGIN}/app?tab=orders#!/detail?id=32&view=summary`;
  const created = await t.app.inject({ method: 'POST', url: '/api/w/requests', headers: auth, payload: { pageUrl: raw, pageTitle: 'Orders', viewportW: 1200, viewportH: 800, body: 'URL check' } });
  expect(created.statusCode).toBe(200);
  const id = created.json().request.id;
  const storedUrl = async () => (await t.sql`select page_url from requests where id = ${id}`)[0]?.page_url;
  expect(await storedUrl()).toBe(safe);

  await t.sql`update requests set page_url = ${raw} where id = ${id}`;
  await t.sql`delete from schema_migrations where name = ${REVIEW_URL_MIGRATION}`;
  expect(await migrate(t.sql)).toContain(REVIEW_URL_MIGRATION);
  expect(await storedUrl()).toBe(safe);
  expect(await migrate(t.sql)).not.toContain(REVIEW_URL_MIGRATION);
  const board = await t.app.inject({ url: '/api/w/requests', headers: auth });
  expect(board.json().requests[0].pageUrl).toBe(safe);
  const filter = `?page=${encodeURIComponent(safe)}`;
  const admin = await t.app.inject({ url: `/api/sites/${site.id}/requests${filter}`, headers: owner.headers });
  expect(admin.json()).toMatchObject({ total: 1, requests: [{ pageUrl: safe, pageTitle: 'Orders' }], pages: [{ url: safe, count: 1 }] });
  const exported = await t.app.inject({ url: `/api/sites/${site.id}/export.xlsx${filter}`, headers: owner.headers });
  expect(exported.statusCode).toBe(200);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(exported.rawPayload as unknown as ExcelJS.Buffer);
  expect(workbook.worksheets[0]!.getCell('G2').value).toMatchObject({ text: `Orders\n${safe}`, hyperlink: safe });
});
