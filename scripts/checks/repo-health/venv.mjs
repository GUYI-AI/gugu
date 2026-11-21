// The Python tools (crapper, repowise) live in one venv, rebuilt when tools.json changes.
// REPO_HEALTH_VENV picks the venv directory, REPO_HEALTH_PYTHON the interpreter (>= 3.11);
// pip honours PIP_INDEX_URL for a mirror.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const tools = JSON.parse(readFileSync(resolve(import.meta.dirname, 'tools.json'), 'utf8'))
const stamp = JSON.stringify(tools.packages)

function sh(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  if (result.error || result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed: ${result.error?.message ?? result.stderr.slice(-3000)}`)
  }
  return result.stdout
}

export function ensureVenv(root) {
  const dir = process.env.REPO_HEALTH_VENV ?? resolve(root, 'node_modules/.cache/repo-health-venv')
  const python = resolve(dir, 'bin/python')
  const stampFile = resolve(dir, 'repo-health-tools.json')
  if (existsSync(python) && existsSync(stampFile) && readFileSync(stampFile, 'utf8') === stamp) return dir
  const base = process.env.REPO_HEALTH_PYTHON ?? 'python3'
  const version = sh(base, ['-c', 'import sys; print("%d.%d" % sys.version_info[:2])']).trim()
  const [major, minor] = version.split('.').map(Number)
  if (major < 3 || (major === 3 && minor < 11)) {
    throw new Error(`${base} is Python ${version}; crapper needs ${tools.python}. Set REPO_HEALTH_PYTHON.`)
  }
  sh(base, ['-m', 'venv', '--clear', dir])
  sh(python, ['-m', 'pip', 'install', '--quiet', ...Object.values(tools.packages).map((pkg) => pkg.spec)])
  writeFileSync(stampFile, stamp)
  return dir
}

export const pinOf = (name) => tools.packages[name].pin
