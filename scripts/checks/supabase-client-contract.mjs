// The client's backend contract, read from source: every PostgREST RPC the client calls with the exact
// named arguments it passes, every Edge Function it invokes by name, and every table/column it selects.
//
// "What the client needs" is not a hand-kept allowlist; it is read from the call sites. Two callers
// share this one reader: the Source check (check-supabase-client-contract.mjs) on every PR, and the
// release backend-contract gate, which compares the result with the live backend before a client
// ships ahead of its database. The release gate supplies what is not public source: a call-site
// filter from the product entrypoints, reviewed non-literal call shapes, and the schema each data
// client is bound to. Each is an optional hook below; without it the reader is pure source rules.
//
// Fail loud: a call site this reader cannot read exactly is an error, never a silent skip. A skipped
// site would make the release gate quietly under-check the very release it guards.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import ts from 'typescript'

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx'])
const RPC_CALL = /\.rpc\(\s*(['"`])([A-Za-z0-9_]+)\1\s*(,|\))/g
// Both ways the client selects a PostgREST profile: `.schema('x')` per call, `schema: 'x'` at
// client construction. `public` is PostgREST's default profile and is always in play.
const SCHEMA_SELECTOR = /(?:\.schema\(\s*|schema:\s*)(['"])([a-z_]+)\1/g

function walk(dir, out) {
  if (statSync(dir).isFile()) { out.push(dir); return out }
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) walk(full, out)
    else if (SOURCE_EXTENSIONS.has(entry.slice(entry.lastIndexOf('.')))) out.push(full)
  }
  return out
}

// This reviewed host query is outside renderer/core. Keep RPC discovery on its original roots.
export function clientDataSourceRoots(rootDirs, repoRoot) {
  return [...rootDirs, join(repoRoot, 'apps/desktop/electron/desktopFileAccess.ts')]
}

// @@@brace-scan - The argument object is a TS expression, not JSON: it holds ternaries, spreads,
// template strings and nested objects. We only need the TOP-LEVEL key names, so scan the balanced
// brace region and collect identifiers at depth 1 that sit immediately before a `:`. Strings and
// comments are skipped so a `:` or `}` inside them cannot desync the scan.
function readOptionalRpcSpread(text, openBraceIndex, spreadIndex, file) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  let object
  const visit = (node) => {
    if (ts.isObjectLiteralExpression(node) && node.getStart(source) === openBraceIndex) object = node
    else if (node.pos <= openBraceIndex && node.end > openBraceIndex) ts.forEachChild(node, visit)
  }
  visit(source)
  const spread = object?.properties.find((node) => ts.isSpreadAssignment(node) && node.getStart(source) === spreadIndex)
  if (!spread) return null
  const unwrap = (node) => {
    while (ts.isParenthesizedExpression(node)) node = node.expression
    return node
  }
  const expression = unwrap(spread.expression)
  let branch
  if (ts.isConditionalExpression(expression)) {
    const empty = unwrap(expression.whenFalse)
    if (!ts.isObjectLiteralExpression(empty) || empty.properties.length !== 0) return null
    branch = unwrap(expression.whenTrue)
  } else if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
    branch = unwrap(expression.right)
  } else return null
  if (!ts.isObjectLiteralExpression(branch)) return null
  const keys = []
  for (const property of branch.properties) {
    // No shorthand, computed names, methods, nested spreads or inferred runtime objects.
    if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)) return null
    keys.push(property.name.text)
  }
  return { keys, end: spread.end }
}

function readTopLevelKeys(text, openBraceIndex, file) {
  const keys = []
  const optionalArgs = []
  let depth = 0
  let i = openBraceIndex
  let pendingKey = null
  let atKeyPosition = true

  while (i < text.length) {
    const ch = text[i]

    if (depth === 1 && atKeyPosition && text.startsWith('...', i)) {
      const spread = readOptionalRpcSpread(text, openBraceIndex, i, file)
      if (!spread) return null
      keys.push(...spread.keys)
      optionalArgs.push(...spread.keys)
      i = spread.end
      atKeyPosition = false
      pendingKey = null
      continue
    }

    if (ch === '/' && text[i + 1] === '/') {
      i = text.indexOf('\n', i)
      if (i === -1) return null
      continue
    }
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      if (end === -1) return null
      i = end + 2
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch
      i += 1
      while (i < text.length) {
        if (text[i] === '\\') i += 2
        else if (text[i] === quote) break
        else i += 1
      }
      if (i >= text.length) return null
      i += 1
      atKeyPosition = false
      pendingKey = null
      continue
    }
    if (ch === '{' || ch === '(' || ch === '[') {
      depth += 1
      i += 1
      if (depth === 1) atKeyPosition = true
      continue
    }
    if (ch === '}' || ch === ')' || ch === ']') {
      depth -= 1
      i += 1
      if (depth === 0) return { args: keys, optionalArgs }
      continue
    }
    if (depth === 1) {
      if (ch === ',') {
        atKeyPosition = true
        pendingKey = null
        i += 1
        continue
      }
      if (ch === ':' && pendingKey) {
        keys.push(pendingKey)
        pendingKey = null
        atKeyPosition = false
        i += 1
        continue
      }
      if (atKeyPosition && /[A-Za-z_$]/.test(ch)) {
        let j = i
        while (j < text.length && /[A-Za-z0-9_$]/.test(text[j])) j += 1
        pendingKey = text.slice(i, j)
        i = j
        continue
      }
      if (!/\s/.test(ch)) {
        // A computed key, spread, or shorthand — the call site is not statically exact.
        if (atKeyPosition) return null
        pendingKey = null
      }
    }
    i += 1
  }
  return null
}

// Locate `function name(...): T { return { ... } }` or `const name = (...) => ({ ... })` in the same
// file and return the index of its object literal's opening brace, or -1 when there is no such
// single-object-literal helper.
function findLocalHelperObjectLiteral(text, helperName) {
  const declared = new RegExp(
    `(?:function\\s+${helperName}\\s*\\(|(?:const|let)\\s+${helperName}\\s*(?::[^=]*)?=\\s*(?:async\\s*)?\\()`,
  ).exec(text)
  if (!declared) return -1

  const from = declared.index + declared[0].length
  const returned = /\)\s*(?::[^{=]*)?(?:=>\s*\(\s*|\{\s*return\s*)/.exec(text.slice(from))
  if (!returned) return -1

  let i = from + returned.index + returned[0].length
  while (i < text.length && /\s/.test(text[i])) i += 1
  return text[i] === '{' ? i : -1
}

// A conditional argument is exact only if every leaf is a readable object literal.
// Check all keys and require backend defaults for any key a branch can omit.
function readConditionalRpcArgument(text, argumentStart, file) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  if (source.parseDiagnostics.length) return null
  let argument
  const visit = (node) => {
    if (ts.isCallExpression(node) && node.arguments[1]?.getStart(source) === argumentStart) argument = node.arguments[1]
    else ts.forEachChild(node, visit)
  }
  visit(source)
  const unwrap = (node) => {
    while (node && ts.isParenthesizedExpression(node)) node = node.expression
    return node
  }
  if (!argument || !ts.isConditionalExpression(unwrap(argument))) return undefined
  const branches = []
  const collect = (node) => {
    node = unwrap(node)
    if (ts.isConditionalExpression(node)) return collect(node.whenTrue) && collect(node.whenFalse)
    if (!ts.isObjectLiteralExpression(node)) return false
    if (node.properties.some(property => !ts.isSpreadAssignment(property)
      && (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)))) return false
    const keys = readTopLevelKeys(text, node.getStart(source), file)
    if (!keys) return false
    branches.push(keys)
    return true
  }
  if (!collect(argument)) return null
  const args = [...new Set(branches.flatMap(branch => branch.args))]
  return { args, optionalArgs: args.filter(key => branches.some(branch => !branch.args.includes(key) || branch.optionalArgs.includes(key))) }
}

/**
 * Derive the client's PostgREST RPC contract from the source tree.
 * `extraRpc(repoRoot, includeSite)` may add one RPC reached by a reviewed transport that is not a `.rpc(` call.
 * @returns {Map<string, {args: string[], sites: string[], optionalArgs?: string[]}>} rpc name -> union of named args
 */
export function extractClientRpcContract(rootDirs, repoRoot, includeSite = () => true, { extraRpc } = {}) {
  const files = []
  for (const dir of rootDirs) walk(dir, files)

  const contract = new Map()
  const unreadable = []

  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    RPC_CALL.lastIndex = 0
    let match
    while ((match = RPC_CALL.exec(text)) !== null) {
      if (!includeSite(file, match.index)) continue
      const name = match[2]
      const terminator = match[3]
      const site = `${relative(repoRoot, file)}:${text.slice(0, match.index).split('\n').length}`

      let args = []
      let optionalArgs = []
      if (terminator === ',') {
        let k = RPC_CALL.lastIndex
        while (k < text.length && /\s/.test(text[k])) k += 1

        let keys = text[k] === '{' ? readTopLevelKeys(text, k, file) : readConditionalRpcArgument(text, k, file)
        if (!keys && text[k] !== '{') {
          if (keys === null) {
            unreadable.push(`${site} — ${name}: argument branches are not statically exact`)
            continue
          }
          // @@@one-hop-helper - Some call sites build the argument object in a small local helper
          // (`client.rpc('x', argsOf(input))`). Resolve exactly one hop to a same-file helper whose
          // body is a single object-literal return; anything deeper is not statically exact.
          const helper = /^([A-Za-z_$][A-Za-z0-9_$]*)\(/.exec(text.slice(k))
          const braceAt = helper ? findLocalHelperObjectLiteral(text, helper[1]) : -1
          if (braceAt === -1) {
            unreadable.push(`${site} — ${name}: argument is not an object literal`)
            continue
          }
          keys = readTopLevelKeys(text, braceAt, file)
        }
        if (keys === null) {
          unreadable.push(`${site} — ${name}: argument object is not statically exact`)
          continue
        }
        args = keys.args
        optionalArgs = keys.optionalArgs
      }

      const existing = contract.get(name)
      if (existing) {
        for (const a of args) if (!existing.args.includes(a)) existing.args.push(a)
        if (optionalArgs.length) existing.optionalArgs = [...new Set([...(existing.optionalArgs ?? []), ...optionalArgs])]
        existing.sites.push(site)
      } else {
        contract.set(name, { args: [...args], sites: [site], ...(optionalArgs.length ? { optionalArgs: [...new Set(optionalArgs)] } : {}) })
      }
    }
  }

  const reviewed = extraRpc?.(repoRoot, includeSite)
  if (reviewed) {
    const previous = contract.get(reviewed.name)
    contract.set(reviewed.name, { args: [...new Set([...(previous?.args ?? []), ...reviewed.args])],
      sites: [...(previous?.sites ?? []), ...reviewed.sites],
      ...(previous?.optionalArgs ? { optionalArgs: previous.optionalArgs } : {}) })
  }
  if (unreadable.length > 0) {
    throw new Error(
      `supabase client contract cannot read ${unreadable.length} client .rpc() call site(s) exactly; ` +
      `the release contract gate refuses to under-check a release:\n  ${unreadable.join('\n  ')}`,
    )
  }

  if (contract.size === 0) {
    throw new Error('supabase client contract found zero client .rpc() call sites — the scan roots are wrong')
  }

  for (const entry of contract.values()) {
    entry.args.sort()
    entry.optionalArgs?.sort()
  }
  return new Map([...contract.entries()].sort((a, b) => a[0].localeCompare(b[0])))
}

// @@@edge-fn-contract — both ways the code reaches an Edge Function: the supabase-js helper
// `.functions.invoke('<name>')`, and a hand-built `…/functions/v1/<name>` URL (the Electron main
// process has no supabase-js client for this and fetches the route directly — model-access is
// exactly that shape, which is why a helper-only scan saw nothing). Only literal names are a
// contract we can prove; a computed name is invisible either way, so we do not pretend to cover it.
// 函数名后面可以跟一段子路由(`attachments/urls`):要部署的是那个函数(`attachments`),子路由是它自己分的。
const EDGE_FUNCTION_INVOKE = /\.functions\s*\.invoke\s*\(\s*['"`]([\w-]+)(?:\/[\w/-]*)?['"`]/g
// 终止断言不能省:没有它,`${base}/functions/v1/pay-${kind}` 会被贪婪捕获成残名 `pay-`,门去探一个
// 永远 404 的名字 → 拦死发版。要求名字后面紧跟引号/斜杠/查询符/空白/行尾,并拒收以 `-` 结尾的残名。
const EDGE_FUNCTION_URL = /\/functions\/v1\/([\w-]*[\w])(?=["'`/?\s)]|$)/g
// 命中了 invoke 但首参不是字面量 —— 用来 fail loud,而不是静默漏掉一个函数(见下方说明)。
const EDGE_FUNCTION_INVOKE_ANY = /\.functions\s*\.invoke\s*\(/g

/**
 * Every Edge Function the client actually calls by literal name.
 *
 * Same failure this gate already covers for RPCs, one layer over: a build shipped
 * `functions.invoke('model-access')` while production had never deployed that function, so the
 * quota panel and the platform model list both died on a 404 that surfaced only as
 * "Edge Function returned a non-2xx status code". RPCs had a gate; Edge Functions did not, and
 * nothing in CD deploys them — they go out by hand, which is exactly how one gets forgotten.
 * `reviewedNames(file, offset)` may name the functions a reviewed non-literal invoke reaches (null: not reviewed).
 * @returns {Set<string>}
 */
export function extractClientEdgeFunctions(rootDirs, { reviewedNames } = {}) {
  const files = []
  for (const dir of rootDirs) walk(dir, files)

  const names = new Set()
  const unreadable = []
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    for (const pattern of [EDGE_FUNCTION_INVOKE, EDGE_FUNCTION_URL]) {
      pattern.lastIndex = 0
      let match
      while ((match = pattern.exec(text)) !== null) names.add(match[1])
    }
    // 与同文件 extractClientRpcContract 同一套标准:读不懂的调用点是错误,不是静默跳过。静默跳过
    // 意味着谁把 invoke('model-access') 重构成常量引用,这个函数就悄悄退出契约、门从此永绿。
    EDGE_FUNCTION_INVOKE_ANY.lastIndex = 0
    let anyMatch
    while ((anyMatch = EDGE_FUNCTION_INVOKE_ANY.exec(text)) !== null) {
      const rest = text.slice(anyMatch.index + anyMatch[0].length).trimStart()
      if (/^['"`][\w-]+(?:\/[\w/-]*)?['"`]/.test(rest)) continue
      const reviewed = reviewedNames?.(file, anyMatch.index)
      if (reviewed) { for (const name of reviewed) names.add(name); continue }
      const line = text.slice(0, anyMatch.index).split('\n').length
      unreadable.push(`${relative(rootDirs[0], file)}:${line} — 函数名不是字面量,无法纳入契约`)
    }
  }
  if (unreadable.length > 0) {
    throw new Error(
      `supabase client contract cannot read ${unreadable.length} Edge Function call site(s) exactly; ` +
        `the release contract gate refuses to under-check a release:\n  ${unreadable.join('\n  ')}`,
    )
  }
  return names
}

/**
 * Derive which PostgREST profiles the client talks to, so the probe reads exactly those and a
 * newly-adopted schema is covered without editing the gate.
 * @returns {string[]}
 */
export function extractClientSchemas(rootDirs) {
  const files = []
  for (const dir of rootDirs) walk(dir, files)

  const schemas = new Set(['public'])
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    SCHEMA_SELECTOR.lastIndex = 0
    let match
    while ((match = SCHEMA_SELECTOR.exec(text)) !== null) schemas.add(match[2])
  }
  return [...schemas].sort()
}

function readDelimited(text, start, open, close) {
  let depth = 0
  let quote = null
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]
    if (quote) {
      if (ch === '\\') i += 1
      else if (ch === quote) quote = null
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch
      continue
    }
    if (ch === '/' && text[i + 1] === '/') {
      i = text.indexOf('\n', i)
      if (i === -1) return null
      continue
    }
    if (ch === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2)
      if (i === -1) return null
      i += 1
      continue
    }
    if (ch === open) depth += 1
    else if (ch === close && --depth === 0) return { body: text.slice(start + 1, i), end: i + 1 }
  }
  return null
}

function splitTopLevel(text, separator = ',') {
  const parts = []
  let start = 0
  let depth = 0
  let quote = null
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (quote) {
      if (ch === '\\') i += 1
      else if (ch === quote) quote = null
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch
    else if (ch === '(' || ch === '[' || ch === '{') depth += 1
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1
    else if (ch === separator && depth === 0) {
      parts.push(text.slice(start, i).trim())
      start = i + 1
    }
  }
  parts.push(text.slice(start).trim())
  return parts
}

function importTarget(file, specifier) {
  let base
  if (specifier.startsWith('.')) base = resolve(dirname(file), specifier)
  else if (specifier.startsWith('@gugu/core/')) {
    const marker = `${join('packages', 'core', 'src')}${specifier.slice('@gugu/core'.length)}`
    let root = dirname(file)
    while (dirname(root) !== root && !existsSync(join(root, 'packages', 'core', 'src'))) {
      root = dirname(root)
    }
    base = resolve(root, marker)
  } else return null
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

function findConstExpression(file, name, moduleBinding = false) {
  const text = readFileSync(file, 'utf8')
  if (moduleBinding) {
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
    for (const statement of source.statements) {
      if (!ts.isVariableStatement(statement) || !(statement.declarationList.flags & ts.NodeFlags.Const)) continue
      const row = statement.declarationList.declarations.find((entry) => ts.isIdentifier(entry.name) && entry.name.text === name)
      if (row?.initializer) return row.initializer.getText(source)
    }
    return null
  }
  const pattern = new RegExp(`\\b(?:export\\s+)?const\\s+${name}\\s*(?::[^=]+)?=`)
  const found = pattern.exec(text)
  if (!found) return null
  const start = found.index + found[0].length
  let depth = 0
  let quote = null
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]
    if (quote) {
      if (ch === '\\') i += 1
      else if (ch === quote) quote = null
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch
    else if (ch === '(' || ch === '[' || ch === '{') depth += 1
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1
    else if ((ch === ';' || ch === '\n') && depth === 0) {
      const soFar = text.slice(start, i).trim()
      const next = text.slice(i + 1).trimStart()
      if (!soFar) continue
      if (ch === '\n' && (/[=+,.]$/.test(soFar) || next.startsWith('.'))) continue
      return soFar
    }
  }
  return text.slice(start).trim()
}

function importedBinding(file, name) {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
  for (const statement of source.statements) {
    const imported = ts.isImportDeclaration(statement) && !statement.importClause?.isTypeOnly
      ? statement.importClause?.namedBindings : undefined
    const bindings = imported && ts.isNamedImports(imported) ? imported : null
    if (!bindings || !statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier)) continue
    for (const binding of bindings.elements) {
      if (!binding.isTypeOnly && binding.name.text === name) return {
        file: importTarget(file, statement.moduleSpecifier.text), name: (binding.propertyName ?? binding.name).text,
      }
    }
  }
  return null
}

function exportedString(name, file, seen) {
  const key = `export:${file}:${name}`
  if (seen.has(key)) return null
  const next = new Set(seen).add(key)
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
  for (const statement of source.statements) {
    if (ts.isVariableStatement(statement) && statement.declarationList.flags & ts.NodeFlags.Const
      && statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
      const row = statement.declarationList.declarations.find((entry) => ts.isIdentifier(entry.name) && entry.name.text === name)
      if (row?.initializer) return staticString(row.initializer.getText(source), file, next, true)
    }
    if (!ts.isExportDeclaration(statement) || statement.isTypeOnly
      || !statement.exportClause || !ts.isNamedExports(statement.exportClause)) continue
    const binding = statement.exportClause.elements.find((entry) => !entry.isTypeOnly && entry.name.text === name)
    if (!binding) continue
    const original = (binding.propertyName ?? binding.name).text
    if (!statement.moduleSpecifier) return staticString(original, file, next, true)
    const target = ts.isStringLiteral(statement.moduleSpecifier) && importTarget(file, statement.moduleSpecifier.text)
    return target ? exportedString(original, target, next) : null
  }
  return null
}

function staticString(expression, file, seen = new Set(), moduleBinding = false) {
  const value = expression.trim().replace(/\s+as\s+const$/, '')
  const literal = /^(['"])([\s\S]*)\1$/.exec(value)
  if (literal) return literal[2].replace(/\\(['"\\])/g, '$1')

  if (value.startsWith('`') && value.endsWith('`')) {
    let body = value.slice(1, -1)
    const substitutions = [...body.matchAll(/\$\{([A-Za-z_$][A-Za-z0-9_$]*)\}/g)]
    for (const match of substitutions) {
      const resolved = staticString(match[1], file, seen, moduleBinding)
      if (resolved == null) return null
      body = body.replace(match[0], resolved)
    }
    return body.includes('${') ? null : body
  }

  const joined = /^\[([\s\S]*)\]\.join\(\s*(['"])(.*?)\2\s*\)$/.exec(value)
  if (joined) {
    const items = splitTopLevel(joined[1]).filter(Boolean).map((item) => staticString(item, file, seen, moduleBinding))
    return items.some((item) => item == null) ? null : items.join(joined[3])
  }

  const additions = splitTopLevel(value, '+')
  if (additions.length > 1) {
    const items = additions.map((item) => staticString(item, file, seen, moduleBinding))
    return items.some((item) => item == null) ? null : items.join('')
  }

  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value)) return null
  const key = `${file}:${value}`
  if (seen.has(key)) return null
  const nextSeen = new Set(seen).add(key)
  const local = findConstExpression(file, value, moduleBinding)
  if (local != null) return staticString(local, file, nextSeen, moduleBinding)
  const imported = importedBinding(file, value)
  return imported?.file ? exportedString(imported.name, imported.file, nextSeen) : null
}

function oneHopParameterValues(text, callIndex, parameter) {
  const declarations = [...text.matchAll(/(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?:<[^>]+>)?\s*\(([^)]*)\)\s*(?::[^{]+)?\{/g)]
    .map((declaration) => {
      const bodyOpen = declaration.index + declaration[0].lastIndexOf('{')
      return { declaration, bodyOpen, body: readDelimited(text, bodyOpen, '{', '}') }
    })
    .filter((item) => item.body && item.bodyOpen < callIndex && callIndex < item.body.end)
    .sort((a, b) => b.bodyOpen - a.bodyOpen)
  const enclosing = declarations[0]
  if (!enclosing) {
    return { values: [], failures: [`parameter ${parameter} is not inside a statically readable function declaration`] }
  }
  const { declaration } = enclosing
  const params = splitTopLevel(declaration[2]).map((part) => /^([A-Za-z_$][A-Za-z0-9_$]*)/.exec(part)?.[1])
  const parameterIndex = params.indexOf(parameter)
  if (parameterIndex === -1) {
    return { values: [], failures: [`${parameter} is not a parameter of function ${declaration[1]}`] }
  }
  const values = []
  const failures = []
  const calls = new RegExp(`\\b${declaration[1]}\\s*(?:<[^>]+>)?\\s*\\(`, 'g')
  let match
  while ((match = calls.exec(text)) !== null) {
    if (declaration.index <= match.index && match.index <= enclosing.bodyOpen) continue
    const open = match.index + match[0].lastIndexOf('(')
    const args = readDelimited(text, open, '(', ')')
    const line = text.slice(0, match.index).split('\n').length
    if (!args) {
      failures.push(`function ${declaration[1]} call at line ${line} has unreadable arguments`)
      continue
    }
    const arg = splitTopLevel(args.body)[parameterIndex]
    if (arg) values.push({ expression: arg, line })
    else failures.push(`function ${declaration[1]} call at line ${line} omits argument ${parameter}`)
  }
  if (values.length === 0 && failures.length === 0) {
    failures.push(`function ${declaration[1]} has no statically readable call sites for ${parameter}`)
  }
  return { values, failures }
}

function staticValues(expression, text, callIndex, file) {
  const direct = staticString(expression, file)
  if (direct != null) return { values: [direct], failures: [] }
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(expression)) {
    return { values: [], failures: [`${expression || '<empty>'} is not statically exact`] }
  }
  const oneHop = oneHopParameterValues(text, callIndex, expression)
  const values = []
  const failures = [...oneHop.failures]
  for (const candidate of oneHop.values) {
    const resolved = staticString(candidate.expression, file)
    if (resolved == null) {
      failures.push(
        `one-hop argument ${candidate.expression} at line ${candidate.line} is not statically exact`,
      )
    } else values.push(resolved)
  }
  return { values, failures }
}

function readInitializer(text, start) {
  function result(end) {
    const raw = text.slice(start, end)
    const leading = raw.length - raw.trimStart().length
    return { body: raw.trim(), start: start + leading, end }
  }
  let depth = 0
  let quote = null
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]
    if (quote) {
      if (ch === '\\') i += 1
      else if (ch === quote) quote = null
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch
    else if (ch === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i)
      if (end === -1) return result(text.length)
      i = end - 1
    } else if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      if (end === -1) return null
      i = end + 1
    } else if (ch === '(' || ch === '[' || ch === '{') depth += 1
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1
    else if ((ch === ';' || ch === '\n') && depth === 0) {
      const body = text.slice(start, i).trim()
      const next = text.slice(i + 1).trimStart()
      if (!body) continue
      if (ch === '\n' && (/[=+,.?:&|]$/.test(body) || next.startsWith('.'))) continue
      return result(i)
    }
  }
  return quote || depth !== 0 ? null : result(text.length)
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function schemaBeforeFrom(text, file, fromIndex, proof) {
  return proof(file, fromIndex)
}

function parseSelectColumns(selection, table, addRelation, site) {
  const columns = new Set()
  for (const raw of splitTopLevel(selection)) {
    const token = raw.trim()
    if (!token || token === '*') continue
    const embedded = /^([^()]+)\(([\s\S]*)\)$/.exec(token)
    if (embedded) {
      const relation = embedded[1].split(':').at(-1).split('!')[0].replace(/^\.\.\./, '').trim()
      if (!/^[a-z_][a-z0-9_]*$/i.test(relation)) {
        throw new Error(`supabase client contract cannot read embedded select '${token}' at ${site}`)
      }
      addRelation(relation, embedded[2])
      continue
    }
    const column = token.replace(/^[a-z_][a-z0-9_]*:(?!:)/i, '')
    const normalized = column.split(/->>?|::/)[0].trim()
    if (!/^[a-z_][a-z0-9_]*$/i.test(normalized)) {
      throw new Error(`supabase client contract cannot read selected column '${token}' on ${table} at ${site}`)
    }
    columns.add(normalized)
  }
  return columns
}

/**
 * Derive every PostgREST relation/column selected by the shipped client.
 * `schemaProof(files)` returns `(file, offset) => schemas` naming the schema(s) each `.from(` reads; without it every
 * relation is keyed by table alone (schema null). `tolerate(error, site)` may accept a schema-proof error for one site
 * (it records the site itself); anything it does not accept is a read failure.
 */
export function extractClientDataContract(rootDirs, repoRoot, includeSite = () => true, { schemaProof, tolerate } = {}) {
  const files = []
  for (const dir of rootDirs) walk(dir, files)
  const contract = new Map()
  const unreadable = []
  const consumedSelects = new Set()
  let toleratedSites = 0
  const recordReadError = (error, site) => {
    if (tolerate?.(error, site)) toleratedSites += 1
    else unreadable.push(error.message)
  }
  let resolveParameter
  let proofInitializationError
  const parameterSchema = (file, index) => {
    if (!schemaProof) return [null]
    if (proofInitializationError) throw proofInitializationError
    try { resolveParameter ??= schemaProof(files) }
    catch (error) { proofInitializationError = error; throw error }
    return resolveParameter(file, index)
  }

  function siteOf(file, text, index) {
    return `${relative(repoRoot, file)}:${text.slice(0, index).split('\n').length}`
  }

  function add(schema, table, selection, site) {
    const key = `${schema ?? '*'}.${table}`
    const entry = contract.get(key) ?? { schema, table, columns: [], sites: [] }
    const columns = parseSelectColumns(selection, table, (nestedTable, nestedSelection) => {
      add(schema, nestedTable, nestedSelection, site)
    }, site)
    for (const column of columns) if (!entry.columns.includes(column)) entry.columns.push(column)
    if (!entry.sites.includes(site)) entry.sites.push(site)
    entry.columns.sort()
    contract.set(key, entry)
  }
  function validateSelection(table, selection, site) {
    parseSelectColumns(selection, table, (nestedTable, nestedSelection) => {
      validateSelection(nestedTable, nestedSelection, site)
    }, site)
  }

  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    const fromPattern = /\.from\s*\(/g
    let match
    while ((match = fromPattern.exec(text)) !== null) {
      if (!includeSite(file, match.index)) continue
      // The built-in `Array.from(...)` builds an array and is never a data read. Its arguments can hold a regex
      // literal with a quote in it, which the delimiter reader cannot span (client e864ab89, voiceNotes.ts).
      // Only the bare global is skipped: `x.Array.from(` and `myArray.from(` are still read as sites.
      if (/(?<![\w$.])Array$/.test(text.slice(Math.max(0, match.index - 8), match.index))) continue
      const site = siteOf(file, text, match.index)
      const fromArgs = readDelimited(text, match.index + match[0].lastIndexOf('('), '(', ')')
      if (!fromArgs) {
        unreadable.push(`${site} - cannot read .from( arguments`)
        continue
      }
      const nextFrom = text.indexOf('.from', fromArgs.end)
      const selectPattern = /\.select\s*\(/g
      selectPattern.lastIndex = fromArgs.end
      const selectMatch = selectPattern.exec(text)
      if (!selectMatch || (nextFrom !== -1 && nextFrom < selectMatch.index)) continue
      const between = text.slice(fromArgs.end, selectMatch.index)
      if (/;|\n\s*(?:await|const|let|return|if|for|while|try)\b/.test(between)) continue
      const selectOpen = selectMatch.index + selectMatch[0].lastIndexOf('(')
      consumedSelects.add(selectMatch.index)
      const selectArgs = readDelimited(text, selectOpen, '(', ')')
      if (!selectArgs) {
        unreadable.push(`${siteOf(file, text, selectMatch.index)} - cannot read .select( arguments`)
        continue
      }
      const tableArg = splitTopLevel(fromArgs.body)[0] ?? ''
      const selectArg = splitTopLevel(selectArgs.body)[0] ?? "'*'"
      const tables = staticValues(tableArg, text, match.index, file)
      const selections = staticValues(selectArg, text, match.index, file)
      const failures = [...tables.failures, ...selections.failures]
      if (failures.length > 0 || tables.values.length === 0 || selections.values.length === 0) {
        const details = failures.length > 0 ? failures.join('; ') : 'no exact values were derived'
        unreadable.push(`${site} - from(${tableArg}).select(${selectArg}) is not statically exact: ${details}`)
        continue
      }
      const pairs = tables.values.length > 1 && selections.values.length > 1 && tables.values.length === selections.values.length
        ? tables.values.map((table, index) => [table, selections.values[index]])
        : tables.values.flatMap((table) => selections.values.map((selection) => [table, selection]))
      try {
        for (const [table, selection] of pairs) validateSelection(table, selection, site)
        const schemas = schemaBeforeFrom(text, file, match.index, parameterSchema)
        for (const schema of schemas) for (const [table, selection] of pairs) add(schema, table, selection, site)
      } catch (error) { recordReadError(error, site) }
      fromPattern.lastIndex = selectArgs.end
    }

    // A saved builder belongs only to the balanced initializer of its own declaration. A later
    // unrelated `.from()` is not evidence about this receiver, and property builders are rejected
    // until the extractor can prove their assignment/lifetime rather than guessing from a name.
    const variableSelect = /\.select\s*\(/g
    while ((match = variableSelect.exec(text)) !== null) {
      if (!includeSite(file, match.index)) continue
      if (consumedSelects.has(match.index)) continue
      const receiverMatch = /((?:this|[A-Za-z_$][A-Za-z0-9_$]*)(?:\s*\.\s*[A-Za-z_$][A-Za-z0-9_$]*)*)\s*$/.exec(
        text.slice(Math.max(0, match.index - 240), match.index),
      )
      if (!receiverMatch) continue
      const receiver = receiverMatch[1].replace(/\s+/g, '')
      const site = siteOf(file, text, match.index)
      if (receiver.includes('.')) {
        const assignmentPattern = new RegExp(`${escapeRegExp(receiver)}\\s*=`, 'g')
        const assignments = [...text.slice(0, match.index).matchAll(assignmentPattern)]
        const assignment = assignments.at(-1)
        if (!assignment) continue
        const initializer = readInitializer(text, assignment.index + assignment[0].length)
        if (initializer?.body.includes('.from')) {
          unreadable.push(
            `${site} - ${receiver}.select uses a property builder that is not statically attributable`,
          )
        }
        continue
      }
      const declarations = [...text.slice(0, match.index).matchAll(
        new RegExp(`\\b(?:const|let)\\s+${receiver}\\s*=`, 'g'),
      )]
      const declaration = declarations.at(-1)
      if (!declaration) continue
      const initializer = readInitializer(text, declaration.index + declaration[0].length)
      if (!initializer) {
        unreadable.push(`${site} - cannot read ${receiver} declaration initializer`)
        continue
      }
      const initializerFrom = /\.from\s*\(/g
      const fromMatches = [...initializer.body.matchAll(initializerFrom)]
      if (fromMatches.length === 0) {
        if (text.slice(initializer.end, match.index).includes('.from')) {
          unreadable.push(
            `${site} - ${receiver}.select initializer does not contain .from; refusing to claim a later unrelated call`,
          )
        }
        continue
      }
      if (fromMatches.length > 1) {
        unreadable.push(`${site} - ${receiver} declaration initializer contains multiple .from calls`)
        continue
      }
      const fromIndex = initializer.start + fromMatches[0].index
      const fromOpen = text.indexOf('(', fromIndex)
      const fromArgs = readDelimited(text, fromOpen, '(', ')')
      const selectOpen = match.index + match[0].lastIndexOf('(')
      const selectArgs = readDelimited(text, selectOpen, '(', ')')
      if (!fromArgs) {
        unreadable.push(`${siteOf(file, text, fromIndex)} - cannot read .from( arguments`)
        continue
      }
      if (!selectArgs) {
        unreadable.push(`${site} - cannot read .select( arguments`)
        continue
      }
      const tableArg = splitTopLevel(fromArgs.body)[0] ?? ''
      const selectArg = splitTopLevel(selectArgs.body)[0] ?? "'*'"
      const tables = staticValues(tableArg, text, fromIndex, file)
      const selections = staticValues(selectArg, text, match.index, file)
      const failures = [...tables.failures, ...selections.failures]
      if (failures.length > 0 || tables.values.length !== 1 || selections.values.length !== 1) {
        unreadable.push(
          `${site} - ${receiver}.select(${selectArg}) is not statically exact: ` +
            `${failures.join('; ') || 'builder table/select does not resolve to one value'}`,
        )
        continue
      }
      try {
        validateSelection(tables.values[0], selections.values[0], site)
        for (const schema of schemaBeforeFrom(text, file, fromIndex, parameterSchema)) add(schema, tables.values[0], selections.values[0], site)
      } catch (error) { recordReadError(error, site) }
    }
  }
  if (unreadable.length > 0) {
    throw new Error(
      `supabase client contract cannot read ${unreadable.length} client data select site(s) exactly; ` +
        `the release contract gate refuses to under-check a release:\n  ${unreadable.join('\n  ')}`,
    )
  }

  if (contract.size === 0 && toleratedSites === 0) {
    throw new Error('supabase client contract found zero client PostgREST select sites - the scan roots are wrong')
  }
  return new Map([...contract.entries()].sort((a, b) => a[0].localeCompare(b[0])))
}
