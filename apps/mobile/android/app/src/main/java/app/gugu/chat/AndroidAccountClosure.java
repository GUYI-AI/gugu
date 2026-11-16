package app.gugu.chat;

import android.content.Context;
import android.system.Os;
import android.system.OsConstants;
import java.io.File;
import java.io.FileDescriptor;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;

/** Android composition. The shared controller decides the server result and retries. */
final class AndroidAccountClosure {
    final AccountClosureReceiptStore receipts;
    private final Context context;
    private final AccountClosurePreparation preparation;
    private final AccountClosureAuthSlot auth;
    AndroidAccountClosure(Context context) throws Exception {
        this.context = context.getApplicationContext();
        preparation = new AccountClosurePreparation(context);
        auth = new AccountClosureAuthSlot(context);
        AccountClosureLocalEraser files = new AccountClosureLocalEraser(context.getFilesDir(), context.getNoBackupFilesDir(), directory -> {
            FileDescriptor descriptor = Os.open(directory.getAbsolutePath(), OsConstants.O_RDONLY | OsConstants.O_NOFOLLOW, 0);
            try {
                if (!OsConstants.S_ISDIR(Os.fstat(descriptor).st_mode)) throw new java.io.IOException("Expected an owner storage directory");
                Os.fsync(descriptor);
            } finally { Os.close(descriptor); }
        });
        List<AccountClosureReceiptStore.Step> steps = new ArrayList<>();
        steps.add(scope -> { auth.eraseIfOwned(scope.ownerId); return true; });
        for (int index = 0; index < 3; index++) {
            final int step = index;
            steps.add(scope -> { files.erase(step, scope.ownerId); return true; });
        }
        String installation = GuguPhoneInstallation.identity(context).key;
        receipts = new AccountClosureReceiptStore(GuguAuthStoragePlugin.STORAGE_LOCK,
            new AccountClosureEncryptedFiles(context, installation), () -> GuguPhoneInstallation.identity(context).key,
            auth::owner, scope -> {
                int state = preparation.state(scope.ownerId);
                if (state < AccountClosurePreparation.RETIRED) throw new AccountClosureReceiptStore.Failure("closure_not_prepared");
                if (ownerBusy(scope.ownerId)) return false;
                if (state < AccountClosurePreparation.ERASING) preparation.set(scope.ownerId, AccountClosurePreparation.ERASING);
                return true;
            }, steps, this::retained, (scope, capturing) -> preparation.generation(scope.ownerId));
    }
    String deviceId(String owner) throws Exception {
        String canonical = GuguAgentHostPolicy.owner(owner);
        String registration = GuguPhoneRegistration.resolve(context, GuguPhoneInstallation.identity(context), canonical, null, null);
        return "phone-" + registration + "-" + canonical;
    }
    CompletableFuture<Void> prepareSignOut(String owner) throws Exception {
        synchronized (GuguAuthStoragePlugin.STORAGE_LOCK) {
            requireCurrentOwner(owner);
            int state = preparation.state(owner);
            if (state >= AccountClosurePreparation.ERASING) throw new AccountClosureReceiptStore.Failure("closure_not_prepared");
            if (state == 0) preparation.set(owner, AccountClosurePreparation.STOPPING);
        }
        // No auth lock is held while a runtime drains. Its last callbacks may
        // need that same lock; erasure itself never takes either runtime lock.
        CompletableFuture<Void> modern = GuguAgentHostService.stopOwnerAndWait(context, owner, false);
        CompletableFuture<Void> legacy = GuguAgentService.stopOwnerAndWait(owner);
        return CompletableFuture.allOf(modern, legacy).thenRun(() -> {
            synchronized (GuguAuthStoragePlugin.STORAGE_LOCK) {
                try {
                    requireCurrentOwner(owner);
                    if (ownerBusy(owner)) throw new AccountClosureReceiptStore.Failure("closure_not_prepared");
                    if (preparation.state(owner) < AccountClosurePreparation.STOPPED) preparation.set(owner, AccountClosurePreparation.STOPPED);
                } catch (Exception error) { throw new java.util.concurrent.CompletionException(error); }
            }
        });
    }
    void retireDevice(String owner, String expectedDeviceId) throws Exception {
        // Registration migration can read the host store. Resolve outside the
        // auth monitor, then recheck its owner under that monitor.
        String registeredDevice = deviceId(owner);
        synchronized (GuguAuthStoragePlugin.STORAGE_LOCK) {
            requireCurrentOwner(owner);
            if (!registeredDevice.equals(expectedDeviceId) || preparation.state(owner) < AccountClosurePreparation.STOPPED || ownerBusy(owner))
                throw new AccountClosureReceiptStore.Failure("closure_not_prepared");
            // The Android adapter calls this only after the existing owner-
            // scoped device removal acknowledges success. No new HTTP API here.
            preparation.set(owner, AccountClosurePreparation.RETIRED);
        }
    }
    AccountClosureReceiptStore.Outcome erase(AccountClosureReceiptStore.Scope scope) throws Exception {
        AccountClosureReceiptStore.Outcome result = receipts.eraseLocal(scope);
        if ("complete".equals(result.status)) {
            synchronized (GuguAuthStoragePlugin.STORAGE_LOCK) { preparation.set(scope.ownerId, AccountClosurePreparation.CLOSED); }
            GuguAgentHostService.forgetClosedOwner(scope.ownerId);
            GuguAgentService.forgetClosedOwner(scope.ownerId);
        }
        return result;
    }
    void cancelPreparation(AccountClosureReceiptStore.Scope scope) throws Exception {
        String generation = receipts.requireCancelledReceipt(scope);
        synchronized (GuguAuthStoragePlugin.STORAGE_LOCK) {
            requireCurrentOwner(scope.ownerId);
            if (!generation.equals(preparation.generation(scope.ownerId)) || preparation.state(scope.ownerId) >= AccountClosurePreparation.ERASING)
                throw new AccountClosureReceiptStore.Failure("scope_conflict");
            preparation.set(scope.ownerId, 0);
            // Never configure or start a host here. Its settings remain off.
        }
    }
    private void requireCurrentOwner(String owner) throws Exception {
        if (!GuguAgentHostPolicy.owner(owner).equals(auth.owner())) throw new AccountClosureReceiptStore.Failure("wrong_local_owner");
    }
    private static boolean ownerBusy(String owner) { return GuguAgentHostService.ownerIsBusy(owner) || GuguAgentService.ownerIsBusy(owner); }
    private static boolean nonempty(File directory) throws Exception {
        if (!directory.exists()) return false;
        File[] entries = directory.listFiles();
        if (entries == null) throw new AccountClosureReceiptStore.Failure("closure_storage_unavailable");
        return entries.length > 0;
    }
    private List<String> retained() throws Exception {
        List<String> names = auth.unattributed();
        File[] cached = context.getCacheDir().listFiles();
        if (cached == null) throw new AccountClosureReceiptStore.Failure("closure_storage_unavailable");
        if (cached.length > 0) names.add("shared-runtime-temp-cache");
        if (nonempty(new File(context.getCacheDir(), "share-in"))) names.add("shared-incoming-file-cache");
        if (nonempty(new File(context.getCacheDir(), "share-out"))) names.add("shared-outgoing-file-cache");
        return names;
    }
}
