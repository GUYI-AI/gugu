import { buildUserShellBaseEnv } from '@main/utils/childProcessEnv';
import { loginShellEnv } from '@main/utils/userEnv';

/** Same shell/process precedence as buildAgentEnv, without changing process.env. */
export function connectionProbeEnv(): NodeJS.ProcessEnv {
  return buildUserShellBaseEnv({ loginShellEnv: loginShellEnv() });
}

/** A worker has no login-shell provider; transfer only the resolved proxy values at spawn. */
export function connectionProbeProxyEnv(): NodeJS.ProcessEnv {
  const env = connectionProbeEnv();
  const names = ['http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY'];
  return Object.fromEntries(names.filter((name) => env[name] !== undefined).map((name) => [name, env[name]]));
}
