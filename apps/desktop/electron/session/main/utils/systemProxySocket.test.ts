import http from 'node:http';
import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { connectThroughSystemProxy } from './systemProxySocket';

const closers: Array<() => void> = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
});

async function listen(server: http.Server | net.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  closers.push(() => server.close());
  return (server.address() as net.AddressInfo).port;
}

async function echoServer(): Promise<number> {
  const server = http.createServer();
  const wss = new WebSocketServer({ server });
  wss.on('connection', (socket) => socket.on('message', (data) => socket.send(`echo:${data}`)));
  closers.push(() => wss.close());
  return listen(server);
}

/** A forward proxy that tunnels CONNECT, or answers it with `status`, or never answers at all. */
async function proxy(behaviour: 'tunnel' | 'silent' | number) {
  const seen: string[] = [];
  const ended: string[] = [];
  const sockets = new Set<net.Socket>();
  const server = http.createServer();
  server.on('connect', (request, client: net.Socket) => {
    seen.push(request.url!);
    sockets.add(client);
    if (behaviour === 'silent') {
      client.resume().once('end', () => ended.push(request.url!));
      return;
    }
    if (typeof behaviour === 'number') {
      client.end(`HTTP/1.1 ${behaviour} Nope\r\n\r\n`);
      return;
    }
    const [host, port] = request.url!.split(':');
    const upstream = net.connect(Number(port), host, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.pipe(client);
      client.pipe(upstream);
    });
    sockets.add(upstream);
  });
  const port = await listen(server);
  closers.push(() => sockets.forEach((socket) => socket.destroy()));
  return { port, seen, ended };
}

function open(url: string, answer: string, handshakeTimeout = 2_000) {
  const asked: string[] = [];
  const ws = new WebSocket(url, {
    handshakeTimeout,
    createConnection: connectThroughSystemProxy(async (target) => {
      asked.push(target);
      return answer;
    }, false) as never,
  });
  closers.push(() => ws.terminate());
  const outcome = new Promise<string>((resolve) => {
    ws.once('open', () => {
      ws.send('hi');
      ws.once('message', (data) => resolve(String(data)));
    });
    ws.once('error', (error) => resolve(`error:${error.message}`));
  });
  return { asked, outcome };
}

describe('host sockets through the system proxy', { timeout: 10_000 }, () => {
  it('tunnels through the proxy Chromium names for this URL', async () => {
    const server = await echoServer();
    const forward = await proxy('tunnel');
    const { asked, outcome } = open(`ws://127.0.0.1:${server}/realtime`, `PROXY 127.0.0.1:${forward.port}; DIRECT`);
    expect(await outcome).toBe('echo:hi');
    expect(asked).toEqual([`http://127.0.0.1:${server}/`]);
    expect(forward.seen).toEqual([`127.0.0.1:${server}`]);
  });

  it('connects directly when the answer is DIRECT, and when it is a SOCKS proxy it cannot tunnel', async () => {
    const server = await echoServer();
    const forward = await proxy('tunnel');
    expect(await open(`ws://127.0.0.1:${server}/`, 'DIRECT').outcome).toBe('echo:hi');
    expect(await open(`ws://127.0.0.1:${server}/`, `SOCKS5 127.0.0.1:${forward.port}`).outcome).toBe('echo:hi');
    expect(forward.seen).toEqual([]);
  });

  it('fails the handshake when the proxy refuses the tunnel', async () => {
    const server = await echoServer();
    const forward = await proxy(403);
    expect(await open(`ws://127.0.0.1:${server}/`, `PROXY 127.0.0.1:${forward.port}`).outcome).toMatch(/^error:.*refused the tunnel \(403\)/);
  });

  it('bounds a proxy that accepts the connection and never answers CONNECT, and closes that tunnel', async () => {
    const forward = await proxy('silent');
    const { outcome } = open('ws://127.0.0.1:9/', `PROXY 127.0.0.1:${forward.port}`, 300);
    expect(await outcome).toBe('error:Opening handshake has timed out');
    await expect.poll(() => forward.ended).toEqual(['127.0.0.1:9']);
  });
});
