import test from 'node:test'
import assert from 'node:assert/strict'
import { versionSettings, exportOptions, deviceSigningConfig, deviceSigningArguments } from './pipeline.mjs'
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
test('device archive scopes the profile to App instead of Swift package targets', () => {
  const config = deviceSigningConfig('App Store Distribution')
  const settings = Object.fromEntries(config.trim().split('\n').map(line => line.split(/\s*=\s*/)))
  const profileFor = target => settings.PROVISIONING_PROFILE_SPECIFIER
    .replace('$(TARGET_NAME)', target)
    .replace(/\$\(([^()]+)\)/g, (_, name) => settings[name] ?? '')
  assert.equal(profileFor('App'), 'App Store Distribution')
  for (const target of ['ClipboardPlugin', 'CapApp-SPM', 'AppPlugin', 'LocalNotificationsPlugin']) assert.equal(profileFor(target), '')
  const args = deviceSigningArguments('TEAM', 'example.app', 'IDENTITY', '/private/sign.keychain-db', '/private/Signing.xcconfig')
  assert.deepEqual(args.slice(0, 2), ['-xcconfig', '/private/Signing.xcconfig'])
  assert.equal(args.some(arg => arg.startsWith('PROVISIONING_PROFILE_SPECIFIER=')), false)
})
test('profile configuration rejects line and variable injection', () => {
  for (const value of ['', 'profile\nCODE_SIGNING_ALLOWED=NO', 'profile\rOTHER=1', '$(OTHER)', 'a//comment', 'a"b', 'a\\b', 'a\0b']) assert.throws(() => deviceSigningConfig(value))
  assert.match(deviceSigningConfig('12345678-1234-1234-1234-123456789ABC'), /GUGU_PROFILE_App = 12345678-/)
})
