const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const JSZip = require('jszip')
const {
  ARCHIVE_NAME,
  MANIFEST_NAME,
  FORMAT_VERSION,
  parseBundleManifest,
  safeRelativePath
} = require('../../apps/desktop/electron/bundled-npm/format.cjs')

/** Pack the already-filtered, closure-checked npm tree. No network or dependency resolution here. */
async function archivePackedNpm({ appDir }) {
  const npmRoot = path.join(appDir, 'node_modules', 'npm')
  const pkg = JSON.parse(fs.readFileSync(path.join(npmRoot, 'package.json'), 'utf8'))
  const zip = new JSZip()
  const files = []
  function walk(dir) {
    for (const entry of fs
      .readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const file = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(file)
        continue
      }
      if (!entry.isFile()) throw new Error(`[bundled-npm] Unsupported npm entry: ${file}`)
      const relative = path.relative(npmRoot, file).split(path.sep).join('/')
      if (!safeRelativePath(relative))
        throw new Error(`[bundled-npm] Invalid npm path: ${relative}`)
      const data = fs.readFileSync(file)
      const mode = fs.statSync(file).mode & 0o777
      files.push({
        path: relative,
        size: data.length,
        mode,
        sha256: createHash('sha256').update(data).digest('hex')
      })
      zip.file(relative, data, {
        createFolders: false,
        date: new Date('1980-01-01T00:00:00Z'),
        unixPermissions: mode
      })
    }
  }
  walk(npmRoot)
  const archive = await zip.generateAsync({
    type: 'nodebuffer',
    platform: 'UNIX',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 }
  })
  const manifest = parseBundleManifest({
    format: FORMAT_VERSION,
    archive: ARCHIVE_NAME,
    version: pkg.version,
    sha256: createHash('sha256').update(archive).digest('hex'),
    files,
    bundledDependencies: pkg.bundleDependencies ?? pkg.bundledDependencies ?? []
  })
  const destination = path.join(path.dirname(appDir), 'npm-bundle')
  fs.mkdirSync(destination, { recursive: true })
  fs.writeFileSync(path.join(destination, ARCHIVE_NAME), archive)
  fs.writeFileSync(path.join(destination, MANIFEST_NAME), `${JSON.stringify(manifest)}\n`)
  // Only remove the loose payload after both offline resources have been written and verified.
  const check = fs.readFileSync(path.join(destination, ARCHIVE_NAME))
  if (createHash('sha256').update(check).digest('hex') !== manifest.sha256)
    throw new Error('[bundled-npm] Written archive checksum mismatch')
  fs.rmSync(npmRoot, { recursive: true })
  return files.length
}

module.exports = { archivePackedNpm }
