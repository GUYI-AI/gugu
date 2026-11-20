import { describe, expect, it } from 'vitest';
import * as nodePty from 'node-pty';
import { spawnNodePty } from './node-pty-spawner';

const env = { ...process.env, TERM: 'xterm-256color' } as Record<string, string>;
const spec = (args: string[]) => ({ command: process.execPath, args, cwd: process.cwd(), env, cols: 80, rows: 24 });

// A pty master is opened without close-on-exec; the next pty's program used to inherit it, and with it every
// other descriptor the host held without the flag. (Windows: ConPTY never passes handles.)
describe.runIf(process.platform === 'linux')('pty fd inheritance', () => {
  it('a pty program does not inherit another pty master', async () => {
    const holder = spawnNodePty(nodePty, spec(['-e', 'setInterval(() => {}, 1000);']));
    const lister = spawnNodePty(nodePty, spec(['-e', "const fs = require('node:fs'); process.stdout.write('fds ' + JSON.stringify(fs.readdirSync('/proc/self/fd').map((fd) => { try { return fs.readlinkSync('/proc/self/fd/' + fd); } catch { return ''; } })) + ' end');"]));
    const out = await new Promise<string>((resolve) => {
      let buffer = '';
      lister.onData((data) => { buffer += data; if (/ end/.test(buffer)) resolve(buffer); });
    });
    holder.kill();
    const links = JSON.parse(/fds (.*) end/s.exec(out)![1]!.replace(/\r?\n/g, '')) as string[];
    expect(links.length).toBeGreaterThan(2);
    expect(links.filter((link) => link.endsWith('ptmx'))).toEqual([]);
  });
});
