import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

/**
 * #3225: a stored turn keeps only a storage marker in `session_turns.data`; its content lives in the normalized
 * tables. Code that reads or writes that column directly still works on old rows and silently misses every new one
 * (#3385 filtered host-ended rows with `json_type(data, '$.hostEnd')` and parsed `row.data`).
 */
const CODEC = new Set([
  'apps/desktop/electron/session/main/core/sessions/session-turn-storage.ts',
  'apps/desktop/electron/session/main/core/sessions/session-turn-codec.ts',
  'apps/desktop/electron/session/main/db/initialize.ts', // migrations
])
/** Direct readers outside the codec, each with why it is not ported yet. May only shrink: a fixed entry fails until removed. */
const DEBT = new Map([
  ['scripts/dev/freeze-sample-project.mjs', "offline node:sqlite script; decoding needs the app's better-sqlite3 payload reader"],
])
const HINT = 'Read stored turns through readSessionTurn, and filter in SQL with sessionTurnHeaderSql or sessionTurnRootObjectSql '
  + '(session-turn-storage.ts). Write through prepareSessionTurn and store its marker. Only the codec and migrations touch session_turns.data.'

const TABLE = /\bsession_turns\b/
const JSON_ON_DATA = /\bjson_\w+\(\s*(?:\w+\.)?data\b/
const bare = (node: ts.Expression): ts.Expression => ts.isAsExpression(node) || ts.isParenthesizedExpression(node)
  || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node) ? bare(node.expression) : node

function turnDataAccesses(source: string, file = 'source.ts'): string[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, /\.[cm]?[jt]sx$/.test(file) ? ts.ScriptKind.TSX : undefined)
  const found: string[] = [], parses: ts.Node[] = []
  let selectsData = false
  const at = (node: ts.Node, why: string) => found.push(`${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}: ${why}`)
  const statement = (node: ts.Node): string => {
    let outer = node
    while (outer.parent && !ts.isSourceFile(outer.parent) && !ts.isBlock(outer.parent)) outer = outer.parent
    return outer.getText(sf)
  }
  const objects = (args: readonly ts.Expression[]) => args.flatMap(arg => ts.isObjectLiteralExpression(arg) ? [arg]
    : ts.isArrayLiteralExpression(arg) ? arg.elements.filter(ts.isObjectLiteralExpression) : [])
  const dataKey = (object: ts.ObjectLiteralExpression) => object.properties.find(one => one.name?.getText(sf) === 'data')
  const visit = (node: ts.Node) => {
    if (ts.isPropertyAccessExpression(node) && node.name.text === 'data' && ts.isIdentifier(node.expression) && node.expression.text === 'sessionTurns') {
      const property = node.parent, projection = property.parent, call = projection?.parent
      if (ts.isPropertyAssignment(property) && property.initializer === node && ts.isObjectLiteralExpression(projection) && call
        && ts.isCallExpression(call) && ts.isPropertyAccessExpression(call.expression) && call.expression.name.text === 'select') selectsData = true
      else at(node, 'sessionTurns.data outside a select projection')
    }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) {
      const text = node.getText(sf)
      if (JSON_ON_DATA.test(text) && (TABLE.test(text) || /\bsessionTurns\b/.test(statement(node)))) at(node, 'JSON function on session_turns.data')
      else if (/\bUPDATE\s+session_turns\s+SET\b[\s\S]*\bdata\s*=/i.test(text)) at(node, 'raw UPDATE of session_turns.data')
      else if (/\bINSERT\s+(?:OR\s+\w+\s+)?INTO\s+session_turns\s*\([^)]*\bdata\b/i.test(text)) at(node, 'raw INSERT of session_turns.data')
      else if (/\bSELECT\b[\s\S]*\bdata\b[\s\S]*\bFROM\s+session_turns\b/i.test(text)) selectsData = true
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && /\b(?:insert|update)\(sessionTurns\)/.test(node.expression.expression.getText(sf))) {
      const method = node.expression.name.text
      const written = method === 'values' || method === 'set' ? objects(node.arguments)
        : method === 'onConflictDoUpdate' ? objects(node.arguments).flatMap(object => {
          const set = object.properties.find(one => one.name?.getText(sf) === 'set')
          return set && ts.isPropertyAssignment(set) && ts.isObjectLiteralExpression(set.initializer) ? [set.initializer] : []
        }) : []
      for (const object of written) {
        const data = dataKey(object)
        const marker = method === 'values' && data && ts.isPropertyAssignment(data)
          && ts.isPropertyAccessExpression(bare(data.initializer)) && (bare(data.initializer) as ts.PropertyAccessExpression).name.text === 'marker'
        if (data && !marker) at(data, 'session_turns.data written without a prepareSessionTurn marker')
      }
    }
    if (ts.isCallExpression(node) && node.expression.getText(sf) === 'JSON.parse' && node.arguments[0]
      && /(?:\.data|\[['"]data['"]\])$/.test(bare(node.arguments[0]).getText(sf))) parses.push(node)
    ts.forEachChild(node, visit)
  }
  visit(sf)
  if (selectsData) for (const parse of parses) at(parse, 'JSON.parse of a selected session_turns.data')
  return found
}

const scanned = () => execFileSync('git', ['ls-files', '--', 'apps', 'packages', 'scripts'], { encoding: 'utf8' }).trim().split('\n')
  .filter(path => /\.[cm]?[jt]sx?$/.test(path) && !/\.(?:test|spec|stories)\.[cm]?[jt]sx?$/.test(path) && !/(?:^|\/)tests?\//.test(path) && !CODEC.has(path))

describe('session_turns.data stays behind the stored-turn codec', () => {
  it.each([
    // #3385, as it landed on dev.
    `db.select({ id: sessionTurns.id, seq: sessionTurns.seq, data: sessionTurns.data }).from(sessionTurns)
      .where(and(eq(sessionTurns.sessionId, sessionId), like(sessionTurns.turnId, 'record:%'),
        sql\`(json_extract(\${sessionTurns.data}, '$.outcome.kind') IS NULL OR json_type(\${sessionTurns.data}, '$.hostEnd') = 'object')\`)).all()
      .map(row => ({ seq: row.seq, turn: JSON.parse(row.data) as TranscriptTurn }))`,
    "db.select({ id: sessionTurns.id }).from(sessionTurns).where(sql`json_extract(data, '$.outcome.kind') IS NULL`).all()",
    "connection.prepare(`SELECT 1 FROM session_turns, json_each(session_turns.data,'$.items') WHERE session_turns.id=?`).get(id)",
    "connection.prepare('SELECT data FROM session_turns WHERE id=?').all(id).map(row => JSON.parse(row.data as string))",
    "db.select({ data: sessionTurns.data }).from(sessionTurns).all().map(row => JSON.parse(row['data']))",
    'tx.update(sessionTurns).set({ data: JSON.stringify(turn) }).run()',
    'tx.insert(sessionTurns).values({ id, sessionId, seq, turnId, data: JSON.stringify(turn) }).run()',
    'tx.insert(sessionTurns).values({ id, data: normalized.marker }).onConflictDoUpdate({ target: sessionTurns.id, set: { data: JSON.stringify(turn) } }).run()',
    "connection.prepare('UPDATE session_turns SET revision=revision+1, data=? WHERE id=?').run(data, id)",
    "connection.prepare('INSERT OR IGNORE INTO session_turns(id,session_id,seq,turn_id,data) VALUES (?,?,?,?,?)').run(...row)",
    "db.select({ id: sessionTurns.id }).from(sessionTurns).where(like(sessionTurns.data, '%hostEnd%')).all()",
  ])('rejects a direct access: %s', source => expect(turnDataAccesses(source)).not.toEqual([]))

  it.each([
    'db.select({ id: sessionTurns.id, data: sessionTurns.data }).from(sessionTurns).all().map(row => readSessionTurn(db.connection, row))',
    "db.select({ id: sessionTurns.id }).from(sessionTurns).where(sql`${sql.raw(sessionTurnHeaderSql('outcome_kind', '$.outcome.kind'))} IS NULL OR ${sql.raw(sessionTurnRootObjectSql('hostEnd'))}`).all()",
    'tx.insert(sessionTurns).values({ id, sessionId, seq, turnId, data: normalized.marker }).run()',
    "connection.prepare('SELECT id, rowid AS turn_row, data FROM session_turns WHERE rowid IN (SELECT value FROM json_each(?))').all(ids).map(row => readSessionTurn(connection, row))",
    "connection.prepare(\"SELECT 1 FROM activity_events WHERE json_extract(data, '$.sleep_until_at') > ?\").get(at)",
    'const failure = JSON.parse(error.cause.data as string)',
  ])('permits a codec route or an unrelated column: %s', source => expect(turnDataAccesses(source)).toEqual([]))

  it('keeps every source file outside the codec and migrations off the column', () => {
    // A file that never names the table or its schema export cannot reach the column; only those are parsed.
    const failures = scanned().filter(path => !DEBT.has(path)).map(path => [path, readFileSync(path, 'utf8')] as const)
      .filter(([, source]) => /session_turns|sessionTurns/.test(source))
      .flatMap(([path, source]) => turnDataAccesses(source, path).map(found => `${path}:${found}`))
    expect(failures, HINT).toEqual([])
  })

  it('lists only debt that is still there', () => {
    const files = new Set(scanned())
    for (const [path, reason] of DEBT) {
      expect(reason).not.toBe('')
      expect(files.has(path) && turnDataAccesses(readFileSync(path, 'utf8'), path).length > 0, `${path} no longer reads session_turns.data: remove it from DEBT`).toBe(true)
    }
  })
})
