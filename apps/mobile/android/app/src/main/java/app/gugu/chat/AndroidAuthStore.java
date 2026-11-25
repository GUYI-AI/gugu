package app.gugu.chat;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;
import java.io.File;
import java.util.LinkedHashMap;
import java.util.Map;
import org.json.JSONObject;

/** Canonical login/PKCE access. No host lock or refresh authority is acquired here. */
final class AndroidAuthStore {
    private static final String LEGACY = "gugu-auth-storage";
    private final Context context;
    private interface Action<T> { T run(AuthStorageMigration store) throws Exception; }
    AndroidAuthStore(Context context) { this.context = context; }
    String get(String key) throws Exception { return perform("read", store -> store.get(key)); }
    void put(String key, String value) throws Exception { perform("write", store -> { store.put(key, value); return null; }); }
    void removeTemporary(String key) throws Exception { perform("remove", store -> { store.removeTemporary(key); return null; }); }
    private <T> T perform(String operation, Action<T> action) throws Exception {
        synchronized (GuguAuthStoragePlugin.STORAGE_LOCK) {
            try {
                return action.run(new AuthStorageMigration(GuguAuthStoragePlugin.STORAGE_LOCK,
                    new AndroidAuthRecords(context), legacy(), AndroidAuthStore::ownerOf));
            } catch (Exception error) {
                AuthStorageFailure failure = error instanceof AuthStorageFailure ? (AuthStorageFailure) error
                    : new AuthStorageFailure(error instanceof java.security.GeneralSecurityException ? "key_unavailable" : "persistence_unavailable",
                        error instanceof java.security.GeneralSecurityException);
                // Fixed reason codes only. Never log raw exception messages/causes or stored values.
                Log.e("GuguAuthStorage", "auth_storage_failure operation=" + operation + " reason=" + failure.reason);
                throw failure;
            }
        }
    }
    static String ownerOf(String value) throws Exception {
        if (value == null) return null;
        try {
            JSONObject envelope = new JSONObject(value);
            if ("RETIRED_EMPTY".equals(envelope.optString("state")) && envelope.length() == 1) return null;
            if (!"SESSION".equals(envelope.optString("state")) || envelope.length() != 2
                || !(envelope.get("raw") instanceof String)) throw new IllegalArgumentException();
            JSONObject session = new JSONObject(envelope.getString("raw"));
            if (!(session.get("access_token") instanceof String) || session.getString("access_token").isEmpty()
                || !(session.get("refresh_token") instanceof String) || session.getString("refresh_token").isEmpty()) throw new IllegalArgumentException();
            return GuguAgentHostPolicy.owner(session.getJSONObject("user").getString("id"));
        } catch (Exception invalid) { throw new AuthStorageFailure("legacy_envelope_invalid", true); }
    }
    private AuthStorageMigration.Legacy legacy() {
        return new AuthStorageMigration.Legacy() {
            private File preference() throws Exception {
                return new File(new File(context.getApplicationInfo().dataDir).getCanonicalFile(), "shared_prefs/" + LEGACY + ".xml");
            }
            private File backup() throws Exception { return new File(preference().getPath() + ".bak"); }
            @Override public Map<String, String> read() throws Exception {
                ProtectedFile.path(preference()); ProtectedFile.path(backup());
                // Android restores .bak first. Parse that same source before its loader can
                // turn malformed XML into a successful empty preference map.
                File disk = backup().exists() ? backup() : preference();
                Map<String, String> expected = LegacyAuthXml.read(ProtectedFile.read(disk, AuthStorageRecord.MAX_BYTES));
                SharedPreferences source = context.getSharedPreferences(LEGACY, Context.MODE_PRIVATE);
                Map<String, String> values = new LinkedHashMap<>();
                for (String key : AuthStorageRecord.KEYS) {
                    if (source.contains(key)) {
                        Object value = source.getAll().get(key);
                        if (!(value instanceof String)) throw new AuthStorageFailure("legacy_value_invalid", true);
                        values.put(key, (String) value);
                    }
                }
                if (!expected.equals(values)) throw new AuthStorageFailure("legacy_readback_mismatch", true);
                return values;
            }
            @Override public void clear() throws Exception {
                ProtectedFile.path(preference()); ProtectedFile.path(backup());
                SharedPreferences source = context.getSharedPreferences(LEGACY, Context.MODE_PRIVATE);
                if (!preference().exists() && !backup().exists() && source.getAll().isEmpty()) return;
                // Clear the cached preference object before deleting its physical XML/.bak.
                if (!source.edit().clear().commit()) throw new AuthStorageFailure("legacy_clear_failed", false);
                if (!context.deleteSharedPreferences(LEGACY) || preference().exists() || backup().exists()
                    || !source.getAll().isEmpty()) throw new AuthStorageFailure("legacy_delete_failed", false);
                File directory = preference().getParentFile();
                if (directory.isDirectory()) ProtectedFile.sync(directory);
            }
        };
    }
}
