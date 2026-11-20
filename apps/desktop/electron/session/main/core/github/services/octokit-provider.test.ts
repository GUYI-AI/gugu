import { err, ok } from '@gugu/session-shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { githubApiAuthService } from './github-api-auth-service-instance';
import { clearOctokitCache, getOctokit } from './octokit-provider';

const mockOctokit = vi.hoisted(() => vi.fn());
vi.mock('@octokit/rest', () => ({ Octokit: mockOctokit }));
vi.mock('./github-api-auth-service-instance', () => ({ githubApiAuthService: { resolve: vi.fn() } }));
const mockResolve = vi.mocked(githubApiAuthService.resolve);
const vaultFetch = vi.fn() as unknown as typeof fetch;
const auth = (cacheKey: string) => ok({ fetch: vaultFetch, cacheKey, account: { id: 'c1', providerAccountId: '42', host: 'github.com', login: 'monalisa', avatarUrl: '', credentialSource: 'device_flow' as const, connectedAt: 0, updatedAt: 0 } });

describe('getOctokit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearOctokitCache();
    mockOctokit.mockImplementation(function (options) { return { options }; });
  });

  it('sends every request through the vault: no auth, the vault fetch, api.github.com', async () => {
    mockResolve.mockResolvedValue(auth('github.com:host:connector:github:c1'));
    await expect(getOctokit('github.com')).resolves.toMatchObject({ success: true });
    const options = mockOctokit.mock.calls[0]![0];
    expect(options).toMatchObject({ baseUrl: 'https://api.github.com', request: { fetch: vaultFetch } });
    expect(options.auth).toBeUndefined();
  });

  it('uses the enterprise API base URL for GHES hosts, and passes the context on', async () => {
    mockResolve.mockResolvedValue(auth('ghe:k'));
    await getOctokit('ghe.example.com', { projectId: 'p' });
    expect(mockResolve).toHaveBeenCalledWith('ghe.example.com', { projectId: 'p' });
    expect(mockOctokit).toHaveBeenCalledWith(expect.objectContaining({ baseUrl: 'https://ghe.example.com/api/v3' }));
  });

  it('keeps one client per credential choice', async () => {
    mockResolve.mockResolvedValueOnce(auth('a')).mockResolvedValueOnce(auth('b')).mockResolvedValueOnce(auth('a'));
    await getOctokit('github.com'); await getOctokit('github.com'); await getOctokit('github.com');
    expect(mockOctokit).toHaveBeenCalledTimes(2);
  });

  it('forwards typed auth errors', async () => {
    mockResolve.mockResolvedValue(err({ type: 'auth_required', host: 'github.com', message: 'GitHub authentication required.' }));
    await expect(getOctokit('github.com')).resolves.toEqual({ success: false, error: { type: 'auth_required', host: 'github.com', message: 'GitHub authentication required.' } });
    expect(mockOctokit).not.toHaveBeenCalled();
  });
});
