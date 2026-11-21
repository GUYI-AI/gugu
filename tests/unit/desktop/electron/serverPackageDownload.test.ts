import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { downloadServerPackage, DownloadSiteUnreachableError } from '../../../../apps/desktop/electron/server/server-package-download'

let home: string
const servers: Server[] = []
const sockets = new Set<Socket>()
beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-package-download-')) })
afterEach(async () => {
  for (const socket of sockets) socket.destroy()
  sockets.clear()
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
  fs.rmSync(home, { recursive: true, force: true })
})
async function feed(reply: (socket: Socket) => void): Promise<string> {
  const server = createServer(socket => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => {}) // The client intentionally aborts the timeout fixture.
    socket.once('data', () => reply(socket))
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server.address() as { port: number }).port}/package`
}
describe('server package transport', () => {
  it('streams a large HTTP/1.0 close-delimited response to disk without changing its bytes', async () => {
    const bytes = Buffer.alloc(8 * 1024 * 1024, 0xab)
    const url = await feed(socket => {
      socket.write('HTTP/1.0 200 OK\r\nConnection: close\r\n\r\n')
      socket.end(bytes)
    })
    const destination = path.join(home, 'package')
    await downloadServerPackage(url, destination)
    expect(createHash('sha256').update(fs.readFileSync(destination)).digest('hex'))
      .toBe(createHash('sha256').update(bytes).digest('hex'))
  })
  it('rejects a truncated body, then can download again in the same process', async () => {
    let broken = true
    const url = await feed(socket => socket.end(broken
      ? 'HTTP/1.0 200 OK\r\nContent-Length: 10000\r\n\r\nshort'
      : 'HTTP/1.0 200 OK\r\nContent-Length: 4\r\n\r\nokay'))
    const destination = path.join(home, 'package')
    await expect(downloadServerPackage(url, destination)).rejects.toBeInstanceOf(DownloadSiteUnreachableError)
    broken = false
    await downloadServerPackage(url, destination)
    expect(fs.readFileSync(destination, 'utf8')).toBe('okay')
  })
  it('follows a feed redirect and rejects a non-success response without writing a package', async () => {
    const target = await feed(socket => socket.end('HTTP/1.0 503 Unavailable\r\n\r\n'))
    const url = await feed(socket => socket.end(`HTTP/1.0 302 Found\r\nLocation: ${target}\r\n\r\n`))
    const destination = path.join(home, 'package')
    await expect(downloadServerPackage(url, destination)).rejects.toThrow('HTTP 503')
    expect(fs.existsSync(destination)).toBe(false)
  })
  it('reports a body which stops mid-stream as the site, not as an install failure', async () => {
    const url = await feed(socket => socket.write('HTTP/1.1 200 OK\r\nContent-Length: 10000\r\n\r\nstart'))
    const failure = downloadServerPackage(url, path.join(home, 'package'), 50)
    await expect(failure).rejects.toBeInstanceOf(DownloadSiteUnreachableError)
    await expect(failure).rejects.toThrow('stopped receiving data')
  })
  it('keeps a failing disk write out of the unreachable class', async () => {
    const url = await feed(socket => socket.end('HTTP/1.0 200 OK\r\nContent-Length: 4\r\n\r\nokay'))
    const failure = downloadServerPackage(url, path.join(home, 'missing-dir', 'package'))
    await expect(failure).rejects.toThrow('ENOENT')
    await expect(failure).rejects.not.toBeInstanceOf(DownloadSiteUnreachableError)
  })
  it('aborts a connection which never supplies a response', async () => {
    const url = await feed(() => {})
    await expect(downloadServerPackage(url, path.join(home, 'package'), 25)).rejects.toThrow('stopped receiving data')
  })
  it('rejects a malformed redirect through the transport without an uncaught exception', async () => {
    const url = await feed(socket => socket.end('HTTP/1.0 302 Found\r\nLocation: http://[\r\n\r\n'))
    await expect(downloadServerPackage(url, path.join(home, 'package'))).rejects.toBeInstanceOf(DownloadSiteUnreachableError)
  })
})
