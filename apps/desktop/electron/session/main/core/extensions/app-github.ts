/**
 * `gugu.github` (60, `github`): GitHub's REST API as the person, through the account they connected in Settings › Integrations
 * (the same default github.com account an App fork uses, app-forks.ts). The token stays in main: the page names a method and
 * a path, main adds the token and sends it to api.github.com only. A read is a GET; a write (any other method) is the person's
 * click on a page (bridge-protocol.ts: `githubWrite`). What the App may touch beyond that is the person's trust at install.
 */
const API = 'https://api.github.com';
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const fail = (code: 'invalid' | 'unavailable' | 'failed', message: string) => Object.assign(new Error(message), { code });

/** A path on api.github.com and nothing else: `/repos/…?…`, never a full URL or one that leaves the host. */
function apiUrl(path: unknown): URL {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) throw fail('invalid', 'gugu.github takes a path on api.github.com, starting with "/"');
  const url = new URL(path, API);
  if (url.origin !== API) throw fail('invalid', 'gugu.github only reaches api.github.com');
  return url;
}

async function token(): Promise<string> {
  const [{ githubAccountService }, { githubApiAuthService }, { githubAccountReconciliationService }] = await Promise.all([
    import('../github/accounts/github-account-service-instance'), import('../github/services/github-api-auth-service-instance'),
    import('../github/accounts/github-account-reconciliation-instance'),
  ]);
  // The same first read the account UI makes (github/controller.ts): a `gh` login on this computer is taken in once.
  await githubAccountReconciliationService.reconcileOnce();
  const account = (await githubAccountService.listAccounts()).find((entry) => entry.isDefault && entry.host === 'github.com');
  if (!account) throw fail('unavailable', 'No GitHub account is connected: connect GitHub in Connectors');
  const auth = await githubApiAuthService.getToken('github.com', { accountId: account.accountId });
  if (!auth.success) throw fail('unavailable', `Reconnect GitHub in Connectors: ${auth.error.message}`);
  return auth.data;
}

/**
 * GitHub's answer as it came: `{ status, data }`, `data` parsed when it is JSON. A 4xx is GitHub's word (409 head moved,
 * 405 not mergeable) and goes back to the App to show, not thrown; only not reaching GitHub is a failure.
 */
export async function githubForApp(method: 'githubRead' | 'githubWrite', args: Record<string, unknown>): Promise<{ status: number; data: unknown }> {
  const verb = method === 'githubRead' ? 'GET' : typeof args.method === 'string' ? args.method.toUpperCase() : '';
  if (method === 'githubWrite' && !WRITE_METHODS.has(verb)) throw fail('invalid', 'gugu.github.write(method, path, body): method is POST, PUT, PATCH or DELETE');
  const url = apiUrl(args.path);
  const body = method === 'githubWrite' && args.body !== undefined ? JSON.stringify(args.body) : undefined;
  let response: Response;
  try {
    response = await fetch(url, {
      method: verb,
      headers: {
        Authorization: `Bearer ${await token()}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body }),
    });
  } catch (error) {
    if ((error as { code?: unknown }).code === 'unavailable') throw error;
    throw fail('failed', `Could not reach GitHub: ${error instanceof Error ? error.message : String(error)}`);
  }
  const text = await response.text();
  let data: unknown = text;
  if ((response.headers.get('content-type') ?? '').includes('json') && text) {
    try { data = JSON.parse(text); } catch { data = text; } // GitHub said JSON but sent something else: hand over the text as it came.
  }
  return { status: response.status, data };
}
