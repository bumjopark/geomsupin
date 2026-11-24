// 위젯 스타일: Shadow DOM 안에만 적용되므로 사이트 CSS 와 서로 간섭하지 않는다.
// 인라인 style 속성은 쓰지 않는다(엄격한 style-src 에서 막힌다). 값이 동적인 곳은 스크립트가 CSSOM 으로 넣는다.
export const CSS_TEXT = `
:host { all: initial; }
*, *::before, *::after { box-sizing: border-box; }
.root {
  --brand: #2f6bff; --brand-d: #1f55e0; --brand-soft: #eaf0ff; --ink: #1c2530; --muted: #6b7684; --line: #e6e9ee; --bg: #ffffff; --soft: #f5f7fa; --pin: #ff4d6a;
  --ok: #16a34a; --ok-soft: #e8f8ee; --warn: #d97706; --warn-soft: #fff4e0; --bad: #e11d48;
  position: fixed; inset: 0; pointer-events: none; z-index: 2147483000;
  font: 14px/1.5 'Pretendard', 'Apple SD Gothic Neo', 'Noto Sans KR', 'Malgun Gothic', system-ui, sans-serif; color: var(--ink);
  -webkit-text-size-adjust: 100%;
}
button { font: inherit; color: inherit; cursor: pointer; border: 0; background: none; padding: 0; }
input, textarea { font: inherit; color: inherit; }
.hide { display: none !important; }
.big { font-size: 34px; line-height: 1.2; margin-bottom: 6px; }

/* 하단 막대 */
.bar { position: fixed; bottom: 16px; left: 16px; display: flex; gap: 4px; align-items: center; padding: 5px; background: #fff; color: var(--ink); border: 1px solid var(--line); border-radius: 999px; box-shadow: 0 10px 30px rgba(20,30,50,.18), 0 2px 6px rgba(20,30,50,.08); pointer-events: auto; }
.bar.right { left: auto; right: 16px; }
.bar button.pill { position: relative; display: inline-flex; align-items: center; gap: 6px; height: 38px; padding: 0 15px; border-radius: 999px; font-weight: 700; white-space: nowrap; }
.bar button.primary { background: var(--brand); color: #fff; }
.bar button.primary:hover { background: var(--brand-d); }
.bar button.ghost:hover { background: var(--soft); }
.bar .count { min-width: 22px; height: 22px; padding: 0 7px; border-radius: 11px; background: var(--brand-soft); color: var(--brand-d); font-size: 12px; display: inline-grid; place-items: center; }
.bar .dot { position: absolute; top: 5px; right: 5px; width: 10px; height: 10px; border-radius: 50%; background: var(--pin); border: 2px solid #fff; }

@keyframes rise { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }

/* 핀 모드 */
.shield { position: fixed; inset: 0; cursor: crosshair; pointer-events: auto; background: transparent; touch-action: pan-x pan-y; }
.banner { position: fixed; top: 14px; left: 50%; transform: translateX(-50%); background: var(--ink); color: #fff; padding: 10px 14px 10px 18px; border-radius: 999px; box-shadow: 0 10px 28px rgba(0,0,0,.28); display: flex; gap: 12px; align-items: center; pointer-events: auto; max-width: calc(100vw - 24px); }
.banner b { color: #9db9ff; }
.banner button { padding: 5px 12px; border-radius: 999px; background: rgba(255,255,255,.16); white-space: nowrap; flex: none; }
.hilite { position: fixed; border: 2px solid var(--brand); background: rgba(47,107,255,.10); border-radius: 4px; pointer-events: none; display: none; }
.hilite .tag { position: absolute; left: -2px; top: -23px; background: var(--brand); color: #fff; font-size: 11px; padding: 1px 7px; border-radius: 6px; white-space: nowrap; max-width: 60vw; overflow: hidden; text-overflow: ellipsis; }

/* 핀 표시 */
.marker { position: fixed; width: 30px; height: 30px; margin: -15px 0 0 -15px; border-radius: 50% 50% 50% 4px; transform: rotate(-45deg); background: var(--pin); color: #fff; box-shadow: 0 4px 12px rgba(0,0,0,.32); border: 2px solid #fff; display: grid; place-items: center; pointer-events: auto; cursor: pointer; transition: transform .15s; }
.marker:hover { transform: rotate(-45deg) scale(1.12); z-index: 5; }
.marker span { transform: rotate(45deg); font-size: 12px; font-weight: 800; }
.marker.st-진행 { background: #f59e0b; }
.marker.st-완료 { background: var(--ok); opacity: .5; transform: rotate(-45deg) scale(.78); }
.marker.st-완료:hover, .marker.st-완료.sel { opacity: 1; transform: rotate(-45deg) scale(1.08); }
.marker[data-rc]::after { content: attr(data-rc); position: absolute; right: -15px; top: 6px; min-width: 17px; height: 17px; padding: 0 4px; border-radius: 9px; background: #fff; color: var(--ink); border: 1px solid var(--line); font-size: 10.5px; font-weight: 800; line-height: 15px; text-align: center; transform: rotate(45deg); box-shadow: 0 1px 4px rgba(0,0,0,.25); }
.marker.st-재발생 { background: #b4234b; }
.marker.st-보류 { background: #8b95a5; }
.marker.far { opacity: .6; }
.marker.sel { outline: 3px solid rgba(47,107,255,.5); outline-offset: 2px; }
.marker.pulse { animation: pulse 0.9s ease-out 2; }
@keyframes pulse { 0% { box-shadow: 0 0 0 0 rgba(47,107,255,.55); } 100% { box-shadow: 0 0 0 24px rgba(47,107,255,0); } }
.draft { position: fixed; width: 22px; height: 22px; margin: -11px 0 0 -11px; border-radius: 50%; background: var(--brand); border: 3px solid #fff; box-shadow: 0 3px 10px rgba(0,0,0,.4); pointer-events: none; }

/* 카드 공통 */
.card { background: var(--bg); border: 1px solid var(--line); border-radius: 20px; box-shadow: 0 18px 50px rgba(20,30,50,.26); pointer-events: auto; }
.card h3 { margin: 0; font-size: 16px; }
.muted { color: var(--muted); font-size: 12.5px; }
.err { color: #b91c1c; font-size: 12.5px; min-height: 0; }
.x { width: 30px; height: 30px; border-radius: 50%; color: var(--muted); font-size: 14px; display: inline-grid; place-items: center; }
.x:hover { background: var(--soft); color: var(--ink); }
.av { flex: none; width: 34px; height: 34px; border-radius: 50%; color: #fff; font-weight: 800; font-size: 14px; display: inline-grid; place-items: center; }
.av.sm { width: 24px; height: 24px; font-size: 11.5px; }

/* 입력 폼 */
.pop { position: fixed; width: 344px; max-width: calc(100vw - 16px); padding: 14px 16px 16px; }
.pop .head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 8px; }
.pop textarea, .editta, .compose textarea { width: 100%; resize: vertical; padding: 10px 12px; border: 1px solid var(--line); border-radius: 12px; background: #fff; outline: none; line-height: 1.5; }
.pop textarea { min-height: 84px; max-height: 40vh; }
.pop textarea:focus, .pop input:focus, .modal input:focus, .editta:focus, .compose textarea:focus { border-color: var(--brand); box-shadow: 0 0 0 3px rgba(47,107,255,.18); }
.pop .split { display: grid; gap: 8px; }
.pop .row { display: flex; gap: 6px; flex-wrap: wrap; margin: 8px 0; align-items: center; }
.namef { display: grid; gap: 4px; font-weight: 700; font-size: 13px; margin-bottom: 8px; }
.namef small { font-weight: 400; color: var(--muted); }
.pop input { height: 38px; padding: 0 12px; border: 1px solid var(--line); border-radius: 12px; outline: none; background: #fff; }
.chip { padding: 4px 11px; border-radius: 999px; border: 1px solid var(--line); background: #fff; font-size: 12.5px; white-space: nowrap; }
.chip:hover { background: var(--soft); }
.chip[aria-pressed="true"] { background: var(--brand); border-color: var(--brand); color: #fff; }
.link { color: var(--brand); font-size: 12.5px; font-weight: 600; }
.link:hover { text-decoration: underline; }
.actions { display: flex; gap: 8px; justify-content: flex-end; align-items: center; margin-top: 10px; }
.actions .muted { margin-right: auto; }
.btn { height: 38px; padding: 0 18px; border-radius: 12px; font-weight: 700; border: 1px solid var(--line); background: #fff; white-space: nowrap; }
.btn:hover { background: var(--soft); }
.btn.sm { height: 32px; padding: 0 12px; font-size: 13px; border-radius: 10px; }
.btn.primary { background: var(--brand); border-color: var(--brand); color: #fff; }
.btn.primary:hover { background: var(--brand-d); }
.btn.primary:disabled { opacity: .55; cursor: default; }
.btn.ok { background: var(--ok); border-color: var(--ok); color: #fff; }
.btn.ok:hover { background: #12873f; }
.btn.warn { background: var(--warn-soft); border-color: #f6d9a8; color: #92560a; }
.btn.danger { background: var(--bad); border-color: var(--bad); color: #fff; }
.thumb { display: flex; gap: 10px; align-items: center; padding: 8px; border-radius: 12px; background: var(--soft); margin-top: 6px; font-size: 12.5px; color: var(--muted); }
.thumb img { width: 84px; height: 52px; object-fit: cover; border-radius: 8px; border: 1px solid var(--line); background: #fff; }
.spin { width: 16px; height: 16px; border: 2px solid var(--line); border-top-color: var(--brand); border-radius: 50%; animation: spin 0.8s linear infinite; display: inline-block; flex: none; }
@keyframes spin { to { transform: rotate(360deg); } }

/* 모두의 요청(패널) */
.panel { position: fixed; left: 16px; bottom: 74px; width: 400px; max-width: calc(100vw - 24px); height: min(76vh, 600px); display: flex; flex-direction: column; overflow: hidden; animation: rise .22s ease-out; }
.panel.right { left: auto; right: 16px; }
.panel .top { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 12px 12px 8px 18px; }
.panel .tops { display: flex; gap: 6px; align-items: center; }
.tabs { display: flex; gap: 4px; padding: 0 12px 8px; border-bottom: 1px solid var(--line); }
.tabx { display: inline-flex; gap: 6px; align-items: center; padding: 6px 12px; border-radius: 999px; font-weight: 700; font-size: 13px; color: var(--muted); }
.tabx:hover { background: var(--soft); }
.tabx[aria-pressed="true"] { background: var(--brand-soft); color: var(--brand-d); }
.tabx .n { font-size: 11.5px; opacity: .8; }
.panel .list { overflow: auto; padding: 6px; flex: 1; min-height: 0; }
.panel .empty { padding: 44px 20px; text-align: center; color: var(--muted); }
.item { display: flex; gap: 10px; align-items: flex-start; width: 100%; text-align: left; padding: 10px; border-radius: 14px; }
.item:hover { background: var(--soft); }
.item .main { flex: 1; min-width: 0; display: grid; gap: 3px; }
.item .meta { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; font-size: 12px; color: var(--muted); }
.item .who { color: var(--ink); font-size: 13px; }
.item .body { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; word-break: break-word; }
.item .sub { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; font-size: 12px; color: var(--muted); }
.item .th { flex: none; width: 56px; height: 44px; object-fit: cover; border-radius: 8px; border: 1px solid var(--line); background: var(--soft); }
.no { font-weight: 800; color: var(--muted); font-size: 12px; }
.st { padding: 1px 9px; border-radius: 999px; font-size: 11.5px; font-weight: 700; background: #e5e7eb; color: #374151; white-space: nowrap; }
.st.접수 { background: #ffe8ec; color: #be123c; }
.st.진행 { background: var(--warn-soft); color: #92560a; }
.st.완료 { background: var(--ok-soft); color: #14703a; }
.st.재발생 { background: #fde2ea; color: #9d174d; }
.st.보류 { background: #eceef2; color: #4b5563; }
.tagx { padding: 1px 8px; border-radius: 8px; background: var(--soft); border: 1px solid var(--line); font-size: 11px; }
.foot { padding: 8px 16px; border-top: 1px solid var(--line); display: flex; justify-content: space-between; align-items: center; gap: 8px; }
.foot .me { display: inline-flex; gap: 8px; align-items: center; font-size: 12.5px; }

/* 대화(핀에 붙는 말풍선) */
.tpop { position: fixed; width: 344px; max-width: calc(100vw - 16px); max-height: min(72vh, 540px); display: flex; flex-direction: column; overflow: hidden; animation: rise .18s ease-out; }
.tpop.dock { left: auto; top: auto; right: 16px; bottom: 74px; }
.thead { display: flex; align-items: center; gap: 6px; padding: 9px 8px 9px 14px; border-bottom: 1px solid var(--line); }
.thead .status { margin-left: auto; padding: 0; background: none; border-radius: 0; display: flex; }
.thead .x { width: 28px; height: 28px; flex: none; }
.tmore { padding: 8px 14px 10px; border-bottom: 1px solid var(--line); background: var(--soft); display: grid; gap: 8px; }
.tmore .row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.tscroll { flex: 1; min-height: 0; overflow: auto; padding: 12px 14px; }
.newer { position: absolute; left: 50%; bottom: 62px; transform: translateX(-50%); padding: 4px 12px; border-radius: 999px; background: var(--brand); color: #fff; font-size: 12px; font-weight: 700; box-shadow: 0 4px 12px rgba(0,0,0,.25); }
.cm.first .cbub { flex: 1; background: #fff; border: 1px solid var(--line); border-radius: 4px 14px 14px 14px; }
.cm.first.mine .cbub { background: var(--brand-soft); border-color: transparent; }
.cm .cbub { overflow-wrap: anywhere; }
.hint0 { text-align: center; padding: 6px 0; }
.tpop .shot img { max-height: 140px; }
.dbody { white-space: pre-wrap; word-break: break-word; font-size: 15px; line-height: 1.6; padding: 2px 0 8px; }
.astobe { display: grid; gap: 6px; margin: 4px 0 8px; }
.astobe div { padding: 8px 10px; border-radius: 10px; background: var(--soft); white-space: pre-wrap; word-break: break-word; }
.astobe small { display: block; color: var(--muted); font-weight: 700; margin-bottom: 2px; }
.shot { display: block; border-radius: 12px; overflow: hidden; border: 1px solid var(--line); background: var(--soft); margin: 4px 0 8px; }
.shot img { display: block; width: 100%; max-height: 190px; object-fit: cover; object-position: top; }
.shotfail { padding: 14px; }
.move-fields { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; min-width: 0; padding: 8px; border: 1px solid var(--line); border-radius: 10px; }
.move-fields select { flex: 1 1 140px; min-width: 0; max-width: 100%; color: inherit; background: white; border: 1px solid var(--line); border-radius: 8px; padding: 6px; }
.move-result { width: 100%; color: var(--muted); font-size: 12px; }
.move-result:empty { display: none; }
.move-result img { max-height: 96px; object-fit: contain; }
.move-surface { cursor: grab; touch-action: none; }
.move-surface.dragging { cursor: grabbing; }
.move-banner { top: auto; bottom: 16px; }
.move-source, .move-destination, .move-ghost { position: absolute; pointer-events: none; border-radius: 6px; }
.move-source { outline: 2px dashed var(--brand); background: rgb(47 107 255 / 12%); }
.move-destination { outline: 3px solid var(--brand); }
.move-ghost { display: grid; place-items: center; background-color: #e1eaff; background-repeat: no-repeat; opacity: .85; box-shadow: 0 8px 18px #18213340; }
.shot-pair { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px; margin-top: 6px; }
.shot-pair figure { margin: 0; }
.shot-pair figcaption { color: var(--muted); font-size: 12px; }
.shot-pair .shot img { object-fit: contain; }
.shot-button { width: 100%; padding: 0; cursor: zoom-in; }
.shot-zoom .card { display: grid; justify-items: end; gap: 8px; max-width: 94vw; padding: 12px; }
.shot-zoom img { max-width: 100%; max-height: 78vh; object-fit: contain; }
.tagx.hint { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.status { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; padding: 10px; border-radius: 14px; background: var(--soft); }
.note { margin-top: 8px; padding: 8px 10px; border-radius: 10px; background: var(--brand-soft); font-size: 13px; }
.own { display: flex; gap: 14px; margin-top: 8px; }
.danger { margin-top: 8px; padding: 10px; border-radius: 12px; background: #fff1f3; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; font-size: 13px; }
.thread { display: grid; gap: 10px; }
.cm { display: flex; gap: 8px; align-items: flex-start; }
.cm .cbub { background: var(--soft); border-radius: 4px 14px 14px 14px; padding: 7px 11px; min-width: 0; max-width: calc(100% - 34px); }
.cm.mine .cbub { background: var(--brand-soft); }
.cm.agency .cbub { background: #fff4e0; }
.cwho { display: flex; gap: 6px; align-items: center; font-size: 12.5px; flex-wrap: wrap; }
.badge { padding: 0 7px; border-radius: 999px; background: var(--warn); color: #fff; font-size: 11px; font-weight: 700; }
.ctext { white-space: pre-wrap; word-break: break-word; }
.sys { text-align: center; font-size: 12px; color: var(--muted); display: flex; gap: 8px; justify-content: center; align-items: center; flex-wrap: wrap; }
.sys span { opacity: .7; }
.compose { display: flex; gap: 8px; align-items: flex-end; padding: 10px 12px; border-top: 1px solid var(--line); background: #fff; }
.compose textarea { resize: none; min-height: 38px; max-height: 110px; padding: 8px 12px; }

/* 안내창 */
.modal-wrap { position: fixed; inset: 0; z-index: 30; background: rgba(15,23,42,.45); display: grid; grid-template-columns: minmax(0, 1fr); place-items: center; pointer-events: auto; padding: 16px; overflow: auto; }
.modal { width: 380px; max-width: 100%; justify-self: center; padding: 24px; display: grid; gap: 12px; text-align: center; }
.modal h3 { font-size: 18px; }
.modal input { height: 40px; padding: 0 12px; border: 1px solid var(--line); border-radius: 12px; outline: none; background: #fff; width: 100%; }

.toast.act { pointer-events: auto; cursor: pointer; }
.toast.act:hover { background: #2b3748; }
.toast { z-index: 40; position: fixed; bottom: 76px; left: 50%; transform: translateX(-50%); background: var(--ink); color: #fff; padding: 11px 18px; border-radius: 999px; box-shadow: 0 10px 28px rgba(0,0,0,.3); pointer-events: none; max-width: calc(100vw - 24px); text-align: center; animation: fade .25s ease-out; }
@keyframes fade { from { opacity: 0; } to { opacity: 1; } }

@media (max-width: 560px) {
  .pop { left: 8px !important; right: 8px; bottom: 8px; top: auto !important; width: auto; max-width: none; }
  .panel { left: 8px; right: 8px; bottom: 70px; width: auto; max-width: none; height: min(78vh, 640px); }
  .tpop.dock { left: 8px; right: 8px; bottom: 70px; width: auto; max-width: none; }
  .toast { top: 16px; bottom: auto; }
  .bar, .bar.right { left: 50%; right: auto; transform: translateX(-50%); }
  .bar button.pill { padding: 0 12px; }
}
@media (prefers-reduced-motion: reduce) { .marker.pulse, .spin, .panel, .tpop, .toast { animation: none; } }
`;
