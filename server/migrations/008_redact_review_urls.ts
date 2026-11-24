import type postgres from 'postgres';
import { normalizePageUrl } from '../../shared/constants.ts';

export const REVIEW_URL_MIGRATION = '008_redact_review_urls';

/** Keep existing page filters aligned with the URLs used by new requests. */
export async function redactReviewUrls(tx: postgres.TransactionSql) {
  let cursor: string | undefined;
  while (true) {
    const rows: { id: string; page_url: string }[] = await tx`
      select id, page_url from requests where page_url ~ '[?#]'
      ${cursor ? tx`and id > ${cursor}::uuid` : tx``}
      order by id limit 500`;
    if (!rows.length) return;
    cursor = rows.at(-1)!.id;
    const updates = rows.flatMap(row => {
      const pageUrl = normalizePageUrl(row.page_url);
      return pageUrl === row.page_url ? [] : [[row.id, pageUrl]];
    });
    if (updates.length) await tx`
      update requests as r set page_url = clean.page_url
      from (values ${tx(updates)}) as clean(id, page_url) where r.id = clean.id::uuid`;
  }
}
