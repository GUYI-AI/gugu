import { requireAgentFileAccess, requireAgentFileTreeAccess } from '@gugu/core/local/state/agentFileBoundary';
import { execFile } from '@gugu/core/local/childProcess';
import { promisify } from 'node:util';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import { variantNameSchema, type ExtensionVariant } from '@shared/extensions/variants';
import { compareExtensionVersions } from '@shared/extensions/manifest';
import { bundleEntryRejection, isOfficialMarketSource, type MarketCodeSource } from '@shared/extensions/market';
import { getGitExecutable } from '../utils/exec';
import { reviewGitEnv } from '../runtime/review-git-env';
import { loginShellEnv } from '@main/utils/userEnv';
import { appSourcesRoot, extensionsService } from './extensions-root';
import { cloudExtensionMarket } from './market-catalog-root';
import { packExtensionArchive } from './extension-archive';

const run = promisify(execFile);
const forkRecordSchema = z.object({
  id: z.string(), name: variantNameSchema, base: z.string(),
  source: z.object({ repo: z.string(), path: z.string(), commit: z.string() }),
});
type ForkRecord = z.infer<typeof forkRecordSchema>;

/** Git as the person's own environment has it: the source is a public repository; nothing of the host's is lent to it. */
async function git(cwd: string, args: string[]): Promise<string> {
  const env = reviewGitEnv({ processEnv: process.env, loginShellEnv: loginShellEnv() });
  return (await run(getGitExecutable(), args, { cwd, env, maxBuffer: 4 * 1024 * 1024 })).stdout.trim();
}

function checkedSource(source: MarketCodeSource): void {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(source.repo) || !/^[a-f0-9]{40}$/i.test(source.commit) ||
      (source.path !== '.' && bundleEntryRejection(source.path))) {
    throw new Error('The installed App has an invalid market source; ask its publisher to correct the source record.');
  }
}

/** The receipt lives in .git, outside the bundle. Merely copying an App with the same id is never a fork install. */
export async function forkOfDirectory(sourceDir: string): Promise<(ForkRecord & { root: string }) | null> {
  const sources = path.resolve(appSourcesRoot());
  const relative = path.relative(sources, path.resolve(sourceDir));
  if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || relative === '..') return null;
  const root = path.join(sources, relative.split(path.sep)[0] ?? '');
  const receipt = await requireAgentFileAccess(path.join(root, '.git', 'gugu-fork.json'));
  if (!fs.existsSync(receipt)) return null;
  const record = forkRecordSchema.parse(JSON.parse(fs.readFileSync(receipt, 'utf8')));
  checkedSource(record.source);
  if (path.basename(root) !== `${record.id}@${record.name}` ||
      fs.realpathSync(sourceDir) !== fs.realpathSync(path.join(root, record.source.path))) {
    throw new Error('Install the fork from the source_dir returned by app_create.');
  }
  return { ...record, root };
}

/** Fetch precisely the installed release's source, then give the agent its editable bundle directory. */
export async function createAppFork(id: string, requestedName?: string) {
  const service = extensionsService();
  if (!service.isInstalled(id)) throw new Error(`App ${id} is not installed; use app_install {market:${JSON.stringify(id)}} first.`);
  const installed = service.get(id);
  const origin = service.origins()[id];
  if (origin !== 'market' && origin !== 'fork') throw new Error(`App ${id} is not installed from the market. Install it with app_install {market:${JSON.stringify(id)}} before forking.`);
  const name = variantNameSchema.parse(requestedName ?? 'my-fork');
  if (name === 'upstream') throw new Error('upstream is the original variant; choose another fork name.');
  const state = service.variants(id);
  const current = state.variants.find((entry) => entry.name === state.active);
  const version = current?.base ?? installed.manifest.version;
  const row = await cloudExtensionMarket().sourceVersion(id, version);
  if (!row) throw new Error(`The market no longer has the exact source of ${id}@${version}; ask its publisher to restore that version's source record.`);
  const source = row.source;
  checkedSource(source);
  const root = path.join(appSourcesRoot(), `${id}@${name}`);
  const sourceDir = path.join(root, source.path);
  await requireAgentFileTreeAccess(root);
  await requireAgentFileAccess(path.join(root, '.git', 'gugu-fork.json'));
  // An App built from the market repository's own `sources/<id>`: a sparse clone of that folder, on a branch named for the App.
  // A compiled release there (`releases/<id>/<version>`) is cloned whole, like any other repository.
  const marketSources = isOfficialMarketSource(source) && (source.path === `sources/${id}` || source.path.startsWith(`sources/${id}/`));
  const branch = marketSources ? `fork/${id}/${name}` : `gugu-fork/${name}`;
  fs.mkdirSync(appSourcesRoot(), { recursive: true });
  const existing = fs.existsSync(root) ? await forkOfDirectory(sourceDir) : null;
  if (fs.existsSync(root) && (!existing || existing.id !== id || existing.name !== name)) {
    throw new Error(`The fork folder ${root} already exists; choose another name in app_create {fork_of, name}.`);
  }
  if (!existing) {
    try {
      await git(appSourcesRoot(), ['clone', '--no-checkout', '--origin', 'upstream',
        ...(marketSources ? ['--filter=blob:none', '--sparse'] : []), `https://github.com/${source.repo}.git`, root]);
      if (marketSources) await git(root, ['sparse-checkout', 'set', '--', `sources/${id}`]);
      await git(root, ['fetch', 'upstream', source.commit]);
      await git(root, ['checkout', '-b', branch, source.commit]);
      await requireAgentFileAccess(path.join(sourceDir, 'manifest.json'));
      const manifest = service.inspectDirectory(sourceDir).manifest;
      if (manifest.id !== id || manifest.version !== version) throw new Error(`The indexed source does not contain ${id}@${version}; ask the publisher to correct its source record.`);
      const record: ForkRecord = { id, name, base: version, source };
      fs.writeFileSync(path.join(root, '.git', 'gugu-fork.json'), `${JSON.stringify(record)}\n`);
    } catch (error) {
      fs.rmSync(root, { recursive: true, force: true });
      throw new Error(`The exact installed source could not be prepared. Retry app_create with the same fork_of and name after fixing: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  service.retainUpstream(id, { name: 'upstream', base: version, commit: source.commit, repo: source.repo, path: source.path, dir: null, sha256: row.sha256, bytes: row.bytes });
  // A fork on GitHub and its push are the agent's, with the person's own git and gh (guide apps-fork): the host's GitHub
  // credentials stay in the password vault and never go into a git process.
  const repo: string | null = null;
  return { id, name, source_dir: sourceDir, git_dir: root, branch, repo, base: existing?.base ?? version, commit: await git(root, ['rev-parse', 'HEAD']), next: `Edit source_dir, keep the App id and data format, then app_install {source_dir:${JSON.stringify(sourceDir)}} to activate this variant. Read guide apps-fork.` };
}

export async function prepareForkVariant(sourceDir: string): Promise<ExtensionVariant | undefined> {
  await requireAgentFileTreeAccess(sourceDir);
  const fork = await forkOfDirectory(sourceDir);
  if (!fork) return undefined;
  const service = extensionsService();
  const { manifest, bytes, sha256 } = await packExtensionArchive(service, sourceDir);
  if (manifest.id !== fork.id) throw new Error(`Keep the upstream App id ${fork.id} in manifest.json, then retry app_install.`);
  service.get(fork.id);
  const commit = await git(fork.root, ['rev-parse', 'HEAD']);
  // A successful merge of an indexed commit advances the base, regardless of the fork's manifest version.
  const versions = await cloudExtensionMarket().sourceVersions(fork.id);
  let base = fork.base;
  for (const row of versions.filter((entry) => !entry.yanked && entry.source.repo === fork.source.repo && entry.source.path === fork.source.path).sort((a, b) => compareExtensionVersions(a.version, b.version))) {
    if (compareExtensionVersions(row.version, base) > 0 && await git(fork.root, ['merge-base', commit, row.source.commit]).then((common) => common === row.source.commit, () => false)) base = row.version;
  }
  const remotes = (await git(fork.root, ['remote'])).split('\n');
  const remote = remotes.includes('origin') ? await git(fork.root, ['config', '--get', 'remote.origin.url']) : '';
  const repo = /^https:\/\/github.com\/([^/]+\/[^/]+?)(?:\.git)?$/.exec(remote)?.[1] ?? null;
  return { name: fork.name, base, commit, repo, path: fork.source.path, dir: sourceDir, sha256, bytes: bytes.byteLength };
}
