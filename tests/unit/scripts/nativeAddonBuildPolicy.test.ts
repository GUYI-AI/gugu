import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const { createNativeAddonBuildEnv } = createRequire(import.meta.url)('../../../scripts/build/native-addon-build-policy.cjs')

describe('native source-build policy', () => {
  it.each(['darwin', 'linux', 'win32'])('forces SQLite 13 source builds even with bundled N-API prebuilds on %s', platform => {
    const env = { PATH: 'fixture', npm_package_config_node_gyp_force_build: '0', CXXFLAGS: '-g' }
    const result = createNativeAddonBuildEnv(platform, env)
    expect(result.npm_package_config_node_gyp_force_build).toBe('1')
    expect(result.PATH).toBe('fixture')
    expect(env.npm_package_config_node_gyp_force_build).toBe('0')
    if (platform === 'win32') expect(result.CXXFLAGS).toBe('-g')
    else {
      expect(result.CXXFLAGS).toContain('-g')
      expect(result.CXXFLAGS).toContain('-fvisibility=hidden')
      expect(result.CXXFLAGS).toContain('-UV8_DEPRECATION_WARNINGS')
    }
  })
})
