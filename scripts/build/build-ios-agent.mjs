import { createRequire } from 'node:module'
import { cp, readFile, readdir, mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { copyMobileRuntimeNotices } from './mobile-runtime-notices.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const tooling = resolve(process.env.GUGU_IOS_TOOLING_ROOT ?? root)
const require = createRequire(join(tooling, 'package.json'))
const { build } = require('esbuild')
const out = join(root, 'apps/mobile/ios/App/App/HostRuntime')
await mkdir(out, { recursive: true })
const bootstrap = await readFile(join(root, 'apps/mobile/runtime/ios/bootstrap.js'), 'utf8')
const built = await build({ banner: { js: bootstrap }, entryPoints: [join(root, 'apps/mobile/runtime/ios/agent.mjs')],
  outfile: join(out, 'agent.js'), bundle: true, platform: 'browser', target: 'safari15', format: 'iife', minify: true,
  alias: { '@capacitor/core': join(root, 'apps/mobile/runtime/ios/calendar-bridge.mjs'),
    '@gugu/session-shared/logger': join(root, 'packages/session-shared/src/logger/redact.ts') },
  nodePaths: [join(root, 'apps/mobile/node_modules'), join(tooling, 'node_modules')], metafile: true })
const bytes = await readFile(join(out, 'agent.js'))
const inputs = Object.keys(built.metafile.inputs)
if (inputs.some((path) => path.startsWith('node:') || path.includes('pi-coding-agent/'))) throw new Error('iOS runtime contains a Node-only input')
const packages = new Map()
for (const input of inputs.filter((path) => path.includes('node_modules/'))) {
  let directory = dirname(resolve(root, input))
  while (directory !== dirname(directory)) {
    try {
      const metadata = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
      if (metadata.name && metadata.version) { packages.set(directory, metadata); break }
    } catch (error) { if (error.code !== 'ENOENT') throw error }
    directory = dirname(directory)
  }
}
await rm(join(out, 'licenses/npm'), { recursive: true, force: true })
const notices = []
for (const [directory, metadata] of packages) {
  const names = (await readdir(directory)).filter((name) => /^(?:licen[cs]e|copying|copyright|notice)(?:[.-].*)?$/i.test(name))
  const target = join(out, 'licenses/npm', `${metadata.name.replaceAll('/', '__')}-${metadata.version}`)
  await mkdir(target, { recursive: true })
  for (const name of names) await cp(join(directory, name), join(target, name), { recursive: true })
  notices.push({ name: metadata.name, version: metadata.version, license: metadata.license ?? null,
    files: names.map((name) => `npm/${metadata.name.replaceAll('/', '__')}-${metadata.version}/${name}`) })
}
const supplemental = await copyMobileRuntimeNotices(root, out, 'npm', [...packages].map(([directory, metadata]) => ({ ...metadata, directory })))
for (const notice of notices) {
  notice.files.push(...(supplemental.get(`${notice.name}@${notice.version}`) ?? []))
  if (!notice.files.length) throw new Error(`${notice.name}: packaged runtime has no license body`)
}
await writeFile(join(out, 'licenses/npm-packages.json'), JSON.stringify(notices, null, 2) + '\n')
const manifest = { protocolVersion: 1, piVersion: '1.4.0', sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length,
  entrypoint: 'apps/mobile/runtime/ios/agent.mjs', inputs }
await writeFile(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
console.log(JSON.stringify({ ...manifest, inputs: inputs.length }))
