# iOS host projection

This entry projects the existing `OwnerPublication` into the native `GuguAgent`
plugin. It does not publish an auth session, refresh credentials, register a
plugin, install the shared host bridge, or enable a platform capability.

## Integration

The integrator mounts `IOSHostRoot` once alongside the existing owner
publication root, independently of Android's `PhoneDeviceRoot`. The singleton
`iosHostRuntime` owns the projection; `useIOSHostRuntimeSnapshot()` subscribes
to it. No existing App root, routing, platform selection, or capability flag is
changed by this directory.

Only a ready owner publication with a complete native binding can configure
the host. Pending, stopped, failed, and changed publications immediately
withdraw the old projection and its settings. Each asynchronous operation
checks the current publication and local subscription generation before
publishing a result. Native events wake a scoped `hostState` reread; event
payloads never directly update the store.

Same-binding refresh and subscription detach/remount do not stop a live native
host. The store probes an existing configuration first. Only native
`host_not_ready` permits a new configure for that binding. Native retirement
before credential replacement, including `prepareOwnerRetirement`, remains an
integrator responsibility; this root does not substitute a JS stop for it.

## Native wire

The original source baseline is `df429e78a835b7b624a6b583d0ee1ba63fcdfb4f`.
The scoped three-entry wire below follows native patch
`7e2c9772b22cbf118c9a37b1cd7c2074fa2d9abe`. It requires that patch; the
baseline's owner-only wire is not supported as a fallback. The source of
`GuguIOSHostService` and `GuguIOSHostAdapter` at that head has been read against
the request projection here; this is source alignment, not an iOS execution
result.

| Method | Exact request fields |
| --- | --- |
| `configure` | `expectedBinding`, optional `device: { label }` |
| `hostState` | `expectedBinding` |
| `hostCall` | `expectedBinding`, `id`, `channel`, `args` |
| `stopHost` | `expectedBinding` |

Every `expectedBinding` is freshly projected to exactly `ownerId`, `deviceId`,
and `installationId`. Device IDs retain the existing
`phone-${installationId}-${ownerId}` format. Tokens, grants, and caller-supplied
generation fields are not forwarded. The client has no `authSession` method.

`hostCall` retains the original request UUID and the exclusive `{ result }` or
`{ error: { code, message, admission } }` envelope. An uncertain result is not
automatically retried. A valid host state can contain a string `error` and
`ready: false`; this is distinct from a rejected Capacitor promise. In
particular, configured `delivery_not_connected` remains unavailable for task
execution while local settings can still be queried.

Native `stopHost` succeeds with an empty object. A rejected or malformed stop
is propagated and retained as failure; it does not become a successful stop.
`retry()` retries a failed same-binding stop before attempting configuration.
Removing the root only removes subscriptions and withdraws the projection.

Complete binding checks cover the caller's owner and installation. The native
patch also guards admitted calls with its captured generation. Neither this
wire nor events carry a JS publication identifier, so this change does not
claim native binding to a new publication of the same owner and installation.

## Local notification settings

`IOSNotificationsSettings` exposes only the current iPhone's named
`notifications` preference through `appSettings.get`, `getWithMeta`, and
`update`. `iosHostRuntime.updateNotifications(value, originalRequestUUID)`
performs the update and then reads back the persisted value before publishing
it. Reads use fresh UUIDs; writes retain the caller's original UUID.

Both `enabled` and `sound` must be actual booleans. The store exposes
`settings.status: 'unknown'` with no value when nothing has been persisted or a
read fails. UI defaults, another machine's settings, and remote settings are
never used as evidence. This module does not mirror chat notification settings
or register APNs.

## Verification scope

Focused Vitest tests exercise the typed wire, reply validation, owner and
installation changes, late replies, same-binding reuse, stop failure, listener
cleanup, persisted settings readback, and the new root/store entry. Their
native and owner-publication boundaries are injected. They do not exercise the
installed iOS App, Keychain, HTTP, EventKit, APNs, or a real model loop.

Directed ESLint and TypeScript checks cover the new files. The standalone
TypeScript check uses the existing owner-publication public state declaration
as its boundary; it is not a whole-repository typecheck. The integrator still
needs full App compilation and independent execution against the same native
head before enabling any capability.
