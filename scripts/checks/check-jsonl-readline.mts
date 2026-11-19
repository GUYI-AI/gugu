#!/usr/bin/env node
// JSONL has one delimiter: LF. readline also accepts CR and Unicode separators.
import ts from 'typescript'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const readlineModule = (value: string) => /^(?:node:)?readline(?:\/promises)?$/.test(value)
const children = (node: ts.Node): ts.Node[] => { const result: ts.Node[] = []; ts.forEachChild(node, child => { result.push(child) }); return result }
const walk = (node: ts.Node): ts.Node[] => [node, ...children(node).flatMap(walk)]
const mentions = (node: ts.Node | undefined, names: Set<string>): boolean =>
  !!node && walk(node).some(part => ts.isIdentifier(part) && names.has(part.text))
const jsonParse = (node: ts.Expression): boolean => ts.isPropertyAccessExpression(node)
  && ts.isIdentifier(node.expression) && node.expression.text === 'JSON' && node.name.text === 'parse'

export function findReadlineJsonl(source: string, path = 'source.ts'): { line: number; column: number }[] {
  if (!/readline/.test(source)) return []
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true)
  const nodes = walk(file)
  const namespaces = new Set<string>(), factories = new Set<string>()
  const requireReadline = (node: ts.Expression | undefined): boolean => !!node && ts.isCallExpression(node)
    && ts.isIdentifier(node.expression) && node.expression.text === 'require'
    && !!node.arguments[0] && ts.isStringLiteral(node.arguments[0]) && readlineModule(node.arguments[0].text)
  for (const node of nodes) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && readlineModule(node.moduleSpecifier.text)) {
      if (node.importClause?.name) namespaces.add(node.importClause.name.text)
      const binding = node.importClause?.namedBindings
      if (binding && ts.isNamespaceImport(binding)) namespaces.add(binding.name.text)
      if (binding && ts.isNamedImports(binding)) for (const item of binding.elements) {
        if ((item.propertyName ?? item.name).text === 'createInterface') factories.add(item.name.text)
      }
    }
    if (ts.isVariableDeclaration(node) && requireReadline(node.initializer)) {
      if (ts.isIdentifier(node.name)) namespaces.add(node.name.text)
      if (ts.isObjectBindingPattern(node.name)) for (const item of node.name.elements) {
        if (ts.isIdentifier(item.name) && (item.propertyName ?? item.name).getText(file) === 'createInterface') factories.add(item.name.text)
      }
    }
  }
  const factory = (node: ts.Expression): node is ts.CallExpression => ts.isCallExpression(node) && (
    (ts.isIdentifier(node.expression) && factories.has(node.expression.text))
    || (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'createInterface'
      && ((ts.isIdentifier(node.expression.expression) && namespaces.has(node.expression.expression.text))
        || requireReadline(node.expression.expression))))
  const readers = new Map<string, ts.CallExpression>()
  for (const node of nodes) if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && factory(node.initializer)) {
    readers.set(node.name.text, node.initializer)
  }
  const parsers = new Set<string>()
  // Local wrappers such as parseJson(line) are still JSON readers.
  for (const node of nodes) {
    if (ts.isFunctionDeclaration(node) && node.name && node.body
      && walk(node.body).some(part => ts.isCallExpression(part) && jsonParse(part.expression))) parsers.add(node.name.text)
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer
      && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
      && walk(node.initializer.body).some(part => ts.isCallExpression(part) && jsonParse(part.expression))) parsers.add(node.name.text)
  }
  const readsJson = (body: ts.Node, initial: string[]): boolean => {
    const names = new Set(initial), inside = walk(body)
    for (let changed = true; changed;) {
      changed = false
      for (const part of inside) if (ts.isVariableDeclaration(part) && ts.isIdentifier(part.name)
        && !names.has(part.name.text) && mentions(part.initializer, names)) {
        names.add(part.name.text); changed = true
      }
    }
    return inside.some(part => ts.isCallExpression(part)
      && (jsonParse(part.expression) || (ts.isIdentifier(part.expression) && parsers.has(part.expression.text)))
      && part.arguments.some(arg => mentions(arg, names)))
  }
  const reference = (node: ts.Expression): ts.CallExpression | undefined =>
    factory(node) ? node : ts.isIdentifier(node) ? readers.get(node.text) : undefined
  const hits = new Set<ts.CallExpression>()
  for (const node of nodes) {
    if (ts.isForOfStatement(node)) {
      const call = reference(node.expression)
      const name = ts.isVariableDeclarationList(node.initializer) ? node.initializer.declarations[0]?.name : node.initializer
      if (call && name && ts.isIdentifier(name) && readsJson(node.statement, [name.text])) hits.add(call)
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && ['on', 'once', 'addListener'].includes(node.expression.name.text)
      && node.arguments[0] && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === 'line') {
      const call = reference(node.expression.expression), callback = node.arguments[1]
      if (!call || !callback) continue
      if (ts.isIdentifier(callback) && parsers.has(callback.text)) hits.add(call)
      if ((ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) && callback.body
        && readsJson(callback.body, callback.parameters.flatMap(param => ts.isIdentifier(param.name) ? [param.name.text] : []))) hits.add(call)
    }
  }
  return [...hits].map(node => {
    const point = file.getLineAndCharacterOfPosition(node.getStart(file))
    return { line: point.line + 1, column: point.character + 1 }
  })
}

export function isProductionSource(path: string): boolean {
  return /^(apps|packages)\//.test(path) && /\.(?:[cm]?[jt]sx?)$/.test(path)
    && !/(?:^|\/)(?:tests?|__tests__|fixtures)(?:\/|$)|\.(?:test|spec|stories)\.|\.d\.[cm]?ts$/.test(path)
}

function main() {
  const paths = execFileSync('git', ['ls-files', '-z', '--', 'apps', 'packages'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
    .split('\0').filter(isProductionSource)
  if (!paths.length) throw new Error('JSONL readline check has no production scan surface')
  let failed = false
  for (const path of paths) for (const point of findReadlineJsonl(readFileSync(path, 'utf8'), path)) {
    failed = true
    console.error(`::error file=${path},line=${point.line},col=${point.column}::JSONL must use @gugu/core/local/jsonl.mjs; readline splits valid JSON strings.`)
  }
  console.log(`jsonl-readline: scanned=${paths.length} production source files`)
  if (failed) process.exitCode = 1
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main()
