# #3283 read-model PR: cut product lines (shared brief for the 4 cut lanes)

## Context
PR #3283 (GUYI-AI/gugu) moves every read a surface shows onto one replica: `apps/desktop/src/lib/replica.ts`
(`replica({...})`, `useReplica`, `useReplicas`, readings `unknown | value(+error) | error`, `retryOf(reading)`,
`refresh`, `refreshTag`, `watch`, `at().set`). Read `replica.ts` first. Owner-facing map: `/home/wcc/work/pr3283/THEORY-MAP.md`.

Against dev (a62bb6b35, already merged into the head 41a46042b) the PR adds **+1259 product lines** net (tests excluded).
The owner is unhappy with quality: moving to one mechanism should make code shorter, not longer. Goal for the
whole PR: product net below 0. Owner, verbatim: no hacks — joining lines, deleting comments, or squeezing formatting to
win lines is a hack and is seen at once. The cut must come from real causes: duplicated shapes, wrappers, dead code,
code that re-says what the mechanism already does, surfaces that grew where they should have shrunk.

## Measuring
- `python3 /home/wcc/work/pr3283/tools/pnum.py a62bb6b35 HEAD 40` inside your worktree (commit first): product net and the
  top files. For one file: `git diff --numstat a62bb6b35 -- <file>`. For a deleted dev file the PR replaced:
  `git show a62bb6b35:<path>` (list them: `git diff --name-status a62bb6b35 HEAD --diff-filter=D`).
- For each file you own: compare it with the dev code it replaced and find why the new one is longer.

## What counts as a real cut (examples)
- A shape repeated across declarations or hooks (same `read` wrapper, same unwrap-and-throw, same "enabled when X,
  which machine" hook) folded into one helper in your domain — or, if it belongs in the mechanism, **reported** (below).
- A wrapper that only forwards (`useX = (a) => useReplica(model, [a])`): delete it, callers use the model; fix the tests
  that mocked it by name (mock the replica module or seed the replica instead).
- A surface that hand-builds what `ReadingSlot` / `RefreshFailed reading=` / `retryOf` already does.
- Dead code: exports nobody imports (check with `git grep`), branches that can no longer happen.
- Code the PR added that dev did not need (a guard, a second path, a fallback) and that the mechanism already covers.
Not a cut: removing required behaviour (dev's behaviour stays unless it was a second implementation of a concept),
shortening names, collapsing statements onto one line, removing comments that still describe code that stays.
When you remove code, remove its now-stale comment with it (that is fine); a comment you keep must still be true.

## Rules
- Work only in your worktree `/home/wcc/work/pr3283/w<N>` (branch `cut<N>`), only on the files of your scope. A file
  outside your scope that you need changed: report it, do not edit it. `apps/desktop/src/lib/replica.ts` and
  `scripts/checks/effect-fetch-state.mts` are the coordinator's: do not edit them; report mechanism proposals instead.
- Frozen files must not grow (CI): ContactsPanel.tsx, ChatAreaPanel.tsx, lib/chat.ts, store/chat.tsx,
  GroupMembersSection.tsx, MessageBubble.tsx.
- Do not install dependencies or run pnpm/vitest/tsc on this machine (15G control plane; it has OOMed). Verify with
  `bash /home/wcc/work/pr3283/tools/check.sh <N> <vitest files or dirs>`: it ships your working tree to a gpu checkout and
  runs typecheck, `lint:source` (eslint, effect-fetch-state, hardcoded-cjk: no Chinese literals in renderer code, use
  `t()`), and the vitest files you name. It takes 2–5 min; run it after each meaningful step, and finally with every test
  file that imports or mocks a module you changed (`git grep -l <module name> -- tests apps`).
- Commit in reviewable semantic commits (one cause per commit), author already configured. Message: English, what and
  why; no AI signature, no Co-Authored-By line. Never push, never message anyone, never touch other worktrees.
- Code style: match the surrounding code (density, naming, comment tone). English comments.

## Report (your final message)
1. Lines: product net of your scope before → after (`pnum.py` total before/after too), commits (sha + one line each).
2. Per file: lines cut and the cause.
3. What you could not cut, per item, with the concrete reason (not "domain logic" alone: say which behaviour needs it).
4. Mechanism proposals for replica.ts: the repeated shape, every call site (path:line), lines it would save, and the
   exact option/helper you propose. Only shapes repeated ≥3 times.
5. Out-of-scope files you would change, and how.
6. Final check.sh output summary (typecheck / lint:source / tests).
