#!/usr/bin/env node
// Source rule: every backend call the client makes is readable from source. Each `.rpc(` call site names its RPC and
// its arguments exactly, and each `.from(...).select(...)` site names its table and columns exactly.
//
// The release backend-contract gate compares exactly these reads with the live backend before a client ships, and it
// refuses a release whose call sites it cannot read. Running the same reader here moves that refusal to the PR that
// wrote the site, instead of the release that first meets it. The release gate also narrows to product-reachable
// sites and proves which schema each data client is bound to; this check reads every site and proves no schema.
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { clientDataSourceRoots, extractClientDataContract, extractClientRpcContract } from './supabase-client-contract.mjs'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const sourceRoots = [join(repoRoot, 'apps/desktop/src'), join(repoRoot, 'packages/core/src')]

const failures = []
for (const [kind, read] of [
  ['rpc', () => extractClientRpcContract(sourceRoots, repoRoot)],
  ['select', () => extractClientDataContract(clientDataSourceRoots(sourceRoots, repoRoot), repoRoot)],
]) {
  try {
    console.log(`supabase client contract: ${read().size} ${kind === 'rpc' ? 'RPCs' : 'relations'} read exactly`)
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error))
  }
}
if (failures.length > 0) {
  for (const failure of failures) console.error(failure)
  console.error(`\nWrite each call site so its name and argument keys (or table and columns) are literals at the call:` +
    ` an object literal argument, not a variable holding one. See ${relative(process.cwd(), fileURLToPath(import.meta.url))}.`)
  process.exit(1)
}
