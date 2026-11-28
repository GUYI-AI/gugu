package app.gugu.chat;

import android.content.Context;
import org.json.JSONObject;
import java.util.ArrayList;
import java.util.List;

/** Every caller holds the existing native main-auth commit lock. */
final class AccountClosureAuthSlot {
    private final AndroidAuthStore storage;
    AccountClosureAuthSlot(Context context) { storage = new AndroidAuthStore(context); }
    String owner() throws Exception { return ownerOf(storage.get("sb-main")); }
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
        storage.put("sb-main", new JSONObject().put("state", "RETIRED_EMPTY").toString());
    }
    List<String> unattributed() throws Exception {
        List<String> names = new ArrayList<>();
        if (storage.get("sb-main-code-verifier") != null) names.add("auth-code-verifier");
        if (storage.get("sb-main-oauth-pending") != null) names.add("auth-oauth-pending");
        return names;
    }
}
