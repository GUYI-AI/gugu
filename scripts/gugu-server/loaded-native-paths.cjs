const { realpathSync } = require('node:fs')
const { createRequire } = require('node:module')
const { dirname, isAbsolute, relative, resolve, sep } = require('node:path')

function isInside(directory, file) {
  const part = relative(directory, file)
  return part !== '' && part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part)
}

/** Inspect the binary actually loaded by the package, not an assumed build/Release location. */
function loadedNativePath(packageDirectory, cache) {
  const paths = Object.keys(cache).filter(file => file.endsWith('.node') && isInside(packageDirectory, file))
  if (paths.length !== 1) throw new Error(`Expected one loaded native binary in ${packageDirectory}, found ${paths.length}`)
  return paths[0]
}

function serverNativePaths(appDirectory) {
  const app = realpathSync(appDirectory)
  const req = createRequire(resolve(app, 'package.json'))
  const packages = ['better-sqlite3', 'node-pty']
  const roots = packages.map(name => {
    const root = dirname(realpathSync(req.resolve(`${name}/package.json`)))
    if (!isInside(app, root)) throw new Error(`${name} resolved outside the packaged app`)
    return root
  })
  const Database = req('better-sqlite3')
  const db = new Database(':memory:')
  try {
    if (db.prepare('SELECT 1 AS ready').get().ready !== 1) throw new Error('Packaged SQLite query failed')
  } finally { db.close() }
  req('node-pty')
  return roots.map(root => loadedNativePath(root, req.cache))
}

module.exports = { loadedNativePath, serverNativePaths }

if (require.main === module) {
  if (!process.argv[2]) throw new Error('Missing packaged app directory')
  process.stdout.write(`${serverNativePaths(process.argv[2]).join('\n')}\n`)
}
