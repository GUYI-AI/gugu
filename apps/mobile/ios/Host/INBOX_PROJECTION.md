# Shared native inbox envelope projection

Refs #1877. The native runtime exposes `readDelivery` only to native code. Its
input is a picked authoritative `pull_agent_inbox_v2` row, native owner/Agent
identity, a native rules-delivery decision, and optional Agent-visible thread
history. Credential-shaped fields are rejected before entering JSC.

`runtime/ios/delivery.mjs` invokes the existing core delivery-envelope producer,
mention/identity helpers, thread bootstrap and listen-mode defaults. It does not
implement another delivery XML format. The projected route retains the original
message/chat/thread IDs, privacy and sender. An owner DM keeps the existing direct
answer semantics. No replacement source UUID is generated.

Missing authoritative rules, identity or private-file reference columns reject
an incompatible row. Invalid machine IDs/versions, changed rule text and a
whisper with no exact recipient fail closed. Private attachments remain
unsupported until the native reader can verify their identity and bytes.

Projection alone does not establish permission or durable admission and does not
advance a read cursor. The future native inbox pump must recheck the original
source context, persist the exact input/route/rules receipt, then acknowledge
delivery using the existing cloud cursor/fence protocol. Reopening a projection
or journal never executes an input or retries an uncertain write. Inbox pumping,
Pi communication tools and private attachments still block public readiness.

This slice changes the runtime resource. A must rebuild it from the same frozen
source, keep its exact manifest/hash and license bodies, and run the actual JSC
driver. Source and syntax checks alone do not prove the resource or an iOS App.
