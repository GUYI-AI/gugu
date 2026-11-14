const fs = require('node:fs')
const NODE_REQUIRE_BANNER = "import { createRequire as __guguPackedCreateRequire } from 'node:module'; const require = __guguPackedCreateRequire(import.meta.url);"

function nodeRequirePlugin() {
  return { name: 'packed-node-require', setup(builder) {
    builder.onLoad({ filter: /\.[cm]?js$/ }, args => {
      const contents = fs.readFileSync(args.path, 'utf8')
      // esbuild emits banners verbatim, outside its symbol-renaming graph. Remove
      // only our exact previous banner before parsing an already compacted input.
      return contents.includes(NODE_REQUIRE_BANNER)
        ? { contents: contents.replaceAll(NODE_REQUIRE_BANNER, ''), loader: 'js' }
        : null
    })
  } }
}

module.exports = { NODE_REQUIRE_BANNER, nodeRequirePlugin }
