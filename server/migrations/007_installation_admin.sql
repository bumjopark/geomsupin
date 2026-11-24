alter table users alter column email drop not null, alter column password_hash drop not null;

create table installation_admin_links (
  workspace_id uuid primary key references workspaces(id) on delete cascade,
  actor_id uuid not null,
  token_hash text unique,
  expires_at timestamptz not null,
  foreign key (workspace_id, actor_id) references members(workspace_id, user_id) on delete cascade
);

create table installation_admin_sessions (
  token_hash text primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  actor_id uuid not null,
  expires_at timestamptz not null,
  foreign key (workspace_id, actor_id) references members(workspace_id, user_id) on delete cascade
);
create index installation_admin_sessions_workspace on installation_admin_sessions(workspace_id);
