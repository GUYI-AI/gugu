package app.gugu.chat;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/** One atomic encrypted replacement contains the discovery index and native records. */
final class AccountClosureIndexedSecrets implements AccountClosureReceiptStore.Secrets {
    private static final Object LOCK = new Object();
    private static final int MAGIC = 0x47554932;
    private final AccountClosureReceiptStore.Secrets protectedFiles;
    static final class Entry {
        final String owner, key;
        final byte[] bytes;
        Entry(String owner, String key, byte[] bytes) { this.owner = owner; this.key = key; this.bytes = bytes.clone(); }
    }
    private static final class Index {
        String selectedKey;
        final Map<String, Entry> entries = new LinkedHashMap<>();
    }
    AccountClosureIndexedSecrets(AccountClosureReceiptStore.Secrets protectedFiles) { this.protectedFiles = protectedFiles; }
    @Override public byte[] read(String key) throws Exception {
        synchronized (LOCK) {
            Entry entry = load().entries.get(key);
            // Never hide a record from the old private format and mint another capability.
            if (entry == null && protectedFiles.read(key) != null) throw failure();
            return entry == null ? null : entry.bytes.clone();
        }
    }
    @Override public void write(String key, byte[] bytes) throws Exception {
        synchronized (LOCK) {
            if (!key.matches("[a-f0-9]{64}") || bytes.length > 16384) throw failure();
            String owner = ownerOf(bytes);
            if (!key.equals(AccountClosureOperationV2.keyForOwner(owner))) throw failure();
            Index index = load();
            if (!index.entries.containsKey(key)) index.selectedKey = key;
            index.entries.put(key, new Entry(owner, key, bytes));
            ByteArrayOutputStream output = new ByteArrayOutputStream();
            try (DataOutputStream out = new DataOutputStream(output)) {
                out.writeInt(MAGIC); out.writeInt(1); out.writeUTF(index.selectedKey); out.writeInt(index.entries.size());
                for (Entry entry : index.entries.values()) {
                    out.writeUTF(entry.owner); out.writeUTF(entry.key); out.writeInt(entry.bytes.length); out.write(entry.bytes);
                }
            }
            if (output.size() > 100000) throw failure();
            protectedFiles.write(indexKey(), output.toByteArray());
        }
    }
    /** Native only. No ordinary bridge enumerates this index or returns its bytes. */
    List<Entry> discover() throws Exception {
        synchronized (LOCK) {
            Index index = load(); List<Entry> entries = new ArrayList<>();
            if (index.selectedKey != null) entries.add(index.entries.get(index.selectedKey));
            for (Entry entry : index.entries.values()) if (!entry.key.equals(index.selectedKey)) entries.add(entry);
            return entries;
        }
    }
    private Index load() throws Exception {
        byte[] bytes = protectedFiles.read(indexKey()); Index index = new Index();
        if (bytes == null) return index;
        try (DataInputStream in = new DataInputStream(new ByteArrayInputStream(bytes))) {
            if (bytes.length > 100000 || in.readInt() != MAGIC || in.readInt() != 1) throw failure();
            index.selectedKey = in.readUTF(); int count = in.readInt();
            if (count < 1 || count > bytes.length / 80) throw failure();
            for (int i = 0; i < count; i++) {
                String owner = in.readUTF(), key = in.readUTF(); int length = in.readInt();
                if (!key.matches("[a-f0-9]{64}") || length < 1 || length > 16384 || length > in.available()) throw failure();
                byte[] record = new byte[length]; in.readFully(record);
                if (!owner.equals(ownerOf(record)) || !key.equals(AccountClosureOperationV2.keyForOwner(owner))
                    || index.entries.put(key, new Entry(owner, key, record)) != null) throw failure();
            }
            if (in.available() != 0 || !index.entries.containsKey(index.selectedKey)) throw failure();
            return index;
        } catch (Exception corrupt) { throw failure(); }
    }
    private static String ownerOf(byte[] bytes) throws Exception {
        try (DataInputStream in = new DataInputStream(new ByteArrayInputStream(bytes))) {
            AccountClosureOperationV2.validateProtectedHeader(in);
            String owner = in.readUTF(); if (!UUID.fromString(owner).toString().equals(owner)) throw failure();
            return owner;
        }
    }
    private static String indexKey() throws Exception {
        byte[] bytes = MessageDigest.getInstance("SHA-256").digest("gugu-account-closure/v2/index".getBytes(StandardCharsets.UTF_8));
        StringBuilder hex = new StringBuilder(); for (byte value : bytes) hex.append(String.format(java.util.Locale.ROOT, "%02x", value & 255));
        return hex.toString();
    }
    private static AccountClosureReceiptStore.Failure failure() { return new AccountClosureReceiptStore.Failure("closure_storage_unavailable"); }
}
