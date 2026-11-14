#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync, openSync, closeSync, readdirSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export function versionSettings(version, build) {
  if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) throw new Error('IOS_VERSION must be three numeric components')
  if (!/^[1-9]\d{0,3}(\.(0|[1-9]\d{0,1})){0,2}$/.test(build ?? '')) throw new Error('IOS_BUILD must be 1..9999[.0..99[.0..99]]')
  return [`MARKETING_VERSION=${version}`, `CURRENT_PROJECT_VERSION=${build}`]
}
export function exportOptions(team, bundle, profile, identity) {
  return { method: 'app-store-connect', destination: 'export', signingStyle: 'manual',
    teamID: team, signingCertificate: identity, provisioningProfiles: { [bundle]: profile },
    manageAppVersionAndBuildNumber: false, stripSwiftSymbols: true, uploadSymbols: true }
}

function main() {
  const mode = process.argv[2]
  if (!['dry-run', 'release', 'upload'].includes(mode)) throw new Error('Usage: pipeline.mjs dry-run|release|upload; see README.md')
  const env = process.env
  if (!env.IOS_OUTPUT_DIR) throw new Error('Set IOS_OUTPUT_DIR outside the repository')
  const root = fileURLToPath(new URL('../../../', import.meta.url))
  const out = resolve(env.IOS_OUTPUT_DIR)
  if (out === root || out.startsWith(`${root}/`)) throw new Error('Output must be outside the repository')
  // A fresh output directory prevents stale artifacts from being mistaken for this run.
  mkdirSync(out, { recursive: false, mode: 0o700 })
  const receipt = { mode, stage: 'preflight', status: 'running', startedAt: new Date().toISOString() }
  const save = () => writeFileSync(join(out, 'receipt.json'), JSON.stringify(receipt, null, 2), { mode: 0o600 })
  const required = name => { if (!env[name]) throw new Error(`Set ${name}`); return env[name] }
  const run = (stage, command, args) => {
    receipt.stage = stage; save()
    const fd = openSync(join(out, `${stage}.log`), 'wx', 0o600)
    try {
      const result = spawnSync(command, args, { cwd: root, env, stdio: ['ignore', fd, fd] })
      if (result.error || result.status !== 0) throw new Error(`${stage} failed; inspect private ${stage}.log (exit ${result.status ?? 'spawn'})`)
    } finally { closeSync(fd) }
  }
  try {
    if (process.platform !== 'darwin') throw new Error('macOS required')
    required('DEVELOPER_DIR')
    run('toolchain', '/usr/bin/xcodebuild', ['-version'])
    receipt.sourceHead = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim()
    if (mode === 'upload') {
      const ipa = resolve(required('IOS_IPA'))
      if (!existsSync(ipa) || !ipa.endsWith('.ipa')) throw new Error('IOS_IPA must be an exported device IPA')
      // Only metadata is passed here. altool reads its own key from a protected external directory.
      required('API_PRIVATE_KEYS_DIR')
      const auth = ['--api-key', required('ASC_KEY_ID'), '--api-issuer', required('ASC_ISSUER_ID')]
      run('validate', '/usr/bin/xcrun', ['altool', '--validate-app', ipa, ...auth])
      run('upload', '/usr/bin/xcrun', ['altool', '--upload-package', ipa, ...auth])
      receipt.status = 'uploaded-awaiting-processing'
    } else {
      const versions = versionSettings(required('IOS_VERSION'), required('IOS_BUILD'))
      const archive = join(out, 'App.xcarchive')
      const common = ['-project', 'apps/mobile/ios/App/App.xcodeproj', '-scheme', 'App',
        '-configuration', 'Release', '-derivedDataPath', join(out, 'DerivedData'),
        '-clonedSourcePackagesDirPath', join(out, 'SourcePackages'), '-jobs', '2',
        '-archivePath', archive, ...versions]
      const signing = ['CODE_SIGN_STYLE=Manual', 'CODE_SIGNING_ALLOWED=YES']
      if (mode === 'dry-run') {
        run('simulator-archive', '/usr/bin/xcodebuild', [...common,
          '-sdk', 'iphonesimulator', '-destination', 'generic/platform=iOS Simulator',
          ...signing, 'CODE_SIGN_IDENTITY=-', 'DEVELOPMENT_TEAM=', 'PROVISIONING_PROFILE_SPECIFIER=', 'archive'])
        run('simulator-signature', '/usr/bin/codesign', ['--verify', '--deep', '--strict', join(archive, 'Products/Applications/App.app')])
        receipt.status = 'dry-run-complete'; receipt.next = 'Device archive requires Apple Distribution identity and matching App Store Connect profile; no export or upload attempted'
      } else {
        const team = required('IOS_TEAM_ID'), profile = required('IOS_PROFILE'), identity = required('IOS_SIGN_IDENTITY')
        const bundle = required('IOS_BUNDLE_ID'), keychain = required('IOS_KEYCHAIN')
        // Account/provisioning changes are never requested. Caller installs/unlocks assets separately.
        run('device-archive', '/usr/bin/xcodebuild', [...common, '-sdk', 'iphoneos',
          '-destination', 'generic/platform=iOS', ...signing, `DEVELOPMENT_TEAM=${team}`,
          `PRODUCT_BUNDLE_IDENTIFIER=${bundle}`, `PROVISIONING_PROFILE_SPECIFIER=${profile}`,
          `CODE_SIGN_IDENTITY=${identity}`, `OTHER_CODE_SIGN_FLAGS=--keychain ${keychain}`, 'archive'])
        const options = join(out, 'ExportOptions.plist')
        writeFileSync(options, JSON.stringify(exportOptions(team, bundle, profile, identity)), { mode: 0o600 })
        run('export-options', '/usr/bin/plutil', ['-convert', 'xml1', options])
        run('export', '/usr/bin/xcodebuild', ['-exportArchive', '-archivePath', archive,
          '-exportPath', join(out, 'export'), '-exportOptionsPlist', options])
        const ipas = readdirSync(join(out, 'export')).filter(file => file.endsWith('.ipa'))
        if (ipas.length !== 1) throw new Error('Expected exactly one exported IPA')
        receipt.ipa = join(out, 'export', ipas[0]); receipt.status = 'exported-not-uploaded'
      }
    }
  } catch (error) {
    receipt.status = 'failed'; receipt.error = error.message; process.exitCode = 1
  } finally {
    receipt.finishedAt = new Date().toISOString(); save()
    console.log(`${receipt.status}: ${join(out, 'receipt.json')}`)
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main() } catch (error) { console.error(error.message); process.exitCode = 1 }
}
