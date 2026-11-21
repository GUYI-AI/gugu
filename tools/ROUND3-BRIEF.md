# Round 3: one read path per kind of data (replaces the line target)

The owner corrected the goal (verbatim): 「这个方向不对劲啊, 我记得我们说的不是这样的啊, 首推链路统一, 架构干净啊」.
Lines are a signal, not the target. Do not remove behaviour to save lines.

New target: every kind of data is read through exactly one path, and the architecture is clean. Every change must be
explainable as "one path fewer" or "one way of writing it fewer".

## Task
1. Merge rma-head into your worktree first (`git merge rma-head`; it holds all lanes so far).
2. Inventory, for every kind of data in your domain (one row per data kind, e.g. "installed Apps on a machine",
   "market shelf", "agent list per machine"):
   - read paths on dev a62bb6b35: every place that reads it from its source or keeps its own copy. That includes stores,
     caches, useEffect+useState reads, react-query hooks, module-level Maps, a second rpc call in a component, a
     subscription that keeps a copy. Use `git grep` on a62bb6b35 for the source call (rpc name, service method) and for
     the store names.
   - read paths at the head (`rma-head` merged): the same count. A replica plus its readers is ONE path. A component
     calling the source rpc directly beside the replica is a second path.
   - Write the rows to `/home/wcc/work/pr3283/tools/paths-<N>.md` as a table:
     `| data | dev paths (where) | head paths (where) | note |`. Name the files of each path briefly.
3. Wherever the head still has more than one path for a data kind, or two ways of writing the same thing, fold it into
   one. A one-off command (a write, an action's own answer) is not a read path; say so in the note when you skip one.
4. Cold-review structural items still open in your scope, judged by the new rule: change them if they remove a path or a
   way of writing; reject them with the reason if they only move lines.
5. Verify with check.sh as before (every test that imports or mocks a module you changed). Commit, no AI signature.

## Report
- The table file path, and its totals (data kinds, dev paths, head paths).
- Commits, each with the path or the way of writing it removed.
- What stays at more than one path, and why.
- The pnum.py total after (`python3 /home/wcc/work/pr3283/tools/pnum.py a62bb6b35 HEAD`), as information only.
