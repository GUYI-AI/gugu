const fs = require('node:fs')
const path = require('node:path')
const { isBuiltin } = require('node:module')
const { NODE_REQUIRE_BANNER, nodeRequirePlugin } = require('./packed-node-require.cjs')

// These entrypoints are resolved by name and launched by an external Node interpreter.
// Keep their public paths and the SDK's own filesystem-relative executable lookup.
const ADAPTERS = [
  { name: '@agentclientprotocol/claude-agent-acp', entries: ['index.js', 'lib.js'], external: ['@anthropic-ai/claude-agent-sdk'] },
  { name: 'pi-acp', entries: ['index.js'], external: [] },
]
const FILESYSTEM_ROOTS = [
  'better-sqlite3', 'node-pty', '@parcel/watcher',
  '@playwright/mcp', 'playwright-core', 'zcode-acp-server',
  '@anthropic-ai/claude-agent-sdk', '@gugu-acp/compat',
]

function filesBelow(root) {
  if (!fs.existsSync(root)) return []
  return fs.readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(root, entry.name)
    if (entry.isSymbolicLink()) throw new Error(`[packed-js] unexpected symlink: ${file}`)
    return entry.isDirectory() ? filesBelow(file) : [file]
  })
}

function packageName(spec) {
  if (isBuiltin(spec) || ['electron', 'original-fs'].includes(spec) || spec.startsWith('.') || path.isAbsolute(spec) || spec.includes(':')) return null
  return spec.split('/').slice(0, spec.startsWith('@') ? 2 : 1).join('/')
}

function resolvePackage(name, from, appDir) {
  for (let directory = from; ; directory = path.dirname(directory)) {
    const candidate = path.join(directory, 'node_modules', name)
    if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate
    if (directory === appDir) return null
    if (path.dirname(directory) === directory) throw new Error(`[packed-js] resolver escaped app: ${from}`)
  }
}

function packagesBelow(modules) {
  if (!fs.existsSync(modules)) return []
  const packages = []
  for (const entry of fs.readdirSync(modules, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue
    const directory = path.join(modules, entry.name)
    if (entry.isSymbolicLink()) throw new Error(`[packed-js] unexpected package symlink: ${directory}`)
    if (!entry.isDirectory()) continue
    if (entry.name.startsWith('@')) {
      packages.push(...packagesBelow(directory))
      continue
    }
    if (!fs.existsSync(path.join(directory, 'package.json'))) throw new Error(`[packed-js] package metadata missing: ${directory}`)
    packages.push(directory)
    // npm owns its bundled tree, including node-gyp sources. The separate offline-archive
    // packer owns this entire subtree; never trace, bundle or remove its contents here.
    if (entry.name !== 'npm') packages.push(...packagesBelow(path.join(directory, 'node_modules')))
  }
  return packages
}

async function bundleAdapter(appDir, adapter, build) {
  const directory = resolvePackage(adapter.name, appDir, appDir)
  if (!directory) throw new Error(`[packed-js] missing adapter: ${adapter.name}`)
  const dist = path.join(directory, 'dist')
  const output = path.join(directory, '.packed-js')
  const result = await build({
    absWorkingDir: appDir,
    entryPoints: adapter.entries.map(entry => path.join(dist, entry)),
    outdir: output,
    outbase: dist,
    bundle: true,
    splitting: true,
    platform: 'node',
    format: 'esm',
    target: 'node18',
    chunkNames: 'chunks/[name]-[hash]',
    external: adapter.external,
    banner: { js: NODE_REQUIRE_BANNER },
    plugins: [nodeRequirePlugin()],
    metafile: true,
    write: false,
    logLevel: 'silent',
  })
  if (result.warnings.length) throw new Error(`[packed-js] ${adapter.name}: ${result.warnings.map(warning => warning.text).join('; ')}`)
  const external = new Set(adapter.external)
  for (const item of Object.values(result.metafile.outputs)) {
    for (const imported of item.imports) {
      const name = imported.external && packageName(imported.path)
      if (name) external.add(name)
    }
  }
  // Build and validate in memory before replacing any materialized files.
  fs.rmSync(output, { recursive: true, force: true })
  for (const file of result.outputFiles) {
    fs.mkdirSync(path.dirname(file.path), { recursive: true })
    fs.writeFileSync(file.path, file.contents)
  }
  fs.rmSync(dist, { recursive: true, force: true })
  fs.renameSync(output, dist)
  return { directory, external }
}

function importsInFiles(files) {
  const ts = require('typescript')
  const references = []
  for (const file of files) {
    const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, false, ts.ScriptKind.JS)
    const aliases = new Set(['require', '__require', '_require', 'require_'])
    const factories = new Set(['createRequire'])
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) || !['module', 'node:module'].includes(statement.moduleSpecifier.text)) continue
      const bindings = statement.importClause?.namedBindings
      if (bindings && ts.isNamedImports(bindings)) {
        for (const binding of bindings.elements) if ((binding.propertyName ?? binding.name).text === 'createRequire') factories.add(binding.name.text)
      }
    }
    const isCreateRequire = expression => ts.isIdentifier(expression)
      ? factories.has(expression.text) || /^createRequire(?:\$\d+)?$/.test(expression.text)
      : ts.isPropertyAccessExpression(expression) && expression.name.text === 'createRequire'
    const findAliases = node => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer
          && ts.isCallExpression(node.initializer) && isCreateRequire(node.initializer.expression)) aliases.add(node.name.text)
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left)
          && ts.isCallExpression(node.right) && isCreateRequire(node.right.expression)) aliases.add(node.left.text)
      ts.forEachChild(node, findAliases)
    }
    findAliases(source)
    const add = (literal, optional) => {
      if (!literal || !ts.isStringLiteralLike(literal)) return
      const name = packageName(literal.text)
      if (name) references.push({ name, from: path.dirname(file), optional })
    }
    const visit = (node, optional = false) => {
      if (ts.isTryStatement(node)) {
        visit(node.tryBlock, optional || !!node.catchClause)
        if (node.catchClause) visit(node.catchClause, optional)
        if (node.finallyBlock) visit(node.finallyBlock, optional)
        return
      }
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) add(node.moduleSpecifier, optional)
      if (ts.isCallExpression(node)) {
        const expression = node.expression
        const identifier = ts.isPropertyAccessExpression(expression) && expression.name.text === 'resolve' ? expression.expression : expression
        if (expression.kind === ts.SyntaxKind.ImportKeyword
            || (ts.isIdentifier(identifier) && (aliases.has(identifier.text) || /^require\d+$/.test(identifier.text)))
            || (ts.isPropertyAccessExpression(expression) && expression.getText(source) === 'import.meta.resolve')) add(node.arguments[0], optional)
      }
      ts.forEachChild(node, child => visit(child, optional))
    }
    visit(source)
  }
  return references
}

function emittedPackageImports(appDir) {
  return importsInFiles(filesBelow(path.join(appDir, 'apps', 'desktop', 'dist-electron')).filter(file => /\.[cm]?js$/.test(file)))
}

function stats(root) {
  const files = filesBelow(root)
  return { files: files.length, smallFiles: files.filter(file => fs.statSync(file).size < 4096).length }
}

function preserveLicenses(appDir) {
  const modules = path.join(appDir, 'node_modules')
  const notices = filesBelow(modules).filter(file => /^(?:licen[cs]e|copying|notice)(?:[.-]|$)/i.test(path.basename(file)))
  const content = notices.sort().map(file => `--- ${path.relative(modules, file).replaceAll('\\', '/')} ---\n${fs.readFileSync(file, 'utf8')}`).join('\n\n')
  const previous = path.join(modules, 'THIRD-PARTY-LICENSES.txt')
  fs.writeFileSync(previous, (fs.existsSync(previous) ? fs.readFileSync(previous, 'utf8') + '\n\n' : '') + content)
}

async function compactPackedJs({ appDir, build = require('esbuild').build }) {
  const before = stats(appDir)
  // Bundling must not discard the notices previously shipped beside dependency code.
  preserveLicenses(appDir)
  const overrides = new Map()
  for (const adapter of ADAPTERS) {
    const bundled = await bundleAdapter(appDir, adapter, build)
    overrides.set(bundled.directory, bundled.external)
  }
  const packages = packagesBelow(path.join(appDir, 'node_modules'))
  const { bundlePackedPeers } = require('./bundle-packed-peers.cjs')
  const peerOverrides = await bundlePackedPeers({ appDir, packages, build, packageName, resolvePackage, filesBelow, importsInFiles })
  const retained = new Set()
  const queue = []
  const retain = (name, from, required = true) => {
    const directory = resolvePackage(name, from, appDir)
    if (!directory) {
      if (required) throw new Error(`[packed-js] missing runtime dependency ${name} from ${path.relative(appDir, from)}`)
      return
    }
    if (!retained.has(directory)) { retained.add(directory); queue.push(directory) }
  }
  for (const name of [...FILESYSTEM_ROOTS, ...ADAPTERS.map(adapter => adapter.name)]) retain(name, appDir)
  // Both the loose npm package and the offline archive layout are supported.
  retain('npm', appDir, false)
  // A vendor's existing try/catch may probe an absent optional accelerator. Preserve
  // every installed dependency, but do not turn that pre-existing absence into a new error.
  for (const { name, from, optional } of emittedPackageImports(appDir)) retain(name, from, !optional)
  for (let index = 0; index < queue.length; index++) {
    const directory = queue[index]
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'))
    if (path.basename(directory) === 'npm') continue
    if (peerOverrides.has(directory)) {
      for (const name of peerOverrides.get(directory).required) retain(name, directory)
      for (const name of peerOverrides.get(directory).optional) retain(name, directory, false)
      continue
    }
    if (overrides.has(directory)) {
      for (const name of overrides.get(directory)) retain(name, directory)
      continue
    }
    for (const name of Object.keys(manifest.dependencies ?? {})) retain(name, directory)
    for (const name of Object.keys({ ...manifest.optionalDependencies, ...manifest.peerDependencies })) retain(name, directory, false)
  }
  const removed = packages.filter(directory => !retained.has(directory))
  for (const directory of removed.sort((a, b) => b.length - a.length)) fs.rmSync(directory, { recursive: true, force: true })
  return { before, after: stats(appDir), removedPackages: removed.map(directory => path.relative(appDir, directory)).sort() }
}

module.exports = { compactPackedJs, emittedPackageImports, packageName, resolvePackage, stats }
