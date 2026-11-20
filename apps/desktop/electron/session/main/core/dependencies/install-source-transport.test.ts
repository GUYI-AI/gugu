import { createServer } from 'node:http';
import { connect } from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createInstallTransport, installProxyRoute } from './install-source-transport';

afterEach(() => vi.unstubAllEnvs());
describe('mise environment route', () => {
  it('uses only the supplied child environment, respecting HTTPS/HTTP/ALL_PROXY and NO_PROXY', () => {
    vi.stubEnv('HTTPS_PROXY', 'http://wrong-process-proxy:9999');
    const env = { HTTPS_PROXY: 'http://127.0.0.1:7897', HTTP_PROXY: 'http://127.0.0.1:7898', ALL_PROXY: 'http://127.0.0.1:7899', NO_PROXY: '.npmjs.org,localhost,127.0.0.1,::1' };
    expect(installProxyRoute(env, 'https://registry.npmjs.org/a')).toBeNull();
    expect(installProxyRoute(env, 'https://notnpmjs.org/a')).toBe('http://127.0.0.1:7897/');
    expect(installProxyRoute(env, 'http://mirror.test/a')).toBe('http://127.0.0.1:7898/');
    expect(installProxyRoute({ ALL_PROXY: env.ALL_PROXY }, 'https://mirror.test/a')).toBe('http://127.0.0.1:7899/');
    expect(installProxyRoute({}, 'https://mirror.test/a')).toBeNull();
    expect(installProxyRoute({ https_proxy: env.HTTPS_PROXY, no_proxy: '*' }, 'https://mirror.test/a')).toBeNull();
  });
  it.each([{ ALL_PROXY: 'socks5://127.0.0.1:1' }, { NO_PROXY: '10.0.0.0/8' }, { NO_PROXY: 'mirror.test:443' }, { HTTPS_PROXY: 'http://a:1', https_proxy: 'http://b:2' }, { SSL_CERT_FILE: '/custom.pem' }])('does not silently change unsupported routes %j', (env) => {
    expect(() => installProxyRoute(env, 'https://mirror.test/a')).toThrow();
  });
  it('actual local requests use the supplied proxy; NO_PROXY switches to direct without process.env', async () => {
    const destination = createServer((_req, res) => res.end('archive'));
    const proxy = createServer();
    let hits = 0;
    proxy.on('connect', (req, socket, head) => {
      hits++;
      const upstream = connect(Number(req.url!.split(':')[1]), '127.0.0.1', () => {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        socket.pipe(upstream); upstream.pipe(socket);
      });
      socket.on('error', () => upstream.destroy()); upstream.on('error', () => socket.destroy());
    });
    await new Promise<void>((done) => destination.listen(0, '127.0.0.1', done));
    await new Promise<void>((done) => proxy.listen(0, '127.0.0.1', done));
    const url = `http://127.0.0.1:${(destination.address() as AddressInfo).port}/artifact`;
    const env = { HTTP_PROXY: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}` };
    const via = createInstallTransport(env);
    const direct = createInstallTransport({ ...env, NO_PROXY: '127.0.0.1' });
    try {
      expect(await (await via.fetch(url)).text()).toBe('archive');
      expect(hits).toBe(1);
      expect(await (await direct.fetch(url)).text()).toBe('archive');
      expect(hits).toBe(1);
    } finally {
      await Promise.all([via.close(), direct.close()]);
      proxy.closeAllConnections(); destination.closeAllConnections();
      await Promise.all([new Promise<void>((done) => proxy.close(() => done())), new Promise<void>((done) => destination.close(() => done()))]);
    }
  });
});
