// Same Node prebuilds as better-sqlite3 12.11.1; refuse unverified archives before extraction/load.
const { createHash } = require('node:crypto')
const { readFileSync } = require('node:fs')
const { basename } = require('node:path')
const base = 'https://download.gugu.nextmind.space/releases/vendor/better-sqlite3/v12.11.1/'
const pins = {
  "better-sqlite3-v12.11.1-node-v137-darwin-arm64.tar.gz": "6eaefc8a9c088fea873365f7db2c0f89be6ea021ede62f6a71832f5130826a93",
  "better-sqlite3-v12.11.1-node-v137-darwin-x64.tar.gz": "f9fe570a2ef7d6069196dd595f49bc8592574963dd1f249dcaa8878626773fc9",
  "better-sqlite3-v12.11.1-node-v137-linux-arm64.tar.gz": "60da4cbe1b1714c8db62f2ee71a9928cde5303dab57bde14c02debd12a784439",
  "better-sqlite3-v12.11.1-node-v137-linux-x64.tar.gz": "99c43785639d5d3690c396ba245ee680ac8b469a46b19233a3546f0eb7f8e312",
  "better-sqlite3-v12.11.1-node-v137-win32-arm64.tar.gz": "a6d712a918ece580882f83aee8c02d37c8841036eef68d208d71eb255d041e80",
  "better-sqlite3-v12.11.1-node-v137-win32-x64.tar.gz": "4ee5e653174d6ddd301605d351798cdae2613da06c4f37ecdce263021fcf1255"
}
function configure (opts) {
  if (opts.pkg.name !== 'better-sqlite3') return
  const file = `better-sqlite3-v${opts.pkg.version}-node-v${opts.abi}-${opts.platform}${opts.libc || ''}-${opts.arch}.tar.gz`
  opts.download = base + file
  delete opts.token
  // Retain upstream's source-build fallback for another ABI/libc/version; never request GitHub.
  if (opts.pkg.version !== '12.11.1' || opts.runtime !== 'node' || !pins[file]) {
    opts.buildFromSource = true
    return
  }
}
function verifyArchive (file, opts, url) {
  if (opts.pkg.name !== 'better-sqlite3') return
  const expected = pins[basename(url)]
  if (!expected || url !== base + basename(url)) throw new Error('Unreviewed SQLite prebuild origin')
  const actual = createHash('sha256').update(readFileSync(file)).digest('hex')
  if (actual !== expected) throw new Error('SQLite prebuild SHA256 mismatch; archive was not extracted or loaded')
}
module.exports = { configure, verifyArchive, pins }
