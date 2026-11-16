import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/** Only call on the payload produced by npm ci against the committed SQLite lock. */
export function sqlitePayloadSnapshot(directory) {
  const files = Object.create(null)
  function visit(part) {
    for (const entry of readdirSync(join(directory, part), { withFileTypes: true })) {
      const name = part ? `${part}/${entry.name}` : entry.name
      if (entry.isDirectory()) visit(name)
      else if (entry.isFile()) files[name] = createHash('sha256').update(readFileSync(join(directory, name))).digest('hex')
      else throw new Error(`Unexpected SQLite payload entry: ${name}`)
    }
  }
  visit('')
  return Object.freeze(files)
}

/** Bind that independently locked payload to what the server app will actually resolve. No package code runs here. */
export function assertSqlitePayload(directory, expected, expectedEntry) {
  const app = realpathSync(directory)
  const req = createRequire(resolve(app, 'package.json'))
  const installed = dirname(realpathSync(req.resolve('better-sqlite3/package.json')))
  const part = relative(app, installed)
  if (!part || part === '..' || part.startsWith(`..${sep}`) || isAbsolute(part)) {
    throw new Error('SQLite resolved outside its installed app')
  }
  const entry = realpathSync(req.resolve('better-sqlite3'))
  const entryPart = relative(installed, entry).split(sep).join('/')
  if (!Object.hasOwn(expected, entryPart) || entryPart !== expectedEntry) {
    throw new Error('SQLite entry is outside the verified payload or differs from the committed-lock entry')
  }
  const actual = sqlitePayloadSnapshot(installed)
  const names = Object.keys(expected).sort()
  if (JSON.stringify(Object.keys(actual).sort()) !== JSON.stringify(names)
    || names.some(name => actual[name] !== expected[name])) {
    throw new Error('Installed SQLite payload differs from the committed-lock payload')
  }
  return entry
}
