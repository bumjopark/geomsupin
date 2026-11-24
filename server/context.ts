import type { Config } from './config.ts';
import type { Sql } from './db.ts';
import type { Storage } from './storage.ts';

export interface AppContext {
  config: Config;
  sql: Sql;
  storage: Storage;
}

export interface AuthCtx {
  userId: string;
  name: string;
  workspaceId: string;
  workspaceName: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthCtx;
  }
}
