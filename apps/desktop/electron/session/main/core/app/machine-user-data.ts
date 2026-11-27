import { app } from 'electron';

/**
 * gugu-dev#1616 The machine's own directory, apart from the signed-in account's userData: what is installed on this
 * computer (Apps' packages, the market's unpacked downloads, the first-run App record) is shared by every account on it;
 * each account's data stays in its own userData. Set by the desktop shell before boot (main.ts GUGU_MACHINE_USER_DATA);
 * a host that has no account layout (the headless server, tests) uses its userData for both.
 */
export function machineUserDataDir(): string {
  return process.env.GUGU_MACHINE_USER_DATA?.trim() || app.getPath('userData');
}
