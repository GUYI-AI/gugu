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

/** Private V2 local authority. No HTTP, receipt export, cancellation or erasure authority. */
final class AccountClosureOperationV2 {
    private static final int MAGIC = 0x47554332, STORAGE_VERSION = 3;
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
        private SideEffects(AccountClosureReceiptStore.Scope scope, Metadata captured) {
            this.scope = scope; this.captured = captured; ownerId = captured.ownerId;
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
            requireEnabled(); Record record = require(scope);
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
        final String ownerId, sessionId, installationId, deviceId;
        Identity(String owner, String session, String installation, String device) throws Exception {
            uuid(owner); uuid(session);
            if (installation == null || installation.isEmpty() || installation.length() > 256
                || device == null || device.isEmpty() || device.length() > 256) throw failure("invalid_scope");
            ownerId = owner; sessionId = session; installationId = installation; deviceId = device;
        }
    }
    /** Deliberately contains neither the receipt nor any credentials. */
    static final class Metadata {
        final int protocolVersion = PROTOCOL_VERSION, challengeGeneration = 0;
        final String ownerId, localOperationId, originalAuthSessionId, installationId, canonicalDeviceId;
        final String nativeGeneration, checkpoint;
        final String serverGeneration = null, serverOperationId = null, requestId = null, confirmationId = null;
        final Long operationRevision = null;
        final long localRevision;
        Metadata(Record record) {
            ownerId = record.owner; localOperationId = record.operation; originalAuthSessionId = record.sid;
            installationId = record.installation; canonicalDeviceId = record.device;
            nativeGeneration = record.generation; checkpoint = record.checkpoint; localRevision = record.revision;
        }
    }
    private static final class Record {
        String owner, operation, sid, installation, device, generation, checkpoint;
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
            if (record != null) { requireBinding(scope, current, record); return new Metadata(record); }
            record = new Record(); record.owner = current.ownerId; record.operation = scope.localOperationId;
            record.sid = current.sessionId; record.installation = current.installationId; record.device = current.deviceId;
            record.generation = UUID.randomUUID().toString(); record.checkpoint = CAPTURED; record.revision = 1;
            record.receipt = new byte[32]; entropy.fill(record.receipt);
            save(record); // The discoverable owner index and secret are the SAME atomic protected record.
            return new Metadata(record);
        }
    }
    Metadata readCapturedOperation(AccountClosureReceiptStore.Scope scope) throws Exception {
        synchronized (authLock) { requireEnabled(); return new Metadata(require(scope)); }
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
            if (CAPTURED.equals(record.checkpoint)) { record.checkpoint = PREPARING; advance(record); }
            return new Metadata(record);
        }
    }
    CompletableFuture<Metadata> prepare(AccountClosureReceiptStore.Scope scope) throws Exception {
        final Metadata captured = beginOrRestoreOperation(scope);
        if (LOCAL_PREPARED.equals(captured.checkpoint)) {
            // A persisted local completion is read-only on reentry. Never mint a
            // new side-effect admission or rewrite its receipt/generation/revision.
            if (runtime.busy(scope.ownerId)) throw failure("closure_not_prepared");
            synchronized (authLock) {
                requireEnabled(); Record record = require(scope);
                if (!LOCAL_PREPARED.equals(record.checkpoint) || !record.generation.equals(captured.nativeGeneration)
                    || record.revision != captured.localRevision) throw failure("scope_conflict");
                return CompletableFuture.completedFuture(new Metadata(record));
            }
        }
        final Metadata preparing = checkpointOperation(scope, captured.localRevision, captured.nativeGeneration, "request_local_preparation");
        final SideEffects admission;
        synchronized (authLock) {
            admission = new SideEffects(scope, preparing);
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
                    requireEnabled(); Record record = require(scope);
                    if (!record.generation.equals(preparing.nativeGeneration) || record.revision != preparing.localRevision)
                        throw failure("scope_conflict");
                    if (PREPARING.equals(record.checkpoint)) { record.checkpoint = LOCAL_PREPARED; advance(record); }
                    return new Metadata(record);
                }
            } catch (Exception error) { throw new CompletionException(error); }
        });
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
        if (read(secrets, installation, owner) != null) throw failure("closure_v2_pending");
    }
    private void requireEnabled() throws Exception { if (!enabled) throw failure("closure_v2_unavailable"); }
    private Identity current(AccountClosureReceiptStore.Scope scope) throws Exception {
        Identity current = identity.read();
        if (current == null || !scope.ownerId.equals(current.ownerId)) throw failure("wrong_local_owner");
        return current;
    }
    private Record require(AccountClosureReceiptStore.Scope scope) throws Exception {
        Identity current = current(scope);
        Record record = read(secrets, current.installationId, current.ownerId);
        if (record == null) throw failure("closure_context_missing");
        requireBinding(scope, current, record); return record;
    }
    private static void requireBinding(AccountClosureReceiptStore.Scope scope, Identity current, Record record) throws Exception {
        if (!record.operation.equals(scope.localOperationId) || !record.owner.equals(current.ownerId)
            || !record.sid.equals(current.sessionId) || !record.installation.equals(current.installationId)
            || !record.device.equals(current.deviceId)) throw failure("scope_conflict");
    }
    private void advance(Record record) throws Exception {
        if (record.revision == Long.MAX_VALUE) throw failure("scope_conflict");
        record.revision++; save(record);
    }
    private void save(Record record) throws Exception {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        try (DataOutputStream out = new DataOutputStream(bytes)) {
            out.writeInt(MAGIC); out.writeInt(STORAGE_VERSION); out.writeInt(PROTOCOL_VERSION);
            for (String value : new String[]{record.owner, record.operation, record.sid, record.installation,
                record.device, record.generation, record.checkpoint}) out.writeUTF(value);
            out.writeLong(record.revision); out.write(record.receipt);
            // Reserved trusted-cloud fields are explicitly absent in this first source segment.
            out.writeBoolean(false);
        }
        secrets.write(key(record.installation, record.owner), bytes.toByteArray());
    }
    private static Record read(AccountClosureReceiptStore.Secrets secrets, String installation, String owner) throws Exception {
        byte[] bytes = secrets.read(key(installation, owner));
        if (bytes == null) return null;
        if (bytes.length > 4096) throw failure("closure_storage_unavailable");
        try (DataInputStream in = new DataInputStream(new ByteArrayInputStream(bytes))) {
            if (in.readInt() != MAGIC || in.readInt() != STORAGE_VERSION || in.readInt() != PROTOCOL_VERSION)
                throw failure("closure_storage_unavailable");
            Record record = new Record(); record.owner = in.readUTF(); record.operation = in.readUTF(); record.sid = in.readUTF();
            record.installation = in.readUTF(); record.device = in.readUTF(); record.generation = in.readUTF(); record.checkpoint = in.readUTF();
            record.revision = in.readLong(); record.receipt = new byte[32]; in.readFully(record.receipt);
            if (in.readBoolean() || in.available() != 0 || record.revision < 1 || !owner.equals(record.owner)
                || !installation.equals(record.installation) || !Arrays.asList(CAPTURED, PREPARING, LOCAL_PREPARED).contains(record.checkpoint))
                throw failure("closure_storage_unavailable");
            new AccountClosureReceiptStore.Scope(record.owner, record.operation);
            new Identity(record.owner, record.sid, record.installation, record.device); uuid(record.generation);
            return record;
        } catch (Exception invalid) { throw failure("closure_storage_unavailable"); }
    }
    private static String key(String installation, String owner) throws Exception {
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
