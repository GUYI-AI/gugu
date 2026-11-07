# iOS owner session publication

The renderer's existing `sessionCoordinator` is the only refresh authority. The native owner bridge accepts only the owner and access token already committed in `GuguAuthStorage`'s main `SESSION` envelope, verifies the owner using the packaged backend's `auth.getUser`, and compares the committed record again after the asynchronous response. It never receives a refresh token from a bridge call, refreshes a token, or stores a credential in the host journal or JavaScript runtime.

The bridge protocol is `GuguIOSOwner`:

- `publishSession({ownerId, accessToken})` resolves `{available: true, binding}` after verification.
- `getBinding({ownerId})` resolves `{available: boolean, binding: object | null}`. A different current stored owner rejects with `stale_context`.
- `retireSession({ownerId})` resolves `{retired: true}` only after the native host has stopped. Retirement invalidates publication generations and ephemeral credentials first. A failed stop rejects, remains closed to publication, and requires another successful retirement attempt.

`binding` contains `ownerId`, `deviceId`, and `installationId`. The device ID is exactly `phone-${installationId}-${ownerId}`. Installation identity is stored in the private, backup-excluded application container rather than Keychain. It must be reused across renderer origin changes, and malformed identity storage fails closed.

`GuguIOSOwnerSession.credentials(expectedBinding:)` is the native-only access supplier for the concrete host backend. Both owner binding reads and credential reads recheck the current stored owner/token, expiry and native installation. A token rotation does not change the owner's device identity, but its new access token needs verification before the binding or credentials are available. No generic cloud RPC or model endpoint is exposed to JavaScript by this bridge.

The AuthStorage writer serializes queued writes across `prepareMainWrite`. Native retirement remains closed after stop succeeds, until `commitMainWrite` performs the actual Keychain write and reads back the prepared owner. A failed storage commit cannot reopen a degraded renderer's old session. Each successful commit consumes its generation-bound permit.

`GuguIOSAppRuntime` assembles one App-lifetime owner session, shared host lifecycle and calendar service. The bridge registers AuthStorage, GuguIOSOwner and CalendarPermissions from that instance. Its foreground owner guard and committed identity must succeed before calendar connection. A missing or invalid packaged configuration leaves only the foreground login shell registered. The GuguAgent task facade remains unavailable until its concrete backend is connected.

`cap:sync:ios` prepares `HostRuntime/GuguBackend.json` using the existing renderer environment resolver, bundles the static runtime and synchronizes the WebView. Only the public URL and anon/publishable key ship; a privileged or human token is rejected. Invalid preparation removes the previous generated configuration. The renderer mounts a publication subscriber without creating another auth coordinator or refresher.

The real App/SDK/Keychain/HTTP paths remain unverified. Native policy and injected transport tests do not establish an iOS local host or end-to-end calendar result.
