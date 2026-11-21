# Handoff: lane session:31000078 (Apps page location + market detail polish; animation-off)

The lane moves to juma4 (owner decision, 总管 2 msg:6489f372).

## Files in this directory

```
mkt-location/   mkt-location.bundle  head mkt-detail 1215b74ca  on origin/dev 7db4b05f6   ← main deliverable, ready
                PR-BODY.md (English, owner format)
                shots/  memory-{before,after}-*.png + memory-{before,after}.webm, before-1440/, after-1440/, after-900/,
                        market-back-restored-after.png
anim-off/       anim-off.bundle      head anim-off   16712d836  on dev f523a2ba2 (needs a rebase on latest dev)
                PR-BODY.md (GATES_RESULT filled: all green)
```

Both commits are authored shuxueshuxue <98064968+shuxueshuxue@users.noreply.github.com>, with no AI signature. Suggested branches:
- `lane/apps-location-wip` (two commits, ready for a PR);
- `lane/anim-off-wip`.

## 1. Apps page location + market detail polish (main)

### Owner's words, verbatim (relayed by 总管 2)

- msg:79e5354a: 「apps 点进去之后详情界面现在有点问题, 比如滑动条似乎会串, 滑动一边另一边也会动, other devices 这个按钮的位置和样式很怪
点进去之后有时候这个 app 应该是在左侧边栏是滑动到正中间的, 而不是现在会掉到外面去
很多这样子的细节都没有打磨好」
- msg:f61b6f4b: 「市场页还有个点是他也没有记忆, 比如 installed 里面我切换到 apps, 打开一个 app 的内部设置页, 然后关掉, 回来的时候就不是上次的那个 apps 里面的位置了」
- msg:9ca22876: 「侧边栏的 add app 点进去居然不是 app。我现在强烈怀疑 market place 这一页的架构有问题，或许连 url 都没有了，可能需要重构」

### What 总管 2 asked for

- **msg:9ca22876:**
  - one `AppsLocation` in the apps view params as the only source;
  - every entry passes a location, and Add App passes the Apps tab;
  - coming back restores the last location.
- **msg:cb097679:**
  - no nested `back`: closing is history back;
  - the old one-shot params are fully gone, with no aliases.
- **Deliver:**
  - a bundle on latest dev;
  - same-profile, same-width before/after shots and a recording;
  - an English PR body;
  - full unit and tooling gates.

### State: done, ready for PR

- **Commit 1, `60ed75d4b`: market detail.**
  - The list and the page scroll apart (`use-browse-list.ts`).
  - The selected App is centred in the list.
  - "Other devices" sits in the action row at the same size.
- **Commit 2, `1215b74ca`: the location refactor.**
  - `features/apps/apps-location.ts` holds the location.
  - Navigation stores gain `placeParams`: a history entry carries a place, and an in-place move calls `history.replaceCurrent`.
  - `apps-views` and `InstalledManager` are controlled by the location.
  - The card's dead Installed tab and its orphaned row components are deleted.
  - Net 36 files, +545/−786.
- **Gates on gpu, run as cxpele on the commit before the last amend:**
  - install, typecheck, unit, lint, renderer, permanent and uistate: green;
  - browser: 1 failure (`workspace-new-tab` still asserted `navigate('apps')`). Fixed and amended into 1215b74ca; that test now passes on its own (4/4).
  - The full browser gate was not re-run after the amend.
- **YATU on a real web build signed in, 1440×900:**
  - Installed → 应用 → an App's settings → back. Before: the sheet is on 智能体. After: the sheet is on 应用.
  - Market list scrolled 296 px → open App → similar → back: 296 restored. (The old build also restored it in this path.)
  - Two independent panes. At 900 px, one column by design.

### Left / open

- **Add App from a task's New tab, real UI.** Not walked: the test account has no local task, because no agent is installed. A browser test covers the button. If juma4 has a desktop rig with a task, walk it.
- **Narrow width (~700).** Earlier, clicking the market tab failed in both the old and the new build. Not investigated (likely the shell layout at narrow width). Worth a look.
- **Behaviour changes to confirm with the owner.** Both are in the PR body:
  - Leaving Apps with the Installed sheet open and coming back reopens the sheet.
  - Opening an App, or opening it in a window, no longer resets the Apps page to its list.
- **Possible polish finding, not fixed:** the "+" on a market card is a decorative mark, not a button.

### Gotchas

- `ExtensionsSettingsCard` reads `currentAppsLocation()` from the global `appState`. Tests must reset it:
  - `extensions-folder-install.test.ts` has a top-level `beforeEach` that resets params and prunes history;
  - jsdom has no `Element.scrollTo`, so the test polyfills it.
- **Playwright rig:** clicking a card that is off screen scrolls the page to it first. Pick a card that is visible when testing scroll restore. Alt+Left is not "back" in the web build.
- **Gates must run as cxpele**, through `cx-enter.sh cxpele` and `/tmp/gate-run.sh`. Root runs give false reds.

### How to verify

1. `git bundle verify`.
2. Run the full gates (`/tmp/cxpele/gates-mk3.sh` is the recipe).
3. Do the owner's flow: Installed → 应用 → open an App → back. You should be on 应用.

## 2. Animation-off (paused when the market work came in)

- **What it is:** 16712d836, "motion nobody can see is removed, not paused".
  - Invisible animations get `animation: none` through `data-animation-off`.
  - RunningTokenBar's measuring copies get the same treatment.
  - `gg-md-table-more` is left unchanged, with measurements given in the PR body.
- **Gates on that commit as cxpele:** all 8 green (`/tmp/cxpele/gates-ao/summary.txt`).
- **Left:** rebase on latest dev, re-run gates, open the PR.

## 3. Idle watcher on the owner's Air (task B) — needs an owner

- The ThinkPad watcher (`~/gugu-idle-watch/watch.sh`) logged `2026-11-21T08:59:05Z CAPTURED, stopping`.
- **Still to do:**
  - analyse `/tmp/gugu-idle-probe/capture-*.json` on the Air;
  - delete that capture;
  - confirm inspector port 9229 is closed.
- **Rules on the Air:** read-only, and CDP or the inspector only over loopback or an ssh tunnel. This is the evidence for whether the anim-off fix addresses the idle-restyle report.

## Resources

- **gpu cx slot `cxpele`:**
  - Worktrees `/tmp/cxpele/mk3` (mkt-detail) and `/tmp/cxpele/pg` (anim-off) are kept; their node_modules and dist were cleaned.
  - Rig in `/tmp/cxpele/rig` (`mk3.mjs`, `run-mk3.sh`, `s-*.json`); evidence in `/tmp/cxpele/rig/mk3-out`. Do not delete `out` dirs.
  - Rig hosts 924696 and 924697 are stopped. Slot usage is about 5.4G.
- **Test account `mkt3-desk`:** released. I asked P4 to settle it, since tickets are signed on the machine that uses them. A juma4 lane asks P4 for its own.
- No mac1 gate lease is held.
