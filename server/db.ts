import postgres from 'postgres';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './config.ts';
import { redactReviewUrls, REVIEW_URL_MIGRATION } from './migrations/008_redact_review_urls.ts';

export type Sql = postgres.Sql;

export function connect(url: string, max = 10): Sql {
  return postgres(url, {
    max,
    idle_timeout: 30,
    connect_timeout: 10,
    onnotice: () => {},
  });
}

const MIGRATIONS_DIR = join(ROOT, 'server', 'migrations');

/** 번호 순으로 한 번씩만 적용한다. 잠금으로 동시 실행을 막는다. */
export async function migrate(sql: Sql): Promise<string[]> {
  const applied: string[] = [];
  await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(7302026)`;
    await tx`create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())`;
    const done = new Set((await tx<{ name: string }[]>`select name from schema_migrations`).map((r) => r.name));
    const names = [...readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')), REVIEW_URL_MIGRATION].sort();
    for (const f of names) {
      if (done.has(f)) continue;
      if (f === REVIEW_URL_MIGRATION) await redactReviewUrls(tx);
      else await tx.unsafe(readFileSync(join(MIGRATIONS_DIR, f), 'utf8'));
      await tx`insert into schema_migrations (name) values (${f})`;
      applied.push(f);
    }
  });
  return applied;
}
