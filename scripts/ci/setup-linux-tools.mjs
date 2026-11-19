import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFile, chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'

const profiles = { unit: ['ripgrep'], desktop: ['tmux'], android: [], media: ['ffmpeg', 'ffprobe'] }

// Cache only source archives. Verify even cache hits, and extract fresh executables for each job.
export async function verifiedArchive(tool, cache, fetchArchive = fetch) {
  const path = join(cache, tool.sha256)
  let bytes
  try { bytes = await readFile(path) } catch (error) { if (error.code !== 'ENOENT') throw error }
  if (!bytes) {
    const response = await fetchArchive(tool.url, { signal: AbortSignal.timeout(120_000) })
    if (!response.ok) throw new Error(`${tool.url}: HTTP ${response.status}`)
    bytes = Buffer.from(await response.arrayBuffer())
  }
  if (createHash('sha256').update(bytes).digest('hex') !== tool.sha256) throw new Error(`${tool.url}: SHA256 mismatch`)
  await mkdir(cache, { recursive: true })
  await writeFile(path, bytes)
  return bytes
}

export async function setupLinuxTools(profile, env = process.env) {
  if (!Object.hasOwn(profiles, profile)) throw new Error(`Unknown Linux tool profile: ${profile}`)
  if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('CI Linux tools require Linux x64')
  const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
  const lock = JSON.parse(await readFile(join(root, 'scripts/ci/linux-tools.json'), 'utf8'))
  const cache = join(root, '.ci-cache/linux-tool-archives', profile)
  // FFprobe must be a sibling of FFmpeg: the native color-metadata regression resolves it there.
  const directory = join(env.RUNNER_TEMP, 'gugu-linux-tools', profile)
  await rm(directory, { recursive: true, force: true })
  await mkdir(directory, { recursive: true })
  const paths = []
  for (const name of profiles[profile]) {
    const tool = lock[name], bytes = await verifiedArchive(tool, cache)
    if (tool.format === 'gzip') await writeFile(join(directory, tool.binaries[0]), gunzipSync(bytes))
    else {
      const archive = join(cache, tool.sha256)
      execFileSync('tar', ['-xf', archive, '--strip-components=1', '-C', directory])
    }
    for (const binary of tool.binaries) {
      const path = join(directory, binary)
      await chmod(path, 0o755)
      execFileSync(path, [name === 'tmux' ? '-V' : name.startsWith('ff') ? '-version' : '--version'], { stdio: 'inherit' })
      paths.push(dirname(path))
    }
    console.log(`${name}: verified ${tool.sha256} from ${tool.url}`)
  }
  if (profile === 'android') paths.push('/usr/lib/llvm-18/bin', '/usr/sbin')
  if (paths.length) await appendFile(env.GITHUB_PATH, [...new Set(paths)].join('\n') + '\n')
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await setupLinuxTools(process.argv[2])
