import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { removeTreeSync } from './remove-tree';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

// On Windows the link is a junction, which Electron 44's rmSync goes through; this test tells only there.
describe('removeTreeSync', () => {
  it('takes a tree with a link in it, and leaves what the link points at', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'remove-tree-'));
    roots.push(root);
    const kept = path.join(root, 'kept');
    fs.mkdirSync(path.join(kept, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(kept, 'sub', 'a.txt'), 'a');
    const tree = path.join(root, 'tree', 'deep');
    fs.mkdirSync(tree, { recursive: true });
    fs.writeFileSync(path.join(tree, 'b.txt'), 'b', { mode: 0o444 });
    fs.symlinkSync(kept, path.join(tree, 'link'), process.platform === 'win32' ? 'junction' : 'dir');

    removeTreeSync(path.join(root, 'tree'));
    removeTreeSync(path.join(root, 'missing'));

    expect(fs.existsSync(path.join(root, 'tree'))).toBe(false);
    expect(fs.readFileSync(path.join(kept, 'sub', 'a.txt'), 'utf8')).toBe('a');
  });
});
