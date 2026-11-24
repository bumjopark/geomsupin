import { afterAll, beforeAll, expect, it } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';
import { randomBytes } from 'node:crypto';
import { createSite, openReviewer, HOST, pngDataUrl, installManager, startTestApp, type TestApp } from './helpers.ts';

let t: TestApp;
let admin: Record<string, string>;
beforeAll(async () => { t = await startTestApp(); admin = (await installManager(t)).headers; });
afterAll(async () => { await t?.close(); });

it('동시에 시작한 다른 테스트가 사용 중인 DB를 초기화하지 못한다', async () => {
  await expect(startTestApp()).rejects.toThrow('다른 테스트가 이 DB를 사용 중');
  expect((await t.sql`select count(*)::int as n from users`)[0]!.n).toBe(1);
});

async function fixture() {
  const { site, token } = await createSite(t, admin, '동시 검수', 'http://review.example');
  const headers = { ...HOST, origin: 'http://review.example', 'x-gp-key': site.widgetKey };
  const pid = randomBytes(16).toString('hex');
  const session = (await openReviewer(t, headers, token, { name: '검수자', pid })).json();
  const widget = { ...headers, authorization: `Bearer ${session.session}` };
  const payload = { pageUrl: 'http://review.example/', viewportW: 1200, viewportH: 800, body: '원래 내용' };
  const result = await t.app.inject({ method: 'POST', url: '/api/w/requests', headers: widget, payload });
  expect(result.statusCode).toBe(200);
  return { site, token, pid, session: session.session as string, widget, payload, id: result.json().request.id as string };
}

it('같은 브라우저가 동시에 입장해도 기존 작성자와 요청을 보존한다', async () => {
  const f = await fixture();
  const sessions = await Promise.all(Array.from({ length: 5 }, () => openReviewer(t, f.widget, f.token, { pid: f.pid })));
  expect(new Set(sessions.map(s => s.json().reviewer.id)).size).toBe(1);
  expect(new Set(sessions.map(s => s.json().session)).size).toBe(5);
  const rows = await t.sql`select count(*)::int as n from reviewers where site_id = ${f.site.id} and pid = ${f.pid}`;
  expect(rows[0]!.n).toBe(1);
  const response = await t.app.inject({ url: `/api/w/requests/${f.id}`, headers: { ...f.widget, authorization: `Bearer ${sessions[0]!.json().session}` } });
  expect(response.json().request).toMatchObject({ mine: true, author: '검수자' });
});

it('동시에 같은 등록을 재전송해도 번호와 요청이 하나만 생긴다', async () => {
  const f = await fixture();
  const payload = { ...f.payload, mutationId: randomBytes(16).toString('hex'), screenshot: await pngDataUrl(80, 80) };
  const result = await Promise.all(Array.from({ length: 3 }, () => t.app.inject({ method: 'POST', url: '/api/w/requests', headers: f.widget, payload })));
  for (const r of result) expect(r.statusCode, r.body).toBe(200);
  expect(new Set(result.map((r) => r.json().request.id)).size).toBe(1);
  expect((await t.sql`select request_seq from sites where id = ${f.site.id}`)[0]!.request_seq).toBe(2);
  expect((await t.sql`select count(*)::int as n from requests where site_id = ${f.site.id}`)[0]!.n).toBe(2);
  const retry = await t.app.inject({ method: 'POST', url: '/api/w/requests', headers: f.widget, payload });
  expect(retry.json().request.id).toBe(result[0]!.json().request.id);
});

it('위젯과 관리 화면의 댓글은 재전송 시 중복되지 않고 새로운 같은 내용은 허용한다', async () => {
  const f = await fixture();
  for (const [prefix, headers] of [['/api/requests/', admin], ['/api/w/requests/', f.widget]] as const) {
    const payload = { body: prefix, mutationId: randomBytes(16).toString('hex') };
    const results = await Promise.all(Array.from({ length: 3 }, () => t.app.inject({ method: 'POST', url: `${prefix}${f.id}/comments`, headers, payload })));
    for (const r of results) expect(r.statusCode, r.body).toBe(200);
    expect((await t.sql`select count(*)::int as n from comments where request_id = ${f.id} and body = ${prefix}`)[0]!.n).toBe(1);
    await t.app.inject({ method: 'POST', url: `${prefix}${f.id}/comments`, headers, payload: { ...payload, mutationId: randomBytes(16).toString('hex') } });
    expect((await t.sql`select count(*)::int as n from comments where request_id = ${f.id} and body = ${prefix}`)[0]!.n).toBe(2);
  }
});

// 행 잠금 뒤에 두 실제 HTTP 요청을 대기시켜, 우연한 실행 타이밍에 의존하지 않고 경합을 만든다.
async function overlap(id: string, actions: (() => PromiseLike<{ statusCode: number; body: string }>)[]) {
  let release!: () => void;
  let locked!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const ready = new Promise<void>((r) => { locked = r; });
  const holder = t.sql.begin(async (tx) => { await tx`select id from requests where id = ${id} for update`; locked(); await gate; });
  await ready;
  const pending = actions.map((action) => Promise.resolve(action()));
  try {
    let waiting = 0;
    for (let i = 0; i < 200; i++) {
      const [row] = await t.sql`select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`;
      waiting = row!.n;
      if (waiting >= actions.length) break;
      await delay(10);
    }
    expect(waiting).toBeGreaterThanOrEqual(actions.length);
  } finally { release(); await holder; }
  for (const result of await Promise.all(pending)) expect(result.statusCode, result.body).toBe(200);
}

it('위젯에서 내용 수정과 해결을 동시에 해도 둘 다 남는다', async () => {
  const f = await fixture();
  await overlap(f.id, [{ body: '수정된 내용' }, { status: '완료' }].map((payload) => () => t.app.inject({ method: 'PATCH', url: `/api/w/requests/${f.id}`, headers: f.widget, payload })));
  const row = (await t.sql`select body, status, resolved_at from requests where id = ${f.id}`)[0]!;
  expect(row.body).toBe('수정된 내용'); expect(row.status).toBe('완료'); expect(row.resolved_at).not.toBeNull();
});

it('담당자와 위젯이 동시에 수정해도 해결 상태와 담당자가 모두 남는다', async () => {
  const f = await fixture();
  await overlap(f.id, [
    () => t.app.inject({ method: 'PATCH', url: `/api/requests/${f.id}`, headers: admin, payload: { assignee1: '개발팀' } }),
    () => t.app.inject({ method: 'PATCH', url: `/api/w/requests/${f.id}`, headers: f.widget, payload: { status: '완료' } }),
  ]);
  const row = (await t.sql`select assignee1, status from requests where id = ${f.id}`)[0]!;
  expect(row.assignee1).toBe('개발팀'); expect(row.status).toBe('완료');
});

it('관리 화면 두 곳에서 다른 항목을 동시에 고쳐도 서로 덮어쓰지 않는다', async () => {
  const f = await fixture();
  await overlap(f.id, [{ assignee1: '담당 A' }, { resolutionNote: '수정 확인' }].map((payload) => () => t.app.inject({ method: 'PATCH', url: `/api/requests/${f.id}`, headers: admin, payload })));
  const row = (await t.sql`select assignee1, resolution_note from requests where id = ${f.id}`)[0]!;
  expect(row.assignee1).toBe('담당 A'); expect(row.resolution_note).toBe('수정 확인');
});

it('동시에 같은 상태로 바꾸면 상태 기록은 한 번만 남는다', async () => {
  const f = await fixture();
  await overlap(f.id, ['/api/requests/', '/api/w/requests/'].map((prefix) => () => t.app.inject({ method: 'PATCH', url: prefix + f.id, headers: prefix.includes('/w/') ? f.widget : admin, payload: { status: '완료' } })));
  const rows = await t.sql`select id from comments where request_id = ${f.id} and author_type = 'system'`;
  expect(rows).toHaveLength(1);
});

it('댓글 등록과 상태 변경이 동시에 대기해도 교착 없이 모두 저장된다', async () => {
  const f = await fixture();
  await overlap(f.id, [
    () => t.app.inject({ method: 'POST', url: `/api/requests/${f.id}/comments`, headers: admin, payload: { body: '담당자 동시 답글' } }),
    () => t.app.inject({ method: 'POST', url: `/api/w/requests/${f.id}/comments`, headers: f.widget, payload: { body: '검수자 동시 답글' } }),
    () => t.app.inject({ method: 'PATCH', url: `/api/w/requests/${f.id}`, headers: f.widget, payload: { status: '완료' } }),
  ]);
  expect((await t.sql`select count(*)::int as n from comments where request_id = ${f.id}`)[0]!.n).toBe(3);
  expect((await t.sql`select status from requests where id = ${f.id}`)[0]!.status).toBe('완료');
});

it('300개를 넘은 대화는 최신 댓글을 보여 주고 이전 대화도 빠짐없이 읽는다', async () => {
  const f = await fixture();
  await t.sql`insert into comments (request_id, author_type, author_name, body, created_at)
    select ${f.id}, 'agency', '담당자', '댓글 ' || n, now() + n * interval '1 microsecond' from generate_series(1, 305) as n`;
  for (const [prefix, headers] of [['/api/requests/', admin], ['/api/w/requests/', f.widget]] as const) {
    const result = (await t.app.inject({ method: 'GET', url: prefix + f.id, headers })).json().request;
    expect(result.comments).toHaveLength(300);
    expect(result.comments.at(-1).body).toBe('댓글 305');
    expect(result.commentsBefore).toBe(result.comments[0].id);
    const older = await t.app.inject({ method: 'GET', url: `${prefix}${f.id}/comments?before=${result.commentsBefore}`, headers });
    expect(older.statusCode).toBe(200);
    expect(older.json().comments.map((c: { body: string }) => c.body)).toEqual(['댓글 1', '댓글 2', '댓글 3', '댓글 4', '댓글 5']);
    expect(older.json().commentsBefore).toBeNull();
  }
});

it('프로젝트를 종료하면 이미 열린 위젯의 읽기·쓰기도 즉시 중단된다', async () => {
  const f = await fixture();
  await t.app.inject({ method: 'PATCH', url: `/api/sites/${f.site.id}`, headers: admin, payload: { status: 'done' } });
  expect((await t.app.inject({ method: 'GET', url: '/api/w/requests', headers: f.widget })).statusCode).toBe(404);
  expect((await t.app.inject({ method: 'POST', url: '/api/w/requests', headers: f.widget, payload: f.payload })).statusCode).toBe(404);
});

it('이름을 바꾸면 변경 없음 응답 때문에 보드에 옛 이름이 남지 않는다', async () => {
  const f = await fixture();
  const prev = (await t.app.inject({ method: 'GET', url: '/api/w/requests', headers: f.widget })).json();
  await t.app.inject({ method: 'PATCH', url: '/api/w/reviewer', headers: f.widget, payload: { name: '새 이름' } });
  const next = (await t.app.inject({ method: 'GET', url: `/api/w/requests?v=${encodeURIComponent(prev.version)}`, headers: f.widget })).json();
  expect(next.unchanged).not.toBe(true);
  expect(next.requests[0].author).toBe('새 이름');
});

it('캡처 원본 저장 뒤 썸네일 저장이 실패하면 원본도 정리한다', async () => {
  const f = await fixture();
  const original = t.ctx.storage;
  const keys = new Set<string>();
  t.ctx.storage = { ...original, get: original.get.bind(original), read: original.read.bind(original),
    put: async (key) => { if (key.includes('-thumb.')) throw new Error('disk full'); keys.add(key); },
    delete: async (key) => { keys.delete(key); },
  };
  try {
    const res = await t.app.inject({ method: 'POST', url: '/api/w/requests', headers: f.widget, payload: { ...f.payload, screenshot: await pngDataUrl(100, 100) } });
    expect(res.statusCode).toBe(500); expect(keys.size).toBe(0);
  } finally { t.ctx.storage = original; }
});

it('같은 밀리초 안의 변경도 목록 갱신에서 놓치지 않는다', async () => {
  const f = await fixture();
  await t.sql`update requests set updated_at = '2026-01-01 00:00:00.000100+00' where id = ${f.id}`;
  const prev = (await t.app.inject({ method: 'GET', url: '/api/w/requests', headers: f.widget })).json();
  await t.sql`update requests set body = '빠른 변경', updated_at = '2026-01-01 00:00:00.000200+00' where id = ${f.id}`;
  const next = (await t.app.inject({ method: 'GET', url: `/api/w/requests?v=${prev.version}`, headers: f.widget })).json();
  expect(next.requests[0].body).toBe('빠른 변경');
});

it('이전 대화 API에도 프로젝트 접근 권한을 적용한다', async () => {
  const own = await fixture(); const other = await fixture();
  const res = await t.app.inject({ method: 'GET', url: `/api/w/requests/${other.id}/comments`, headers: own.widget });
  expect(res.statusCode).toBe(404);
  const anonymous = await t.app.inject({ method: 'GET', url: `/api/requests/${own.id}/comments`, headers: HOST });
  expect(anonymous.statusCode).toBe(401);
  const invalid = await t.app.inject({ method: 'GET', url: `/api/w/requests/${own.id}/comments?before=invalid`, headers: own.widget });
  expect(invalid.statusCode).toBe(400);
});

it('501번째 이후의 핀도 다음 목록에서 조회하고, 엑셀은 일부만 조용히 내보내지 않는다', async () => {
  const f = await fixture();
  await t.sql`insert into requests (site_id, round_id, no, reviewer_name, page_url, body)
    select site_id, round_id, n, reviewer_name, page_url, '추가 ' || n from requests cross join generate_series(2, 505) as n where id = ${f.id}`;
  const first = (await t.app.inject({ method: 'GET', url: '/api/w/requests', headers: f.widget })).json();
  expect(first.requests).toHaveLength(500); expect(first.nextBefore).toBe(6);
  const second = (await t.app.inject({ method: 'GET', url: `/api/w/requests?before=${first.nextBefore}&v=${first.version}`, headers: f.widget })).json();
  expect(second.requests).toHaveLength(5); expect(second.requests.at(-1).id).toBe(f.id); expect(second.nextBefore).toBeNull();
  const exportResult = await t.app.inject({ method: 'GET', url: `/api/sites/${f.site.id}/export.xlsx`, headers: admin });
  expect(exportResult.statusCode).toBe(400); expect(exportResult.json().error.code).toBe('export_limit');
});
