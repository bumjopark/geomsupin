/** 서버가 준 순서를 보존한다(ISO 날짜로 다시 정렬하면 DB의 마이크로초 정밀도를 잃는다). */
export function mergeComments<T extends { id: string }>(older: T[], newer: T[]): T[] {
  const ids = new Set(newer.map((c) => c.id));
  return [...older.filter((c) => !ids.has(c.id)), ...newer];
}
