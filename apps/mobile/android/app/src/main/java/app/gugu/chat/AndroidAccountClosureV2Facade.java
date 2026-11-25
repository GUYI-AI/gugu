package app.gugu.chat;

import android.content.Context;
import android.system.Os;
import android.system.OsConstants;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import org.json.JSONObject;
import java.io.File;
import java.io.FileDescriptor;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.TimeUnit;

/** V2 only. All authority and request intents stay in native custody. */
final class AndroidAccountClosureV2Facade {
    static final class Handle {
        final String operation, generation;
        final long revision;
        Handle(String operation, String generation, long revision) throws Exception {
            if (operation == null || operation.isEmpty() || operation.length() > 256 || generation == null
                || !UUID.fromString(generation).toString().equals(generation) || revision < 1 || revision > 9007199254740991L)
                throw failure("invalid_scope");
            this.operation = operation; this.generation = generation; this.revision = revision;
        }
    }
    private final Context context;
    private final AndroidAccountClosureV2 nativeOperations;
    private final AccountClosureHttp transport;
    AndroidAccountClosureV2Facade(Context context) throws Exception {
        this.context = context.getApplicationContext();
        nativeOperations = new AndroidAccountClosureV2(context, true);
        transport = new AccountClosureHttp(AndroidAccountClosureBackend.load(context));
    }
    JSObject readPolicy() throws Exception {
        AndroidAccountClosureV2.StoredSession session = session();
        JSONObject policy = AccountClosureV2Wire.policy(transport.request("status", session.bearer, null));
        synchronized (GuguAuthStoragePlugin.STORAGE_LOCK) { sameSession(session); }
        return JSObject.fromJSONObject(policy);
    }
    JSObject discover() throws Exception {
        AccountClosureOperationV2.Metadata metadata = nativeOperations.discover();
        return metadata == null ? null : snapshot(metadata);
    }
    JSObject capture() throws Exception {
        AccountClosureOperationV2.Metadata existing = nativeOperations.discover();
        if (existing != null) return snapshot(existing);
        AndroidAccountClosureV2.StoredSession actor = session();
        JSONObject policy = AccountClosureV2Wire.policy(transport.request("status", actor.bearer, null));
        if (!policy.getBoolean("available")) throw failure("closure_v2_unavailable");
        AccountClosureOperationV2 store = nativeOperations.operation(actor.owner);
        AccountClosureReceiptStore.Scope scope = new AccountClosureReceiptStore.Scope(actor.owner, UUID.randomUUID().toString());
        AccountClosureOperationV2.Metadata metadata;
        synchronized (GuguAuthStoragePlugin.STORAGE_LOCK) {
            sameSession(actor);
            metadata = store.beginOrRestoreOperation(scope);
        }
        metadata = pending(store, scope, metadata, "register", state -> {});
        JSONObject body = binding(store, scope, metadata, false).put("consent_version", AccountClosureV2Wire.CONSENT);
        return snapshot(receive(store, scope, metadata, "register", body));
    }
    JSObject sendCode(Handle handle) throws Exception {
        AccountClosureOperationV2.Metadata metadata = resolve(handle);
        requireOpen(metadata);
        AccountClosureOperationV2 store = nativeOperations.operation(metadata.ownerId);
        AccountClosureReceiptStore.Scope scope = scope(metadata);
        metadata = pending(store, scope, metadata, "challenge", state -> {
            if (state.challengeGeneration == Integer.MAX_VALUE) throw failure("scope_conflict");
            state.attemptedChallengeGeneration = state.challengeGeneration + 1; state.codeSent = false; state.challengeExpiresAt = 0;
        });
        JSONObject body = binding(store, scope, metadata, false).put("consent_version", AccountClosureV2Wire.CONSENT)
            .put("generation", metadata.protocol.attemptedChallengeGeneration);
        return snapshot(receive(store, scope, metadata, "challenge", body));
    }
    JSObject prepare(Handle handle) throws Exception {
        AccountClosureOperationV2.Metadata metadata = resolve(handle);
        requireOpen(metadata);
        if (!metadata.protocol.codeSent || metadata.challengeGeneration < 1) throw failure("challenge_required");
        AccountClosureOperationV2 store = nativeOperations.operation(metadata.ownerId);
        AccountClosureReceiptStore.Scope scope = scope(metadata);
        metadata = store.prepare(scope).get(30, TimeUnit.SECONDS);
        if (metadata.serverGeneration != null) return snapshot(metadata);
        metadata = pending(store, scope, metadata, "prepare_device", state -> {});
        JSONObject body = binding(store, scope, metadata, false).put("device_id", metadata.canonicalDeviceId)
            .put("native_generation", metadata.nativeGeneration);
        return snapshot(receive(store, scope, metadata, "prepare_device", body));
    }
    JSObject confirm(Handle handle, String code, boolean acknowledgeForfeit) throws Exception {
        if (!acknowledgeForfeit || code == null || !code.matches("[0-9]{6,10}")) throw failure("invalid_request");
        AccountClosureOperationV2.Metadata metadata = resolve(handle);
        requireOpen(metadata);
        if (!AccountClosureOperationV2.LOCAL_PREPARED.equals(metadata.checkpoint) || metadata.serverGeneration == null
            || !metadata.protocol.codeSent) throw failure("closure_not_prepared");
        if (metadata.protocol.challengeExpiresAt > 0 && metadata.protocol.challengeExpiresAt <= System.currentTimeMillis())
            throw failure("verification_failed");
        AccountClosureOperationV2 store = nativeOperations.operation(metadata.ownerId);
        AccountClosureReceiptStore.Scope scope = scope(metadata);
        metadata = pending(store, scope, metadata, "confirm", state -> {
            state.confirmationId = UUID.randomUUID().toString(); state.confirmationRejected = false;
            state.cancelRequested = false; state.confirmCancellationBlocked = false;
        });
        JSONObject body = binding(store, scope, metadata, false).put("consent_version", AccountClosureV2Wire.CONSENT)
            .put("generation", metadata.challengeGeneration).put("confirmation_id", metadata.confirmationId)
            .put("native_generation", metadata.nativeGeneration).put("server_generation", metadata.serverGeneration)
            .put("code", code).put("acknowledge_forfeit", true);
        AccountClosureOperationV2.Metadata result = receive(store, scope, metadata, "confirm", body);
        return snapshot(cleanDeleted(result));
    }
    JSObject recover(Handle handle) throws Exception {
        AccountClosureOperationV2.Metadata metadata = resolve(handle);
        if (metadata.protocol.released()) return snapshot(metadata);
        AccountClosureOperationV2 store = nativeOperations.operation(metadata.ownerId, true);
        AccountClosureReceiptStore.Scope scope = scope(metadata);
        // This path can never register, send, prepare or confirm, including after Auth deletion.
        JSONObject body = binding(store, scope, metadata, true);
        return snapshot(cleanDeleted(receive(store, scope, metadata, "result", body)));
    }
    JSObject cancel(Handle handle) throws Exception {
        AccountClosureOperationV2.Metadata metadata = resolve(handle);
        if (metadata.protocol.cancelled) return snapshot(metadata);
        if (metadata.protocol.deleted()) throw failure("request_active");
        AccountClosureOperationV2 store = nativeOperations.operation(metadata.ownerId);
        AccountClosureReceiptStore.Scope scope = scope(metadata);
        // A missing preparation generation is never a local release. The server's
        // serialized cancel either closes that exact operation or demands recovery.
        metadata = store.updateProtocol(scope, metadata.localRevision, metadata.nativeGeneration, false,
            AccountClosureProtocolRecord::requestCancellation);
        JSONObject body = binding(store, scope, metadata, false).put("native_generation", metadata.nativeGeneration);
        if (metadata.serverGeneration != null) body.put("server_generation", metadata.serverGeneration);
        return snapshot(receive(store, scope, metadata, "cancel", body));
    }
    JSObject finalizeOperation(Handle handle) throws Exception {
        AccountClosureOperationV2.Metadata metadata = resolve(handle);
        return snapshot(nativeOperations.operation(metadata.ownerId, true).finalizeDeleted(scope(metadata), metadata));
    }
    AccountClosureOperationV2.Metadata cleanDeleted(AccountClosureOperationV2.Metadata metadata) throws Exception {
        if (!metadata.protocol.deleted() || metadata.protocol.finalized || metadata.protocol.cleanupStep == 4) return metadata;
        AccountClosureOperationV2 store = nativeOperations.operation(metadata.ownerId, true);
        AccountClosureReceiptStore.Scope scope = scope(metadata);
        metadata = store.prepareForDeletion(scope).get(30, TimeUnit.SECONDS);
        final AccountClosureAuthSlot auth = new AccountClosureAuthSlot(context);
        final AccountClosureLocalEraser files = new AccountClosureLocalEraser(context.getFilesDir(), context.getNoBackupFilesDir(), directory -> {
            FileDescriptor fd = Os.open(directory.getAbsolutePath(), OsConstants.O_RDONLY | OsConstants.O_NOFOLLOW, 0);
            try {
                if (!OsConstants.S_ISDIR(Os.fstat(fd).st_mode)) throw failure("closure_storage_unavailable");
                Os.fsync(fd);
            } finally { Os.close(fd); }
        });
        AccountClosureOperationV2.Metadata completed = store.cleanDeleted(scope, metadata, new AccountClosureOperationV2.Cleanup() {
            public void erase(int step, String owner) throws Exception {
                if (step == 0) auth.eraseIfOwned(owner); else files.erase(step - 1, owner);
            }
            public List<String> retained() throws Exception {
                List<String> names = new ArrayList<>(auth.unattributed());
                if (nonempty(context.getCacheDir())) names.add("shared-runtime-temp-cache");
                if (nonempty(new File(context.getCacheDir(), "share-in"))) names.add("shared-incoming-file-cache");
                if (nonempty(new File(context.getCacheDir(), "share-out"))) names.add("shared-outgoing-file-cache");
                return names;
            }
        });
        GuguAgentHostService.forgetClosedOwner(metadata.ownerId);
        GuguAgentService.forgetClosedOwner(metadata.ownerId);
        return completed;
    }
    private AccountClosureOperationV2.Metadata receive(AccountClosureOperationV2 store, AccountClosureReceiptStore.Scope scope,
                                                       AccountClosureOperationV2.Metadata metadata, String route, JSONObject body) throws Exception {
        String bearer = null;
        if (!"result".equals(route)) {
            synchronized (GuguAuthStoragePlugin.STORAGE_LOCK) {
                AndroidAccountClosureV2.StoredSession current = session();
                if (!current.owner.equals(metadata.ownerId) || !current.sid.equals(metadata.originalAuthSessionId)) throw failure("scope_conflict");
                // Revalidate local CAS immediately before dispatch, without retaining the Auth lock over HTTP.
                AccountClosureOperationV2.Metadata latest = store.readCapturedOperation(scope);
                if (latest.localRevision != metadata.localRevision || !latest.nativeGeneration.equals(metadata.nativeGeneration)) throw failure("scope_conflict");
                bearer = current.bearer;
            }
        }
        AccountClosureHttp.Reply response = transport.request(route, bearer, AccountClosureV2Wire.encode(body));
        if ("cancel".equals(route) && AccountClosureV2Wire.cancellationBlocked(response)) {
            store.updateProtocol(scope, metadata.localRevision, metadata.nativeGeneration, false,
                AccountClosureProtocolRecord::blockCancellation);
            throw failure("request_active");
        }
        AccountClosureV2Receiver.Reply reply = AccountClosureV2Wire.operation(response, route);
        AccountClosureOperationV2.Metadata accepted = AccountClosureV2Receiver.accept(store, scope, metadata, route, transport.backendIdentity(), reply);
        if (reply.rejectedConfirmation && "confirm".equals(metadata.protocol.pendingRoute)) throw failure("verification_failed");
        return accepted;
    }
    private JSONObject binding(AccountClosureOperationV2 store, AccountClosureReceiptStore.Scope scope,
                                AccountClosureOperationV2.Metadata metadata, boolean recovering) throws Exception {
        return AccountClosureV2Wire.binding(metadata, store.nativeReceipt(scope, metadata.localRevision, metadata.nativeGeneration, recovering));
    }
    private AccountClosureOperationV2.Metadata pending(AccountClosureOperationV2 store, AccountClosureReceiptStore.Scope scope,
                                                       AccountClosureOperationV2.Metadata metadata, String route,
                                                       AccountClosureOperationV2.ProtocolMutation mutation) throws Exception {
        return store.updateProtocol(scope, metadata.localRevision, metadata.nativeGeneration, false, state -> {
            if (state.released() || state.deleted() || state.pendingRoute != null) throw failure("recovery_required");
            mutation.apply(state); state.pendingRoute = route;
        });
    }
    private AccountClosureOperationV2.Metadata resolve(Handle handle) throws Exception {
        return nativeOperations.resolve(handle.operation, handle.generation, handle.revision);
    }
    private AndroidAccountClosureV2.StoredSession session() throws Exception {
        synchronized (GuguAuthStoragePlugin.STORAGE_LOCK) {
            AndroidAccountClosureV2.StoredSession value = AndroidAccountClosureV2.storedSession(context);
            if (value == null) throw failure("unauthorized"); return value;
        }
    }
    private void sameSession(AndroidAccountClosureV2.StoredSession expected) throws Exception {
        AndroidAccountClosureV2.StoredSession current = session();
        if (!current.owner.equals(expected.owner) || !current.sid.equals(expected.sid)) throw failure("scope_conflict");
    }
    private static void requireOpen(AccountClosureOperationV2.Metadata metadata) throws Exception {
        if (metadata.protocol.pendingRoute != null) throw failure("recovery_required");
        if (!"open".equals(metadata.protocol.serverState) || metadata.protocol.released()) throw failure("request_active");
    }
    private static AccountClosureReceiptStore.Scope scope(AccountClosureOperationV2.Metadata metadata) throws Exception {
        return new AccountClosureReceiptStore.Scope(metadata.ownerId, metadata.localOperationId);
    }
    private static boolean nonempty(File path) throws Exception {
        if (!path.exists()) return false;
        File[] files = path.listFiles(); if (files == null) throw failure("closure_storage_unavailable"); return files.length > 0;
    }
    static JSObject snapshot(AccountClosureOperationV2.Metadata metadata) throws Exception {
        AccountClosureProtocolRecord state = metadata.protocol;
        String phase = state.finalized ? "finalized" : state.cancelled ? "cancelled" : state.cleanupStep == 4 ? "local-complete"
            : state.deleted() ? "deleted" : "cancel".equals(state.pendingRoute) ? "cancel-pending"
            : "processing".equals(state.serverState) ? "processing" : "confirming".equals(state.serverState) || "confirm".equals(state.pendingRoute) ? "confirming"
            : state.serverGeneration != null ? "prepared" : AccountClosureOperationV2.LOCAL_PREPARED.equals(metadata.checkpoint) ? "local-prepared"
            : state.codeSent ? "challenge" : state.serverOperationId != null ? "registered" : "captured";
        JSObject handle = new JSObject().put("localOperationId", metadata.localOperationId).put("nativeGeneration", metadata.nativeGeneration)
            .put("localRevision", metadata.localRevision);
        JSObject server = state.serverOperationId == null ? null : new JSObject().put("operationId", state.serverOperationId)
            .put("state", state.serverState).put("operationRevision", state.serverRevision).put("challengeGeneration", state.challengeGeneration);
        if (server != null && state.challengeExpiresAt > 0) {
            java.text.SimpleDateFormat iso = new java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", java.util.Locale.ROOT);
            iso.setTimeZone(java.util.TimeZone.getTimeZone("UTC"));
            server.put("challengeExpiresAt", iso.format(new java.util.Date(state.challengeExpiresAt)));
        }
        String pending = state.pendingRoute;
        JSArray retained = new JSArray(); for (String name : state.retained) retained.put(name);
        return new JSObject().put("handle", handle).put("ownerId", metadata.ownerId).put("phase", phase)
            .put("serverOperation", server == null ? JSONObject.NULL : server)
            .put("serverPreparationGeneration", state.serverGeneration == null ? JSONObject.NULL : state.serverGeneration)
            .put("recoveryOnly", state.pendingRoute != null || "confirming".equals(state.serverState) || "processing".equals(state.serverState)
                || AccountClosureOperationV2.PREPARING.equals(metadata.checkpoint))
            .put("pendingEffect", pending == null ? JSONObject.NULL : pending)
            .put("confirmCancellationBlocked", state.confirmCancellationBlocked)
            .put("agentsPaused", AccountClosureOperationV2.LOCAL_PREPARED.equals(metadata.checkpoint)
                && (!state.cancelled || state.resumeRequired)).put("retainedUnattributed", retained);
    }
    private static AccountClosureReceiptStore.Failure failure(String code) { return new AccountClosureReceiptStore.Failure(code); }
}
