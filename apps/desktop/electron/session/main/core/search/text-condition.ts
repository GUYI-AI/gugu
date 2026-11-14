/**
 * One text, one condition, for every trigram index here: the text is split on whitespace and each piece is a substring
 * that must occur. A piece of three or more characters MATCHes the trigram index (a substring index, so no word
 * segmentation, Chinese included); a shorter one is a LIKE over the given columns. No pieces → null (nothing to search).
 */
export function textCondition(text: string, ftsTable: string, likeColumns: readonly string[]): { sql: string; params: string[] } | null {
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  const long = words.filter((word) => [...word].length >= 3), short = words.filter((word) => [...word].length < 3);
  const sql: string[] = [], params: string[] = [];
  if (long.length) {
    sql.push(`${ftsTable} MATCH ?`);
    params.push(long.map((word) => `"${word.replaceAll('"', '""')}"`).join(' AND '));
  }
  for (const word of short) {
    sql.push(`(${likeColumns.map((column) => `${column} LIKE ? ESCAPE '\\'`).join(' OR ')})`);
    params.push(...likeColumns.map(() => `%${word.replace(/[\\%_]/g, '\\$&')}%`));
  }
  return { sql: sql.join(' AND '), params };
}
