#!/usr/bin/env python3
"""Move `// @@@effect-flow(...)` / `// @@@reading-default(...)` markers out of product code into
scripts/checks/effect-fetch-state-exemptions.txt.

usage: convert-markers.py [worktree] [--remote-slot wN]

1. Reads every marker in apps/desktop/src (non-test .ts/.tsx), with the `//` lines that continue it, and deletes them.
2. Runs the rule's raw scans (scanEffectFetchState, scanLiteralDefaults) on the stripped tree: locally when `node` and
   node_modules are there, else on gpu /tmp/cxrma/<slot> (the check.sh checkout: the tree is shipped as a patch vs BASE).
3. Writes the list: per file and kind, one entry per finding. A finding takes the reason of the marker that was on it
   (effect-flow: the marker right above the effect; reading-default: the nearest marker above), else the next entry
   already listed for that file and kind. Markers that exempted nothing and listed entries left over are dropped (printed).
   A finding with neither is printed and the script exits 1 (the list is still written).
Re-runnable: with no markers left it rewrites the list from the findings and the entries already there.
"""
import json, os, re, subprocess, sys, base64

BASE = '41a46042b'
SOURCE_ROOT = 'apps/desktop/src'
LIST = 'scripts/checks/effect-fetch-state-exemptions.txt'
KINDS = ['effect-flow', 'reading-default']
HEADER = """# Findings of scripts/checks/effect-fetch-state.mts that are not a read put into component state, one line each:
# `<path under apps/desktop/src>: <kind>(<category>) - <reason>`. Per file and kind there are as many lines as findings.
# The categories are EXEMPTIONS in effect-fetch-state.mts. Generated from the old markers by convert-markers.py; edit by hand.
"""
MARKER = re.compile(r'^\s*//.*@@@(effect-flow|reading-default)(?:\(([^)]*)\))?(?:\s*-\s*(.*))?$')
COMMENT = re.compile(r'^(\s*)//\s?(.*)$')
TEST = re.compile(r'(\.(test|spec)\.tsx?$)|(/(tests|__tests__)/)')
ENTRY = re.compile(r'^(.+?): (effect-flow|reading-default)\(([^)]*)\) - ?(.*)$')

SCAN_JS = """import { scanEffectFetchState, scanLiteralDefaults } from './scripts/checks/effect-fetch-state.mts'
console.log(JSON.stringify({ 'effect-flow': scanEffectFetchState(), 'reading-default': scanLiteralDefaults() }))
"""


def source_files(root):
    for dirpath, dirnames, filenames in os.walk(os.path.join(root, SOURCE_ROOT)):
        dirnames.sort()
        for name in sorted(filenames):
            if not re.search(r'\.tsx?$', name) or name.endswith('.d.ts'):
                continue
            rel = os.path.relpath(os.path.join(dirpath, name), root).replace(os.sep, '/')
            if not TEST.search(rel):
                yield rel


def strip_markers(root):
    """Delete the markers; return ({rel path: [(kind, category, reason, target line in the stripped file)]}, lines removed)."""
    markers, removed = {}, 0
    for rel in source_files(root):
        path = os.path.join(root, rel)
        with open(path, encoding='utf8') as f:
            lines = f.read().split('\n')
        if not any('@@@effect-flow' in l or '@@@reading-default' in l for l in lines):
            continue
        kept, found, i = [], [], 0
        while i < len(lines):
            m = MARKER.match(lines[i])
            if not m:
                kept.append(lines[i]); i += 1; continue
            indent = COMMENT.match(lines[i]).group(1)
            reason = [(m.group(3) or '').strip()]
            i += 1
            while i < len(lines):
                c = COMMENT.match(lines[i])
                if not c or c.group(1) != indent or '@@@' in lines[i]:
                    break
                reason.append(c.group(2).strip()); i += 1
            found.append((m.group(1), (m.group(2) or '').strip(), ' '.join(r for r in reason if r), len(kept) + 1))
        with open(path, 'w', encoding='utf8') as f:
            f.write('\n'.join(kept))
        markers[rel] = found
        removed += len(lines) - len(kept)
    return markers, removed


def scan(root, slot):
    if not slot:
        out = subprocess.run(['node', '--input-type=module', '-e', SCAN_JS], cwd=root, capture_output=True, text=True)
    else:
        subprocess.run(['git', 'add', '-A', '-N', '.'], cwd=root, check=True)
        patch = subprocess.run(['git', 'diff', '--binary', BASE], cwd=root, capture_output=True, check=True).stdout
        local = f'/tmp/convert-markers-{slot}.patch'
        with open(local, 'wb') as f:
            f.write(patch)
        cfg = os.path.expanduser('~/YellowPage/ssh_config')
        remote = f'/tmp/cxrma/{slot}'
        subprocess.run(['scp', '-q', '-F', cfg, local, f'gpu-via-juma3:{remote}.patch'], check=True)
        js = base64.b64encode(SCAN_JS.encode()).decode()
        inner = (f'cd {remote} && git checkout -q -f {BASE} && git clean -fdq -e node_modules'
                 f' && {{ [ ! -s {remote}.patch ] || git apply --index --whitespace=nowarn {remote}.patch; }}'
                 f' && echo {js} | base64 -d > .scan-raw.mjs && node .scan-raw.mjs')
        out = subprocess.run(['ssh', '-F', cfg, 'gpu-via-juma3',
                              f"chown cxrma {remote}.patch; /root/work/handoff/linux-rig/cx-enter.sh cxrma bash -c '{inner}'"],
                             capture_output=True, text=True)
    lines = [l for l in out.stdout.splitlines() if l.startswith('{')]
    if out.returncode != 0 or not lines:
        sys.exit(f'scan failed (rc {out.returncode}):\n{out.stdout[-2000:]}\n{out.stderr[-2000:]}')
    return json.loads(lines[-1])


def main():
    args = sys.argv[1:]
    slot = None
    if '--remote-slot' in args:
        at = args.index('--remote-slot'); slot = args[at + 1]; del args[at:at + 2]
    root = os.path.abspath(args[0] if args else '.')

    listed = {}  # (rel under SOURCE_ROOT, kind) -> [entry text]
    if os.path.exists(os.path.join(root, LIST)):
        with open(os.path.join(root, LIST), encoding='utf8') as f:
            for line in f.read().split('\n'):
                m = ENTRY.match(line)
                if m and not line.startswith('#'):
                    listed.setdefault((m.group(1), m.group(2)), []).append(line)

    markers, removed_lines = strip_markers(root)
    found = scan(root, slot)

    entries, missing, unused_markers, unused_listed = [], [], [], []
    keys = sorted({(rel, kind) for kind in KINDS for rel in found[kind]} | {(SOURCE_ROOT + '/' + p, k) for p, k in listed},
                  key=lambda k: (k[0], KINDS.index(k[1])))
    for rel, kind in keys:
        short = rel[len(SOURCE_ROOT) + 1:]
        own = [m for m in markers.get(rel, []) if m[0] == kind]
        used = set()
        old = list(listed.get((short, kind), []))
        for line in sorted(found[kind].get(rel, [])):
            if kind == 'effect-flow':
                at = [i for i, m in enumerate(own) if m[3] == line]
            else:
                at = [i for i, m in enumerate(own) if m[3] <= line][-1:]
            if at:
                used.add(at[0])
                _, category, reason, _ = own[at[0]]
                entries.append(f'{short}: {kind}({category}) - {reason}')
            elif old:
                entries.append(old.pop(0))
            else:
                missing.append(f'{rel}:{line} {kind}')
        unused_markers += [f'{rel}:{m[3]} {kind}({m[1]}) - {m[2]}' for i, m in enumerate(own) if i not in used]
        unused_listed += old
    # Files with markers but no findings of that kind.
    for rel, own in markers.items():
        for kind in KINDS:
            if (rel, kind) not in keys:
                unused_markers += [f'{rel}:{m[3]} {kind}({m[1]}) - {m[2]}' for m in own if m[0] == kind]

    with open(os.path.join(root, LIST), 'w', encoding='utf8') as f:
        f.write(HEADER + ''.join(e + '\n' for e in entries))
    removed = sum(len(v) for v in markers.values())
    print(f'markers removed: {removed} ({removed_lines} lines) in {len(markers)} files; entries written: {len(entries)}')
    for m in sorted(unused_markers):
        print(f'dropped marker (exempted nothing): {m}')
    for e in unused_listed:
        print(f'dropped stale entry: {e}')
    for m in missing:
        print(f'NOT EXEMPT (no marker, no entry): {m}')
    if missing:
        sys.exit(1)


if __name__ == '__main__':
    main()
