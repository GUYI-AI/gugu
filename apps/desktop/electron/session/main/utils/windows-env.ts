import path from 'node:path';

export function getWindowsEnvKey(env: NodeJS.ProcessEnv, key: string): string | undefined {
  if (env[key] !== undefined) return key;

  const lowerKey = key.toLowerCase();
  return Object.keys(env).find((candidate) => candidate.toLowerCase() === lowerKey);
}

export function getWindowsEnvValue(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const envKey = getWindowsEnvKey(env, key);
  return envKey ? env[envKey] : undefined;
}

export function getWindowsPathEnvKey(env: NodeJS.ProcessEnv): string {
  return getWindowsEnvKey(env, 'PATH') ?? 'PATH';
}

/**
 * Windows PATH entries compare case-insensitively, and a trailing separator is meaningless
 * (`C:\x\npm` and `c:\X\npm\` are the same directory). Normalising both sides keeps the
 * presence check from prepending a duplicate that Windows would treat as the same entry.
 */
function normalizeWindowsPathEntry(entry: string): string {
  return entry.trim().replace(/[\\/]+$/, '').toLowerCase();
}

export function prependWindowsPathEntry(env: NodeJS.ProcessEnv, entry: string): boolean {
  const pathKey = getWindowsPathEnvKey(env);
  const entries = (env[pathKey] ?? '').split(path.win32.delimiter).filter(Boolean);
  const existing = new Set(entries.map(normalizeWindowsPathEntry));

  if (existing.has(normalizeWindowsPathEntry(entry))) {
    return false;
  }

  env[pathKey] = [entry, ...entries].join(path.win32.delimiter);
  return true;
}

/**
 * `read`(刚从注册表读到的 PATH)在前,`current` 里它没有的条目补在后;比较用上面同一把尺。
 * 补在后而 ❌ 不丢:咕咕前置的目录(npm 全局 bin、自己的 agent 目录)不在注册表里。
 */
export function mergeWindowsPath(read: string, current: string): string {
  const merged: string[] = [];
  const seen = new Set<string>();
  for (const entry of [...read.split(path.win32.delimiter), ...current.split(path.win32.delimiter)]) {
    const key = normalizeWindowsPathEntry(entry);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push(entry);
  }
  return merged.join(path.win32.delimiter);
}

/**
 * One value out of a `reg export` file (UTF-16LE whatever the system code page — `reg query` prints in the console
 * code page, so a non-ASCII path on zh-CN came back garbled). Handles the two string types:
 *  · REG_SZ `"Name"="C:\\x"` — `\` and `"` escaped inside the quotes;
 *  · REG_EXPAND_SZ `"Name"=hex(2):43,00,…,\` — UTF-16LE bytes, wrapped over `\`-continued lines. `expand` says the
 *    `%VAR%` references in it are meant to be expanded (`expandWindowsEnvStrings`).
 * Value names compare case-insensitively, as the registry does (`Path` and `PATH` are one value).
 */
export function parseRegExportValue(exported: string, name: string): { value: string; expand: boolean } | null {
  const prefix = `"${name.replace(/[\\"]/g, '\\$&')}"=`.toLowerCase();
  const lines = exported.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trimEnd();
    if (!line.toLowerCase().startsWith(prefix)) continue;
    const data = line.slice(prefix.length);
    if (data.length >= 2 && data.startsWith('"') && data.endsWith('"')) {
      return { value: data.slice(1, -1).replace(/\\(.)/g, '$1'), expand: false };
    }
    if (!data.startsWith('hex(2):')) return null;
    let hex = data.slice('hex(2):'.length);
    while (hex.endsWith('\\') && i + 1 < lines.length) hex = hex.slice(0, -1) + lines[++i].trim();
    const bytes = Buffer.from(hex.split(',').filter(Boolean).map((byte) => parseInt(byte, 16)));
    return { value: bytes.toString('utf16le').replace(/\0+$/, ''), expand: true };
  }
  return null;
}

/** `%NAME%` → its value in `env` (names case-insensitive); an undefined name stays as written, as Windows leaves it. */
export function expandWindowsEnvStrings(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(/%([^%]+)%/g, (whole, name: string) => getWindowsEnvValue(env, name) ?? whole);
}
