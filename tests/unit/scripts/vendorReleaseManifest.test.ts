import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { vendorReleaseManifest } from '../../../scripts/build/vendor-release-manifest.mts'

describe('vendor mirror pin inventory', () => {
  it('lists every pinned platform with immutable own-storage URLs and original SHA pins', () => {
    const { artifacts } = vendorReleaseManifest()
    expect(JSON.parse(readFileSync(resolve(__dirname, '../../../scripts/build/vendor-assets.json'), 'utf8'))).toEqual(vendorReleaseManifest())
    expect(artifacts).toHaveLength(64)
    expect(new Set(artifacts.map(item => item.key)).size).toBe(64)
    for (const item of artifacts) {
      expect(item.sha256).toMatch(/^[a-f0-9]{64}$/)
      expect(item.url).toBe(`https://download.gugu.nextmind.space/${item.key.split('/').map(encodeURIComponent).join('/')}`)
      expect(item.repository).toMatch(/^[\w-]+\/[\w-]+$/)
    }
    const gradle = artifacts[22]
    expect(gradle.sha256).toBe('ed1a8d686605fd7c23bdf62c7fc7add1c5b23b2bbc3721e661934ef4a4911d7c')
    expect(gradle.url).toBe('https://download.gugu.nextmind.space/releases/vendor/gradle/8.14.3/gradle-8.14.3-all.zip')
    const libc = artifacts.find(item => item.key.includes('/libc++/'))!
    expect(libc.url).toContain('/libc%2B%2B/30/')
    expect(libc.size).toBe(341604)
    expect(artifacts.filter(item => item.component === 'termux')).toHaveLength(9)
    expect(artifacts.filter(item => item.component === 'cua-driver')).toHaveLength(0)
    expect(artifacts.filter(item => item.component === 'tmux')).toHaveLength(4)
    expect(artifacts.filter(item => item.component === 'electron')).toHaveLength(7)
    expect(artifacts.filter(item => item.component === 'better-sqlite3')).toHaveLength(6)
    expect(artifacts.filter(item => item.component === 'electron-builder')).toHaveLength(14)
    expect(artifacts.filter(item => item.component === 'node-toolchain')).toHaveLength(10)
  })

  it('keeps the Android lock data and generated inventory in agreement', () => {
    const lock = JSON.parse(readFileSync(resolve(__dirname, '../../../apps/mobile/runtime/android-node.lock.json'), 'utf8'))
    for (const pkg of lock.packages) {
      const item = vendorReleaseManifest().artifacts.find(archive => archive.sha256 === pkg.sha256)!
      expect(item.url).toBe(`${lock.mirror}/${encodeURIComponent(pkg.name)}/${encodeURIComponent(pkg.version)}/${pkg.sha256}.deb`)
      expect(item.size).toBe(pkg.size)
    }
  })
})
