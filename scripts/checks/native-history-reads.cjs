#!/usr/bin/env node
// #2062: syntax guard plus exact legacy-function debt; runtime budgets police indirect reads.
const { createHash } = require('node:crypto')
const { existsSync, readdirSync, readFileSync, statSync } = require('node:fs')
const { join, relative, resolve } = require('node:path')
const ts = require('typescript')

const ROOTS = [
  'packages/session-core/src/session-record',
  'apps/desktop/electron/session/main/core/session-timeline',
  'packages/core/src/local/agent/transcriptInventory.ts',
  'apps/desktop/electron/sessionpage/local-session-source.ts',
]
const FORBIDDEN = new Set(['readFile', 'readFileSync', 'createReadStream', 'readFromStart', 'readSnapshot', 'readLines'])
const debt = require('./native-history-reads-debt.json')

function name(node) {
  if (!node) return ''
  if (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) return node.text
  if (ts.isPropertyAccessExpression(node)) return name(node.name)
  if (ts.isElementAccessExpression(node)) return name(node.argumentExpression)
  if (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node) || ts.isAsExpression(node)) return name(node.expression)
  return ''
}
function owner(node, source) {
  for (let at = node.parent; at; at = at.parent) {
    if (ts.isFunctionLike(at) && at.body) return at.getText(source)
  }
  return node.getText(source)
}
function analyze(file, text) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const aliases = new Map()
  function bindings(node) {
    if (ts.isImportSpecifier(node)) aliases.set(node.name.text, name(node.propertyName || node.name))
    if (ts.isBindingElement(node)) aliases.set(name(node.name), name(node.propertyName || node.name))
    if (ts.isVariableDeclaration(node) && node.initializer) aliases.set(name(node.name), name(node.initializer))
    ts.forEachChild(node, bindings)
  }
  bindings(source)
  const findings = []
  function callName(node) { const key = name(node.expression); return aliases.get(key) || key }
  function hasRead(node) {
    if (ts.isCallExpression(node) && /^(read|readSync)$/.test(callName(node))) return true
    return !!ts.forEachChild(node, child => hasRead(child) || undefined)
  }
  function visits(node) {
    let rule
    if (ts.isCallExpression(node) && FORBIDDEN.has(callName(node))) rule = callName(node)
    if ((ts.isWhileStatement(node) || ts.isForStatement(node)) && hasRead(node.statement)) {
      const condition = ts.isWhileStatement(node) ? node.expression : node.condition
      if (condition && /\b(size|fileSize|sourceSize|eof)\b|^true$/.test(condition.getText(source))) rule = 'read-loop-to-eof'
    }
    if (rule) {
      const fingerprint = createHash('sha256').update(owner(node, source)).digest('hex')
      const key = `${file}:${rule}:${fingerprint}`
      findings.push({ file, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, rule, key })
    }
    ts.forEachChild(node, visits)
  }
  visits(source)
  return findings
}
function scan(root) {
  const findings = []
  function walk(path) {
    if (!existsSync(path)) return
    if (statSync(path).isDirectory()) {
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        if (entry.isDirectory() || entry.isFile()) walk(join(path, entry.name))
      }
    } else if (/\.[cm]?[jt]sx?$/.test(path) && !/\.(test|spec|node-test)\./.test(path)) {
      findings.push(...analyze(relative(root, path).split('\\').join('/'), readFileSync(path, 'utf8')))
    }
  }
  for (const path of ROOTS) walk(join(root, path))
  return findings
}
function violations(root) {
  // Multiplicity matters: copying an unchanged legacy function must not create another exemption.
  const remaining = new Map(debt.map(([key, count]) => [key, count]))
  return scan(root).filter(finding => {
    const left = remaining.get(finding.key) || 0
    if (!left) return true
    remaining.set(finding.key, left - 1)
    return false
  })
}
module.exports = { ROOTS, analyze, scan, violations }
if (require.main === module) {
  const found = violations(resolve(__dirname, '../..'))
  for (const { file, line, rule } of found) process.stderr.write(`${file}:${line}: forbidden history read (${rule}); use a bounded positional reader\n`)
  process.exitCode = found.length ? 1 : 0
}
