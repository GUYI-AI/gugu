const base = 'https://download.gugu.nextmind.space/releases/vendor/'

// These are the environment aliases read by @electron/get's mirrorVar().
function electronKeys(name) {
  const snake = name.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase()
  return [
    `npm_config_electron_${name.toLowerCase()}`,
    `NPM_CONFIG_ELECTRON_${snake.toUpperCase()}`,
    `npm_config_electron_${snake}`,
    `npm_package_config_electron_${name}`,
    `npm_package_config_electron_${snake}`,
    `ELECTRON_${snake.toUpperCase()}`,
  ]
}

/** The pinned production archives have one origin, including installers' implicit requests. */
function configureVendorDownloads(env = process.env) {
  for (const key of electronKeys('mirror')) env[key] = base + 'electron/'
  for (const key of ['ELECTRON_BUILDER_BINARIES_MIRROR', 'npm_config_electron_builder_binaries_mirror', 'NPM_CONFIG_ELECTRON_BUILDER_BINARIES_MIRROR', 'npm_package_config_electron_builder_binaries_mirror']) env[key] = base + 'electron-builder/'
  // Inherited path, filename or version overrides must not select an unreviewed archive.
  for (const name of ['customDir', 'customFilename', 'customVersion']) {
    for (const key of electronKeys(name)) delete env[key]
  }
  for (const key of ['ELECTRON_BUILDER_BINARIES_DOWNLOAD_OVERRIDE_URL', 'ELECTRON_BUILDER_BINARIES_CUSTOM_DIR', 'NPM_CONFIG_ELECTRON_BUILDER_BINARIES_CUSTOM_DIR', 'npm_config_electron_builder_binaries_custom_dir', 'npm_package_config_electron_builder_binaries_custom_dir']) delete env[key]
  return env
}

module.exports = { configureVendorDownloads }
