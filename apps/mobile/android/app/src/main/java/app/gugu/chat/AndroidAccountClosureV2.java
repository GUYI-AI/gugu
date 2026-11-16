package app.gugu.chat;

import android.content.Context;
import android.util.Base64;
import org.json.JSONObject;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.CompletableFuture;

/** Private, unregistered composition. There is deliberately no Capacitor/UI/HTTP entry. */
final class AndroidAccountClosureV2 {
    private static final boolean ENABLED = false;
    private final Context context;
    AndroidAccountClosureV2(Context context) { this.context = context.getApplicationContext(); }
    boolean available() { return ENABLED; }
    AccountClosureOperationV2.Metadata beginOrRestoreOperation(AccountClosureReceiptStore.Scope scope) throws Exception {
        return operation(scope.ownerId).beginOrRestoreOperation(scope);
    }
    AccountClosureOperationV2.Metadata readCapturedOperation(AccountClosureReceiptStore.Scope scope) throws Exception {
        return operation(scope.ownerId).readCapturedOperation(scope);
    }
    AccountClosureOperationV2.Metadata readCapturedOperation() throws Exception {
        if (!ENABLED) throw new AccountClosureReceiptStore.Failure("closure_v2_unavailable");
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
    private AccountClosureOperationV2 operation(String owner) throws Exception {
        if (!ENABLED) throw new AccountClosureReceiptStore.Failure("closure_v2_unavailable");
        // Registration can take the host-store monitor: NEVER resolve it while holding STORAGE_LOCK.
        java.util.concurrent.atomic.AtomicReference<String> device = new java.util.concurrent.atomic.AtomicReference<>(
            new AndroidAccountClosure(context).deviceId(owner));
        String installation = GuguPhoneInstallation.identity(context).key;
        return new AccountClosureOperationV2(GuguAuthStoragePlugin.STORAGE_LOCK,
            new AccountClosureEncryptedFiles(context, installation), () -> capture(owner, installation, device.get()),
            new AccountClosureOperationV2.Runtime() {
                public CompletableFuture<Void> stopAndDrain(String drainingOwner) throws Exception {
                    synchronized (GuguAuthStoragePlugin.STORAGE_LOCK) {
                        capture(drainingOwner, installation, device.get());
                        var grants = GuguAgentService.permissions(context);
                        if (drainingOwner.equals(grants.getString("owner", ""))) {
                            if (!grants.edit().clear().commit())
                                throw new AccountClosureReceiptStore.Failure("closure_storage_unavailable");
                            GuguNotificationListener.setCollecting(false);
                        }
                    }
                    return CompletableFuture.allOf(GuguAgentHostService.stopOwnerAndWait(context, drainingOwner, false),
                        GuguAgentService.stopOwnerAndWait(drainingOwner)).thenRun(() -> {
                            try { device.set(new AndroidAccountClosure(context).deviceId(drainingOwner)); }
                            catch (Exception error) { throw new java.util.concurrent.CompletionException(error); }
                        });
                }
                public boolean busy(String owner) {
                    return GuguAgentHostService.ownerIsBusy(owner) || GuguAgentService.ownerIsBusy(owner);
                }
            }, ENABLED);
    }
    private AccountClosureOperationV2.Identity capture(String owner, String installation, String device) throws Exception {
        // Called only inside STORAGE_LOCK, from the committed native Auth envelope.
        String raw = context.getSharedPreferences("gugu-auth-storage", Context.MODE_PRIVATE).getString("sb-main", null);
        if (raw == null || !owner.equals(AccountClosureAuthSlot.ownerOf(raw)))
            throw new AccountClosureReceiptStore.Failure("wrong_local_owner");
        if (new AccountClosurePreparation(context).state(owner) != 0)
            throw new AccountClosureReceiptStore.Failure("scope_conflict");
        JSONObject session = new JSONObject(new JSONObject(raw).getString("raw"));
        String[] jwt = session.getString("access_token").split("\\.", -1);
        if (jwt.length != 3) throw new AccountClosureReceiptStore.Failure("invalid_scope");
        JSONObject claims = new JSONObject(new String(Base64.decode(jwt[1], Base64.URL_SAFE | Base64.NO_WRAP), StandardCharsets.UTF_8));
        if (!owner.equals(claims.getString("sub")) || !installation.equals(GuguPhoneInstallation.identity(context).key))
            throw new AccountClosureReceiptStore.Failure("scope_conflict");
        // Capture an identifier, NOT a local claim that the server session is live/authorized.
        return new AccountClosureOperationV2.Identity(owner, claims.getString("session_id"), installation, device);
    }
    static void requireNoCapturedOperation(Context context, String owner) throws Exception {
        synchronized (GuguAuthStoragePlugin.STORAGE_LOCK) {
            String installation = GuguPhoneInstallation.identity(context).key;
            AccountClosureOperationV2.requireNoCapturedOperation(new AccountClosureEncryptedFiles(context, installation), installation, owner);
        }
    }
}
