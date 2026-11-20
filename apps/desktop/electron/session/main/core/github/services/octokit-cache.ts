import type { Octokit } from '@octokit/rest';

/** One Octokit per host and credential choice (`GitHubRequestAuth.cacheKey`); a changed choice is another key. */
const cachedOctokits = new Map<string, Octokit>();

export function getCachedOctokit(key: string): Octokit | undefined {
  return cachedOctokits.get(key);
}

export function setCachedOctokit(key: string, octokit: Octokit): void {
  cachedOctokits.set(key, octokit);
}

export function clearOctokitCache(): void {
  cachedOctokits.clear();
}
