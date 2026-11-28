// Run on macOS after build:app with pnpm exec electron scripts/smoke/first-application-menu.cjs.
// Launch the real main entry. Its first BrowserWindow is created after the ready menu and before the session host loads preferences.
const assert = require('node:assert/strict')
const { mkdtempSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { app, Menu } = require('electron')

assert.equal(process.platform, 'darwin')
const root = resolve(__dirname, '../..')
const profile = mkdtempSync(join(tmpdir(), 'gugu-first-menu-'))
process.env.GUGU_USER_DATA_DIR = profile
process.env.GUGU_HOME = join(profile, 'home')
process.env.GUGU_TEST_MODE = '1'
app.setAppPath(root)
app.once('browser-window-created', () => {
  try {
    const items = Menu.getApplicationMenu().items
    const appItems = items.find(item => item.role === 'appmenu').submenu.items
    // Settings is the application-specific action between About and Services.
    const settings = appItems.slice(0, appItems.findIndex(item => item.role === 'services'))
      .find(item => item.type === 'normal' && !item.role)
    const closeLabel = Menu.buildFromTemplate([{ role: 'close' }]).items[0].label
    const close = items.find(item => item.role === 'filemenu').submenu.items.find(item => item.label === closeLabel)
    assert.ok(settings, 'Settings menu item exists')
    assert.ok(close, 'Close Window menu item exists')
    process.stdout.write(JSON.stringify({ settings: settings.accelerator ?? null, close: close.accelerator ?? null }) + '\n')
    assert.equal(settings?.accelerator, 'CmdOrCtrl+,')
    assert.equal(close?.accelerator, 'CmdOrCtrl+W')
    setImmediate(() => app.exit(0))
  } catch (error) {
    console.error(error)
    setImmediate(() => app.exit(1))
  }
})
require(join(root, require(join(root, 'package.json')).main))
