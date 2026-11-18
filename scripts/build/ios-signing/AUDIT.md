# Signing readiness audit

Baseline: #1898 head fa54e293fcb4c3d2ecf185b273879e81546b8bec. This audit does not certify the later native-host integration. Re-run against the final archive. No existing iOS files are changed by this PR.

| Item | Baseline finding | Required before distribution |
| --- | --- | --- |
| Camera/microphone | Info.plist contains Chinese camera and microphone purposes for chat attachments | Confirm shipped capture paths match the descriptions; do not add permissions for deferred recording features |
| Calendar | No calendar plugin or usage description in this foreground baseline | Calendar integration needs NSCalendarsFullAccessUsageDescription for iOS 17+ read/write; NSCalendarsUsageDescription if supporting earlier authorization. Suggested purpose: Allow the local assistant to read and manage calendar events you request. Do not substitute a write-only key for read/write access |
| Notifications | No push plugin or entitlement in this foreground baseline | UserNotifications authorization is requested at runtime; there is no generic NSNotificationsUsageDescription requirement. Push integration needs registered App ID capability, matching profile and a final signed aps-environment of production for TestFlight |
| Privacy manifest | No app-level PrivacyInfo.xcprivacy in tracked baseline | Capacitor 8.3.3 packages include Capacitor and CapacitorCordova manifests. Check they survive archive packaging and generate Xcode's privacy report. Add an app manifest for any required-reason API called by app/native-host code; never copy an unrelated reason code or claim no collected data merely because the manifest is missing |
| Encryption | ITSAppUsesNonExemptEncryption absent | Do not automatically set NO. See dependency findings below; publisher must complete the real encryption questionnaire |

The tracked native shell uses Security/Keychain for auth storage. The dependency graph also includes libsodium 0.8.4 / libsodium-wrappers 0.8.4. `packages/core/src/shared/fileCipher.ts` dynamically imports libsodium for secretstream authenticated file encryption (XChaCha20-Poly1305), and mobile renderer paths import file hashing from that module (`attachmentBytes.ts`, `capacitorShare.ts`). This is an implementation of cryptography outside Apple's OS, even if a particular execution uses only hashing. Inspect the actual generated web chunks and final IPA before answering encryption questions; dependency presence alone does not prove a chunk was bundled.

Prepared answers: encryption is used (HTTPS/Keychain plus potentially bundled libsodium); no proprietary cipher is implemented by this code; the standard/non-OS encryption branch must be evaluated if libsodium is bundled. Apple's [export documentation matrix](https://developer.apple.com/help/app-store-connect/reference/app-information/export-compliance-documentation-for-encryption) distinguishes OS-only encryption from external standard algorithms and notes the France distribution condition. Leave the plist declaration unset pending that review instead of incorrectly suppressing the questionnaire. Set ITSAppUsesNonExemptEncryption=NO only after the publisher establishes the shipped app qualifies for the exemption; otherwise set YES and supply the requested documentation/compliance code. Internal TestFlight does not justify a guessed declaration.

Final archive inspection (private output only):

```sh
plutil -p App.xcarchive/Products/Applications/App.app/Info.plist
find App.xcarchive/Products/Applications/App.app -name '*.xcprivacy'
codesign --verify --deep --strict App.xcarchive/Products/Applications/App.app
codesign -d --entitlements :- App.xcarchive/Products/Applications/App.app
```

Repeat signature/entitlement inspection on the **exported IPA** after extraction, since export can re-sign it. Inspect the embedded mobileprovision with `security cms -D -i` (public profile data only); compare team, application-identifier, expiration and aps-environment with the signed app. No private key inspection is needed. App Store Connect validation/processing remains required.

Official references: [calendar access](https://developer.apple.com/documentation/eventkit/accessing-calendar-using-eventkit-and-eventkitui), [APS entitlement](https://developer.apple.com/documentation/bundleresources/entitlements/aps-environment), [required-reason API declarations](https://developer.apple.com/documentation/bundleresources/describing-use-of-required-reason-api), [encryption questionnaire](https://developer.apple.com/help/app-store-connect/manage-app-information/determine-and-upload-app-encryption-documentation/).
