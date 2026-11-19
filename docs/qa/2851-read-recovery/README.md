# Read recovery and file actions (#2851)

The [40 matching screenshot pairs](screenshots.csv) cover desktop CSS viewport widths 1280/800 and phone-shaped web widths 390/360, in light and dark themes. They are original PNGs from controlled rendering of the real components on macOS. These captures are not native app or physical phone acceptance. The browser test runner scales the viewport to fit its capture surface; the CSV records the actual PNG dimensions separately from the CSS viewport size.

Before captures use the approved review fixtures. After captures use production source `0d9a92342e937bce00d2e64c45a26cdfdec48345`, with the same controlled inputs. The pure file-preview panel and version-history section receive their newly supported fallback callback; real asynchronous retry behavior is verified separately by targeted tests. HTML registration and browser settings captures exercise the real read owners. Upload-conflict captures run the built-in App in its iframe with controlled host SDK data. Clearing-storage captures show the real confirmation dialog without executing the destructive action.

Only the selected upload-conflict case is loaded from the workspace fixture: an unrelated retired comments fixture imports a source file absent from this tree. A first capture batch had a Vite error overlay and was discarded. Its replacement passed all 40 selected captures. Only replacement PNGs are included here.

| Check | Result |
| --- | --- |
| Read recovery / file-preview regressions | 32 passed in 4 files |
| Upload-conflict actions | 22 passed |
| Clear-storage scope, English and Chinese, named/default/isolated profiles | 6 passed |
| TypeScript (`tsgo --noEmit`) on final source | Passed |
| Replacement captures | 40 passed, 92 intentionally unselected |

Persistent-failure images show the final cause and fallback after automatic recovery is exhausted. Transient-error tests verify recovery without a click. Known-offline, revoked-access and missing-file behavior remains covered. Exact-head CI is reported in PR checks.
