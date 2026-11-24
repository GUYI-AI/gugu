package app.gugu.chat;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Arrays;
import java.util.IdentityHashMap;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;

/** Private V2 custody and native CAS. HTTP facts enter through the native receiver. */
final class AccountClosureOperationV2 {
    private static final int MAGIC = 0x47554332, STORAGE_VERSION = 5;
    static final int PROTOCOL_VERSION = 2;
    static final String CAPTURED = "captured", PREPARING = "preparing", LOCAL_PREPARED = "local_prepared";
    interface NativeIdentity { Identity read() throws Exception; }
    interface Runtime {
        CompletableFuture<Void> stopAndDrain(SideEffects admission) throws Exception;
        boolean busy(String owner) throws Exception;
    }
    interface LocalEffect { void run() throws Exception; }
    private static final Map<Object, SideEffects> ADMISSIONS = new IdentityHashMap<>();
    /** Native-only proof, minted from the protected record; never constructed by a caller. */
    final class SideEffects {
        final String ownerId;
        private final AccountClosureReceiptStore.Scope scope;
        private final Metadata captured;
        private final boolean recovering;
        private SideEffects(AccountClosureReceiptStore.Scope scope, Metadata captured, boolean recovering) {
            this.scope = scope; this.captured = captured; this.recovering = recovering; ownerId = captured.ownerId;
        }
        void check() throws Exception {
            synchronized (authLock) { requireActive(); }
        }
        void runLocal(LocalEffect effect) throws Exception {
            synchronized (authLock) { requireActive(); effect.run(); }
        }
        private void requireActive() throws Exception {
            synchronized (ADMISSIONS) {
                if (ADMISSIONS.get(authLock) != this) throw failure("scope_conflict");
            }
            requireEnabled(); Record record = require(scope, recovering);
            if (recovering && (record.protocol == null || !record.protocol.deleted())) throw failure("trusted_result_unavailable");
            if (!record.sid.equals(captured.originalAuthSessionId) || !record.installation.equals(captured.installationId)
                || !record.device.equals(captured.canonicalDeviceId) || !record.generation.equals(captured.nativeGeneration) || record.revision != captured.localRevision
                || !PREPARING.equals(record.checkpoint)) throw failure("scope_conflict");
        }
    }
    /** Called under the same native Auth lock by its replacement writer. Same-SID
     * refreshes remain legal; a different owner/SID cannot cross stop dispatch. */
    static void requireAuthMutation(Object authLock, String owner, String sid) throws Exception {
        if (!Thread.holdsLock(authLock)) throw failure("scope_conflict");
        synchronized (ADMISSIONS) {
            SideEffects active = ADMISSIONS.get(authLock);
            if (active != null && (!active.captured.ownerId.equals(owner) || !active.captured.originalAuthSessionId.equals(sid)))
                throw failure("scope_conflict");
        }
    }
    static boolean hasSideEffectAdmission(Object authLock) {
        synchronized (ADMISSIONS) { return ADMISSIONS.containsKey(authLock); }
    }
    interface Entropy { void fill(byte[] bytes); }
    static final class Identity {
        final String ownerId, sessionId, installationId, deviceId, backendIdentity;
        final boolean authenticated;
        Identity(String owner, String session, String installation, String device, String backend) throws Exception {
            this(owner, session, installation, device, backend, true);
        }
        Identity(String owner, String session, String installation, String device, String backend, boolean authenticated) throws Exception {
            uuid(owner); uuid(session);
            if (installation == null || installation.isEmpty() || installation.length() > 256
                || device == null || device.isEmpty() || device.length() > 256
                || backend == null || backend.isEmpty() || backend.length() > 2048) throw failure("invalid_scope");
            ownerId = owner; sessionId = session; installationId = installation; deviceId = device;
            backendIdentity = backend; this.authenticated = authenticated;
        }
    }
    /** Deliberately contains neither the receipt nor any credentials. */
    static final class Metadata {
        final int protocolVersion = PROTOCOL_VERSION, challengeGeneration;
        final String ownerId, localOperationId, originalAuthSessionId, installationId, canonicalDeviceId, backendIdentity;
        final String nativeGeneration, checkpoint;
        final String serverGeneration, serverOperationId, requestId, confirmationId;
        final Long operationRevision;
        final AccountClosureProtocolRecord protocol;
        final long localRevision;
        Metadata(Record record) {
            ownerId = record.owner; localOperationId = record.operation; originalAuthSessionId = record.sid;
            installationId = record.installation; canonicalDeviceId = record.device;
            backendIdentity = record.backend;
            nativeGeneration = record.generation; checkpoint = record.checkpoint; localRevision = record.revision;
            protocol = record.protocol == null ? new AccountClosureProtocolRecord() : record.protocol.copy();
            serverGeneration = protocol.serverGeneration; serverOperationId = protocol.serverOperationId;
            requestId = protocol.requestId; confirmationId = protocol.confirmationId;
            challengeGeneration = protocol.challengeGeneration;
            operationRevision = serverOperationId == null ? null : protocol.serverRevision;
        }
    }
    private static final class Record {
        String owner, operation, sid, installation, device, backend, generation, checkpoint;
        AccountClosureProtocolRecord protocol;
        byte[] receipt;
        long revision;
    }
    private final Object authLock;
    private final AccountClosureReceiptStore.Secrets secrets;
    private final NativeIdentity identity;
    private final Runtime runtime;
    private final Entropy entropy;
    private final boolean enabled;

    AccountClosureOperationV2(Object authLock, AccountClosureReceiptStore.Secrets secrets,
                             NativeIdentity identity, Runtime runtime, boolean enabled) {
        this(authLock, secrets, identity, runtime, enabled, new SecureRandom()::nextBytes);
    }
    AccountClosureOperationV2(Object authLock, AccountClosureReceiptStore.Secrets secrets,
                             NativeIdentity identity, Runtime runtime, boolean enabled, Entropy entropy) {
        this.authLock = authLock; this.secrets = secrets; this.identity = identity;
        this.runtime = runtime; this.enabled = enabled; this.entropy = entropy;
    }
    Metadata beginOrRestoreOperation(AccountClosureReceiptStore.Scope scope) throws Exception {
        synchronized (authLock) {
            requireEnabled();
            Identity current = current(scope);
            Record record = read(secrets, current.installationId, current.ownerId);
            if (record != null && (record.protocol == null || !record.protocol.cancelled
                || record.operation.equals(scope.localOperationId))) { requireBinding(scope, current, record); return new Metadata(record); }
            boolean keepPause = record != null && record.protocol != null && record.protocol.resumeRequired;
            record = new Record(); record.owner = current.ownerId; record.operation = scope.localOperationId;
            record.sid = current.sessionId; record.installation = current.installationId; record.device = current.deviceId;
            record.backend = current.backendIdentity;
            record.generation = UUID.randomUUID().toString(); record.checkpoint = CAPTURED; record.revision = 1;
            record.receipt = new byte[32]; entropy.fill(record.receipt);
            if (keepPause) { record.protocol = new AccountClosureProtocolRecord(); record.protocol.resumeRequired = true; }
            save(record); // The discoverable owner index and secret are the SAME atomic protected record.
            return new Metadata(record);
        }
    }
    Metadata readCapturedOperation(AccountClosureReceiptStore.Scope scope) throws Exception {
        synchronized (authLock) { requireEnabled(); return new Metadata(require(scope)); }
    }
    Metadata readForRecovery(AccountClosureReceiptStore.Scope scope) throws Exception {
        synchronized (authLock) { requireEnabled(); return new Metadata(require(scope, true)); }
    }
    static Metadata protectedMetadata(AccountClosureReceiptStore.Secrets secrets, String installation, String owner) throws Exception {
        Record record = read(secrets, installation, owner); return record == null ? null : new Metadata(record);
    }
    interface ProtocolMutation { void apply(AccountClosureProtocolRecord record) throws Exception; }
    /** Package-private native receiver only; no bridge accepts this mutation or server terminal strings. */
    Metadata updateProtocol(AccountClosureReceiptStore.Scope scope, long revision, String generation,
                            boolean recovering, ProtocolMutation mutation) throws Exception {
        synchronized (authLock) {
            requireEnabled(); Record record = require(scope, recovering);
            if (record.revision != revision || !record.generation.equals(generation)) throw failure("scope_conflict");
            AccountClosureProtocolRecord next = record.protocol == null ? new AccountClosureProtocolRecord() : record.protocol.copy();
            mutation.apply(next); next.validate(); record.protocol = next; advance(record); return new Metadata(record);
        }
    }
    /** Never exposed by a Capacitor method or ordinary snapshot. */
    String nativeReceipt(AccountClosureReceiptStore.Scope scope, long revision, String generation, boolean recovering) throws Exception {
        synchronized (authLock) {
            requireEnabled(); Record record = require(scope, recovering);
            if (record.revision != revision || !record.generation.equals(generation)
                || (record.protocol != null && record.protocol.released())) throw failure("scope_conflict");
            StringBuilder hex = new StringBuilder();
            for (byte value : record.receipt) hex.append(String.format(java.util.Locale.ROOT, "%02x", value & 255));
            return hex.toString();
        }
    }
    Metadata readCapturedOperationForCurrentOwner() throws Exception {
        synchronized (authLock) {
            requireEnabled(); Identity current = identity.read();
            if (current == null) throw failure("wrong_local_owner");
            Record record = read(secrets, current.installationId, current.ownerId);
            if (record == null) throw failure("closure_context_missing");
            requireBinding(new AccountClosureReceiptStore.Scope(record.owner, record.operation), current, record);
            return new Metadata(record);
        }
    }
    Metadata checkpointOperation(AccountClosureReceiptStore.Scope scope, long expectedLocalRevision,
                                 String nativeGeneration, String localEvent) throws Exception {
        synchronized (authLock) {
            requireEnabled(); Record record = require(scope);
            if (record.revision != expectedLocalRevision || !record.generation.equals(nativeGeneration)) throw failure("scope_conflict");
            // No arbitrary target state, cloud boolean, OTP intent or terminal event is accepted.
            if (!"request_local_preparation".equals(localEvent)) throw failure("untrusted_checkpoint");
            if (CAPTURED.equals(record.checkpoint)) { markPreparing(record); advance(record); }
            return new Metadata(record);
        }
    }
    CompletableFuture<Metadata> prepare(AccountClosureReceiptStore.Scope scope) throws Exception {
        return prepare(scope, false);
    }
    /** Deleted-account recovery can drain only its original protected owner after Auth retirement. */
    CompletableFuture<Metadata> prepareForDeletion(AccountClosureReceiptStore.Scope scope) throws Exception {
        return prepare(scope, true);
    }
    private CompletableFuture<Metadata> prepare(AccountClosureReceiptStore.Scope scope, boolean recovering) throws Exception {
        final Metadata captured = recovering ? readForRecovery(scope) : beginOrRestoreOperation(scope);
        if (recovering && !captured.protocol.deleted()) throw failure("trusted_result_unavailable");
        if (captured.protocol.released()) throw failure("scope_conflict");
        if (LOCAL_PREPARED.equals(captured.checkpoint)) {
            // A persisted local completion is read-only on reentry. Never mint a
            // new side-effect admission or rewrite its receipt/generation/revision.
            if (runtime.busy(scope.ownerId)) throw failure("closure_not_prepared");
            synchronized (authLock) {
                requireEnabled(); Record record = require(scope, recovering);
                if (!LOCAL_PREPARED.equals(record.checkpoint) || !record.generation.equals(captured.nativeGeneration)
                    || record.revision != captured.localRevision) throw failure("scope_conflict");
                return CompletableFuture.completedFuture(new Metadata(record));
            }
        }
        final Metadata preparing;
        synchronized (authLock) {
            Record record = require(scope, recovering);
            if (record.revision != captured.localRevision || !record.generation.equals(captured.nativeGeneration)) throw failure("scope_conflict");
            if (CAPTURED.equals(record.checkpoint)) { markPreparing(record); advance(record); }
            preparing = new Metadata(record);
        }
        final SideEffects admission;
        synchronized (authLock) {
            admission = new SideEffects(scope, preparing, recovering);
            synchronized (ADMISSIONS) {
                if (ADMISSIONS.containsKey(authLock)) throw failure("scope_conflict");
                ADMISSIONS.put(authLock, admission);
            }
            try { admission.requireActive(); }
            catch (Exception refused) { synchronized (ADMISSIONS) { ADMISSIONS.remove(authLock); } throw refused; }
        }
        final CompletableFuture<Void> drain;
        // Dispatch with a native owner/SID mutation fence, not with the Auth monitor
        // held across service locks. Release the fence BEFORE awaiting exit proofs.
        try { drain = runtime.stopAndDrain(admission); }
        finally { synchronized (authLock) { synchronized (ADMISSIONS) { ADMISSIONS.remove(authLock); } } }
        return drain.thenApply(unused -> {
            try {
                if (runtime.busy(scope.ownerId)) throw failure("closure_not_prepared");
                synchronized (authLock) {
                    requireEnabled(); Record record = require(scope, recovering);
                    if (!record.generation.equals(preparing.nativeGeneration) || record.revision != preparing.localRevision)
                        throw failure("scope_conflict");
                    if (PREPARING.equals(record.checkpoint)) { record.checkpoint = LOCAL_PREPARED; advance(record); }
                    return new Metadata(record);
                }
            } catch (Exception error) { throw new CompletionException(error); }
        });
    }
    interface Cleanup {
        void erase(int step, String owner) throws Exception;
        java.util.List<String> retained() throws Exception;
    }
    Metadata cleanDeleted(AccountClosureReceiptStore.Scope scope, Metadata expected, Cleanup cleanup) throws Exception {
        // Runtime monitors are never acquired while holding the native Auth monitor.
        if (runtime.busy(scope.ownerId)) throw failure("closure_not_prepared");
        synchronized (authLock) {
            Record record = require(scope, true);
            if (record.revision != expected.localRevision || !record.generation.equals(expected.nativeGeneration)
                || record.protocol == null || !record.protocol.deleted() || !LOCAL_PREPARED.equals(record.checkpoint))
                throw failure("trusted_result_unavailable");
            while (record.protocol.cleanupStep < 4) {
                cleanup.erase(record.protocol.cleanupStep, record.owner);
                record.protocol.cleanupStep++; advance(record);
            }
            record.protocol.retained = new java.util.ArrayList<>(cleanup.retained());
            record.protocol.validate(); advance(record);
            return new Metadata(record);
        }
    }
    Metadata finalizeDeleted(AccountClosureReceiptStore.Scope scope, Metadata expected) throws Exception {
        synchronized (authLock) {
            Record record = require(scope, true);
            if (record.revision != expected.localRevision || !record.generation.equals(expected.nativeGeneration)
                || record.protocol == null || !record.protocol.deleted() || record.protocol.cleanupStep != 4
                || current(scope, true).authenticated) throw failure("scope_conflict");
            if (!record.protocol.finalized) {
                record.protocol.finalized = true;
                Arrays.fill(record.receipt, (byte)0); advance(record);
            }
            return new Metadata(record);
        }
    }
    /** Only an existing explicit user enable action calls this; no reconcile or new session admission. */
    void resumeCurrentOwnerAfterCancellation() throws Exception {
        final Identity admitted;
        final Metadata expected;
        synchronized (authLock) {
            requireEnabled(); admitted = identity.read();
            if (admitted == null || !admitted.authenticated) throw failure("unauthorized");
            Record record = read(secrets, admitted.installationId, admitted.ownerId);
            if (record == null) return;
            if (record.protocol == null || !record.protocol.cancelled) throw failure("closure_v2_pending");
            if (!record.protocol.resumeRequired) return;
            expected = new Metadata(record);
        }
        if (runtime.busy(admitted.ownerId)) throw failure("closure_not_prepared");
        synchronized (authLock) {
            Identity current = identity.read();
            if (current == null || !current.authenticated || !admitted.ownerId.equals(current.ownerId)) throw failure("wrong_local_owner");
            if (!admitted.sessionId.equals(current.sessionId)) throw failure("scope_conflict");
            Record record = read(secrets, current.installationId, current.ownerId);
            // A cancelled operation is terminal; an explicit new login of A may
            // resume A, while its old operation/SID/receipt remain unchanged.
            if (record == null || record.revision != expected.localRevision || !record.generation.equals(expected.nativeGeneration)
                || !record.owner.equals(current.ownerId) || !record.installation.equals(current.installationId)
                || !record.device.equals(current.deviceId) || !record.backend.equals(current.backendIdentity)
                || record.protocol == null || !record.protocol.cancelled) throw failure("scope_conflict");
            record.protocol.resumeRequired = false; advance(record);
        }
    }
    private static void markPreparing(Record record) {
        record.checkpoint = PREPARING;
        if (record.protocol == null) record.protocol = new AccountClosureProtocolRecord();
        record.protocol.resumeRequired = true;
    }
    // These are intentionally not permission-bearing placeholders. A future native trusted
    // transport must bind both generations and authoritative results before implementing them.
    void bindServerResult(AccountClosureReceiptStore.Scope scope) throws Exception { refuseCloud(scope); }
    void cancel(AccountClosureReceiptStore.Scope scope) throws Exception { refuseCloud(scope); }
    void erase(AccountClosureReceiptStore.Scope scope) throws Exception { refuseCloud(scope); }
    private void refuseCloud(AccountClosureReceiptStore.Scope scope) throws Exception {
        synchronized (authLock) { requireEnabled(); require(scope); throw failure("trusted_result_unavailable"); }
    }
    /** A persisted seal survives disabling the feature and is never inferred from renderer state. */
    static void requireNoCapturedOperation(AccountClosureReceiptStore.Secrets secrets, String installation, String owner) throws Exception {
        Record record = read(secrets, installation, owner);
        // Cancellation reopens admission; deleting an account leaves a permanent
        // owner tombstone so late callbacks cannot recreate its local state.
        if (record != null && (record.protocol == null || !record.protocol.cancelled || record.protocol.resumeRequired)) throw failure("closure_v2_pending");
    }
    private void requireEnabled() throws Exception { if (!enabled) throw failure("closure_v2_unavailable"); }
    private Identity current(AccountClosureReceiptStore.Scope scope) throws Exception {
        return current(scope, false);
    }
    private Identity current(AccountClosureReceiptStore.Scope scope, boolean recovering) throws Exception {
        Identity current = identity.read();
        if (current == null || !scope.ownerId.equals(current.ownerId)) throw failure("wrong_local_owner");
        if (!recovering && !current.authenticated) throw failure("unauthorized");
        return current;
    }
    private Record require(AccountClosureReceiptStore.Scope scope) throws Exception {
        return require(scope, false);
    }
    private Record require(AccountClosureReceiptStore.Scope scope, boolean recovering) throws Exception {
        Identity current = current(scope, recovering);
        Record record = read(secrets, current.installationId, current.ownerId);
        if (record == null) throw failure("closure_context_missing");
        requireBinding(scope, current, record); return record;
    }
    private static void requireBinding(AccountClosureReceiptStore.Scope scope, Identity current, Record record) throws Exception {
        if (!record.operation.equals(scope.localOperationId) || !record.owner.equals(current.ownerId)
            || !record.sid.equals(current.sessionId) || !record.installation.equals(current.installationId)
            || !record.device.equals(current.deviceId) || !record.backend.equals(current.backendIdentity)) throw failure("scope_conflict");
    }
    private void advance(Record record) throws Exception {
        if (record.revision >= 9007199254740991L) throw failure("scope_conflict");
        record.revision++; save(record);
    }
    private void save(Record record) throws Exception {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        try (DataOutputStream out = new DataOutputStream(bytes)) {
            out.writeInt(MAGIC); out.writeInt(STORAGE_VERSION); out.writeInt(PROTOCOL_VERSION);
            for (String value : new String[]{record.owner, record.operation, record.sid, record.installation,
                record.device, record.backend, record.generation, record.checkpoint}) out.writeUTF(value);
            out.writeLong(record.revision); out.write(record.receipt);
            out.writeBoolean(record.protocol != null);
            if (record.protocol != null) record.protocol.write(out);
        }
        secrets.write(keyForOwner(record.owner), bytes.toByteArray());
    }
    private static Record read(AccountClosureReceiptStore.Secrets secrets, String installation, String owner) throws Exception {
        byte[] bytes = secrets.read(keyForOwner(owner));
        if (bytes == null) return null;
        if (bytes.length > 16384) throw failure("closure_storage_unavailable");
        try (DataInputStream in = new DataInputStream(new ByteArrayInputStream(bytes))) {
            validateProtectedHeader(in);
            Record record = new Record(); record.owner = in.readUTF(); record.operation = in.readUTF(); record.sid = in.readUTF();
            record.installation = in.readUTF(); record.device = in.readUTF(); record.backend = in.readUTF();
            record.generation = in.readUTF(); record.checkpoint = in.readUTF();
            record.revision = in.readLong(); record.receipt = new byte[32]; in.readFully(record.receipt);
            record.protocol = in.readBoolean() ? AccountClosureProtocolRecord.read(in) : null;
            if (in.available() != 0 || record.revision < 1 || !owner.equals(record.owner)
                || !installation.equals(record.installation) || !Arrays.asList(CAPTURED, PREPARING, LOCAL_PREPARED).contains(record.checkpoint))
                throw failure("closure_storage_unavailable");
            new AccountClosureReceiptStore.Scope(record.owner, record.operation);
            new Identity(record.owner, record.sid, record.installation, record.device, record.backend); uuid(record.generation);
            return record;
        } catch (Exception invalid) { throw failure("closure_storage_unavailable"); }
    }
    static void validateProtectedHeader(DataInputStream in) throws Exception {
        if (in.readInt() != MAGIC || in.readInt() != STORAGE_VERSION || in.readInt() != PROTOCOL_VERSION)
            throw failure("closure_storage_unavailable");
    }
    static String keyForOwner(String owner) throws Exception {
        uuid(owner);
        // Stable per owner within native protected storage: changing the installation must
        // reject the existing record, rather than hide it behind a different lookup key.
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(("gugu-account-closure/v2\u0000" + owner).getBytes(StandardCharsets.UTF_8));
        StringBuilder hex = new StringBuilder();
        for (byte value : digest) hex.append(String.format(java.util.Locale.ROOT, "%02x", value & 255));
        return hex.toString();
    }
    private static void uuid(String value) throws Exception {
        try { if (!UUID.fromString(value).toString().equals(value)) throw new IllegalArgumentException(); }
        catch (RuntimeException invalid) { throw failure("invalid_scope"); }
    }
    private static AccountClosureReceiptStore.Failure failure(String code) { return new AccountClosureReceiptStore.Failure(code); }
}
