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

## Checks before a real signing run

Release mode passes `OTHER_CODE_SIGN_FLAGS=--keychain ...` to codesign. This does not make the dedicated keychain visible to every identity/chain lookup performed by the build tools. In the first authorized run, `find-identity` found zero valid identities outside the user search list and one after temporarily appending the dedicated keychain. Do not assume `--keychain` alone is sufficient.

If discovery requires a temporary user search-list entry, prepare an operator wrapper before the first attempt: reserve an exclusive signing window with no other signing jobs or search-list writers, snapshot the exact original user search list in a protected recovery receipt, and add only the dedicated keychain for the duration of archive/export. Install cleanup traps for normal exit, errors and catchable interruption signals; restore the exact original list and verify it by reading it back. Preserve recovery instructions for interruptions that traps cannot catch, and reconcile them before another signing attempt. Do not change the default keychain, system trust settings or global toolchain selection.

The operator wrapper is not implemented by this script. Exact ordered restoration was verified after ordinary signing failures and successful archive/export. Recovery after abrupt termination (SIGKILL or power loss) was not exercised. Wait for separately authorized assets and the approved toolchain before changing the search list, and record discovery, noninteractive signing, export and restoration together.

Prepare private-key access in the **same SSH/security session that starts the build**. With the password held only in memory and shell tracing disabled, unlock the dedicated keychain, disable its automatic locking for the window, and set the partition list after importing the certificate:

```sh
set +x
security unlock-keychain -p "$KEYCHAIN_PASSWORD" "$IOS_KEYCHAIN"
security set-keychain-settings "$IOS_KEYCHAIN"
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$KEYCHAIN_PASSWORD" "$IOS_KEYCHAIN"
```

Do not print the password, log expanded arguments, export the private key, or apply these commands to a default/login/System keychain. The CLI transiently places the password in process arguments, so use this sequence only in an approved environment. Before archive, sign and verify a private copy of a small executable, using the selected SHA-1 and `--keychain`; do not start archive while that probe fails.

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

## First-run observations

- **Verified:** on Xcode 26.6 / 17F113 with the iOS 26.5 SDK, device archive, manual App Store export, IPA verification, validation and upload succeeded. A separate read-only delivery lookup returned build/import/processing status `VALID`. A real-device installation and push delivery were not tested by this run.
- **Verified:** the generated `Signing.xcconfig` defines `GUGU_PROFILE_App` and expands `PROVISIONING_PROFILE_SPECIFIER = $(GUGU_PROFILE_$(TARGET_NAME))`, so only `App` receives a profile. Removing the command-line provisioning-profile setting resolved Swift package targets rejecting archive. Additional application/extension targets require their own explicit mapping.
- **Verified:** a dedicated keychain outside the user search list had one matching identity but zero valid identities; appending it after the exact original list changed the valid count to one. The original list order, default/system lists and global toolchain selection were restored and read back unchanged after both normal failures and successful runs. Abrupt-stop recovery remains untested.
- **Verified:** `security verify-cert` built the certificate chain with policy `codeSign`. Its policy name differs from `find-identity -p codesigning`; a policy-creation diagnostic must not be treated as a successful code-signing-policy check.
- **Verified:** an initial CodeSign reported `errSecInternalComponent`; system logs showed `SecKeyCreateSignature` error -25308 / `CSSMERR_CSP_NO_USER_INTERACTION`. Repeating unlock and setting `apple-tool:,apple:,codesign:` in the build's own session made a small signing/verification probe and then archive/export pass. See [Apple DTS's diagnostic guide](https://developer.apple.com/forums/thread/712005).
- **Inference:** the earlier session boundary contributed to private-key access failure. Same-session unlock and the added `codesign:` partition were changed together; the run did not isolate which was necessary on its own.
- **Verified:** Xcode recognized the profile in `~/Library/Developer/Xcode/UserData/Provisioning Profiles/<UUID>.mobileprovision`; the legacy directory was not needed for this toolchain.
- **Verified:** App Store validation rejected the 1024 icon's alpha channel with error 90717. Replacing that iOS icon with an approved RGB version and rebuilding changed the exported asset catalog's `Opaque` field from false to true; server validation then passed. An [App Store app icon](https://developer.apple.com/design/human-interface-guidelines/app-icons) must not contain an alpha channel.
