-- 공유 보드: 링크를 받은 사람은 비밀번호 없이 들어와 서로의 핀을 보고, 상태를 바꾸고, 댓글을 주고받는다.
alter table review_links drop column password_hash;

-- 상태가 바뀐 기록 같은 시스템 댓글
alter table comments drop constraint comments_author_type_check;
alter table comments add constraint comments_author_type_check check (author_type in ('agency', 'reviewer', 'system'));

-- 마지막으로 바꾼 사람(공유 보드에 보여 준다)
alter table requests add column updated_by text not null default '';
