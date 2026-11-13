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
// @@@wide-invalidation — 解析出来的规则顺带查两种「写得对、却让大片页面重算」的选择器。两条都是 Blink 失效集的结构性后果,
// 和页面当下长什么样无关,所以能静态判:
//
// 1. universal-sibling / tag-sibling:兄弟组合子(+ / ~)左边那一段没有类 / id / 属性。Blink 的兄弟失效集只能按这三样记,
//    左边什么都没有(`*`、`:not(…)`、伪类)或只有标签(`li + li`、`:is(th, td) + …`)的规则都进同一个「通用」集:文档里任何一次
//    插入、移除节点,都拿这个集去重查它后面的兄弟 —— 右边是 `*` 就整棵子树作废,右边是标签就重算那些兄弟里所有这种标签。实撞:
//    `.mg .tool-app-fields > * + *` 随 App 页的样式表载入后常驻,此后每次切项目群都把整页重算一遍(5.4 万节点,单次 600–1000 ms);
//    `:is(th, td) + :is(th, td)` 让每来一条消息都重算聊天里所有表格的单元格。
//    改法:不用兄弟组合子(`> :not(:first-child)`),或者左边给一个类 / 属性。
//    只有标签的那种(tag-sibling)在 App 自己的文档里放行:那是无类名的底样式,文档小,也不和主文档共用失效集。
// 2. has-off-subject:`:has()` 写在被设样式的元素之外(`A:has(X) B`、`A:has(X) + B`)。Blink 给所有这类规则只留**一个**失效集
//    (按伪类记,不按规则记):任何一条让某个祖先被标记后,那个祖先里每次有节点增删改,它的后代里凡是命中「所有这类规则的
//    B 的并集」的都重算。实撞:`[data-chat-surface]:has(.gg-phone-task-card) [data-running-bar-content]` 把整个聊天列标成祖先,
//    并集里有 `button`、`input`、`[role]`、`[data-slot]`,于是鼠标每划过一条消息都重算每一行里的十几个元素,行越多越慢。
//    改法:`:has()` 只写在被设样式的元素自己身上(`B:has(~ X)`、`X ~ B`),或者由知道这个状态的组件直接给 B 挂属性。
//    写在自己身上的 `:has()` 只作废那一个元素。

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
// App 自己的文档(App 页、预装 App):无类名的底样式靠标签写兄弟规则,tag-sibling 在这里放行(见上)。
const APP_DOCUMENT_FRAGMENTS = ['/session/app-runtime/ui/', '/preinstalled-apps/']

function collect(dir, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.storybook') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORIES.has(entry.name)) continue
      collect(full, found)
    } else if (entry.isFile() && (path.extname(entry.name) === '.css' || entry.name.endsWith('.css.ts'))) {
      const posix = full.split(path.sep).join('/')
      if (SKIPPED_PATH_FRAGMENTS.some((fragment) => posix.includes(fragment))) continue
      found.push(full)
    }
  }
  return found
}

// 选择器列表 → 每个复合选择器是 [{ comb, simples }];simple = { t: class|id|attr|tag|univ|nest|pseudo|pe, name, args?, raw? }。
// 只有带选择器参数的伪类(:is / :where / :not / :has …)才往里解析。
export function parseSelectorList(source) {
  let i = 0
  const ident = () => {
    const start = i
    while (i < source.length) {
      if (source[i] === '\\') { i += 2; continue }
      if (!/[\w\-\u00a0-\uffff%]/.test(source[i])) break
      i++
    }
    return source.slice(start, i)
  }
  const balanced = () => {
    const start = i
    for (let depth = 1; i < source.length && depth; i++) {
      const ch = source[i]
      if (ch === '\\') i++
      else if (ch === '"' || ch === "'") { for (i++; i < source.length && source[i] !== ch; i++) if (source[i] === '\\') i++ }
      else if (ch === '(' || ch === '[') depth++
      else if (ch === ')' || ch === ']') depth--
    }
    return source.slice(start, i - 1)
  }
  const compound = () => {
    const simples = []
    for (;;) {
      const ch = source[i]
      if (ch === '.') { i++; simples.push({ t: 'class', name: ident() }) }
      else if (ch === '#') { i++; simples.push({ t: 'id', name: ident() }) }
      else if (ch === '[') { i++; simples.push({ t: 'attr', raw: balanced() }) }
      else if (ch === '*') { i++; simples.push({ t: 'univ' }) }
      else if (ch === '&') { i++; simples.push({ t: 'nest' }) }
      else if (ch === ':') {
        i++
        const element = source[i] === ':'
        if (element) i++
        const name = ident().toLowerCase()
        const simple = { t: element ? 'pe' : 'pseudo', name }
        if (source[i] === '(') {
          i++
          simple.raw = balanced()
          if (/^(is|where|not|has|matches|-webkit-any|-moz-any)$/.test(name)) simple.args = parseSelectorList(simple.raw)
        }
        simples.push(simple)
      } else if (ch !== undefined && /[\w\\\u00a0-\uffff-]/.test(ch)) simples.push({ t: 'tag', name: ident().toLowerCase() })
      else break
    }
    return simples
  }
  const list = []
  let current = [], comb = null
  while (i < source.length) {
    const ch = source[i]
    if (/\s/.test(ch)) i++
    else if (ch === ',') { i++; list.push(current); current = []; comb = null }
    else if (ch === '>' || ch === '+' || ch === '~') { i++; comb = ch }
    else {
      const before = i
      const simples = compound()
      if (i === before) { i++; continue }
      current.push({ comb: current.length ? comb ?? ' ' : comb, simples })
      comb = null
    }
  }
  if (current.length) list.push(current)
  return list
}
// 兄弟组合子左边这一段靠什么圈定元素:'key' = 类 / id / 属性(Blink 能按它记失效集),或 `:is()` / `:where()` 里每个分支的最右
// 一段都有;'tag' = 只有标签;null = 什么都没有。`:not()` / `:has()` 和别的伪类不算。嵌套符 `&` 代表外层选择器,算 'key'。
function siblingKey(simples) {
  const arms = (simple) => simple.t === 'pseudo' && /^(is|where|matches|-webkit-any|-moz-any)$/.test(simple.name) && simple.args?.length > 0
    ? simple.args.map((arm) => siblingKey(arm.at(-1)?.simples ?? [])) : null
  if (simples.some((simple) => ['class', 'id', 'attr', 'nest'].includes(simple.t) || arms(simple)?.every((key) => key === 'key'))) return 'key'
  if (simples.some((simple) => simple.t === 'tag' || arms(simple)?.every((key) => key !== null))) return 'tag'
  return null
}
/** 一个选择器(可以是逗号列表)撞了哪几条:'universal-sibling'、'tag-sibling'、'has-off-subject'。 */
export function wideInvalidation(selector) {
  const found = new Set()
  // subject:这个复合选择器的最右一段是不是被设样式的元素本身(顶层是;`:is()` / `:not()` 的分支在最右一段里时也是)。
  const walk = (complex, subject) => complex.forEach((part, index) => {
    const onSubject = subject && index === complex.length - 1
    if ((part.comb === '+' || part.comb === '~') && index > 0) {
      const key = siblingKey(complex[index - 1].simples)
      if (key !== 'key') found.add(key === 'tag' ? 'tag-sibling' : 'universal-sibling')
    }
    for (const simple of part.simples) {
      if (simple.t !== 'pseudo' || !simple.args) continue
      if (simple.name === 'has') { if (!onSubject) found.add('has-off-subject') }
      else for (const arm of simple.args) walk(arm, onSubject)
    }
  })
  for (const complex of parseSelectorList(selector)) walk(complex, true)
  return [...found]
}
// @@@has-off-subject-known — 这道判据进来之前就有的写法。它们的 `:has()` 都挂在小组件上(输入框、页签、设置分组、一行消息),
// 重算范围到不了整页,先留着。**只许减少**:改掉一处就把数减掉(数对不上闸会红);❌ 往里加新的 —— 新写法照上面的改法写。
export const HAS_OFF_SUBJECT_KNOWN = {
  'apps/desktop/preinstalled-apps/workspace/style.css': 4,
  'apps/desktop/src/components/chat/messageBubbleChrome.css': 1,
  'apps/desktop/src/components/chat/pinned-topics.css': 3,
  'apps/desktop/src/components/referralPreview/referralPreview.css': 1,
  'apps/desktop/src/components/settings/settings-content.css': 1,
  'apps/desktop/src/mobile/phone-look.css': 1,
  'apps/desktop/src/mobile/phone-shell.css': 6,
  'apps/desktop/src/session/app-runtime/ui/ui.css': 1,
  'apps/desktop/src/session/renderer/index.css': 3,
  'apps/desktop/src/session/renderer/lib/ui/assistant-ui/thread-scroll-to-bottom.css.ts': 1,
  'packages/session-ui/src/react/components/chat-composer/chat-composer.css.ts': 3,
  'packages/session-ui/src/react/primitives/combobox/combobox.css.ts': 1,
  'packages/session-ui/src/react/primitives/input-group/input-group.css.ts': 4,
}
// 同一批里写成 Tailwind 工具类的(lib/ui 的 field.tsx、input-group.tsx);编译后的表由单测查(defaultBorderColor.test.ts)。
export const HAS_OFF_SUBJECT_KNOWN_UTILITIES = [
  '@md/field-group:has-[>[data-slot=field-content]]:[&>[role=checkbox],[role=radio]]:mt-px',
  'has-[>[data-align=block-end]]:[&>input]:pt-3',
  'has-[>[data-align=block-start]]:[&>input]:pb-3',
  'has-[>[data-align=inline-end]]:[&>input]:pr-1.5',
  'has-[>[data-align=inline-start]]:[&>input]:pl-1.5',
  'has-[>[data-slot=field-content]]:[&>[role=checkbox],[role=radio]]:mt-px',
]
const REASONS = {
  'universal-sibling': '兄弟组合子左边没有类 / 属性 / 标签,每次增删节点都会作废后面兄弟的样式',
  'tag-sibling': '兄弟组合子左边只有标签,每次增删节点都会重算后面兄弟里所有命中右边的元素',
  'has-off-subject': ':has() 不在被设样式的元素自己身上,它所在的祖先里每次增删节点都会重算一大批后代',
}
/** vanilla-extract 源文件(.css.ts)里写出来的选择器:`globalStyle('…')` 的第一个参数,和 `selectors: { '…': {…} }` 那样的键。
 *  插值 `${…}` 是别处定义的类名,按一个类算。返回 [{ line, selector, reason }]。 */
export function wideInvalidationInVanillaExtract(text) {
  // 注释里的引号会把字面量配错对:先把注释抹成等长空白(行号不变)。
  const source = text.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' ')).replace(/(^|[^:'"`\\])\/\/[^\n]*/g, (m, p) => p + ' '.repeat(m.length - p.length))
  const hits = []
  const literal = /(['"`])((?:\\[\s\S]|(?!\1)[^\\])*)\1/g
  for (let match; (match = literal.exec(source)); ) {
    const after = source.slice(literal.lastIndex, literal.lastIndex + 12)
    const before = source.slice(Math.max(0, match.index - 40), match.index)
    const isKey = /^\s*\]?\s*:\s*\{/.test(after)
    const isGlobal = /globalStyle\(\s*$/.test(before)
    if ((!isKey && !isGlobal) || match[2].startsWith('@')) continue
    const selector = match[2].replace(/\$\{[^}]*\}/g, '.interpolated')
    for (const reason of wideInvalidation(selector)) hits.push({ line: source.slice(0, match.index).split('\n').length, selector: match[2], reason })
  }
  return hits
}
/** 一棵 postcss 树里撞线的规则:[{ line, selector, outermost, reason }]。原生嵌套先接回外层选择器再判;outermost 是最外层那条的选择器。 */
export function wideInvalidationIn(root) {
  const hits = []
  root.walkRules((rule) => {
    if (rule.parent?.type === 'atrule' && /keyframes$/.test(rule.parent.name)) return
    const outer = []
    for (let parent = rule.parent; parent; parent = parent.parent) if (parent.type === 'rule') outer.push(parent.selector)
    for (const own of rule.selectors) {
      const selector = outer.reduce((inner, parent) => inner.includes('&') ? inner.replaceAll('&', `:is(${parent})`) : `:is(${parent}) ${inner}`, own)
      for (const reason of wideInvalidation(selector)) hits.push({ line: rule.source?.start?.line ?? 0, selector: own.replace(/\s+/g, ' '), outermost: outer.at(-1) ?? own, reason })
    }
  })
  return hits
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const files = collect(repoRoot).sort()
  const failures = []
  const known = new Map()
  for (const file of files) {
    const source = readFileSync(file, 'utf8')
    const rel = path.relative(repoRoot, file).split(path.sep).join('/')
    try {
      // `from` 让报错带上真实路径;不做任何插件,只要解析器点头。
      const appDocument = APP_DOCUMENT_FRAGMENTS.some((fragment) => `/${rel}`.includes(fragment))
      const hits = (file.endsWith('.ts') ? wideInvalidationInVanillaExtract(source) : wideInvalidationIn(postcss.parse(source, { from: file })))
        .filter((hit) => !(appDocument && hit.reason === 'tag-sibling'))
      const offSubject = hits.filter((hit) => hit.reason === 'has-off-subject')
      known.set(rel, offSubject.length)
      for (const hit of offSubject.length === (HAS_OFF_SUBJECT_KNOWN[rel] ?? 0) ? hits.filter((one) => one.reason !== 'has-off-subject') : hits) {
        failures.push(`${rel}:${hit.line} — \`${hit.selector}\`: ${REASONS[hit.reason]}(@@@wide-invalidation ${hit.reason})`)
      }
      if (offSubject.length !== (HAS_OFF_SUBJECT_KNOWN[rel] ?? 0)) {
        failures.push(`${rel} — has-off-subject 有 ${offSubject.length} 处,HAS_OFF_SUBJECT_KNOWN 记的是 ${HAS_OFF_SUBJECT_KNOWN[rel] ?? 0}:多了就照上面改掉新写的那处,少了就把记的数减到 ${offSubject.length}`)
      }
    } catch (error) {
      const where = error.line ? `:${error.line}:${error.column ?? 0}` : ''
      failures.push(`${rel}${where} — ${error.reason ?? error.message}`)
    }
  }
  for (const rel of Object.keys(HAS_OFF_SUBJECT_KNOWN)) if (!known.has(rel)) failures.push(`${rel} — HAS_OFF_SUBJECT_KNOWN 里记着,文件已经不在了:把这一行删掉`)

  if (failures.length > 0) {
    console.error('css parse guard FAILED — 这些文件 PostCSS 读不懂(构建时会整份丢掉),或写了让大片页面重算的选择器:')
    for (const line of failures) console.error(`  ${line}`)
    console.error('\n⚠️ 最常见的一种:注释里写了 `*/`(比如 `text-*/font-*`),把注释提前闭合。')
    process.exit(1)
  }

  console.log(`css parse guard passed: ${files.length} stylesheet(s) parsed`)
}
