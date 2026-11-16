package app.gugu.chat;

import android.content.Context;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;

/** Native-only persistent fence. Missing or corrupt evidence never permits erase. */
final class AccountClosurePreparation {
    static final int STOPPING = 1, STOPPED = 2, RETIRED = 3, ERASING = 4, CLOSED = 5;
    private final AccountClosureEncryptedFiles secrets;
    private final String installation;
    AccountClosurePreparation(Context context) throws Exception {
        installation = GuguPhoneInstallation.identity(context).key;
        secrets = new AccountClosureEncryptedFiles(context, installation);
    }
    int state(String owner) throws Exception {
        byte[] bytes = secrets.read(key(owner));
        if (bytes == null) return 0;
        if (bytes.length != 2 || bytes[0] != 1 || bytes[1] < 0 || bytes[1] > CLOSED) throw new AccountClosureReceiptStore.Failure("closure_storage_unavailable");
        return bytes[1];
    }
    void set(String owner, int value) throws Exception { secrets.write(key(owner), new byte[] {1, (byte)value}); }
    static void requireOpen(Context context, String owner) throws Exception {
        synchronized (GuguAuthStoragePlugin.STORAGE_LOCK) {
            if (new AccountClosurePreparation(context).state(owner) != 0) throw new AccountClosureReceiptStore.Failure("closure_not_prepared");
        }
    }
    static void requireWritableState(Context context, String owner) throws Exception {
        synchronized (GuguAuthStoragePlugin.STORAGE_LOCK) {
            if (new AccountClosurePreparation(context).state(owner) >= ERASING) throw new AccountClosureReceiptStore.Failure("closure_not_prepared");
        }
    }
    static void requireAuthWrite(Context context, String value) throws Exception {
        String owner = AccountClosureAuthSlot.ownerOf(value);
        if (owner != null && new AccountClosurePreparation(context).state(owner) >= ERASING)
            throw new AccountClosureReceiptStore.Failure("closure_not_prepared");
    }
    private String key(String owner) throws Exception {
        GuguAgentHostPolicy.owner(owner);
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(("closure-preparation\u0000" + installation + "\u0000" + owner).getBytes(StandardCharsets.UTF_8));
        StringBuilder hex = new StringBuilder();
        for (byte value : digest) hex.append(String.format(java.util.Locale.ROOT,"%02x",value & 255));
        return hex.toString();
    }
}
