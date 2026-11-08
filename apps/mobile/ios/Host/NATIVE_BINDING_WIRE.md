# Explicit iOS native host binding

Refs #1877. The three iOS wire entries accept exactly:

```text
hostState({ expectedBinding })
hostCall({ expectedBinding, id, channel, args })
stopHost({ expectedBinding })
expectedBinding = { ownerId, deviceId, installationId }
```

All three binding fields are required. Unknown fields, owner-only legacy calls
and incomplete bindings reject before backend work. Service constructs the typed
binding from those three fields, verifies it against native publication, and
passes that same value to Adapter. It does not select a binding from ownerId.
The Adapter's hostCall expectedBinding is mandatory. Its state/stop methods also
take the typed original binding. Native pre-seal retirement now takes
`prepareOwnerRetirement(expectedBinding:completion:)` for the same reason.

Adapter captures its retirement generation before enqueueing, checks it at queue
admission, and checks original binding/generation again before delivery. A known
mutating receipt is retained under its original binding before a late reply is
rejected. A stale stop cannot stop a replacement installation. An auth sign-out
delegation still uses the existing coordinator-owned native retirement path.

This binds account/device/installation and the native retirement generation that
the request entered. A new owner publication with the same owner and installation
has no separate JS publication ID in this contract; this slice does not claim to
bind such a publication. Caller publication guards remain required before/after
I/O. Host events are reread triggers, not an authoritative binding or preference.
