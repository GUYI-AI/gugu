import { realpathSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { chmod, link, mkdtemp, open, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { MAX_CREATION_RECORD_BYTES, openCreationAttachmentJournal as openJournal } from './creation-attachment-journal';

const openCreationAttachmentJournal: typeof openJournal = (root, owner, device, request, options) =>
  openJournal(root, owner, device, request, { durabilityRoot: realpathSync(root), ...options });

const roots: string[] = [];
const fresh = async () => { const root = realpathSync(await mkdtemp(join(tmpdir(), 'creation-journal-'))); roots.push(root); return root; };
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe('POSIX bounded private creation facts', () => {
  it.skipIf(process.platform === 'win32')('rejects a private FIFO with no writer through the complete journal read before the child deadline', async () => {
    const root = await fresh();
    await openCreationAttachmentJournal(root, 'owner', 'device', 'request');
    const [key] = await readdir(root), path = join(root, key, 'creating.json');
    await promisify(execFile)('mkfifo', ['-m', '600', path]);
    const module = fileURLToPath(new URL('./creation-attachment-journal.ts', import.meta.url));
    const script = `const {openCreationAttachmentJournal}=await import(${JSON.stringify(`file://${module}`)});\nconst j=await openCreationAttachmentJournal(${JSON.stringify(root)},'owner','device','request',{durabilityRoot:${JSON.stringify(root)}});\ntry {await j.read('creating');process.exitCode=2} catch(e) {if(!String(e.message).includes('private regular file')) throw e;console.log('FIFO_REJECTED')}`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NODE_OPTIONS: '' } });
    let output = '', error = '', expired = false;
    child.stdout.on('data', bytes => { output += bytes; }); child.stderr.on('data', bytes => { error += bytes; });
    const timer = setTimeout(() => {
      expired = true;
      void promisify(execFile)('pgrep', ['-af', String(child.pid)]).catch(() => undefined).finally(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      });
    }, 5000);
    try {
      const [code] = await once(child, 'close');
      expect(expired, error).toBe(false); expect(code, error).toBe(0); expect(output).toContain('FIFO_REJECTED');
    } finally { clearTimeout(timer); }
  }, 10_000);
  it('reopens complete private records and keeps an exclusive fact immutable', async () => {
    const root = await fresh(), journal = await openCreationAttachmentJournal(root, 'owner', 'device', 'request');
    expect(await journal.append('creating', { conversationId: 'original' })).toBe(true);
    expect(await journal.append('creating', { conversationId: 'original' })).toBe(false);
    expect(await (await openCreationAttachmentJournal(root, 'owner', 'device', 'request')).read('creating')).toEqual({ conversationId: 'original' });
    await expect(journal.append('creating', { conversationId: 'other' })).rejects.toThrow('conflicts');
  });
  it('refuses an oversized sparse record before allocating or reading its body', async () => {
    const root = await fresh(), journal = await openCreationAttachmentJournal(root, 'owner', 'device', 'request');
    const [key] = await readdir(root), file = await open(join(root, key, 'creating.json'), 'wx', 0o600);
    try { await file.truncate(MAX_CREATION_RECORD_BYTES + 1); } finally { await file.close(); }
    await expect(journal.read('creating')).rejects.toThrow('invalid size');
  });
  it('rejects invalid UTF-8 and partial JSON instead of treating corruption as an absent intent', async () => {
    const root = await fresh(), journal = await openCreationAttachmentJournal(root, 'owner', 'device', 'request');
    const [key] = await readdir(root), path = join(root, key, 'creating.json');
    await writeFile(path, Buffer.from([0xff]), { mode: 0o600 });
    await expect(journal.read('creating')).rejects.toThrow();
    await writeFile(path, '{'); await expect(journal.read('creating')).rejects.toThrow('cannot be read');
  });
  it('keeps POSIX group/other refusal and rejects hard-linked records', async () => {
    const root = await fresh();
    await chmod(root, 0o755);
    await expect(openCreationAttachmentJournal(root, 'owner', 'device', 'request')).rejects.toThrow('private directory');
    await chmod(root, 0o700);
    const journal = await openCreationAttachmentJournal(root, 'owner', 'device', 'request');
    await journal.append('creating', { conversationId: 'original' });
    const [key] = await readdir(root); await link(join(root, key, 'creating.json'), join(root, 'alias'));
    await expect(journal.read('creating')).rejects.toThrow('private regular file');
  });
});
