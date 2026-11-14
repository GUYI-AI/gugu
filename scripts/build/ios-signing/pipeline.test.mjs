import test from 'node:test'
import assert from 'node:assert/strict'
import { versionSettings, exportOptions } from './pipeline.mjs'
test('Apple build-number limits reject timestamp and prerelease versions', () => {
  for (const build of ['202611150001', '0', '1.100', '1.1.100', '1.2.3.4', '01']) assert.throws(() => versionSettings('1.2.3', build))
  assert.throws(() => versionSettings('1.2.3-beta', '1'))
  assert.deepEqual(versionSettings('1.2.3', '9999.99.99'), ['MARKETING_VERSION=1.2.3', 'CURRENT_PROJECT_VERSION=9999.99.99'])
})
test('manual export pins identity and profile without automatic version changes', () => {
  const options = exportOptions('TEAM', 'example.app', 'PROFILE', 'FINGERPRINT')
  assert.deepEqual(options.provisioningProfiles, { 'example.app': 'PROFILE' })
  assert.equal(options.signingStyle, 'manual')
  assert.equal(options.signingCertificate, 'FINGERPRINT')
  assert.equal(options.manageAppVersionAndBuildNumber, false)
  assert.equal(options.destination, 'export')
})
