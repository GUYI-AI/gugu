#!/usr/bin/env node

// @@@css-blind-gate (Refs #6103) — 四门对 CSS 语法错误是全盲的。
//
// 实撞:2026-09-22 的 token 批次往 `tokens.css` 的注释里写了 `text-*/font-*`,中间那个 `*/`
// 把 CSS 注释**提前闭合**,整个文件 postcss 解析失败 —— 而 `typecheck` / `lint` / `test:unit`
// 三门**全绿**,一个都没照出来。照出来的是 `build:renderer`(它真跑一次 PostCSS)与
// `session-browser`(它真挂一次样式表),而这两样都不在 PR 的必过门里。
//
// 病根不是谁粗心:那三门根本不读 CSS —— tsc 不认识 .css,eslint 的解析器不管 .css,
// vitest 只在真挂样式的那几个 project 里才碰它。一个没人读的文件,写错了当然没人红。
//
// 这道闸只做一件事:把每个 .css 交给 postcss 真解析一遍,语法错就红。
// ❌ 它不判样式对不对(那是 check-ui-visual-spec 的活),只判「这个文件还能不能被编译器读懂」。
//
// @@@universal-sibling — 解析出来的规则顺带查一种「写得对、却让整页变慢」的选择器:兄弟组合子(+ / ~)左边的那一段
// 什么特征都没有(`*`、`:not(…)`、伪类)。Blink 认不出该盯哪个元素,只好对文档里每一次插入节点都重查插入点后面的兄弟,
// 右边也没类名时就把那些兄弟的整棵子树作废。实撞:`.mg .tool-app-fields > * + *` 随 App 页的样式表载入后常驻,
// 此后每次切项目群(弹层挂到 body 下)都把整页重算一遍,页面越大越慢(5.4 万节点的页面,单次 600–1000 ms)。
// 改法:左边给一个类 / 属性 / 标签,或者不用兄弟组合子(`> :not(:first-child)`)。

import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import postcss from 'postcss'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const SKIPPED_DIRECTORIES = new Set([
  '.git', '.next', '.vite', 'build', 'coverage', 'dist', 'dist-electron',
  'node_modules', 'out', 'playwright-report', 'test-results', 'archive', 'tmp',
])
// 别的判据拿「坏 CSS」当样本(tests/fixtures/ui-state-debt-check/invalid-css),那是它们的阳性对照,
// 不是产品文件 ⇒ 这里跳过。❌ 别为了让这道闸变绿去改那些样本。
const SKIPPED_PATH_FRAGMENTS = ['/tests/fixtures/']

function collect(dir, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.storybook') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORIES.has(entry.name)) continue
      collect(full, found)
    } else if (entry.isFile() && path.extname(entry.name) === '.css') {
      const posix = full.split(path.sep).join('/')
      if (SKIPPED_PATH_FRAGMENTS.some((fragment) => posix.includes(fragment))) continue
      found.push(full)
    }
  }
  return found
}

// 按顶层组合子切开(括号里的不切),返回 [段, 组合子, 段, …]。
function compounds(selector) {
  const out = []
  let current = '', depth = 0
  for (const ch of selector) {
    if (ch === '(' || ch === '[') depth++
    if (ch === ')' || ch === ']') depth--
    if (depth === 0 && (ch === '>' || ch === '+' || ch === '~' || ch === ' ')) {
      if (current.trim()) out.push(current.trim())
      if (ch !== ' ') out.push(ch)
      current = ''
    } else current += ch
  }
  if (current.trim()) out.push(current.trim())
  return out
}
// 没有类 / id / 属性 / 标签。`:is()` / `:where()` 的参数算这一段的特征(Blink 也这么取);`:not()` / `:has()` 和别的伪类不算。
const featureless = (compound) => !/[\w.#[]/.test(compound
  .replace(/:(?:is|where)\(((?:[^()]|\([^()]*\))*)\)/g, ' $1 ')
  .replace(/::?[\w-]+(\((?:[^()]|\([^()]*\))*\))?/g, '')
  .replace(/\*/g, ''))

const files = collect(repoRoot).sort()
const failures = []
for (const file of files) {
  const source = readFileSync(file, 'utf8')
  try {
    // `from` 让报错带上真实路径;不做任何插件,只要解析器点头。
    postcss.parse(source, { from: file }).walkRules((rule) => {
      if (rule.parent?.type === 'atrule' && /keyframes$/.test(rule.parent.name)) return
      for (const selector of rule.selectors) {
        const parts = compounds(selector)
        if (parts.some((part, index) => (part === '+' || part === '~') && index > 0 && featureless(parts[index - 1]))) {
          failures.push(`${path.relative(repoRoot, file)}:${rule.source?.start?.line ?? 0} — \`${selector}\`: 兄弟组合子左边没有类 / 属性 / 标签,每次插入节点都会作废后面兄弟的样式(@@@universal-sibling)`)
        }
      }
    })
  } catch (error) {
    const rel = path.relative(repoRoot, file)
    const where = error.line ? `:${error.line}:${error.column ?? 0}` : ''
    failures.push(`${rel}${where} — ${error.reason ?? error.message}`)
  }
}

if (failures.length > 0) {
  console.error('css parse guard FAILED — 这些文件 PostCSS 读不懂(构建时会整份丢掉),或写了整页重算的兄弟选择器:')
  for (const line of failures) console.error(`  ${line}`)
  console.error('\n⚠️ 最常见的一种:注释里写了 `*/`(比如 `text-*/font-*`),把注释提前闭合。')
  process.exit(1)
}

console.log(`css parse guard passed: ${files.length} stylesheet(s) parsed`)
