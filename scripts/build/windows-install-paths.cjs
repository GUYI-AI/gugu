const fs = require('node:fs')
const path = require('node:path')

// @@@short-stage - the Windows installer extracts the package to `<install dir><STAGE_SUFFIX>\<file>` (see
// build-resources/nsis/install-transaction.ps1). Its extractor fails on paths longer than MAX_PATH, so the deepest
// packaged file plus that prefix must fit, for the longest default install location: a per-user install under the
// longest Windows user name (20 characters). The margin leaves room for a deeper dependency than today's before a
// user's install breaks; when it runs out, packaging fails here instead.
const STAGE_SUFFIX = '.new'
const MAX_PATH = 259 // characters, without the terminating NUL
const MARGIN = 20
const INSTALL_PARENT = `C:\\Users\\${'u'.repeat(20)}\\AppData\\Local\\Programs\\`

/** electron-builder's getWindowsInstallationDirName for the assisted installer (oneClick: false). */
function windowsInstallDirName(appInfo) {
  return /^[-_+0-9a-zA-Z .]+$/.test(appInfo.productFilename) ? appInfo.productFilename : appInfo.sanitizedName
}

/** The longest path relative to `root`, Windows separators, without following links. */
function deepestRelativePath(root) {
  let deepest = ''
  const walk = (dir, relative) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const child = relative ? `${relative}\\${entry.name}` : entry.name
      if (child.length > deepest.length) deepest = child
      if (entry.isDirectory()) walk(path.join(dir, entry.name), child)
    }
  }
  walk(root, '')
  return deepest
}

function checkWindowsStagePaths({ appOutDir, installDirName }) {
  const deepest = deepestRelativePath(appOutDir)
  const longest = `${INSTALL_PARENT}${installDirName}${STAGE_SUFFIX}\\${deepest}`
  if (longest.length > MAX_PATH - MARGIN) {
    throw new Error(
      `[windows-stage-path] the installer would extract ${longest.length} characters deep (limit ${MAX_PATH}, ` +
        `margin ${MARGIN}): ${longest}. Shorten the deepest packaged path or the installer's stage prefix.`,
    )
  }
  return { length: longest.length, budget: MAX_PATH - MARGIN, deepest }
}

module.exports = { STAGE_SUFFIX, MAX_PATH, MARGIN, INSTALL_PARENT, windowsInstallDirName, deepestRelativePath, checkWindowsStagePaths }
