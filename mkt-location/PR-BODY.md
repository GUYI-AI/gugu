## Apps page: one location as a back-stack step, and market detail polish

### Problem

Two reports about the Apps page.

1. **The Apps page forgets where you were.** Open Installed, switch to the Apps segment, open an App's settings, then press back: the sheet comes back on the Agents segment. Adding an App from a task's New tab does not open the Apps tab either.

   The cause is structural. Where you are on this page is spread over four one-shot params and several pieces of component state:
   - `marketPage`, `detail`, `installedSection` and `installedDeviceId`, each consumed and then cleared;
   - the card's own `tab`, its `detail` with a nested `from` that rebuilt a second back stack, and `listScroll`;
   - the Installed sheet's section, device and layout, kept in local state.

   The real back stack recorded none of it: every visit to `apps` compared equal, so pushes were skipped. Each entry restored its own piece, and every other piece fell back to a default.

2. **Market detail beside the list** (polish on #3448):
   - the list and the App page scrolled as one;
   - "Other devices" sat on a row of its own, in a smaller button;
   - the selected App could be off screen in the list.

### Change

Two commits.

**1. Market detail: the list and the page scroll apart; the selected App is centred**
- `use-browse-list.ts`: the list beside an open App page is its own scroller. It is sticky under the header, as tall as the visible page, and re-fitted on resize. Scrolling one pane leaves the other where it is.
- The selected card is centred in the list when a page opens: from the list, from a link, from "Similar Apps", and when switching Apps mid-install.
- "Other devices" moved into the action row, at the same button size (`MarketDevicePicker size="lg"`).

**2. Apps page: one location, a step of the back stack**
- **`AppsLocation`** (`features/apps/apps-location.ts`) holds where you are on the Apps page. It is the only source, the Apps view's `location` param:
  - the tab, the device and the sort;
  - the list scroll;
  - the Installed sheet: segment, device, layout and scroll;
  - the open App page.
- **`placeParams`, a general mechanism in the navigation store.** A view declares which params say "where inside me". A history entry carries that place, so two places are two steps. Changing a place param in place (`updateViewParams`) rewrites the current step instead of adding one. So a segment switch or a recorded scroll is not a step of its own, and going back returns to where you left, not to where you came in. Only `apps` uses it today.
- **Every entry passes a location.**

  | Entry | Location |
  |---|---|
  | App link, App settings button in an App's tab | `{...current, detail}` on that device; the sheet closes |
  | Installed button | `{...current, installed: {section: 'agents'}}` |
  | Add App, in the New tab and the workspace panel | `{tab: 'market'}` |
  | "Manage connectors" | `{tab: 'connectors', installed: {section: 'connectors', direct: true}}` |
  | Host links (`library:*`) | the matching tab |
  | Sidebar, ⌘L | the remembered location |

- **Closing is history back.** This covers an App page's back button, the sheet's close, and an agent dialog opened over the sheet. There is no nested `back`/`from` field: no entry needed to avoid a history push. A page reached as the first step (a restart, or a link from another view) goes back to the list or the sheet instead.
- **Removed**, with no aliases:
  - the one-shot params `marketPage`, `detail`, `installedSection` and `installedDeviceId`;
  - the card's Installed tab, unreachable since the Installed sheet;
  - the row components and constant only that tab used (`InstalledAppRow`, `InstalledAgentRows`, `InstalledRowsSkeleton`, `INSTALLED_GROUP_ORDER`).
- **Behaviour changes worth knowing:**
  - Leaving the Apps page with the sheet open and coming back reopens the sheet where it was.
  - Opening an App, or opening it in a window, no longer resets the Apps page to its list first. Back returns to the App page.

### Why this size

36 files, +545 / −786. Most of the deletion is the dead Installed tab and the old per-piece state. The navigation change is about 30 lines across `navigation-store`, `navigation-history-store` and `view-registry`. `apps-location.ts` is 61 lines of type and four helpers. A separate "memory" store beside the existing params was tried first and dropped: it would have been a second source for the same facts.

### Reuse

- The existing back stack (`appState.history`) and `navigateBack`.
- View params, which are already persisted across restarts.
- The transient-param rule (`agentDetail` still never enters history).
- `useAppDetailRequest` still settles a link: settings if installed, otherwise the market page. It now reports into the location.

### Tests

- **Unit, new or rewritten:**
  - `navigation-history-store.test.ts`: places are steps, and `replaceCurrent` is ignored while going back.
  - `navigation-store.test.ts`: place recorded per push; an in-place move rewrites the step; transient params still never recorded.
  - `use-app-detail-request.test.tsx`: link settling, and a page already drawn asks nothing.
  - `extensions-folder-install.test.ts`: installed-inventory cases now go through the sheet's item contract and location-opened settings pages; `extensions-market-snapshot.test.ts` drops its case for the removed Installed tab.
  - `appDetailNavigation`, `assistantEntry`, `host-links-manifest`, `initial-session-section`: assert locations.
- **Browser:** `workspace-new-tab` asserts that Add App lands on `{tab: 'market'}`.
- **Full gates on this commit:** install, typecheck, unit, lint, `build:renderer:ci`, permanent-removal and ui-state-debt are green. The browser gate had one failure: `workspace-new-tab` still asserted the removed `navigate('apps')` call. After that test was updated and amended in, it passes when re-run on its own; the full browser gate was not re-run.
- **Real web build, signed in, at 1440 × 900:**
  - Installed → Apps → an App's settings → back. Before: the sheet is on Agents. After: the sheet is on Apps.
  - Market list scrolled 296 px → open an App → Similar App → back: the list is at 296 px.
  - Wheel over the list: the page stays at 0. Wheel over the page: the list stays put.
  - At 900 px, one column; the list is hidden by design.
- **Not walked in the real build:** Add App from a task's New tab. The test account has no local task to open it from; the browser test above covers the button.

### Design

- No new visual language.
- "Other devices" is a regular-size button in the action row.
- The App list beside a page scrolls on its own, with its selected App centred.
- Back from an App's settings returns to the segment you were on.

Before/after: `shots/memory-before-*.png` / `shots/memory-after-*.png` (same profile, same width), recordings `shots/memory-before.webm` / `shots/memory-after.webm`. Market polish: `shots/before-1440/`, `shots/after-1440/`, `shots/after-900/`.
