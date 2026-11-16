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
    private static final class Snapshot {
        final int state; final String generation;
        Snapshot(int state, String generation) { this.state = state; this.generation = generation; }
    }
    private Snapshot read(String owner) throws Exception {
        byte[] bytes = secrets.read(key(owner));
        if (bytes == null) return new Snapshot(0, null);
        if (bytes.length != 38 || bytes[0] != 2 || bytes[1] < 0 || bytes[1] > CLOSED)
            throw new AccountClosureReceiptStore.Failure("closure_storage_unavailable");
        String generation = new String(bytes, 2, 36, StandardCharsets.US_ASCII);
        try {
            if (!java.util.UUID.fromString(generation).toString().equals(generation)) throw new IllegalArgumentException();
        } catch (RuntimeException invalid) { throw new AccountClosureReceiptStore.Failure("closure_storage_unavailable"); }
        return new Snapshot(bytes[1], generation);
    }
    int state(String owner) throws Exception { return read(owner).state; }
    String generation(String owner) throws Exception {
        String value = read(owner).generation;
        return value == null ? "" : value;
    }
    void set(String owner, int value) throws Exception {
        if (value < 0 || value > CLOSED) throw new AccountClosureReceiptStore.Failure("invalid_scope");
        Snapshot previous = read(owner);
        String generation = value == STOPPING && previous.state == 0 ? java.util.UUID.randomUUID().toString() : previous.generation;
        if (generation == null) throw new AccountClosureReceiptStore.Failure("closure_not_prepared");
        byte[] bytes = new byte[38]; bytes[0] = 2; bytes[1] = (byte)value;
        System.arraycopy(generation.getBytes(StandardCharsets.US_ASCII), 0, bytes, 2, 36);
        secrets.write(key(owner), bytes);
    }
    static void requireOpen(Context context, String owner) throws Exception {
        synchronized (GuguAuthStoragePlugin.STORAGE_LOCK) {
            AndroidAccountClosureV2.requireNoCapturedOperation(context, owner);
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
