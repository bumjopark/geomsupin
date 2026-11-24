import { useLocale } from '../locale.tsx';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, ApiError, fullTime, pathOf, relTime } from '../api.ts';
import { Avatar, Icon, Spinner, StatusPill, useDebounced, useToast } from '../ui.tsx';
import { InviteCard } from './Share.tsx';
import type { Comment, ListResponse, Req, Site } from '../types.ts';
import { KINDS, PRIORITIES, STATUSES } from '../../../shared/constants.ts';
import { mergeComments } from '../../../shared/comments.ts';
import { pendingMutation } from '../../../shared/network.ts';

export function RequestsPage({ site }: { site: Site }) {
  const { locale, t } = useLocale();
  const toast = useToast();
  const [sp, setSp] = useSearchParams();
  const status = sp.get('status') ?? '';
  const page = sp.get('page') ?? '';
  const assignee = sp.get('assignee') ?? '';
  const round = sp.get('round') ?? '';
  const openId = sp.get('r') ?? '';
  const [q, setQ] = useState(sp.get('q') ?? '');
  const dq = useDebounced(q, 300);
  const [data, setData] = useState<ListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const loadSeq = useRef(0);
  const pageSize = 100;
  const offset = Math.max(0, Number(sp.get('offset')) || 0);

  const set = useCallback((patch: Record<string, string | null>) => {
    setSp((prev) => {
      const n = new URLSearchParams(prev);
      if (Object.keys(patch).some((key) => key !== 'r' && key !== 'offset')) n.delete('offset');
      for (const [k, v] of Object.entries(patch)) { if (v) n.set(k, v); else n.delete(k); }
      return n;
    }, { replace: true });
  }, [setSp]);

  useEffect(() => { if ((sp.get('q') ?? '') !== dq) set({ q: dq || null }); }, [dq]); // eslint-disable-line react-hooks/exhaustive-deps

  const query = useMemo(() => {
    const p = new URLSearchParams();
    if (status) p.set('status', status);
    if (page) p.set('page', page);
    if (assignee) p.set('assignee', assignee);
    if (round) p.set('round', round);
    if (dq) p.set('q', dq);
    p.set('limit', String(pageSize));
    p.set('offset', String(offset));
    return p.toString();
  }, [status, page, assignee, round, dq, offset]);

  const load = useCallback(async (silent = false) => {
    const seq = ++loadSeq.current;
    if (!silent) setLoading(true);
    try {
      const next = await api<ListResponse>(`/api/sites/${site.id}/requests?${query}`);
      if (seq !== loadSeq.current) return;
      setData(next); setLoadError('');
    } catch (e) {
      if (seq === loadSeq.current) setLoadError(e instanceof ApiError ? e.message : t("요청을 불러오지 못했어요"));
    } finally { if (seq === loadSeq.current) setLoading(false); }
  }, [site.id, query]);
  useEffect(() => { void load(); return () => { loadSeq.current++; }; }, [load]);
  // 함께 보는 사람들이 새 요청·댓글을 남기면 자동으로 보이게 (탭이 보일 때만 6초마다)
  useEffect(() => {
    const t = window.setInterval(() => { if (!document.hidden) void load(true); }, 6_000);
    return () => window.clearInterval(t);
  }, [load, openId]);

  async function patch(r: Req, body: Record<string, string>) {
    loadSeq.current++;
    try {
      await api(`/api/requests/${r.id}`, { method: 'PATCH', body });
      setData((current) => current && { ...current, requests: current.requests.map((row) => row.id === r.id ? { ...row, ...body } as Req : row) });
      void load(true);
      return true;
    } catch (e) {
      toast(e instanceof ApiError ? e.message : t("저장하지 못했어요"), true);
      return false;
    }
  }

  const counts = data?.counts ?? {};
  const totalAll = Object.values(counts).reduce((a, b) => a + b, 0);
  const statusList = status ? status.split(',') : [];
  const toggleStatus = (s: string) => {
    const has = statusList.includes(s);
    const next = has ? statusList.filter((x) => x !== s) : [...statusList, s];
    set({ status: next.join(',') || null });
  };
  const exportHref = `/api/sites/${site.id}/export.xlsx?${query}${locale === 'en' ? '&lang=en' : ''}`;

  if (!data && !loadError) return <Spinner />;
  if (!data) return <div className="callout" role="alert">{t(loadError)} <button className="btn sm" onClick={() => void load()}>{t("다시 시도")}</button></div>;

  return (
    <div className="stack">
      {loadError && <div className="callout" role="alert">{t(loadError)} <button className="btn sm" onClick={() => void load()}>{t("다시 시도")}</button></div>}
      <div className="request-toolbar">
        <h2>{t("요청 목록")}</h2>
        <div className="filters" role="group" aria-label={t("요청 필터")}>
          <div className="status-filters" role="group" aria-label={t("처리 상태")}>
            <button className="chip" aria-pressed={!status} onClick={() => set({ status: null })}>{t("전체")} <span className="n">{totalAll}</span></button>
            {STATUSES.filter((s) => s !== '재발생' || (counts[s] ?? 0) > 0).map((s) => (
              <button key={s} className="chip" aria-pressed={statusList.includes(s)} onClick={() => toggleStatus(s)}>{t(s)} <span className="n">{counts[s] ?? 0}</span></button>
            ))}
          </div>
          <div className="request-filters">
            <select className="select" value={page} onChange={(e) => set({ page: e.target.value || null })} aria-label={t("페이지 필터")}>
              <option value="">{t("모든 페이지")}</option>
              {data.pages.map((p) => <option key={p.url} value={p.url}>{pathOf(p.url)} ({p.count})</option>)}
            </select>
            <select className="select" value={assignee} onChange={(e) => set({ assignee: e.target.value || null })} aria-label={t("담당 필터")}>
              <option value="">{t("모든 담당")}</option>
              {data.assignees.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
            {data.rounds.length > 1 && (
              <select className="select" value={round} onChange={(e) => set({ round: e.target.value || null })} aria-label={t("차수 필터")}>
                <option value="">{t("모든 차수")}</option>
                {data.rounds.map((r) => <option key={r.no} value={r.no}>{locale === 'en' ? `Round ${r.no}` : `${r.no}차`}</option>)}
              </select>
            )}
            <input className="input" type="search" aria-label={t("내용·등록자 검색")} placeholder={t("내용·등록자 검색")} value={q} onChange={(e) => setQ(e.target.value)} />
            {data.total > 500
              ? <span className="muted small">{t("엑셀은 한 번에 500건까지 받아요. 필터로 나눠 주세요.")}</span>
              : <a className={`btn${data.total ? '' : ' hide'}`} href={exportHref} download title={t("정렬 가능한 요청 목록과 캡처 시트를 함께 받아요. 캡처 보기 링크를 누르면 해당 그림으로 이동해요.")}><Icon name="download" /> {t("엑셀로 받기 (")}{data.total})</a>}
          </div>
        </div>
      </div>

      {totalAll === 0 ? (
        <div className="stack request-empty-grid">
          <div className="card empty">
            <span className="section-mark"><Icon name="message" /></span>
            <h2>{t("아직 들어온 요청이 없어요")}</h2>
            <p className="muted">{t("참여자가 사이트에서 남긴 핀이 여기에 표시됩니다.")}</p>
          </div>
          <InviteCard site={site} />
        </div>
      ) : data.requests.length === 0 ? (
        <div className="card empty"><h2>{t("조건에 맞는 요청이 없어요")}</h2><p className="muted">{t("필터를 바꾸거나")} <button className="btn sm" onClick={() => { setQ(''); setSp({}, { replace: true }); }}>{t("초기화")}</button></p></div>
      ) : (
        <div className="card tablewrap" role="region" aria-label={t("요청 표")} tabIndex={0} style={{ opacity: loading ? 0.6 : 1 }}>
          <table className="tbl">
            <thead>
              <tr><th>#</th><th>{t("캡처")}</th><th>{t("요청 내용")}</th><th>{t("우선순위")}</th><th>{t("1차 담당")}</th><th>{t("상태")}</th><th>{t("남긴 사람")}</th></tr>
            </thead>
            <tbody>
              {data.requests.map((r) => (
                <tr key={r.id} className={`click${r.id === openId ? ' sel' : ''}`} onClick={() => set({ r: r.id })}>
                  <td className="no">{r.no}</td>
                  <td>{r.thumbUrl ? <img className="thumb" src={r.thumbUrl} alt="" loading="lazy" /> : <div className="thumb none">{t("캡처 없음")}</div>}</td>
                  <td className="body-cell">
                    <button type="button" className="request-open" onClick={(event) => { event.stopPropagation(); set({ r: r.id }); }}><span className="txt">{r.body}</span></button>
                    <div className="meta">
                      {r.commentCount > 0 && <span className="mini" aria-label={locale === 'en' ? `Comments: ${r.commentCount}` : `댓글 ${r.commentCount}개`} title={t("댓글")}><Icon name="message" /> {r.commentCount}</span>}
                      <span className="tag">{t(r.kind)}</span>
                      {data.rounds.length > 1 && <span className="tag">{locale === 'en' ? `Round ${r.roundNo}` : `${r.roundNo}차`}</span>}
                      <span title={r.pageUrl}>{pathOf(r.pageUrl)}</span>
                      <span>{r.browser}{r.os ? ` · ${r.os}` : ''}{r.viewportW ? ` · ${r.viewportW}px` : ''}</span>
                      {!!(r.captureNotes.images || r.captureNotes.iframes) && <span className="tag warn" title={t("다른 도메인 이미지·프레임은 화면 캡처에 담기지 않을 수 있어요")}>{t("캡처 일부 누락")}</span>}
                    </div>
                  </td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <select className={`select st-sel pri-${r.priority}`} style={{ borderRadius: 8, minWidth: locale === 'en' ? 105 : 84 }} value={r.priority} onChange={(e) => void patch(r, { priority: e.target.value })} aria-label={t("우선순위")}>
                      {PRIORITIES.map((p) => <option key={p} value={p}>{t(p)}</option>)}
                    </select>
                  </td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <AssigneeInput value={r.assignee1} onSave={(v) => patch(r, { assignee1: v })} />
                  </td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <select className={`select st-sel st-${r.status}`} value={r.status} onChange={(e) => void patch(r, { status: e.target.value })} aria-label={t("상태")}>
                      {STATUSES.filter((s) => s !== '재발생' || r.status === '재발생').map((s) => <option key={s} value={s}>{t(s)}</option>)}
                    </select>
                  </td>
                  <td className="small"><div className="who-cell"><Avatar name={r.reviewerName || '?'} size="sm" /><div><div>{r.reviewerName}</div><div className="muted" title={fullTime(r.createdAt, locale)}>{relTime(r.createdAt, locale)}</div></div></div></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {(data.total > pageSize || offset > 0) && <nav className="row" aria-label={t("요청 목록 페이지")}>
        <button className="btn sm" disabled={offset === 0 || loading} onClick={() => set({ offset: String(Math.max(0, offset - pageSize)) })}>{t("이전")}</button>
        <span className="muted">{data.requests.length ? offset + 1 : 0}–{offset + data.requests.length} / {data.total}{t("건")}</span>
        <button className="btn sm" disabled={offset + pageSize >= data.total || loading} onClick={() => set({ offset: String(offset + pageSize) })}>{t("다음")}</button>
      </nav>}
      {openId && <Detail key={openId} id={openId} onClose={() => set({ r: null })} onChanged={() => void load(true)} />}
    </div>
  );
}

function AssigneeInput({ value, onSave }: { value: string; onSave: (v: string) => Promise<boolean> }) {
  const { t } = useLocale();
  const [draft, setDraft] = useState<string | null>(null);
  const v = draft ?? value;
  return (
    <input
      className="input inline"
      value={v}
      maxLength={40}
      placeholder={t("담당")}
      aria-label={t("1차 담당")}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={async () => {
        if (v.trim() !== value && !(await onSave(v.trim()))) return;
        setDraft((current) => current === v ? null : current);
      }}
      onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) (e.target as HTMLInputElement).blur(); }}
    />
  );
}

function Detail({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const { locale, t } = useLocale();
  const replyMutation = useRef(pendingMutation());
  const toast = useToast();
  const [r, setR] = useState<Req | null>(null);
  const [noteDraft, setNote] = useState<string | null>(null);
  const [a1Draft, setA1] = useState<string | null>(null);
  const [a2Draft, setA2] = useState<string | null>(null);
  const note = noteDraft ?? r?.resolutionNote ?? '';
  const a1 = a1Draft ?? r?.assignee1 ?? '';
  const a2 = a2Draft ?? r?.assignee2 ?? '';
  const [zoom, setZoom] = useState(false);
  const [reply, setReply] = useState('');
  const [sending, setSending] = useState(false);
  const [olderLoading, setOlderLoading] = useState(false);
  const olderLoaded = useRef(false);
  const alive = useRef(true);
  const requestSeq = useRef(0);
  const writes = useRef(0);
  const drawer = useRef<HTMLDialogElement>(null);
  const imageDialog = useRef<HTMLDialogElement>(null);

  function receive(next: Req) {
    if (!alive.current) return;
    setR((cur) => {
      if (cur && next.updatedAt < cur.updatedAt) return cur;
      return cur && olderLoaded.current ? { ...next, comments: mergeComments(cur.comments ?? [], next.comments ?? []), commentsBefore: cur.commentsBefore } : next;
    });
  }

  async function loadOlder() {
    if (!r?.commentsBefore || olderLoading) return;
    setOlderLoading(true);
    try {
      const page = await api<{ comments: Comment[]; commentsBefore: string | null }>(`/api/requests/${id}/comments?before=${r.commentsBefore}`);
      if (!alive.current) return;
      olderLoaded.current = true;
      setR((cur) => cur && { ...cur, comments: mergeComments(page.comments, cur.comments ?? []), commentsBefore: page.commentsBefore });
    } catch (e) { if (alive.current) toast(e instanceof ApiError ? e.message : t("이전 대화를 불러오지 못했어요"), true); }
    finally { if (alive.current) setOlderLoading(false); }
  }

  // 열어 둔 동안 댓글이 새로 달리면 조용히 갱신한다
  useEffect(() => {
    const t = window.setInterval(() => {
      if (document.hidden || writes.current) return;
      const seq = ++requestSeq.current;
      api<{ request: Req }>(`/api/requests/${id}`).then((x) => { if (seq === requestSeq.current) receive(x.request); }, () => {});
    }, 6_000);
    return () => window.clearInterval(t);
  }, [id]);

  async function sendReply() {
    const submitted = reply;
    const body = reply.trim();
    if (!body || sending) return;
    setSending(true);
    requestSeq.current++; writes.current++;
    try {
      const x = await api<{ request: Req }>(`/api/requests/${id}/comments`, { method: 'POST', body: replyMutation.current.body({ body }) });
      replyMutation.current.done();
      if (!alive.current) return;
      receive(x.request);
      setReply((current) => current === submitted ? '' : current);
      onChanged();
    } catch (e) { if (alive.current) toast(e instanceof ApiError ? e.message : t("댓글을 남기지 못했어요"), true); } finally { writes.current--; if (alive.current) setSending(false); }
  }

  useEffect(() => {
    alive.current = true;
    const seq = ++requestSeq.current;
    setR(null);
    api<{ request: Req }>(`/api/requests/${id}`).then((x) => {
      if (seq === requestSeq.current) receive(x.request);
    }).catch(() => { if (alive.current) { toast(t("요청을 불러오지 못했어요"), true); onClose(); } });
    return () => { alive.current = false; requestSeq.current++; };
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const dialog = drawer.current;
    dialog?.showModal();
    return () => { dialog?.close(); };
  }, []);

  useEffect(() => {
    if (!zoom) return;
    const dialog = imageDialog.current;
    dialog?.showModal();
    return () => { dialog?.close(); };
  }, [zoom]);

  function closeDrawer() {
    drawer.current?.close();
    onClose();
  }

  function closeZoom() {
    imageDialog.current?.close();
    setZoom(false);
  }

  async function save(body: Record<string, string>) {
    requestSeq.current++; writes.current++;
    try {
      const x = await api<{ request: Req }>(`/api/requests/${id}`, { method: 'PATCH', body });
      if (!alive.current) return;
      receive(x.request);
      if (body.assignee1 !== undefined) setA1((v) => v?.trim() === body.assignee1 ? null : v);
      if (body.assignee2 !== undefined) setA2((v) => v?.trim() === body.assignee2 ? null : v);
      if (body.resolutionNote !== undefined) setNote((v) => v === body.resolutionNote ? null : v);
      onChanged();
      toast(t("저장했어요"));
    } catch (e) { if (alive.current) toast(e instanceof ApiError ? e.message : t("저장하지 못했어요"), true); }
    finally { writes.current--; }
  }

  async function remove() {
    if (!window.confirm(t("이 요청을 삭제할까요? 캡처도 함께 지워지고 되돌릴 수 없어요."))) return;
    try { await api(`/api/requests/${id}`, { method: 'DELETE' }); toast(t("삭제했어요")); onChanged(); closeDrawer(); } catch { toast(t("삭제하지 못했어요"), true); }
  }

  return (
    <>
      <dialog className="drawer" ref={drawer} aria-label={t("요청 상세")}
        onCancel={event => { event.preventDefault(); closeDrawer(); }}
        onClick={event => { if (event.target === event.currentTarget) closeDrawer(); }}>
        <div className="drawer-head">
          {r ? <><h2>{t("요청 #")}{r.no}</h2><StatusPill status={r.status} /><span className="muted small drawer-time">{locale === 'en' ? `Round ${r.roundNo}` : `${r.roundNo}차`} · {fullTime(r.createdAt, locale)}</span></> : <span className="muted">{t("불러오는 중…")}</span>}
          <div className="grow" />
          <button className="btn sm" onClick={closeDrawer}><Icon name="close" /> {t("닫기 (Esc)")}</button>
        </div>
        {!r ? <Spinner /> : (
          <div className="drawer-body">
            <div className="left drawer-capture">
              <h3>{t("화면 캡처")}</h3>
              {r.screenshotUrl ? (
                <>
                  <button className="shot-open" type="button" aria-label={t("요청 당시 화면 캡처 확대")} onClick={() => setZoom(true)}><img className="shot" src={r.screenshotUrl} alt={t("요청 당시 화면 캡처")} /></button>
                  <div className="row between small muted" style={{ marginTop: 8 }}>
                    <span>{t("요청 당시 화면 (빨간 점선 = 클릭한 요소, 핀 = 클릭 위치)")}</span>
                    <a href={r.screenshotUrl} target="_blank" rel="noreferrer">{t("원본 열기")}</a>
                  </div>
                  {r.proposalUrl && (
                    <figure className="proposal-shot">
                      <figcaption>{t("위치 변경 제안")}</figcaption>
                      <a href={r.proposalUrl} target="_blank" rel="noreferrer"><img className="shot" src={r.proposalUrl} alt={t("제안된 위치의 화면 캡처")} /></a>
                    </figure>
                  )}
                  {!!(r.captureNotes.images || r.captureNotes.iframes) && (
                    <div className="callout" style={{ marginTop: 10 }}>
                      {locale === 'en'
                        ? <>The capture skipped {r.captureNotes.images ?? 0} external images and {r.captureNotes.iframes ?? 0} frames. Open the original page to see the hatched areas.</>
                        : <>다른 도메인 이미지 {r.captureNotes.images ?? 0}개, 프레임(광고·외부 위젯) {r.captureNotes.iframes ?? 0}개를 캡처하지 못했어요. 캡처 안의 <b>사선 무늬</b> 영역이 그 자리예요. 원래 페이지에서 직접 확인해 주세요.</>}
                     </div>
                  )}
                </>
              ) : (
                <div className="callout">{r.captureNotes.failed ? t("화면 캡처에 실패해 캡처 없이 저장된 요청이에요.") : t("캡처가 없는 요청이에요.")} {t("아래 ‘원래 페이지로 가기’로 위치를 확인해 주세요.")}</div>
              )}
            </div>
            <div className="stack drawer-content">
              <section className="drawer-section">
                <h3>{t("요청 내용")}</h3>
                <div className="reqtext">{r.body}</div>
                {(r.asIs || r.toBe) && (
                  <div className="stack" style={{ marginTop: 12, gap: 8 }}>
                    {r.asIs && <div className="quote"><b className="small">{t("지금 (AS-IS)")}</b><div className="reqtext" style={{ fontSize: 14 }}>{r.asIs}</div></div>}
                    {r.toBe && <div className="quote"><b className="small">{t("이렇게 (TO-BE)")}</b><div className="reqtext" style={{ fontSize: 14 }}>{r.toBe}</div></div>}
                  </div>
                )}
              </section>

              <section className="drawer-section">
                <h3>{t("진행 관리")}</h3>
                <div className="grid2">
                  <label className="field">{t("상태")} <select className="select" value={r.status} onChange={(e) => void save({ status: e.target.value })}>
                      {STATUSES.filter((s) => s !== '재발생' || r.status === '재발생').map((s) => <option key={s} value={s}>{t(s)}</option>)}
                    </select>
                  </label>
                  <label className="field">{t("우선순위")} <select className="select" value={r.priority} onChange={(e) => void save({ priority: e.target.value })}>{PRIORITIES.map((p) => <option key={p} value={p}>{t(p)}</option>)}</select>
                  </label>
                  <label className="field kind-field">{t("구분")}<small>{t("수정 / 추가(견적 근거) / 문의 / 버그")}</small>
                    <select className="select" value={r.kind} onChange={(e) => void save({ kind: e.target.value })}>{KINDS.map((p) => <option key={p} value={p}>{t(p)}</option>)}</select>
                  </label>
                  <label className="field">{t("1차 담당")}<input className="input" value={a1} maxLength={40} onChange={(e) => setA1(e.target.value)} onBlur={() => a1.trim() !== r.assignee1 && void save({ assignee1: a1.trim() })} /></label>
                  <label className="field">{t("2차 담당")}<input className="input" value={a2} maxLength={40} onChange={(e) => setA2(e.target.value)} onBlur={() => a2.trim() !== r.assignee2 && void save({ assignee2: a2.trim() })} /></label>
                </div>

                <label className="field">{t("처리 메모")}<small>{t("참여자에게 표시되며 엑셀에도 포함돼요.")}</small>
                  <textarea className="textarea" value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} onBlur={() => note !== r.resolutionNote && void save({ resolutionNote: note })} />
                </label>
                {r.resolvedAt && <div className="ok">{t("처리일")} {fullTime(r.resolvedAt, locale)}</div>}
              </section>

              <section className="drawer-section">
                <h3>{t("대화")}</h3>
                <div className="thread">
                  {r.commentsBefore && <button className="btn sm" disabled={olderLoading} onClick={() => void loadOlder()}>{t("이전 대화 보기")}</button>}
                  {(r.comments ?? []).length === 0 && <div className="muted small">{t("아직 댓글이 없어요. 함께 보는 분들과 여기서 바로 이야기할 수 있어요.")}</div>}
                  {(r.comments ?? []).map((c) => c.type === 'system' ? (
                    <div key={c.id} className="sys">{locale === 'en' ? c.author.replace(/\(담당자\)$/, ' (manager)').replace(/^설치 관리자(?= \(manager\)$|$)/, 'Administrator') : c.author}{locale === 'en' ? ' ' : ' 님이 '}{t(c.body)} · {relTime(c.createdAt, locale)}</div>
                  ) : (
                    <div key={c.id} className={`cm ${c.type}`}>
                      <Avatar name={c.author} size="sm" />
                      <div className="bub">
                        <div className="who"><b>{c.type === 'agency' && c.author === '설치 관리자' ? t(c.author) : c.author}</b>{c.type === 'agency' && <span className="badge agency">{t("담당자")}</span>}<span className="muted">{relTime(c.createdAt, locale)}</span></div>
                        <div className="txt">{c.body}</div>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="replybox">
                  <textarea className="textarea" rows={1} placeholder={t("담당자로 댓글 남기기")} value={reply} maxLength={1000} onChange={(e) => setReply(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void sendReply(); } }} aria-label={t("댓글")} />
                  <button className="btn primary" disabled={sending || !reply.trim()} onClick={() => void sendReply()}>{t("보내기")}</button>
                </div>
              </section>

              <dl className="kv">
                <dt>{t("남긴 사람")}</dt><dd>{r.reviewerName}</dd>
                {r.updatedBy && <><dt>{t("마지막 변경")}</dt><dd>{r.updatedBy} · {relTime(r.updatedAt, locale)}</dd></>}
                <dt>{t("페이지")}</dt><dd><a href={r.pageUrl} target="_blank" rel="noreferrer">{t("원래 페이지로 가기 ↗")}</a><div className="muted small" style={{ wordBreak: 'break-all' }}>{r.pageTitle && <>{r.pageTitle} · </>}{r.pageUrl}</div></dd>
                <dt>{t("환경")}</dt><dd>{r.browser} · {r.os}{r.viewportW ? ` · ${r.viewportW}×${r.viewportH}` : ''}{r.dpr ? ` · ×${r.dpr}` : ''}</dd>
                <dt>{t("위치")}</dt><dd className="mono" style={{ wordBreak: 'break-all' }}>{r.selector || '—'}{r.textHint ? <div className="muted" style={{ fontFamily: 'inherit' }}>“{r.textHint}”</div> : null}</dd>
              </dl>

              <div className="row" style={{ justifyContent: 'flex-end' }}>
                <button className="btn danger sm" onClick={remove}>{t("요청 삭제")}</button>
              </div>
            </div>
          </div>
        )}
      </dialog>
      {zoom && r?.screenshotUrl && (
        <dialog ref={imageDialog} className="image-dialog" aria-label={t("캡처 원본")}
          onCancel={event => { event.preventDefault(); closeZoom(); }}
          onClick={event => { if (event.target === event.currentTarget) closeZoom(); }}>
          <button type="button" className="btn sm" onClick={closeZoom}><Icon name="close" /> {t("닫기")}</button>
          <img src={r.screenshotUrl} alt={t("캡처 원본")} />
        </dialog>
      )}
    </>
  );
}
