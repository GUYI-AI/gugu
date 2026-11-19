package app.gugu.chat;

import android.content.Context;
import android.content.SharedPreferences;
import org.json.JSONObject;
import java.util.ArrayList;
import java.util.List;

/** Every caller holds the existing native main-auth commit lock. */
final class AccountClosureAuthSlot {
    private final SharedPreferences storage;
    AccountClosureAuthSlot(Context context) { storage = context.getSharedPreferences("gugu-auth-storage", Context.MODE_PRIVATE); }
    String owner() throws Exception { return ownerOf(storage.getString("sb-main", null)); }
    static String ownerOf(String value) throws Exception {
        if (value == null) return null;
        JSONObject envelope = new JSONObject(value);
        if ("RETIRED_EMPTY".equals(envelope.optString("state")) && envelope.length() == 1) return null;
        if (!"SESSION".equals(envelope.optString("state")) || envelope.length() != 2) throw new AccountClosureReceiptStore.Failure("closure_storage_unavailable");
        JSONObject session = new JSONObject(envelope.getString("raw"));
        JSONObject user = session.getJSONObject("user");
        return GuguAgentHostPolicy.owner(user.getString("id"));
    }
    void eraseIfOwned(String owner) throws Exception {
        if (!owner.equals(owner())) return;
        // A retirement envelope also prevents the existing legacy fallback
        // reader from importing an old WebView authentication value again.
        if (!storage.edit().putString("sb-main", new JSONObject().put("state", "RETIRED_EMPTY").toString()).commit())
            throw new AccountClosureReceiptStore.Failure("closure_storage_unavailable");
    }
    List<String> unattributed() throws Exception {
        List<String> names = new ArrayList<>();
        if (storage.contains("sb-main-code-verifier")) names.add("auth-code-verifier");
        if (storage.contains("sb-main-oauth-pending")) names.add("auth-oauth-pending");
        return names;
    }
}
