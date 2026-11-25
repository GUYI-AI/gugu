package app.gugu.chat;

import android.content.Context;
import android.content.SharedPreferences;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.Map;

/** Explicit user consent, serialized with all canonical Auth writes. No account-wide sign-out. */
final class AndroidAuthRecovery {
    private static final String LEGACY = "gugu-auth-storage";
    private static final byte[] RESET = "gugu-auth-user-relogin-v1\n".getBytes(StandardCharsets.US_ASCII);
    static final class State {
        final boolean canReset; final String revision;
        State(boolean canReset, String revision) { this.canReset = canReset; this.revision = revision; }
    }
    private static File root(Context context) throws Exception {
        File root = new File(context.getNoBackupFilesDir().getCanonicalFile(), "gugu-auth");
        ProtectedFile.path(root); return root;
    }
    private static File legacy(Context context) throws Exception {
        return new File(new File(context.getApplicationInfo().dataDir).getCanonicalFile(), "shared_prefs/" + LEGACY + ".xml");
    }
    private static boolean closureEvidence(Context context) throws Exception {
        if (AccountClosureOperationV2.hasSideEffectAdmission(GuguAuthStoragePlugin.STORAGE_LOCK)) return true;
        File directory = new File(context.getNoBackupFilesDir().getCanonicalFile(), "account-closure");
        ProtectedFile.path(directory);
        if (!directory.exists()) return false;
        File[] entries = directory.listFiles();
        if (entries == null) throw new AuthStorageFailure("closure_status_unavailable", false);
        // With unreadable Auth the owner cannot be proven. Even corrupt/old retained custody
        // must block destructive recovery; never erase a receipt or infer terminal success.
        return entries.length != 0;
    }
    static State inspect(Context context) throws Exception {
        synchronized (GuguAuthStoragePlugin.STORAGE_LOCK) {
            try { new AndroidAuthStore(context).get("sb-main"); }
            catch (AuthStorageFailure error) {
                if (!error.recovery) throw error;
                return new State(!closureEvidence(context), revision(context));
            }
            throw new AuthStorageFailure("recovery_state_changed", false);
        }
    }
    private static String revision(Context context) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        File old = legacy(context), root = root(context);
        File[] files = {new File(root, "state.enc"), new File(root, "authority.v1"), old, new File(old.getPath() + ".bak")};
        for (int i = 0; i < files.length; i++) {
            digest.update((byte)i);
            byte[] bytes = ProtectedFile.read(files[i], AuthStorageRecord.MAX_BYTES);
            digest.update((byte)(bytes == null ? 0 : 1));
            if (bytes != null) digest.update(MessageDigest.getInstance("SHA-256").digest(bytes));
        }
        StringBuilder hex = new StringBuilder();
        for (byte value : digest.digest()) hex.append(String.format(java.util.Locale.ROOT, "%02x", value & 255));
        return hex.toString();
    }
    static void reset(Context context, String expected) throws Exception {
        synchronized (GuguAuthStoragePlugin.STORAGE_LOCK) {
            State state = inspect(context);
            if (!state.canReset) throw new AuthStorageFailure("closure_recovery_pending", true);
            if (expected == null || !expected.matches("[a-f0-9]{64}") || !expected.equals(state.revision))
                throw new AuthStorageFailure("recovery_state_changed", false);
            File root = root(context); ProtectedFile.directory(root);
            ProtectedFile.write(new File(root, "relogin-reset.v1"), RESET);
            resume(context);
        }
    }
    static void resume(Context context) throws Exception {
        synchronized (GuguAuthStoragePlugin.STORAGE_LOCK) {
            File root = root(context), marker = new File(root, "relogin-reset.v1");
            byte[] intent = ProtectedFile.read(marker, 128);
            if (intent == null) return;
            if (!Arrays.equals(intent, RESET)) throw new AuthStorageFailure("reset_intent_invalid", false);
            if (closureEvidence(context)) throw new AuthStorageFailure("closure_recovery_pending", true);
            // The durable user intent precedes every removal. A crash cannot re-import stale XML.
            File old = legacy(context), backup = new File(old.getPath() + ".bak");
            ProtectedFile.path(old); ProtectedFile.path(backup);
            SharedPreferences preferences = context.getSharedPreferences(LEGACY, Context.MODE_PRIVATE);
            if (old.exists() || backup.exists() || !preferences.getAll().isEmpty()) {
                if (!preferences.edit().clear().commit()) throw new AuthStorageFailure("legacy_clear_failed", false);
                if (!context.deleteSharedPreferences(LEGACY) || old.exists() || backup.exists())
                    throw new AuthStorageFailure("legacy_delete_failed", false);
                ProtectedFile.sync(old.getParentFile());
            }
            remove(new File(root, "state.enc")); remove(new File(root, "authority.v1"));
            File[] temporary = root.listFiles((directory, name) -> name.startsWith("record-") && name.endsWith(".tmp"));
            if (temporary == null) throw new AuthStorageFailure("reset_failed", false);
            for (File file : temporary) remove(file);
            KeyStore keys = KeyStore.getInstance("AndroidKeyStore"); keys.load(null);
            if (keys.containsAlias("gugu-auth-storage-v1")) keys.deleteEntry("gugu-auth-storage-v1");
            AndroidAuthRecords records = new AndroidAuthRecords(context);
            Map<String, String> retired = new LinkedHashMap<>(); retired.put("sb-main", "{\"state\":\"RETIRED_EMPTY\"}");
            records.write(retired); records.markAuthority();
            if (!retired.equals(records.read())) throw new AuthStorageFailure("reset_readback_failed", false);
            remove(marker); ProtectedFile.sync(root);
        }
    }
    private static void remove(File file) throws Exception {
        ProtectedFile.path(file);
        if (file.exists() && (!file.isFile() || !file.delete())) throw new AuthStorageFailure("reset_failed", false);
    }
}
