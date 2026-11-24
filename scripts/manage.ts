import { parseArgs } from 'node:util';
import { loadConfig } from '../server/config.ts';
import { connect, migrate } from '../server/db.ts';
import { issueAdminLink } from '../server/installation-admin.ts';

const { values } = parseArgs({
  options: { list: { type: 'boolean' }, workspace: { type: 'string' }, name: { type: 'string' } },
});
const name = values.name?.trim();
if (values.list && (values.workspace || values.name)) throw new Error('--list는 단독으로 사용하세요');
if (values.name !== undefined && (!name || name.length > 80)) throw new Error('작업공간 이름은 1~80자로 입력하세요');
const config = loadConfig();
const sql = connect(config.databaseUrl, 1);
try {
  await migrate(sql);
  if (values.list) {
    const spaces = await sql<{ id: string; name: string }[]>`select id, name from workspaces order by created_at, id`;
    for (const space of spaces) console.log(`${space.id}\t${JSON.stringify(space.name)}`);
  } else {
    const link = await issueAdminLink(sql, values.workspace, name);
    console.log(`관리 링크 (15분, 한 번 사용)\n${config.publicOrigin}/#manage=${link.token}`);
  }
} finally {
  await sql.end({ timeout: 5 });
}
