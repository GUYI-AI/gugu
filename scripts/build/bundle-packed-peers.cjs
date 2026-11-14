const fs = require('node:fs')
const path = require('node:path')
const { createRequire } = require('node:module')
const ts = require('typescript')
const { NODE_REQUIRE_BANNER, nodeRequirePlugin } = require('./packed-node-require.cjs')

const PURE_PEERS = new Set(['@agentclientprotocol/sdk', '@modelcontextprotocol/sdk', 'zod'])

// SDK and ZCode files use import.meta.url to find assets or child programs. Keep
// those files in place: change only their static pure-JS import specifiers.
async function bundlePackedPeers({ appDir, packages, build, packageName, resolvePackage, filesBelow, importsInFiles }) {
  const owners = packages.filter(directory => {
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'))
    return manifest.name === '@anthropic-ai/claude-agent-sdk' || path.basename(directory) === 'zcode-acp-server'
  })
  const entries = new Map()
  const rewrites = []
  const ownFiles = directory => filesBelow(directory).filter(file => !path.relative(directory, file).split(path.sep).includes('node_modules') && /\.[cm]?js$/.test(file))
  for (const owner of owners) {
    for (const file of ownFiles(owner)) {
      const content = fs.readFileSync(file, 'utf8')
      const source = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS)
      const replacements = []
      for (const statement of source.statements) {
        if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue
        const literal = statement.moduleSpecifier
        if (!literal || !ts.isStringLiteral(literal) || !PURE_PEERS.has(packageName(literal.text))) continue
        const dependency = resolvePackage(packageName(literal.text), path.dirname(file), appDir)
        if (!dependency) throw new Error(`[packed-js] missing peer ${literal.text} from ${file}`)
        const key = dependency + '\0' + literal.text
        let entry = entries.get(key)
        if (!entry) {
          entry = { index: entries.size, spec: literal.text, from: path.dirname(file) }
          entries.set(key, entry)
        }
        replacements.push({ start: literal.getStart(source), end: literal.end, entry })
      }
      if (replacements.length) rewrites.push({ file, content, replacements })
    }
  }
  const outdir = path.join(appDir, 'apps', 'desktop', 'dist-electron', 'packed-peers')
  const byIndex = [...entries.values()]
  if (byIndex.length) {
    const result = await build({
      entryPoints: byIndex.map(entry => ({ in: `packed-peer:${entry.index}`, out: `peer-${entry.index}` })),
      outdir, bundle: true, splitting: true, platform: 'node', format: 'esm', target: 'node18',
      outExtension: { '.js': '.mjs' }, write: false, metafile: true, logLevel: 'silent',
      // Keep native/optional loading and Ajv's generated runtime references on real paths.
      external: ['ws', 'ajv', 'ajv-formats'],
      banner: { js: NODE_REQUIRE_BANNER },
      plugins: [nodeRequirePlugin(), { name: 'packed-peer-entries', setup(builder) {
        builder.onResolve({ filter: /^packed-peer:/ }, async args => {
          const entry = byIndex[Number(args.path.split(':')[1])]
          // Resolve with the original ESM import conditions, then use that module
          // itself as the entry: preserve its entire named/default export surface.
          const resolved = await builder.resolve(entry.spec, { resolveDir: entry.from, kind: 'import-statement' })
          return { path: resolved.path, errors: resolved.errors, warnings: resolved.warnings }
        })
      } }],
    })
    if (result.warnings.length) throw new Error(`[packed-js] peer bundle: ${result.warnings.map(warning => warning.text).join('; ')}`)
    for (const [input, metadata] of Object.entries(result.metafile.inputs)) {
      for (const imported of metadata.imports.filter(item => item.external && ['ws', 'ajv', 'ajv-formats'].includes(item.path))) {
        const original = createRequire(path.resolve(input)).resolve(imported.path)
        const relocated = createRequire(path.join(outdir, 'probe.mjs')).resolve(imported.path)
        if (fs.realpathSync(original) !== fs.realpathSync(relocated)) throw new Error(`[packed-js] relocating peer bundle changes ${imported.path} resolution`)
      }
    }
    for (const file of result.outputFiles) {
      fs.mkdirSync(path.dirname(file.path), { recursive: true })
      fs.writeFileSync(file.path, file.contents)
    }
    for (const { file, content, replacements } of rewrites) {
      let rewritten = content
      for (const replacement of replacements.sort((a, b) => b.start - a.start)) {
        const target = path.join(outdir, `peer-${replacement.entry.index}.mjs`)
        const relative = path.relative(path.dirname(file), target).replaceAll('\\', '/')
        rewritten = rewritten.slice(0, replacement.start) + JSON.stringify(relative.startsWith('.') ? relative : './' + relative) + rewritten.slice(replacement.end)
      }
      fs.writeFileSync(file, rewritten)
    }
  }
  return new Map(owners.map(directory => {
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'))
    const raw = new Set(importsInFiles(ownFiles(directory)).map(reference => reference.name))
    const keep = name => !PURE_PEERS.has(name) || raw.has(name)
    return [directory, {
      required: new Set(Object.keys(manifest.dependencies ?? {}).filter(keep)),
      optional: new Set(Object.keys({ ...manifest.optionalDependencies, ...manifest.peerDependencies }).filter(keep)),
    }]
  }))
}

module.exports = { bundlePackedPeers }
