# iOS manual signing pipeline

Refs #2720. This pipeline consumes the Capacitor project and synchronized web assets. It never logs into Apple, creates signing assets, imports/exports private keys, changes the keychain search list, or changes global xcode-select. Run builds on an approved macOS build machine with an available build slot.

## Prepare the source

Use the repository Node and pnpm versions. In an isolated checkout, install the locked dependencies, select the intended database build target, then run `pnpm cap:sync:ios`. Review generated changes before distribution. This writes web assets and Capacitor configuration; the pipeline itself does not run sync or edit project files. Never substitute cached web assets from another commit.

Set `DEVELOPER_DIR` to the selected Xcode's `Contents/Developer`. Use a currently accepted release or explicitly accepted beta from [Apple's release notes](https://developer.apple.com/help/app-store-connect/release-notes/). A higher major number alone does not prove acceptance. [Upload requirements](https://developer.apple.com/help/app-store-connect/manage-builds/upload-builds/) distinguish build-tool minimums from uploader minimums.

## Simulator rehearsal (no Apple assets)

```sh
export DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer
export IOS_OUTPUT_DIR=/absolute/private/output/unique-run
export IOS_VERSION=0.3.2 IOS_BUILD=1.0.1
node scripts/build/ios-signing/pipeline.mjs dry-run
```

The output parent must exist; the run directory must not. Rehearsal uses **Release**, a generic iOS Simulator archive and local `-` signing, then verifies the signature. It stops before device signing/export. It cannot produce a TestFlight IPA or verify distribution profiles. A successful rehearsal is not proof that Apple's upload service accepts this Xcode.

## Checks before the first real signing run

Dedicated-keychain identity discovery is **unverified**. Release mode passes `OTHER_CODE_SIGN_FLAGS=--keychain ...` to codesign, but this does not establish that xcodebuild's own SHA-1 identity lookup or `xcodebuild -exportArchive` can discover that identity. An unlocked identity outside the user's keychain search list may still be reported as missing. Verify both archive and export with the actual Apple certificate, its matching intermediate chain and distribution profile before considering the release path validated.

If discovery requires a temporary user search-list entry, prepare an operator wrapper before the first attempt: reserve an exclusive signing window with no other signing jobs or search-list writers, snapshot the exact original user search list in a protected recovery receipt, and add only the dedicated keychain for the duration of archive/export. Install cleanup traps for normal exit, errors and catchable interruption signals; restore the exact original list and verify it by reading it back. Preserve recovery instructions for interruptions that traps cannot catch, and reconcile them before another signing attempt. Do not change the default keychain, system trust settings or global toolchain selection.

This wrapper is a proposed operational safeguard, not implemented by this script or proven by the simulator rehearsal. Wait for the separately supplied signing assets and the approved toolchain before changing the search list or running the first real archive/export. Record discovery, noninteractive signing, export and restoration results together.

## Device archive and manual export (requires separately authorized assets)

After the owner has installed and unlocked the matching identity in a dedicated keychain and installed the matching distribution profile, set:

- `IOS_TEAM_ID`: existing developer team ID.
- `IOS_BUNDLE_ID`: registered application identifier.
- `IOS_SIGN_IDENTITY`: installed Apple Distribution certificate SHA-1 fingerprint.
- `IOS_PROFILE`: installed App Store Connect distribution profile UUID or exact name.
- `IOS_KEYCHAIN`: absolute path of the unlocked signing keychain (avoid spaces in the path).
- `IOS_VERSION`, `IOS_BUILD`, `IOS_OUTPUT_DIR`, `DEVELOPER_DIR` as above.

Run `node scripts/build/ios-signing/pipeline.mjs release`. This uses generic iOS / Release / manual signing, writes an ExportOptions plist into the private output, and exports one IPA. No automatic provisioning is enabled. ExportOptions maps the bundle ID to the supplied profile, pins the certificate/team and disables automatic version management. Certificates and profiles must cover all final entitlements. Additional extensions need their own profile mapping before use.

Use a three-component marketing version approved by the release owner. Build numbers follow Apple's numeric limits: first component 1–9999, later components 0–99. Reserve the next monotonically increasing number for this app/version in the release ledger; never silently overwrite or retry a previously uploaded build number. Re-export of the same archive keeps its number. The script validates format; App Store Connect remains authoritative for previously used numbers.

Before upload, inspect the exported IPA's Info.plist, privacy manifests, embedded profile and codesign entitlements. Push-enabled TestFlight builds must contain `aps-environment=production`; simulator signing cannot establish this. Complete encryption declaration against the **final bundled dependencies**, not just the transport protocol. Do not upload until these checks are complete.

## Upload (separate authorization)

Set `IOS_IPA` to the exported IPA and a **fresh** `IOS_OUTPUT_DIR`. This implementation uses a **team API key** with Developer upload role: set `ASC_KEY_ID`, `ASC_ISSUER_ID`, and `API_PRIVATE_KEYS_DIR` to the protected directory containing `AuthKey_<keyID>.p8`. The script passes metadata to altool; it does not open the key. Do not pass private key contents or passwords in arguments, repository files, or chat. An individual key uses different issuer semantics and is not supported by this entry point. The owner may instead upload the IPA with Transporter interactively, avoiding a new API key.

Run `node scripts/build/ios-signing/pipeline.mjs upload`. It validates first, then uploads with altool. It records **uploaded-awaiting-processing**, never "TestFlight ready". An authorized publisher must inspect processing, export compliance and TestFlight availability in App Store Connect; attach the build ID and processing state to the release ledger. Developer upload permission does not grant certificate creation or export compliance administration.

## Failure receipt

Every started run writes private `receipt.json` with stage, status, timestamps and source HEAD; each tool has a separate mode-0600 log. Do not publish raw logs: tools may include local paths, profile metadata and service responses. A failed command sets exit 1 and the failed stage. Directory/preflight failures before the receipt exists print an error and exit 1. Never reuse the failed output directory. Keep receipts, toolchain output, synchronized-source provenance and SHA-256 of the final IPA together; retry upload only after examining the service response and confirming whether it already accepted the build.
