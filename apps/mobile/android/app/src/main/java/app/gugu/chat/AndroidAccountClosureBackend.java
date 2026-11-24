package app.gugu.chat;

import android.content.Context;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;

/** Reads only the build's public backend configuration. No renderer target or token. */
final class AndroidAccountClosureBackend {
    static AccountClosureHttp.Configuration load(Context context) throws Exception {
        try (InputStream input = context.getAssets().open("GuguBackend.json")) {
            ByteArrayOutputStream bytes = new ByteArrayOutputStream();
            byte[] buffer = new byte[4096]; int count;
            while ((count = input.read(buffer)) != -1) {
                if (bytes.size() + count > 32768) throw new IllegalArgumentException();
                bytes.write(buffer, 0, count);
            }
            JSONObject config = new JSONObject(new String(bytes.toByteArray(), StandardCharsets.UTF_8));
            if (config.length() != 3 || config.getInt("version") != 1) throw new IllegalArgumentException();
            String key = config.getString("anonKey");
            if (!key.startsWith("sb_publishable_")) {
                String[] parts = key.split("\\.", -1);
                if (parts.length != 3) throw new IllegalArgumentException();
                JSONObject claims = new JSONObject(new String(android.util.Base64.decode(parts[1],
                    android.util.Base64.URL_SAFE | android.util.Base64.NO_WRAP), StandardCharsets.UTF_8));
                if (!"anon".equals(claims.getString("role"))) throw new IllegalArgumentException();
            }
            return new AccountClosureHttp.Configuration(config.getString("supabaseUrl"), key);
        } catch (Exception invalid) { throw new AccountClosureReceiptStore.Failure("backend_not_configured"); }
    }
}
