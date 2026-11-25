package app.gugu.chat;

import java.util.LinkedHashMap;
import java.util.Map;

/** One lock protects migration and every read/modify/write; failed reads are never absence. */
final class AuthStorageMigration {
    interface Records {
        Map<String, String> read() throws Exception;
        void write(Map<String, String> values) throws Exception;
        void markAuthority() throws Exception;
    }
    interface Legacy {
        Map<String, String> read() throws Exception;
        void clear() throws Exception;
    }
    private final Object lock;
    private final Records secure;
    private final Legacy legacy;
    private final AuthStorageRecord.Owner owner;
    AuthStorageMigration(Object lock, Records secure, Legacy legacy, AuthStorageRecord.Owner owner) {
        this.lock = lock; this.secure = secure; this.legacy = legacy; this.owner = owner;
    }
    String get(String key) throws Exception {
        requireKey(key);
        synchronized (lock) { return load().get(key); }
    }
    void put(String key, String value) throws Exception {
        requireKey(key);
        if (value == null) throw new AuthStorageFailure("value_missing", false);
        synchronized (lock) {
            Map<String, String> values = load();
            values.put(key, value); validate(values); commit(values);
        }
    }
    void removeTemporary(String key) throws Exception {
        if (!AuthStorageKeys.isTemporary(key)) throw new AuthStorageFailure("key_invalid", false);
        synchronized (lock) {
            Map<String, String> values = load();
            if (values.remove(key) != null) commit(values);
        }
    }
    private Map<String, String> load() throws Exception {
        Map<String, String> saved = secure.read();
        if (saved == null) {
            // A throw (corruption/key loss) cannot reach this legacy importer.
            saved = new LinkedHashMap<>(legacy.read());
            validate(saved); commit(saved);
        } else {
            validate(saved);
            secure.markAuthority();
            legacy.clear();
        }
        return new LinkedHashMap<>(saved);
    }
    private void commit(Map<String, String> values) throws Exception {
        secure.write(new LinkedHashMap<>(values));
        Map<String, String> actual = secure.read();
        if (!values.equals(actual)) throw new AuthStorageFailure("readback_mismatch", false);
        secure.markAuthority();
        // Never clear legacy before durable replacement and final-file readback.
        legacy.clear();
    }
    private void validate(Map<String, String> values) throws Exception {
        for (Map.Entry<String, String> item : values.entrySet()) {
            requireKey(item.getKey());
            if (item.getValue() == null) throw new AuthStorageFailure("record_invalid", true);
        }
        owner.of(values.get("sb-main"));
    }
    private static void requireKey(String key) throws AuthStorageFailure {
        if (!AuthStorageKeys.isAllowed(key)) throw new AuthStorageFailure("key_invalid", false);
    }
}
