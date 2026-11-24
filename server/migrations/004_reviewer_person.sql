-- 한 사람 = 북마크 하나. 북마크에 담긴 무작위 사람 식별자(pid)로, 같은 사람이 여러 사이트(origin)에서 눌러도 한 명으로 묶는다.
-- pid 가 없는 옛 북마크는 예전처럼 세션마다 따로 만든다(pid 를 비워 둔다). 기존 데이터는 건드리지 않는다.
alter table reviewers add column pid text;
create unique index reviewers_site_pid on reviewers (site_id, pid) where pid is not null;
