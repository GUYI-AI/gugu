import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile, windowsSystemProgram } from './childProcess';

const execFileAsync = promisify(execFile);

/** Read a registry key as UTF-16LE so non-ASCII values survive any Windows console code page. */
export async function exportWindowsRegistryKey(key: string, env: NodeJS.ProcessEnv): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gugu-reg-'));
  try {
    const file = path.join(dir, 'key.reg');
    await execFileAsync(windowsSystemProgram('reg.exe', env), ['export', key, file, '/y'], { env, timeout: 5_000 });
    return await fs.readFile(file, 'utf16le');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/**
 * One value out of a `reg export` file (UTF-16LE whatever the system code page — `reg query` prints in the console
 * code page, so a non-ASCII path on zh-CN came back garbled). Handles the two string types:
 *  · REG_SZ `"Name"="C:\\x"` — `\` and `"` escaped inside the quotes;
 *  · REG_EXPAND_SZ `"Name"=hex(2):43,00,…,\` — UTF-16LE bytes, wrapped over `\`-continued lines. `expand` says the
 *    `%VAR%` references in it are meant to be expanded by the caller.
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

/** Expand registry environment references case-insensitively, preserving undefined references. */
export function expandWindowsEnvStrings(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(/%([^%]+)%/g, (literal, name: string) => {
    const wanted = name.toLowerCase();
    const key = env[name] === undefined ? Object.keys(env).find((candidate) => candidate.toLowerCase() === wanted) : name;
    return key ? env[key] ?? literal : literal;
  });
}

/** Resolve the CLI shipped inside a Windows app using the directory its installer registered. */
export async function findWindowsRegisteredPaths(
  registryKey: string,
  relativePath: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  const registered = await Promise.all(['HKCU', 'HKLM'].map(async (hive) => {
    const key = `${hive}\\Software\\${registryKey}`;
    let exported: string;
    try {
      exported = await exportWindowsRegistryKey(key, env);
    } catch (error) {
      // reg.exe exits with 1 when the install key is absent for this scope.
      if ((error as { code?: number }).code === 1) return null;
      throw error;
    }
    const location = parseRegExportValue(exported, 'InstallLocation');
    if (!location) return null;
    const root = location.expand ? expandWindowsEnvStrings(location.value, env) : location.value;
    if (!path.win32.isAbsolute(root) || path.win32.parse(root).root.length < 2) return null;
    const candidate = path.win32.join(root, relativePath);
    return (await fs.stat(candidate).catch(() => null))?.isFile() ? candidate : null;
  }));
  return registered.filter((candidate): candidate is string => candidate !== null);
}
