import { spawn } from 'node:child_process';
import { afterEach, expect, it } from 'vitest';
import { AcpProbeRpcClient } from './probe-rpc';

const children: ReturnType<typeof spawn>[] = [];
afterEach(() => { for (const child of children.splice(0)) child.kill(); });

it('refuses a server request with a colliding id without mistaking it for the pending response', async () => {
  const child = spawn(process.execPath, ['-e', `
    let requested;
    require('node:readline').createInterface({input:process.stdin}).on('line', line => {
      const msg = JSON.parse(line);
      if (msg.method) { requested = msg.id; console.log(JSON.stringify({jsonrpc:'2.0',id:msg.id,method:'fs/read_text_file',params:{}})); }
      else if (msg.error?.code === -32601) console.log(JSON.stringify({jsonrpc:'2.0',id:requested,result:{safe:true}}));
    });
  `]);
  children.push(child);
  const rpc = new AcpProbeRpcClient(child);
  await expect(rpc.request('initialize', {})).resolves.toEqual({ safe: true });
});

it('settles pending requests when the owned probe process exits', async () => {
  const child = spawn(process.execPath, ['-e', 'process.stdin.once("data", () => process.exit(1))']);
  children.push(child);
  await expect(new AcpProbeRpcClient(child).request('initialize', {})).rejects.toThrow(/exited/);
});
