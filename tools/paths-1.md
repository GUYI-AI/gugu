# Lane 1 read paths: Apps / extensions / market

Dev = a62bb6b35. Head = w1 cut1 after the round 3 commits (merged with rma-head; HEAD e8507ddcb).
A replica plus its readers counts as ONE path. A one-off command (a write, an install, an action's own answer) is not a read path.

| data | dev paths (where) | head paths (where) | note |
|---|---|---|---|
| Installed list per host (local, remote:<id>, phone) | 6: installedExtensionsStore `api.list` (installed-extensions-store); PhoneAppManage `machineRpc(...).list` for the uninstall check; phoneMarketTargets `api.list` + `deviceApplicationInventory` store.load; installed-elsewhere `rpc.extensions.list`; market-detail-extension-devices `host.api.list`; NotificationSettingsCard `store.load` | 1: `installedExtensions` replica (installed-extensions.ts; the phone via `phoneStore('list')`) | Round 3 folded the last four direct reads: installed-elsewhere and PhoneAppManage use `installedExtensions.reread` (the uninstall decides on a fresh read), and both device pickers use `installedExtensions.fetch`. `fetchInstalledApps`/`peekInstalledApps` are helpers over that same replica. |
| Market updates (offered version per installed App) | 2: installedExtensionsStore `api.marketUpdates`; phoneMarketPage `phoneApps.marketUpdates` | 1: `marketUpdates` replica (installed-extensions.ts) | The phone's `useOfferedVersions` is a reader of the replica. Its `phoneApps.market.refresh()` is a command (fetch the index); a changed index refreshes the replica. |
| Market shelf (catalog pages, kept for first frame) | 1: ExtensionsSettingsCard market pages (useQuery) | 1: `marketShelf` replica + kept-shelf `local` (market-replicas.ts) | The kept copy is that replica's `local`, not a second path. |
| Market search results | 1: ExtensionsSettingsCard (search query) | 1: `marketSearch` replica | Same source as the shelf, a different query and result, so a separate kind. |
| Install ranking | 2: desktop-extension-market useQuery `market_install_ranking`; phoneMarketPage ranking (fed a `marketHome` the phone never drew) | 1: `marketInstallRanking` replica (desktop-extension-market reads it) | The phone's ranking was a dead read: it was only used for `featured`/`home`, which no phone surface drew. |
| Market entry (one App's offered version) | 4: ExtensionsSettingsCard `marketEntry`; use-app-detail-request `host.api.marketEntry`; phoneMarketTargets `api.marketEntry`; market-detail-extension-devices `api.marketEntry` | 1: `marketEntry` replica | Round 3 folded use-app-detail-request and both device pickers. |
| Version history | 2: use-version-history; market-detail-extension-devices `api.marketHistory` | 1: `marketVersionHistory` replica (the phone via `phoneStore('marketHistory')`) | Round 3 folded the desktop picker. |
| Market listing (product page text and media) | 3: app-product-page, market-detail-extension, app-featured `marketListing` | 1: `marketListing` replica | `marketRead` (media bytes) is fetched on demand by the media component, not a data read. |
| App settings | 1: ExtensionsSettingsCard | 1: `extensionSettings` replica | `setSettings` is a command. |
| App places | 1: app-given-section | 1: `appPlaces` replica | |
| Agent tools | 1: app-manage-page | 1: `extensionAgentTools` replica | |
| Agent skills | 1: app-manage-page | 1: `extensionAgentSkills` replica | |
| App data size | 1: app-manage-page | 1: `extensionDataBytes` replica | |
| Agent status per App | 1: ExtensionsSettingsCard | 1: `extensionAgentStatus` replica | |
| Permissions taken back (revoked) | 2: ExtensionsSettingsCard `revoked`; NotificationSettingsCard `revoked` | 1: `extensionRevokedPermissions` replica (NotificationSettingsCard.tsx) | |
| Installable market offers (chat cards) | 2: GroupTabContent `appsHere.marketOffers()`; WidgetBubble `appsHere.marketOffers()` | 1: `marketOffers` replica | Round 3: on the phone, `appsHere.marketOffers` now reads `phoneMarketCatalog` instead of the store a second time. On the desktop it is main's `marketOffers` (main filters the index for this machine), which the renderer reads only here. |
| Phone market catalog (entries for phone / for desktops) | 3: phoneMarketPage useQuery; appsHere phone `marketOffers` (`phoneApps.market.entries()`); firstRunApps `offers` (`phoneApps.market.entries()`) | 1: `phoneMarketCatalog` replica (phoneMarketPage.ts) | Round 3 folded the offers and first-run reads. `phoneApps.market.entries()` inside phoneApps.ts (install picks a version, auto-update) is the store's own command path. |
| Device picker reading (what a device has and is offered, per App) | 2: market-detail-extension-devices own reads; phoneMarketTargets own reads (both directly against each device) | 1: `marketDeviceReading` replica (market-device-readings.ts) over `installedExtensions` + `marketEntry` + `marketVersionHistory` | It is a derived reading. Its sources are the shared replicas above. After an install the source is refreshed first, then the reading. The agent and connector kinds read through their own domains (lane 2). |
| Surface bindings | 1: AppConversationSurfaceHost `rpc` | 1: `appSurfaceBindings` replica | |
| Unread bindings | 1: AppConversationUnread `rpc` | 1: `appUnreadBindings` replica | |
| Composer actions | 1: appComposerActions `rpc` | 1: `appComposerActions` replica | Running an action (`runConversationComposerAction`) is a command. |
| Package summary (attachment package) | 1: sharedPackages summaries Map | 1: `extensionPackageSummary` replica | |
| Shared packages per chat | 1: sharedPackages perChat Map | 1: `sharedAppPackages` replica | |
| App version | 3: AboutSection, FeedbackModal, useReleaseNotes | 1: `appVersion` replica (lib/appVersion.ts) | |
| Chat App has files (picker) | 1: ChatAppsPicker `groupFilesOpenedBy` effect | 1: `chatAppHasFiles` replica (ChatAppsPicker.tsx) | `groupFileOpener` and useChatOpener's `groupFilesOpenedBy` are answers to a click, not read paths. |

## Totals

- Data kinds: 25
- Dev paths: 45
- Head paths: 25 (one per kind)

## Not read paths (commands and action answers)

- install / uninstall / setEnabled / setAutoUpdate / setDisclosure / setSettings / setOpenWithDefault / packInstalled / installAttachment / installFromMarket
- `marketRefresh` (desktop and phone `phoneApps.market.refresh()`): fetches the index; a changed index refreshes the replicas
- `variants` in app-detail-link.ts: a check when a link is opened
- `groupFileOpener`, `groupFilesOpenedBy` (useChatOpener), `appChatFile`
- Push reports to main (`*Changed`, `reportHostLayer`, `setAppState`, `bindSurface`, ...)
