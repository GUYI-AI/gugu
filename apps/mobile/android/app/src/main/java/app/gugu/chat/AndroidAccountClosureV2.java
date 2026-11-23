package app.gugu.chat;

import android.content.Context;
import android.util.Base64;
import org.json.JSONObject;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.CompletableFuture;

/** Native operation composition; the separate V2 facade admits new operations through policy. */
final class AndroidAccountClosureV2 {
    private final Context context;
    private final boolean enabled;
    AndroidAccountClosureV2(Context context) { this(context, false); }
    AndroidAccountClosureV2(Context context, boolean enabled) { this.context = context.getApplicationContext(); this.enabled = enabled; }
    boolean available() { return enabled; }
    AccountClosureOperationV2.Metadata beginOrRestoreOperation(AccountClosureReceiptStore.Scope scope) throws Exception {
        return operation(scope.ownerId).beginOrRestoreOperation(scope);
    }
    AccountClosureOperationV2.Metadata readCapturedOperation(AccountClosureReceiptStore.Scope scope) throws Exception {
        return operation(scope.ownerId).readCapturedOperation(scope);
    }
    AccountClosureOperationV2.Metadata readCapturedOperation() throws Exception {
        if (!enabled) throw new AccountClosureReceiptStore.Failure("closure_v2_unavailable");
        final String owner;
        synchronized (GuguAuthStoragePlugin.STORAGE_LOCK) { owner = new AccountClosureAuthSlot(context).owner(); }
        return operation(owner).readCapturedOperationForCurrentOwner();
    }
    AccountClosureOperationV2.Metadata checkpointOperation(AccountClosureReceiptStore.Scope scope, long revision,
                                                          String nativeGeneration, String event) throws Exception {
        return operation(scope.ownerId).checkpointOperation(scope, revision, nativeGeneration, event);
    }
    CompletableFuture<AccountClosureOperationV2.Metadata> prepare(AccountClosureReceiptStore.Scope scope) throws Exception {
        return operation(scope.ownerId).prepare(scope);
    }
    AccountClosureOperationV2 operation(String owner) throws Exception { return operation(owner, false); }
    AccountClosureOperationV2 operation(String owner, boolean recovering) throws Exception {
        if (!enabled) throw new AccountClosureReceiptStore.Failure("closure_v2_unavailable");
        // Registration can take the host-store monitor: NEVER resolve it while holding STORAGE_LOCK.
        java.util.concurrent.atomic.AtomicReference<String> device = new java.util.concurrent.atomic.AtomicReference<>(
            nativeDeviceId(owner, recovering));
        String installation = GuguPhoneInstallation.identity(context).key;
        return new AccountClosureOperationV2(GuguAuthStoragePlugin.STORAGE_LOCK,
            custody(), () -> capture(owner, installation, device.get(), recovering),
            new AccountClosureOperationV2.Runtime() {
                public CompletableFuture<Void> stopAndDrain(AccountClosureOperationV2.SideEffects admission) throws Exception {
                    String drainingOwner = admission.ownerId;
                    admission.runLocal(() -> {
                        var grants = GuguAgentService.permissions(context);
                        if (drainingOwner.equals(grants.getString("owner", ""))) {
                            if (!grants.edit().clear().commit())
                                throw new AccountClosureReceiptStore.Failure("closure_storage_unavailable");
                            GuguNotificationListener.setCollecting(false);
                        }
                    });
                    return CompletableFuture.allOf(GuguAgentHostService.stopOwnerRuntimeAndWaitForClosure(admission),
                        GuguAgentService.stopOwnerAndWaitForClosure(admission)).thenRun(() -> {
                            try { device.set(nativeDeviceId(drainingOwner, recovering)); }
                            catch (Exception error) { throw new java.util.concurrent.CompletionException(error); }
                        });
                }
                public boolean busy(String owner) {
                    return GuguAgentHostService.ownerIsBusy(owner) || GuguAgentService.ownerIsBusy(owner);
                }
            }, enabled);
    }
    private String nativeDeviceId(String owner, boolean recovering) throws Exception {
        if (!recovering) return new AndroidAccountClosure(context).deviceId(owner);
        String existing = PhoneRegistrationIdentity.readExisting(context.getNoBackupFilesDir(), GuguPhoneInstallation.identity(context).key);
        if (existing == null) throw new AccountClosureReceiptStore.Failure("scope_conflict");
        return "phone-" + existing + "-" + GuguAgentHostPolicy.owner(owner);
    }
    private AccountClosureOperationV2.Identity capture(String owner, String installation, String device, boolean recovering) throws Exception {
        // Called only inside STORAGE_LOCK, from the committed native Auth envelope.
        StoredSession session = storedSession(context);
        String backend = new AccountClosureHttp(AndroidAccountClosureBackend.load(context)).backendIdentity();
        if (session == null) {
            if (!recovering) throw new AccountClosureReceiptStore.Failure("unauthorized");
            AccountClosureOperationV2.Metadata saved = AccountClosureOperationV2.protectedMetadata(custody(), installation, owner);
            if (saved == null) throw new AccountClosureReceiptStore.Failure("closure_context_missing");
            return new AccountClosureOperationV2.Identity(owner, saved.originalAuthSessionId, installation, device, backend, false);
        }
        if (!owner.equals(session.owner)) throw new AccountClosureReceiptStore.Failure("wrong_local_owner");
        if (!recovering && new AccountClosurePreparation(context).state(owner) != 0)
            throw new AccountClosureReceiptStore.Failure("scope_conflict");
        return new AccountClosureOperationV2.Identity(owner, session.sid, installation, device, backend);
    }
    AccountClosureIndexedSecrets custody() throws Exception {
        String installation = GuguPhoneInstallation.identity(context).key;
        return new AccountClosureIndexedSecrets(new AccountClosureEncryptedFiles(context, installation));
    }
    AccountClosureOperationV2.Metadata discover() throws Exception {
        if (!enabled) throw new AccountClosureReceiptStore.Failure("closure_v2_unavailable");
        String installation = GuguPhoneInstallation.identity(context).key;
        StoredSession current;
        synchronized (GuguAuthStoragePlugin.STORAGE_LOCK) { current = storedSession(context); }
        if (current != null) {
            AccountClosureOperationV2.Metadata saved = AccountClosureOperationV2.protectedMetadata(custody(), installation, current.owner);
            if (saved == null || saved.protocol.released()) return null;
            return operation(current.owner, true).readForRecovery(new AccountClosureReceiptStore.Scope(current.owner, saved.localOperationId));
        }
        for (AccountClosureIndexedSecrets.Entry entry : custody().discover()) {
            AccountClosureOperationV2.Metadata saved = AccountClosureOperationV2.protectedMetadata(custody(), installation, entry.owner);
            if (saved != null && !saved.protocol.released())
                return operation(entry.owner, true).readForRecovery(new AccountClosureReceiptStore.Scope(entry.owner, saved.localOperationId));
        }
        return null;
    }
    AccountClosureOperationV2.Metadata resolve(String localOperationId, String generation, long revision) throws Exception {
        String installation = GuguPhoneInstallation.identity(context).key;
        StoredSession session;
        synchronized (GuguAuthStoragePlugin.STORAGE_LOCK) { session = storedSession(context); }
        for (AccountClosureIndexedSecrets.Entry entry : custody().discover()) {
            if (session != null && !session.owner.equals(entry.owner)) continue;
            AccountClosureOperationV2.Metadata saved = AccountClosureOperationV2.protectedMetadata(custody(), installation, entry.owner);
            if (saved == null || !saved.localOperationId.equals(localOperationId)) continue;
            AccountClosureOperationV2.Metadata current = operation(entry.owner, true).readForRecovery(
                new AccountClosureReceiptStore.Scope(entry.owner, localOperationId));
            if (!current.nativeGeneration.equals(generation) || current.localRevision != revision)
                throw new AccountClosureReceiptStore.Failure("scope_conflict");
            return current;
        }
        throw new AccountClosureReceiptStore.Failure("closure_context_missing");
    }
    static final class StoredSession {
        final String owner, sid, bearer;
        StoredSession(String owner, String sid, String bearer) { this.owner = owner; this.sid = sid; this.bearer = bearer; }
    }
    static StoredSession storedSession(Context context) throws Exception {
        String raw = context.getSharedPreferences("gugu-auth-storage", Context.MODE_PRIVATE).getString("sb-main", null);
        String owner = AccountClosureAuthSlot.ownerOf(raw);
        if (owner == null) return null;
        JSONObject session = new JSONObject(new JSONObject(raw).getString("raw"));
        String bearer = session.getString("access_token");
        String[] jwt = bearer.split("\\.", -1);
        if (jwt.length != 3 || bearer.length() > 8192 || bearer.matches(".*\\s.*"))
            throw new AccountClosureReceiptStore.Failure("unauthorized");
        JSONObject claims = new JSONObject(new String(Base64.decode(jwt[1], Base64.URL_SAFE | Base64.NO_WRAP), StandardCharsets.UTF_8));
        String sid = claims.getString("session_id");
        if (!owner.equals(claims.getString("sub")) || !java.util.UUID.fromString(sid).toString().equals(sid))
            throw new AccountClosureReceiptStore.Failure("scope_conflict");
        return new StoredSession(owner, sid, bearer);
    }

    static void requireNoCapturedOperation(Context context, String owner) throws Exception {
        synchronized (GuguAuthStoragePlugin.STORAGE_LOCK) {
            String installation = GuguPhoneInstallation.identity(context).key;
            AccountClosureOperationV2.requireNoCapturedOperation(new AccountClosureIndexedSecrets(new AccountClosureEncryptedFiles(context, installation)), installation, owner);
        }
    }
    static void requireWritableState(Context context, String owner) throws Exception {
        String installation = GuguPhoneInstallation.identity(context).key;
        AccountClosureOperationV2.Metadata saved = AccountClosureOperationV2.protectedMetadata(
            new AccountClosureIndexedSecrets(new AccountClosureEncryptedFiles(context, installation)), installation, owner);
        if (saved != null && saved.protocol.deleted()) throw new AccountClosureReceiptStore.Failure("closure_v2_pending");
    }
    static void resumeAfterCancellation(Context context, String owner) throws Exception {
        synchronized (GuguAuthStoragePlugin.STORAGE_LOCK) {
            if (!owner.equals(new AccountClosureAuthSlot(context).owner())) throw new AccountClosureReceiptStore.Failure("wrong_local_owner");
            String installation = GuguPhoneInstallation.identity(context).key;
            AccountClosureOperationV2.Metadata saved = AccountClosureOperationV2.protectedMetadata(
                new AccountClosureIndexedSecrets(new AccountClosureEncryptedFiles(context, installation)), installation, owner);
            if (saved == null) return;
        }
        new AndroidAccountClosureV2(context, true).operation(owner).resumeCurrentOwnerAfterCancellation();
    }
    static void requireAuthMutation(Context context, String envelope) throws Exception {
        String owner = AccountClosureAuthSlot.ownerOf(envelope), sid = null;
        if (owner != null) requireWritableState(context, owner);
        if (!AccountClosureOperationV2.hasSideEffectAdmission(GuguAuthStoragePlugin.STORAGE_LOCK)) return;
        if (owner != null) {
            JSONObject session = new JSONObject(new JSONObject(envelope).getString("raw"));
            String[] jwt = session.getString("access_token").split("\\.", -1);
            if (jwt.length != 3) throw new AccountClosureReceiptStore.Failure("scope_conflict");
            JSONObject claims = new JSONObject(new String(Base64.decode(jwt[1], Base64.URL_SAFE | Base64.NO_WRAP), StandardCharsets.UTF_8));
            if (!owner.equals(claims.getString("sub"))) throw new AccountClosureReceiptStore.Failure("scope_conflict");
            sid = claims.getString("session_id");
        }
        AccountClosureOperationV2.requireAuthMutation(GuguAuthStoragePlugin.STORAGE_LOCK, owner, sid);
    }
}
