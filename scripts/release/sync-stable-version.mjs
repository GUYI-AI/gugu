#!/usr/bin/env node
// @@@sync-stable-version - after a stable release: tag it, and open the PR that moves dev to the next patch number.
//
// One version series (0.3.x): whichever ships stable first, dev or a hotfix from release/A.B, takes the next number,
// and dev then moves to the one after it. So after stable A.B.C, dev must be A.B.(C+1). The release pipeline's
// version gate only asks that a release be above stable; this workflow keeps dev there without anyone remembering.
//
// Runs in this repository with its own GITHUB_TOKEN, so the private release pipeline needs no token for this repo.
// It never pushes to dev: the bump is a pull request a person approves. A pull request opened with GITHUB_TOKEN
// starts no pull_request workflow, and a dispatched CI run's checks do not count on the pull request (probed
// 2026-11-22), so the approver closes and reopens it once: that starts the normal CI, then approves.
//
// The released commit comes from the public `source.json` the release pipeline writes once a stable release has
// been read back. A release published before that file existed must already carry its tag; otherwise this fails.

import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export const BUMP_BRANCH_PREFIX = 'release-sync/dev-'

function plain(version, what) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version || '')
  if (!match) throw new Error(what + ' must be a plain X.Y.Z version: ' + JSON.stringify(version))
  return match.slice(1).map(Number)
}

/** The version dev must carry while `stable` is live: the next patch number. */
export function nextVersion(stable) {
  const [major, minor, patch] = plain(stable, 'Live stable')
  return major + '.' + minor + '.' + (patch + 1)
}

/** Positive when a is newer; plain X.Y.Z only. */
export function compareVersions(a, b) {
  const x = plain(a, 'Version')
  const y = plain(b, 'Version')
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]
}

/**
 * Pure decision. `tagSha` is the commit tag v<stable> points at (null when absent); `sourceSha` comes from
 * source.json (null when the release predates it); `devVersion` is dev's package.json; `openPr` is the number of
 * an open bump PR for the expected version, if any.
 */
export function planSync({ stable, tagSha, sourceSha, devVersion, openPr }) {
  const actions = []
  const tag = 'v' + stable
  if (tagSha && sourceSha && tagSha !== sourceSha) throw new Error(tag + ' points at ' + tagSha + ', but stable ' + stable + ' was built from ' + sourceSha + '; not moving the tag')
  if (!tagSha) {
    if (!sourceSha) throw new Error(tag + ' is missing and stable ' + stable + ' has no source.json naming its commit; tag it by hand from the release run')
    actions.push({ type: 'tag', tag, sha: sourceSha })
  }
  const expected = nextVersion(stable)
  const order = compareVersions(devVersion, expected)
  if (order > 0) throw new Error('dev is ' + devVersion + ', past ' + expected + ' (the next number after stable ' + stable + '); a version was skipped')
  if (order < 0 && !openPr) actions.push({ type: 'bump', from: devVersion, to: expected, branch: BUMP_BRANCH_PREFIX + expected })
  if (order < 0 && openPr) actions.push({ type: 'waiting', pr: openPr, to: expected })
  return actions
}

/** package.json text with only its top-level version changed. */
export function bumpPackageJson(text, from, to) {
  const pattern = /^(  "version": ")([^"]+)(",?)$/m
  const match = pattern.exec(text)
  if (!match || match[2] !== from) throw new Error('package.json version is not ' + from)
  return text.replace(pattern, '$1' + to + '$3')
}

const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', ...opts }).trim()
const api = (path, ...args) => JSON.parse(sh('gh', ['api', path, ...args]))

function tagCommit(repo, tag) {
  let ref
  try { ref = api('repos/' + repo + '/git/ref/tags/' + tag) } catch (error) {
    if (/HTTP 404/.test(String(error.stderr || error.message))) return null
    throw error
  }
  if (ref.object.type === 'commit') return ref.object.sha
  if (ref.object.type === 'tag') return api('repos/' + repo + '/git/tags/' + ref.object.sha).object.sha
  throw new Error(tag + ' points at a ' + ref.object.type)
}

async function readStable(feeds) {
  const targets = [['mac', 'latest-mac.yml'], ['windows', 'latest.yml'], ['linux', 'latest-linux.yml']].map(([platform, name]) => [platform, new URL(name, feeds.stable).href])
  targets.push(['android', feeds.androidStable])
  const readings = []
  for (const [platform, url] of targets) {
    const response = await fetch(url, { signal: AbortSignal.timeout(60_000) })
    if (!response.ok) throw new Error('Cannot read stable feed ' + url + ': HTTP ' + response.status)
    const text = await response.text()
    readings.push(platform + '=' + (url.endsWith('.json') ? JSON.parse(text).version : /^version:\s*(\S+)\s*$/m.exec(text)?.[1]))
  }
  const versions = new Set(readings.map((r) => r.split('=')[1]))
  // A half-published release (one platform failed and awaits a resumed run) is not a release to follow yet.
  if (versions.size !== 1) throw new Error('Stable feeds disagree: ' + readings.join(', '))
  return [...versions][0]
}

async function sourceOf(feeds, stable) {
  const url = new URL('/releases/verification/stable/' + stable + '/source.json', feeds.stable).href
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) })
  if (response.status === 404) return null
  if (!response.ok) throw new Error('Cannot read ' + url + ': HTTP ' + response.status)
  const proof = await response.json()
  if (proof.version !== stable || !/^[0-9a-f]{40}$/.test(proof.sha || '')) throw new Error(url + ' does not name a commit for ' + stable)
  return proof.sha
}

async function main() {
  const repo = process.env.GITHUB_REPOSITORY
  const dryRun = process.env.DRY_RUN !== 'false'
  const root = process.cwd()
  const feeds = JSON.parse(readFileSync(join(root, 'apps/desktop/electron/updateFeeds.json'), 'utf8'))
  const stable = await readStable(feeds)
  const tagSha = tagCommit(repo, 'v' + stable)
  const sourceSha = await sourceOf(feeds, stable)
  const devVersion = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
  const expected = nextVersion(stable)
  const prs = api('repos/' + repo + '/pulls?state=open&base=dev&head=' + repo.split('/')[0] + ':' + BUMP_BRANCH_PREFIX + expected)
  const actions = planSync({ stable, tagSha, sourceSha, devVersion, openPr: prs[0]?.number })
  console.log('stable ' + stable + ', tag ' + (tagSha || 'missing') + ', dev ' + devVersion + ' → ' + JSON.stringify(actions) + (dryRun ? ' (dry run)' : ''))
  if (dryRun) return
  for (const action of actions) {
    if (action.type === 'tag') {
      api('repos/' + repo + '/git/refs', '-f', 'ref=refs/tags/' + action.tag, '-f', 'sha=' + action.sha)
      const read = tagCommit(repo, action.tag)
      if (read !== action.sha) throw new Error(action.tag + ' reads back as ' + read + ', not ' + action.sha)
    }
    if (action.type === 'bump') {
      const path = join(root, 'package.json')
      writeFileSync(path, bumpPackageJson(readFileSync(path, 'utf8'), action.from, action.to))
      sh('git', ['switch', '-c', action.branch])
      sh('git', ['-c', 'user.name=github-actions[bot]', '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com',
        'commit', '-m', 'chore(release): open ' + action.to + ' on dev after stable ' + stable, '--', 'package.json'])
      sh('git', ['push', 'origin', 'HEAD:refs/heads/' + action.branch])
      const url = sh('gh', ['pr', 'create', '--repo', repo, '--base', 'dev', '--head', action.branch,
        '--title', 'chore(release): open ' + action.to + ' on dev',
        '--body', 'Stable ' + stable + ' is live, so dev moves to the next number, ' + action.to + '. Opened by sync-stable-version.yml.\n\n' +
          'To merge: **close and reopen this pull request once** (a pull request opened by the workflow token starts no CI; reopening as a person does), then approve when CI is green.'])
      console.log('Opened ' + url + '; a person closes and reopens it to start CI, then approves')
    }
    if (action.type === 'waiting') console.log('dev bump to ' + action.to + ' is open as #' + action.pr + '; it needs a close/reopen and an approval')
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.log('::error::sync-stable-version: ' + error.message); process.exitCode = 1 })
}
