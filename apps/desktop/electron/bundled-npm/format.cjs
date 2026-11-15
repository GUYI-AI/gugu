const ARCHIVE_NAME = 'npm.zip'
const MANIFEST_NAME = 'npm.json'
const FORMAT_VERSION = 1

function safeRelativePath(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    !/[\\:\0]/.test(value) &&
    value.split('/').every((part) => part && part !== '.' && part !== '..')
  )
}

function parseBundleManifest(value) {
  if (
    !value ||
    value.format !== FORMAT_VERSION ||
    value.archive !== ARCHIVE_NAME ||
    typeof value.version !== 'string' ||
    !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(value.version) ||
    typeof value.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.sha256) ||
    !Array.isArray(value.files) ||
    value.files.length === 0 ||
    !Array.isArray(value.bundledDependencies)
  ) {
    throw new Error('[bundled-npm] Invalid offline npm manifest')
  }
  const names = new Set()
  for (const file of value.files) {
    if (
      !file ||
      !safeRelativePath(file.path) ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      !Number.isInteger(file.mode) ||
      file.mode < 0 ||
      file.mode > 0o777 ||
      typeof file.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(file.sha256) ||
      names.has(file.path.toLowerCase())
    ) {
      throw new Error('[bundled-npm] Invalid or duplicate offline npm entry')
    }
    names.add(file.path.toLowerCase())
  }
  if (
    !value.bundledDependencies.every(
      (name) => typeof name === 'string' && /^(?:@[\w.-]+\/)?[\w.-]+$/.test(name)
    )
  ) {
    throw new Error('[bundled-npm] Invalid npm bundled dependency name')
  }
  const required = [
    'package.json',
    'bin/npm-cli.js',
    'bin/npx-cli.js',
    ...value.bundledDependencies.map((name) => `node_modules/${name}/package.json`)
  ]
  if (value.bundledDependencies.includes('node-gyp')) {
    required.push(
      'node_modules/node-gyp/bin/node-gyp.js',
      'node_modules/node-gyp/addon.gypi',
      'node_modules/node-gyp/gyp/gyp_main.py',
      'node_modules/node-gyp/gyp/pylib/gyp/input.py',
      'node_modules/node-gyp/src/win_delay_load_hook.cc'
    )
  }
  if (required.some((name) => !names.has(name.toLowerCase()))) {
    throw new Error('[bundled-npm] Offline npm archive is missing its runtime closure')
  }
  return value
}

module.exports = {
  ARCHIVE_NAME,
  MANIFEST_NAME,
  FORMAT_VERSION,
  parseBundleManifest,
  safeRelativePath
}
