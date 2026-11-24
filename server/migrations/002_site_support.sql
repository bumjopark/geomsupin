-- 사이트가 검수핀을 지원하는지(보안 정책 CSP 가 위젯을 막지 않는지). 사이트를 만들 때와 설치 점검 때 서버가 판정해 남긴다.
alter table sites
  add column support_status text not null default 'unknown' check (support_status in ('supported', 'unsupported', 'unknown')),
  add column support_checked_at timestamptz,
  add column support_summary jsonb not null default '{}'::jsonb;
