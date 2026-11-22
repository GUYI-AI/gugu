import { createServer, type Server } from 'node:http';
import { connect } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ session: { defaultSession: { resolveProxy: async () => 'DIRECT' } } }));

import { CloudObjectRouteError, createCloudObjectFetch } from './cloud-object-fetch';

const servers: Server[] = [], tunnels: Array<{ destroy(): void }> = [];
afterEach(async () => {
  for (const socket of tunnels.splice(0)) socket.destroy();
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); }
});
async function listen(server: Server): Promise<number> {
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  return address.port;
}
/** The object store: answers a range as it is asked, and records who connected. */
async function store(seen: string[]) {
  const bytes = Buffer.from('0123456789abcdef');
  return listen(createServer((request, response) => {
    seen.push(`${request.headers.host} ${request.headers.range ?? ''}`);
    const [, from, to] = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range ?? '') ?? [];
    if (from === undefined) { response.writeHead(200, { 'content-length': bytes.length }); response.end(bytes); return; }
    response.writeHead(206, { 'content-range': `bytes ${from}-${to}/${bytes.length}`, 'content-length': Number(to) - Number(from) + 1 });
    response.end(bytes.subarray(Number(from), Number(to) + 1));
  }));
}
/** A real HTTP proxy, as a corporate one tunnels: every CONNECT it opens is recorded. */
async function proxy(opened: string[]) {
  const server = createServer((_request, response) => { response.writeHead(405); response.end(); });
  server.on('connect', (request, client, head) => {
    opened.push(request.url ?? '');
    const [host, port] = (request.url ?? '').split(':');
    const upstream = connect(Number(port), host, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.write(head); upstream.pipe(client); client.pipe(upstream);
    });
    tunnels.push(client, upstream);
    upstream.on('error', () => client.destroy()); client.on('error', () => upstream.destroy());
  });
  return listen(server);
}

describe('the one main-process transport for cloud object bytes', () => {
  it('goes through the proxy Electron resolves for the address, Range and answer intact', async () => {
    const seen: string[] = [], relayed: string[] = [];
    const [port, via] = [await store(seen), await proxy(relayed)];
    const asked: string[] = [];
    const fetchObject = createCloudObjectFetch(async (url) => { asked.push(url); return `PROXY 127.0.0.1:${via}; DIRECT`; });
    const response = await fetchObject(`http://127.0.0.1:${port}/object`, { headers: { Range: 'bytes=4-7' } });
    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe('bytes 4-7/16');
    expect(await response.text()).toBe('4567');
    expect(asked).toEqual([`http://127.0.0.1:${port}/object`]);
    expect(relayed).toEqual([`127.0.0.1:${port}`]);
    expect(seen).toEqual([`127.0.0.1:${port} bytes=4-7`]);
  });

  it('connects directly only when Electron says DIRECT', async () => {
    const seen: string[] = [];
    const port = await store(seen);
    const response = await createCloudObjectFetch(async () => 'DIRECT')(`http://127.0.0.1:${port}/object`);
    expect(await response.text()).toBe('0123456789abcdef');
    expect(seen).toHaveLength(1);
  });

  it('a route it cannot take is refused, and nothing connects in its place', async () => {
    const seen: string[] = [];
    const port = await store(seen);
    for (const answer of ['SOCKS5 127.0.0.1:1080', 'SOCKS 127.0.0.1:1080; DIRECT', '']) {
      await expect(createCloudObjectFetch(async () => answer)(`http://127.0.0.1:${port}/object`)).rejects.toBeInstanceOf(CloudObjectRouteError);
    }
    await expect(createCloudObjectFetch(async () => { throw new Error('resolveProxy failed'); })(`http://127.0.0.1:${port}/object`)).rejects.toThrow('resolveProxy failed');
    expect(seen).toEqual([]);
  });
});
