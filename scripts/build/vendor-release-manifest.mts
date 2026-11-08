// Generate mirror data from the existing pin sources; never execute a bundle or obtain an archive.
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { CUA_DRIVER_MAC_REVISION, CUA_DRIVER_VERSION, cuaDriverArchiveInfo } from './cua-driver-release.mts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const base = 'https://download.gugu.nextmind.space/'
export function vendorReleaseManifest() {
  const artifacts: Array<{ component: string; version: string; platform: string; file: string; sha256: string; size: number | null; repository: string; tag: string; asset: string; key: string; url: string }> = []
  const add = (component: string, version: string, platform: string, file: string, sha256: string, size: number | null, repository: string, tag: string, asset = file) => {
    const key = `releases/vendor/${component}/${version}/${file}`
    artifacts.push({ component, version, platform, file, sha256, size, repository, tag, asset, key, url: base + key.split('/').map(encodeURIComponent).join('/') })
  }
  const psmux = readFileSync(resolve(root, 'scripts/build-psmux-bundle.mjs'), 'utf8')
  const version = /const version = '([^']+)'/.exec(psmux)?.[1]
  const sha256 = /const expectedSha256 = '([a-f0-9]{64})'/.exec(psmux)?.[1]
  if (!version || !sha256) throw new Error('Cannot read the psmux pin')
  add('psmux', version, 'windows-x64', `psmux-${version}-windows-x64.zip`, sha256, null, 'psmux/psmux', version)
  for (const platform of ['darwin-universal', 'win32-x64', 'win32-arm64']) {
    const pin = cuaDriverArchiveInfo(platform)
    const mac = platform === 'darwin-universal'
    add('cua-driver', mac ? CUA_DRIVER_MAC_REVISION : CUA_DRIVER_VERSION, platform, pin.asset, pin.sha256, null, mac ? 'GUYI-AI/gugu' : 'trycua/cua', mac ? 'assets' : `cua-driver-rs-v${CUA_DRIVER_VERSION}`)
    if (artifacts.at(-1)?.url !== pin.url) throw new Error('Cua consumer and vendor manifest disagree')
  }
  const mobile = JSON.parse(readFileSync(resolve(root, 'apps/mobile/runtime/android-node.lock.json'), 'utf8'))
  for (const pkg of mobile.packages) {
    const file = `${pkg.sha256}.deb`
    add('termux', `${pkg.name}/${pkg.version}`, mobile.architecture, file, pkg.sha256, pkg.size, 'GUYI-AI/gugu', 'android-node-runtime')
    if (artifacts.at(-1)?.url !== `${mobile.mirror}/${encodeURIComponent(pkg.name)}/${encodeURIComponent(pkg.version)}/${file}`) throw new Error('Android consumer and vendor manifest disagree')
  }
  for (const [component, pinFile, repository] of [
    ['mise', 'apps/desktop/src/session/shared/core/agents/mise-release.json', 'jdx/mise'],
    ['frp', 'scripts/frpc-release.json', 'fatedier/frp'],
  ]) {
    const pin = JSON.parse(readFileSync(resolve(root, pinFile), 'utf8'))
    for (const [platform, archive] of Object.entries(pin.assets) as Array<[string, { asset: string; sha256: string }]>) {
      add(component, `v${pin.version}`, platform, archive.asset, archive.sha256, null, repository, `v${pin.version}`)
    }
  }
  const wrapper = readFileSync(resolve(root, 'apps/mobile/android/gradle/wrapper/gradle-wrapper.properties'), 'utf8')
  const gradleVersion = /gradle-([0-9.]+)-all\.zip/.exec(wrapper)?.[1]
  const gradleSha = /^distributionSha256Sum=([a-f0-9]{64})$/m.exec(wrapper)?.[1]
  if (!gradleVersion || !gradleSha) throw new Error('Cannot read the pinned Gradle distribution')
  add('gradle', gradleVersion, 'universal', `gradle-${gradleVersion}-all.zip`, gradleSha, null, 'gradle/gradle-distributions', `v${gradleVersion}`)
  if (new Set(artifacts.map(item => item.key)).size !== artifacts.length) throw new Error('Duplicate vendor key')
  return { schema: 1, artifacts }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) console.log(JSON.stringify(vendorReleaseManifest(), null, 2))
