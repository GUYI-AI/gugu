# Handoff: #3283 read model PR-A (lane session 5f367163, wenclaude → juma4)

## Goal, owner's words verbatim

- 05:28 reopen: 「不要乱分啊, 质量是质量, 你又变成流程了, 有毛用」 (don't split the PR).
- 06:42 goal correction, which replaces the line target: 「这个方向不对劲啊, 我记得我们说的不是这样的啊, 首推链路统一, 架构干净啊」
  - Every kind of data is read through exactly one path, and the architecture is clean.
  - Each change must be explainable as "one path fewer" or "one way of writing it fewer".
  - Lines are a signal, not the target. Don't remove behaviour, and don't propose "reads on return" as a cut.
- From 总管: the cold-review structural items still apply (`COLD-REVIEW.md`, 17 items).
  - Report lines honestly on the review basis: exclude the dead files, restore squeezed lines.
  - The final report needs a per-data-kind table: read paths before → after.
- 10:00: merge the latest dev before handing over. This PR always takes dev as a **merge**, never a rebase.

## State

- **Head:** `15a6ed5d564165715a16c6a4757338c233a7cddf`.
- **Bundle:** `pr3283-read-model-a.bundle` (HEAD over the pushed bf74bff7d and dev 7db4b05f6).
  - PR branch on GitHub: `read-model-a` (PR #3283), last pushed bf74bff7d.
  - The head is a fast-forward of bf74bff7d.
- **Commit metadata:** every commit since bf74bff7d is authored by shuxueshuxue, with no AI signature.
- **Dev:** merged up to 7db4b05f6 (`1c3111033`). One conflict, in `imageAnnotate/useAnnotateActions.ts`: dev's `item.replace` path is kept beside the branch's `hasAnnotationSource`.
- **Lines** (pnum vs dev 7db4b05f6, product code): +11348 −11126, net +222. Tests: net +7249.
  - Review basis (without the dead files app-featured 232 + app-market-content 240): +694.
  - Character-normalised: about +2175 lines.
- **Read paths:** 133 kinds, 231 → 167 paths, 17 kinds still on 2+ paths, each with a reason.
  - Tables: `tools/paths-1..4.md`. Summary and cold-review dispositions: `ROUND3-REPORT.md`.
- **Docs, updated for round 3:** `THEORY-MAP-owner.md` §5 and `pr-a-body.md` (the PR body).

## Gates

Full gates ran on a37cb6a39 (gpu `/tmp/cxrma/a`, script `/tmp/cxrma/gates6.sh`, logs `/tmp/cxrma/g6`).

Green: install, typecheck, lint:source, permanent-removal, ui-debt, lint (no cache), build:renderer:ci.

Failed, and what has happened since:

1. **unit:** 4 files failed. All four are fixed in `17d9ebd21` and `15a6ed5d5`, and the 7 related files pass on gpu.
   - `conversationNavigation7520` and `assistantWorkLinkOpen`: lane 3 had moved the link resolver onto `assistantWorkRecords.reread`, which needs a signed-in replica account. Reverted to dev's direct `listAll`. By our own counting rule, a read inside a click is an action, not a read path.
   - `assistantOnboarding740`: its `useAgent` mock still had the old shape; `useAgent` now returns a Reading.
   - `replyStatusRecovery1896`: the replica now logs a failing entry once until it reads again, where dev logged every retry. The test expectation is updated, and this logging change must be stated in the report.
   - **Full test:unit has not been re-run since these fixes.** Re-run it.
2. **db:** `connection-tui-engine.db.test.ts` fails 3 cases: 「独立 home 需要 GUGU_HOME:'codex' 声明了 configRoot」.
   - It looks environmental (the gpu slot runs without GUGU_HOME). Earlier rounds saw it fail alone on pure dev too.
   - **Not re-proven on dev 7db4b05f6.** Run that one file on pure dev before calling it environmental.
3. **browser:** `session-history-view.test.tsx` fails both cases of 「预览读不到文件 … (#3447)」, a test dev added in 3b3dc4f68. **This is still open.**
   - The probe showed `previewLocalSession` is called **0 times**: the detail pane stays on "Reading session content…".
   - The pane (`session-import/session-preview-pane.tsx`) reads through the `sessionImportPreview` replica (`session-import/import-source.ts:62`), keyed `[source.deviceId, filePath, engine]`. The replica's read ignores the `source` object the row passes and calls `resolveImportSource(deviceId)`. In this test that read never fires.
   - Suspects: `source.deviceId` for the history row's source (`importSourceOf(row.machine)`, `session-history-view.tsx:457`), or the replica account in that browser test.
   - Dev's version read through the passed `source.preview(...)` in an effect. Fix it so the replica reads through the same source.
   - Probe: add `console.log(mocks.previewLocalSession.mock.calls.length, detail.element().textContent)` after a 3 s wait. Run with `tools/check.sh 1 --project session-browser <file> -t 3447`.

## Left to do

1. Fix the #3447 browser failure, re-run the full gates on the new head, and settle the db file against pure dev.
2. Bundle to 总管 for a fast-forward push. Check CI once; GitHub reads go through ThinkPad only.
3. Final report to 总管: head, CI, `ROUND3-REPORT.md` content, and line accounting.
   - State honestly that the product A/B was not re-run after round 3.
   - State the logging change: one failure log per failing entry, not one per retry.
4. After the merge: clean the gpu slots and write `RELEASED` in `/tmp/cxrma`.

## Open decisions (for 总管 / owner)

- **Per-kind closure readers:** a replica reader that is not data would remove the market device picker registry (2 of the 17 multi-path kinds).
- **"A read that starts now, joining none begun earlier":** a replica operation for the assistant panel snapshot and the login binding.
- **Context outside the cache key** (lane 3's proposal): only pays with a third site. Not done.

## Gotchas

- **Gpu access:** `ssh -F ~/YellowPage/ssh_config gpu-via-juma3`, then `/root/work/handoff/linux-rig/cx-enter.sh cxrma <cmd>`.
  - The dev mirror is `/vepfs-mlp2/c20250602/251204036/gugu-work/git/gugu.git`.
  - Fetch it **as cxrma**: a root fetch in `/tmp/cxrma/a` left root-owned objects. I chowned them back.
- **check.sh:** `tools/check.sh <N>` ships a local worktree `w<N>` as a diff against 41a46042b into gpu `/tmp/cxrma/w<N>`. It needs `node_modules` there (present in w1 and a).
- **Frozen files:** ContactsPanel, ChatAreaPanel, lib/chat.ts, store/chat.tsx, GroupMembersSection and MessageBubble must not grow. None do at the head.
- **Source rule exemptions:** `scripts/checks/effect-fetch-state-exemptions.txt`, with per-file counts. If dev adds markers, use `tools/convert-markers.py`.
- **Commits:** PR bodies in English, owner's format. Author shuxueshuxue, no AI signature.

## Slots and accounts

- **gpu:** `/tmp/cxrma` (user cxrma), about 12G: `a` (gates checkout, at a37cb6a39 plus node_modules), `w1`–`w5` (w5 links to a).
  - **Held by this lane until the new lane takes them.** The new lane can reuse cxrma or release it: delete node_modules/.cache, keep `g6` logs.
- **mac1:** none.
- **Test accounts:** none used in this round.
- **Local worktrees on wenclaude:** `/home/wcc/work/pr3283/wt` (branch rma-head = head) and `w1`–`w5` (lane branches, all merged).
