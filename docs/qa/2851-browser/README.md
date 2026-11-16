# Browser feedback and phone navigation (#2851)

[24 matching screenshot pairs](screenshots.csv) preserve the original before and after PNGs with SHA-256 and actual image dimensions. Normal/loading cells use desktop CSS viewports 1280/800 and phone-shaped web viewports 390/360, in both themes. Four supplementary cells show the actual English profile menus and the rejected-address UI. The test runner scales viewports to fit its capture surface; PNG pixels and CSS sizes are distinct.

These are controlled macOS browser renders of the real components, using the approved review fixtures. They are not native-app or physical-phone acceptance. Settings and IPC are controlled at their fixture boundary; no real external page, profile clearing or user account is used.

After source: `769013b8aee3e8f3a6d240bcf62f7c237a39c27c`. This source also clears stale draft errors when the actual page URL changes; that transition is covered in the same focused behavior batch. The final spacing correction uses the existing integer spacing scale and all 24 cases were recaptured.

| Verified check | Result |
| --- | --- |
| Browser behavior tests on capture source | 8 passed |
| TypeScript on production UI change | Passed |
| Real component captures | 24 passed in 2 files |
| Rejected address, desktop 800 CSS px | Visible alert, height 37px, clip auto; navigation button 28×28px |
| Rejected address, phone 360 CSS px | Visible alert, height 37px, clip auto; navigation button 44×44px |
| Phone normal/loading, 360/390 CSS px, light/dark | All 3 navigation targets at least 44×44px, assertions passed |

The [raw DOM observations](observations.json) retain measured dimensions. Exact-head PR CI remains the authority for the full repository checks.
