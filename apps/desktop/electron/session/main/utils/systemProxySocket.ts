import net from 'node:net';
import tls from 'node:tls';
import type { Duplex } from 'node:stream';
import { proxyFromPac } from './systemProxyEnv';

/**
 * The host's cloud WebSockets (Realtime, file sync) reach the server the way Chromium would: through the system proxy.
 *
 * `ws` is Node's: it connects straight to the server and never reads the system proxy. For a user whose network only
 * reaches the backend through the system proxy (Clash/Surge "system proxy" mode, a corporate proxy), every Chromium
 * request worked while every channel failed (`CHANNEL_ERROR`): no live messages, no device-command wake-ups.
 *
 * Pass this as `ws`'s `createConnection`. Each connection asks Chromium (`session.resolveProxy`, the same one source as
 * `systemProxyEnv`, PAC included) where this URL goes, then opens the socket: `DIRECT` exactly as `ws` would itself,
 * `PROXY`/`HTTPS` through an HTTP CONNECT tunnel. Asked per connection, so a proxy switched on or off mid-run counts on
 * the next reconnect. SOCKS is not tunneled (the same limit as `systemProxyEnv`) and connects directly, as before.
 *
 * `ws`'s handshake timeout only starts once Node has a socket; the proxy lookup and the tunnel come before that, so the
 * same deadline (`options.timeout`) bounds them here. A proxy that accepts and never answers CONNECT fails like a dead
 * server would, and the half-open tunnel is destroyed.
 */
type ConnectOptions = tls.ConnectionOptions & { host?: string | null; port?: number | string | null; timeout?: number };
type Done = (error: Error | null, socket?: Duplex) => void;

export function connectThroughSystemProxy(resolveProxy: (url: string) => Promise<string>, secure: boolean) {
  return (options: ConnectOptions, done: Done): undefined => {
    const host = String(options.host ?? 'localhost');
    const port = Number(options.port);
    let tunnel: net.Socket | undefined;
    let settled = false;
    const settle = (error: Error | null, socket?: Duplex) => {
      if (settled) {
        socket?.destroy();
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (error) tunnel?.destroy();
      done(error, socket);
    };
    const timer = options.timeout ? setTimeout(() => settle(new Error('Opening handshake has timed out')), options.timeout) : undefined;
    const target = (socket?: net.Socket): Duplex => {
      if (!secure) return socket ?? net.connect({ ...options, host, port } as net.NetConnectOpts);
      const servername = options.servername || options.servername === '' ? options.servername : net.isIP(host) ? '' : host;
      return tls.connect({ ...options, host, port, servername, ...(socket ? { socket } : {}) });
    };
    resolveProxy(`${secure ? 'https' : 'http'}://${host}:${port}/`).then((answer) => {
      if (settled) return;
      const reading = proxyFromPac(answer);
      if (!reading.proxy) {
        settle(null, target());
        return;
      }
      const proxy = new URL(reading.proxy);
      const proxyPort = Number(proxy.port) || (proxy.protocol === 'https:' ? 443 : 80);
      tunnel = proxy.protocol === 'https:'
        ? tls.connect({ host: proxy.hostname, port: proxyPort, servername: net.isIP(proxy.hostname) ? '' : proxy.hostname })
        : net.connect({ host: proxy.hostname, port: proxyPort });
      const authority = net.isIPv6(host) ? `[${host}]:${port}` : `${host}:${port}`;
      const onError = (error: Error) => settle(error);
      const onClose = () => settle(new Error(`System proxy ${proxy.host} closed before the tunnel opened`));
      tunnel.once('error', onError);
      tunnel.once('close', onClose);
      tunnel.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
      let head = Buffer.alloc(0);
      const onData = (chunk: Buffer) => {
        head = Buffer.concat([head, chunk]);
        const end = head.indexOf('\r\n\r\n');
        if (end < 0) return;
        tunnel!.off('data', onData).off('error', onError).off('close', onClose);
        const status = /^HTTP\/1\.[01] (\d{3})/.exec(head.subarray(0, end).toString('latin1'))?.[1];
        if (status !== '200') {
          settle(new Error(`System proxy ${proxy.host} refused the tunnel (${status ?? 'no status'})`));
          return;
        }
        // Nothing follows the proxy's answer: the server speaks only after our TLS hello or upgrade request.
        settle(null, target(tunnel));
      };
      tunnel.on('data', onData);
    }, (error: unknown) => settle(error instanceof Error ? error : new Error(String(error))));
    return undefined;
  };
}

/** `ws` client options for a host socket to the cloud: the system proxy, and a 10 s bound on the whole opening handshake. */
export function systemProxyWebSocketOptions(address: string | URL, resolveProxy: (url: string) => Promise<string>) {
  const secure = /^(wss|https):$/.test(new URL(address).protocol);
  // Node's types say createConnection returns its socket; it may instead call back with one, which is what this does.
  return { handshakeTimeout: 10_000, createConnection: connectThroughSystemProxy(resolveProxy, secure) as never };
}
