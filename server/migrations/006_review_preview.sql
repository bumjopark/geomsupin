alter table sites add column preview_url text not null default '';
alter table sites add column preview_id uuid;
alter table widget_sessions add column preview_id uuid;
alter table requests add column proposal_key text;
