-- geomsupin 초기 스키마. 엑셀의 모든 열은 requests 한 행에서 나온다.

create table users (
  id            uuid primary key default gen_random_uuid(),
  email         text not null,
  name          text not null default '',
  password_hash text not null,
  created_at    timestamptz not null default now()
);
create unique index users_email_lower on users (lower(email));

create table workspaces (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  plan       text not null default 'free',
  created_at timestamptz not null default now()
);

create table members (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  user_id      uuid not null references users(id) on delete cascade,
  role         text not null default 'owner' check (role in ('owner', 'member')),
  created_at   timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

-- 에이전시 로그인 세션 (토큰은 sha256 해시만 저장)
create table sessions (
  id         text primary key,
  user_id    uuid not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  last_seen  timestamptz not null default now()
);
create index sessions_user on sessions (user_id);

create table sites (
  id               uuid primary key default gen_random_uuid(),
  workspace_id     uuid not null references workspaces(id) on delete cascade,
  name             text not null,
  -- 위젯이 허용되는 origin 목록 (예: https://staging.example.com)
  origins          text[] not null default '{}',
  staging_url      text not null default '',
  widget_key       text not null unique,
  is_demo          boolean not null default false,
  status           text not null default 'active' check (status in ('active', 'done')),
  request_seq      integer not null default 0,
  installed_at     timestamptz,
  last_seen_at     timestamptz,
  last_seen_origin text,
  created_at       timestamptz not null default now()
);
create index sites_workspace on sites (workspace_id, created_at desc);

create table rounds (
  id        uuid primary key default gen_random_uuid(),
  site_id   uuid not null references sites(id) on delete cascade,
  no        integer not null,
  status    text not null default 'open' check (status in ('open', 'closed')),
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  unique (site_id, no)
);

-- 고객에게 보내는 링크. 링크의 토큰은 URL 로 다뤄지는 공유 비밀이라 그대로 저장한다.
create table review_links (
  id            uuid primary key default gen_random_uuid(),
  site_id       uuid not null references sites(id) on delete cascade,
  token         text not null unique,
  label         text not null default '',
  password_hash text,
  expires_at    timestamptz,
  revoked_at    timestamptz,
  created_at    timestamptz not null default now()
);
create index review_links_site on review_links (site_id);

-- 가입 없는 고객
create table reviewers (
  id            uuid primary key default gen_random_uuid(),
  site_id       uuid not null references sites(id) on delete cascade,
  link_id       uuid references review_links(id) on delete set null,
  name          text not null,
  email         text,
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now()
);
create index reviewers_site on reviewers (site_id);

-- 위젯 세션 (고객 브라우저에 저장, 해시만 보관)
create table widget_sessions (
  id          text primary key,
  site_id     uuid not null references sites(id) on delete cascade,
  link_id     uuid not null references review_links(id) on delete cascade,
  reviewer_id uuid not null references reviewers(id) on delete cascade,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null
);
create index widget_sessions_reviewer on widget_sessions (reviewer_id);

create table requests (
  id              uuid primary key default gen_random_uuid(),
  site_id         uuid not null references sites(id) on delete cascade,
  round_id        uuid not null references rounds(id) on delete cascade,
  no              integer not null,
  reviewer_id     uuid references reviewers(id) on delete set null,
  reviewer_name   text not null,

  -- 위치: 클릭한 요소의 선택자, 요소 안 상대 위치(0~1), 문서 좌표, 화면 정보
  page_url        text not null,
  page_title      text not null default '',
  selector        text not null default '',
  text_hint       text not null default '',
  offset_x        real,
  offset_y        real,
  page_x          integer,
  page_y          integer,
  viewport_w      integer,
  viewport_h      integer,
  scroll_y        integer,
  dpr             real,
  browser         text not null default '',
  os              text not null default '',

  -- 캡처: 파일 저장소의 키만 둔다
  screenshot_key  text,
  thumb_key       text,
  capture_notes   jsonb not null default '{}'::jsonb,

  kind            text not null default '수정' check (kind in ('수정', '추가', '문의', '버그')),
  priority        text not null default '보통' check (priority in ('긴급', '높음', '보통', '낮음')),
  body            text not null,
  as_is           text,
  to_be           text,

  status          text not null default '접수' check (status in ('접수', '진행', '완료', '재발생', '보류')),
  assignee1       text not null default '',
  assignee2       text not null default '',
  resolution_note text not null default '',

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  resolved_at     timestamptz,
  confirmed_at    timestamptz,
  confirmed_by    uuid references reviewers(id) on delete set null,
  notified_at     timestamptz,

  unique (site_id, no)
);
create index requests_site_status on requests (site_id, status, created_at desc);
create index requests_site_page on requests (site_id, page_url);
create index requests_unnotified on requests (created_at) where notified_at is null;

-- v0.2 에서 화면에 붙일 댓글. 스키마만 먼저 둔다.
create table comments (
  id          uuid primary key default gen_random_uuid(),
  request_id  uuid not null references requests(id) on delete cascade,
  author_type text not null check (author_type in ('agency', 'reviewer')),
  author_id   uuid,
  author_name text not null default '',
  body        text not null,
  created_at  timestamptz not null default now()
);
create index comments_request on comments (request_id, created_at);
