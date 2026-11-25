package app.gugu.chat;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;

/** Version/purpose/package/install/owner authenticated; temporary pre-login values need no owner. */
final class AuthStorageRecord {
    static final int MAX_BYTES = 4 * 1024 * 1024;
    static final String[] KEYS = { "sb-main", "sb-main-code-verifier", "sb-main-oauth-pending" };
    interface Owner { String of(String envelope) throws Exception; }
    private final String context;
    private final GcmRecord.Keys keys;
    private final Owner owner;
    AuthStorageRecord(String application, String installation, GcmRecord.Keys keys, Owner owner) {
        context = "gugu-auth-storage\u00001\u0000" + application + "\u0000" + installation + "\u0000";
        this.keys = keys; this.owner = owner;
    }
    byte[] encrypt(Map<String, String> values) throws Exception {
        validate(values);
        String binding = binding(values);
        ByteArrayOutputStream plain = new ByteArrayOutputStream();
        DataOutputStream output = new DataOutputStream(plain);
        for (String key : KEYS) {
            String value = values.get(key); output.writeBoolean(value != null);
            if (value != null) writeString(output, value);
        }
        byte[] encrypted = GcmRecord.encrypt(plain.toByteArray(), aad(binding), keys);
        ByteArrayOutputStream bytes = new ByteArrayOutputStream(); output = new DataOutputStream(bytes);
        output.writeInt(1); writeString(output, binding); output.write(encrypted);
        if (bytes.size() > MAX_BYTES) throw new AuthStorageFailure("record_too_large", false);
        return bytes.toByteArray();
    }
    Map<String, String> decrypt(byte[] bytes) throws Exception {
        try {
            if (bytes.length > MAX_BYTES) throw new IllegalArgumentException();
            DataInputStream input = new DataInputStream(new ByteArrayInputStream(bytes));
            if (input.readInt() != 1) throw new IllegalArgumentException();
            String binding = readString(input, 36);
            if (!binding.isEmpty() && !binding.matches("[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}")) throw new IllegalArgumentException();
            byte[] encrypted = new byte[input.available()]; input.readFully(encrypted);
            byte[] plain = GcmRecord.decrypt(encrypted, aad(binding), keys);
            input = new DataInputStream(new ByteArrayInputStream(plain));
            Map<String, String> values = new LinkedHashMap<>();
            for (String key : KEYS) if (input.readBoolean()) values.put(key, readString(input, MAX_BYTES));
            if (input.available() != 0 || !binding.equals(binding(values))) throw new IllegalArgumentException();
            validate(values);
            return values;
        } catch (AuthStorageFailure error) { throw error; }
        catch (Exception error) { throw new AuthStorageFailure("record_unreadable", true); }
    }
    void validate(Map<String, String> values) throws Exception {
        for (Map.Entry<String, String> entry : values.entrySet()) {
            if (!AuthStorageKeys.isAllowed(entry.getKey()) || entry.getValue() == null) throw new AuthStorageFailure("record_invalid", true);
        }
        binding(values);
    }
    private String binding(Map<String, String> values) throws Exception {
        String result = owner.of(values.get("sb-main"));
        return result == null ? "" : result;
    }
    private byte[] aad(String binding) { return (context + binding).getBytes(StandardCharsets.UTF_8); }
    private static void writeString(DataOutputStream output, String text) throws Exception {
        byte[] value = text.getBytes(StandardCharsets.UTF_8);
        if (value.length > MAX_BYTES) throw new AuthStorageFailure("record_too_large", false);
        output.writeInt(value.length); output.write(value);
    }
    private static String readString(DataInputStream input, int limit) throws Exception {
        int size = input.readInt();
        if (size < 0 || size > limit || size > input.available()) throw new IllegalArgumentException();
        byte[] bytes = new byte[size]; input.readFully(bytes);
        return new String(bytes, StandardCharsets.UTF_8);
    }
}
