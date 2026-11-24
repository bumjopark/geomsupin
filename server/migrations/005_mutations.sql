-- 저장은 완료됐지만 응답이 끊긴 경우, 같은 전송의 재시도를 한 건으로 처리한다.
alter table requests add column mutation_id text;
create unique index requests_mutation on requests (reviewer_id, mutation_id);
alter table comments add column mutation_id text;
create unique index comments_mutation on comments (request_id, author_type, author_id, mutation_id);
