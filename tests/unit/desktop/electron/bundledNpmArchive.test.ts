import { afterEach, describe, expect, test } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { build } from 'esbuild'
import JSZip from 'jszip'
import { createHash } from 'node:crypto'
import { prepareBundledNpm } from '../../../../apps/desktop/electron/bundled-npm/cache'
import { parseBundleManifest } from '../../../../apps/desktop/electron/bundled-npm/format.cjs'

const require = createRequire(import.meta.url)
const { archivePackedNpm } = require('../../../../scripts/build/archive-packed-npm.cjs') as {
  archivePackedNpm(options: { appDir: string }): Promise<number>
}
const roots: string[] = []
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-npm-archive-'))
  roots.push(root)
  const app = path.join(root, 'resources', 'app')
  const npm = path.join(app, 'node_modules', 'npm')
  const home = path.join(root, 'home')
  fs.mkdirSync(path.join(npm, 'bin'), { recursive: true })
  fs.mkdirSync(path.join(npm, 'node_modules', 'fixture-dep'), { recursive: true })
  fs.writeFileSync(
    path.join(npm, 'package.json'),
    JSON.stringify({ version: '10.9.4', bundleDependencies: ['fixture-dep'] })
  )
  fs.writeFileSync(path.join(npm, 'bin', 'npm-cli.js'), 'console.log("offline fixture")\n')
  fs.writeFileSync(path.join(npm, 'bin', 'npx-cli.js'), '// npx\n')
  fs.writeFileSync(
    path.join(npm, 'node_modules', 'fixture-dep', 'package.json'),
    '{"name":"fixture-dep"}'
  )
  return {
    root,
    app,
    npm,
    home,
    bundle: path.join(root, 'resources', 'npm-bundle'),
    env: { GUGU_HOME: home }
  }
}
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('offline npm archive', () => {
  test('removes the loose payload only after writing its complete offline archive', async () => {
    const f = fixture()
    expect(await archivePackedNpm({ appDir: f.app })).toBe(4)
    expect(fs.existsSync(f.npm)).toBe(false)
    expect(fs.readdirSync(f.bundle).sort()).toEqual(['npm.json', 'npm.zip'])
    const cli = await prepareBundledNpm(f.app, f.env)
    expect(cli).toContain(path.join(f.home, 'cache', 'bundled-npm'))
    expect(execFileSync(process.execPath, [cli!], { encoding: 'utf8' })).toBe('offline fixture\n')
  })

  test('coalesces concurrent first use, reuses immutable files, and leaves no staging directory', async () => {
    const f = fixture()
    await archivePackedNpm({ appDir: f.app })
    const paths = await Promise.all(
      Array.from({ length: 12 }, () => prepareBundledNpm(f.app, f.env))
    )
    expect(new Set(paths).size).toBe(1)
    const cli = paths[0]!
    fs.utimesSync(cli, new Date('2001-01-01'), new Date('2001-01-01'))
    expect(await prepareBundledNpm(f.app, f.env)).toBe(cli)
    expect(fs.statSync(cli).mtime.getUTCFullYear()).toBe(2001)
    expect(
      fs
        .readdirSync(path.join(f.home, 'cache', 'bundled-npm'))
        .filter((name) => name.startsWith('.npm-staging-'))
    ).toEqual([])
  })

  test('rejects archive corruption even when a verified cache already exists', async () => {
    const f = fixture()
    await archivePackedNpm({ appDir: f.app })
    await prepareBundledNpm(f.app, f.env)
    fs.appendFileSync(path.join(f.bundle, 'npm.zip'), 'corruption')
    await expect(prepareBundledNpm(f.app, f.env)).rejects.toThrow('checksum mismatch')
  })

  test('rejects modified cached code rather than launching it', async () => {
    const f = fixture()
    await archivePackedNpm({ appDir: f.app })
    const cli = (await prepareBundledNpm(f.app, f.env))!
    fs.writeFileSync(cli, 'console.log("tampered")')
    await expect(prepareBundledNpm(f.app, f.env)).rejects.toThrow('failed verification')
  })

  test('ignores an interrupted private staging tree and publishes a complete cache', async () => {
    const f = fixture()
    await archivePackedNpm({ appDir: f.app })
    const staging = path.join(f.home, 'cache', 'bundled-npm', '.npm-staging-interrupted')
    fs.mkdirSync(staging, { recursive: true })
    fs.writeFileSync(path.join(staging, 'partial'), 'partial')
    expect(fs.existsSync((await prepareBundledNpm(f.app, f.env))!)).toBe(true)
    expect(fs.readFileSync(path.join(staging, 'partial'), 'utf8')).toBe('partial')
  })

  test('cleans its own failed extraction and rejects a mismatched npm version', async () => {
    const f = fixture()
    await archivePackedNpm({ appDir: f.app })
    const descriptor = path.join(f.bundle, 'npm.json')
    const manifest = JSON.parse(fs.readFileSync(descriptor, 'utf8'))
    manifest.version = '999.0.0'
    fs.writeFileSync(descriptor, JSON.stringify(manifest))
    await expect(prepareBundledNpm(f.app, f.env)).rejects.toThrow('metadata does not match')
    expect(fs.readdirSync(path.join(f.home, 'cache', 'bundled-npm'))).toEqual([])
  })

  test.each(['../outside', '/absolute', 'C:/absolute', 'bin\\outside', 'bin/../outside'])(
    'rejects unsafe manifest path %s',
    async (unsafe) => {
      const f = fixture()
      await archivePackedNpm({ appDir: f.app })
      const location = path.join(f.bundle, 'npm.json')
      const value = JSON.parse(fs.readFileSync(location, 'utf8'))
      value.files[0].path = unsafe
      fs.writeFileSync(location, JSON.stringify(value))
      await expect(prepareBundledNpm(f.app, f.env)).rejects.toThrow('Invalid or duplicate')
    }
  )

  test('rejects a zip-slip name even if ZIP normalization makes it match a declared path', async () => {
    const f = fixture()
    await archivePackedNpm({ appDir: f.app })
    const location = path.join(f.bundle, 'npm.json')
    const value = JSON.parse(fs.readFileSync(location, 'utf8'))
    const zip = await JSZip.loadAsync(fs.readFileSync(path.join(f.bundle, 'npm.zip')))
    const data = await zip.file('bin/npm-cli.js')!.async('nodebuffer')
    zip.remove('bin/npm-cli.js')
    zip.file('../bin/npm-cli.js', data, { createFolders: false })
    const bytes = await zip.generateAsync({ type: 'nodebuffer' })
    value.sha256 = createHash('sha256').update(bytes).digest('hex')
    fs.writeFileSync(path.join(f.bundle, 'npm.zip'), bytes)
    fs.writeFileSync(location, JSON.stringify(value))
    await expect(prepareBundledNpm(f.app, f.env)).rejects.toThrow('unsafe npm archive')
    expect(fs.existsSync(f.home)).toBe(false)
  })

  test('concurrent independent processes publish and verify the same complete cache', async () => {
    const f = fixture()
    await archivePackedNpm({ appDir: f.app })
    const source = path.resolve(__dirname, '../../../../apps/desktop/electron/bundled-npm/cache.ts')
    const bundled = await build({
      stdin: {
        contents: `import {prepareBundledNpm} from ${JSON.stringify(source)}; prepareBundledNpm(process.argv[2], {GUGU_HOME:process.argv[3]}).then(p=>process.stdout.write(p)).catch(e=>{console.error(e);process.exitCode=1})`,
        resolveDir: process.cwd(),
        loader: 'ts'
      },
      bundle: true,
      platform: 'node',
      format: 'cjs',
      write: false
    })
    const worker = path.join(f.root, 'worker.cjs')
    fs.writeFileSync(worker, bundled.outputFiles[0].text)
    const run = promisify(execFile)
    const result = await Promise.all([
      run(process.execPath, [worker, f.app, f.home]),
      run(process.execPath, [worker, f.app, f.home])
    ])
    expect(result[0].stdout).toBe(result[1].stdout)
    expect(execFileSync(process.execPath, [result[0].stdout], { encoding: 'utf8' })).toBe(
      'offline fixture\n'
    )
    expect(fs.readdirSync(path.join(f.home, 'cache', 'bundled-npm'))).toHaveLength(1)
  })

  test('runs the actual archived npm and node-gyp offline, including a local package install', async () => {
    const f = fixture()
    const source = path.dirname(require.resolve('npm/package.json'))
    fs.rmSync(f.npm, { recursive: true })
    fs.cpSync(source, f.npm, {
      recursive: true,
      dereference: true,
      filter: (file) => !file.endsWith('.map')
    })
    await archivePackedNpm({ appDir: f.app })
    const cli = (await prepareBundledNpm(f.app, f.env))!
    const env = {
      ...process.env,
      ...f.env,
      HOME: f.home,
      USERPROFILE: f.home,
      npm_config_userconfig: path.join(f.root, 'empty-npmrc'),
      npm_config_registry: 'http://127.0.0.1:1',
      npm_config_cache: path.join(f.root, 'npm-cache')
    }
    expect(
      execFileSync(process.execPath, [cli, '--version'], { env, encoding: 'utf8' }).trim()
    ).toBe(JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8')).version)
    const npm = path.join(cli, '..', '..')
    expect(
      execFileSync(
        process.execPath,
        [path.join(npm, 'node_modules', 'node-gyp', 'bin', 'node-gyp.js'), '--version'],
        { env, encoding: 'utf8' }
      )
    ).toMatch(/^v\d/)
    expect(fs.existsSync(path.join(npm, 'node_modules', 'node-gyp', 'gyp', 'gyp_main.py'))).toBe(
      true
    )
    const pkg = path.join(f.root, 'local-package')
    fs.mkdirSync(pkg)
    fs.writeFileSync(
      path.join(pkg, 'package.json'),
      '{"name":"offline-npm-fixture","version":"1.0.0"}'
    )
    const dest = path.join(f.root, 'installed')
    execFileSync(
      process.execPath,
      [
        cli,
        'install',
        '--offline',
        '--no-audit',
        '--no-fund',
        '--ignore-scripts',
        '--package-lock=false',
        '--prefix',
        dest,
        pkg
      ],
      { env, encoding: 'utf8' }
    )
    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(dest, 'node_modules', 'offline-npm-fixture', 'package.json'),
          'utf8'
        )
      ).version
    ).toBe('1.0.0')
    expect(
      parseBundleManifest(JSON.parse(fs.readFileSync(path.join(f.bundle, 'npm.json'), 'utf8')))
        .bundledDependencies.length
    ).toBeGreaterThan(0)
  }, 60_000)
})
