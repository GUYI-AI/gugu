package app.gugu.chat;

import org.junit.Test;
import javax.crypto.Cipher;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.Map;
import static org.junit.Assert.*;

/** Real JVM AES-GCM and product record codec; not an Android Keystore test. */
public class AuthStorageRecordTest {
    private static final String OWNER = "12345678-1234-1234-1234-123456789abc";
    private static final SecretKey KEY = new SecretKeySpec(new byte[32], "AES");
    private static final AuthStorageRecord.Owner OWNER_OF = value -> value == null || value.equals("retired") ? null : OWNER;
    private static AuthStorageRecord codec(String application, String installation, SecretKey key) {
        return new AuthStorageRecord(application, installation, create -> key, OWNER_OF);
    }
    private static Map<String, String> values() {
        Map<String, String> values = new LinkedHashMap<>();
        values.put("sb-main", "PRIVATE_ACCESS_REFRESH_CANARY_凭据\n{ raw preserved }");
        values.put("sb-main-code-verifier", "PRIVATE_PKCE_CANARY");
        values.put("sb-main-oauth-pending", "PRIVATE_PENDING_CANARY");
        return values;
    }
    private static void unreadable(AuthStorageRecord record, byte[] bytes) throws Exception {
        try { record.decrypt(bytes); fail("Unauthenticated record accepted"); }
        catch (AuthStorageFailure expected) { assertTrue(expected.recovery); assertNull(expected.getCause()); }
    }
    @Test public void randomizedEncryptionPreservesAllValuesAndDoesNotStorePlaintext() throws Exception {
        AuthStorageRecord record = codec("app.gugu.chat", "install-a", KEY); Map<String, String> values = values();
        byte[] first = record.encrypt(values), second = record.encrypt(values);
        assertFalse(Arrays.equals(first, second)); assertEquals(values, record.decrypt(first));
        assertEquals(values, codec("app.gugu.chat", "install-a", KEY).decrypt(second));
        String disk = new String(first, StandardCharsets.ISO_8859_1);
        for (String value : values.values()) assertFalse(disk.contains(value));
        assertFalse(disk.contains("PRIVATE_ACCESS_REFRESH_CANARY"));
    }
    @Test public void packageInstallationKeyVersionOwnerAndCiphertextAreAuthenticated() throws Exception {
        AuthStorageRecord record = codec("app.gugu.chat", "install-a", KEY); byte[] original = record.encrypt(values());
        unreadable(codec("app.gugu.chat.beta", "install-a", KEY), original);
        unreadable(codec("app.gugu.chat", "install-b", KEY), original);
        byte[] other = new byte[32]; other[0] = 1;
        unreadable(codec("app.gugu.chat", "install-a", new SecretKeySpec(other, "AES")), original);
        for (int position : new int[] {3, 8, original.length - 1}) {
            byte[] bad = original.clone(); bad[position] ^= 1; unreadable(record, bad);
        }
        unreadable(new AuthStorageRecord("app.gugu.chat", "install-a", create -> KEY, value -> null), original);
        for (int size : new int[] {0, 1, 7, 28}) unreadable(record, Arrays.copyOf(original, size));
        unreadable(record, Arrays.copyOf(original, original.length + 1));
    }
    @Test public void readingAMissingKeyNeverRequestsGeneration() throws Exception {
        byte[] original = codec("app.gugu.chat", "install-a", KEY).encrypt(values());
        int[] reads = {0};
        AuthStorageRecord missing = new AuthStorageRecord("app.gugu.chat", "install-a", create -> {
            assertFalse("A read requested key generation", create); reads[0]++;
            throw new AuthStorageFailure("key_missing", true);
        }, OWNER_OF);
        unreadable(missing, original); assertEquals(1, reads[0]);
    }
    @Test public void preloginAndRetiredRecordsRemainDistinctFromPhysicalAbsence() throws Exception {
        AuthStorageRecord record = codec("app.gugu.chat", "install-a", KEY);
        Map<String, String> prelogin = new LinkedHashMap<>(); prelogin.put("sb-main-code-verifier", "verifier");
        assertEquals(prelogin, record.decrypt(record.encrypt(prelogin)));
        prelogin.put("sb-main", "retired"); assertEquals(prelogin, record.decrypt(record.encrypt(prelogin)));
        assertEquals(new LinkedHashMap<>(), record.decrypt(record.encrypt(new LinkedHashMap<>())));
    }
    @Test public void existingHostWireFormatStillDecryptsWithItsOriginalOwnerAad() throws Exception {
        byte[] iv = new byte[12], plain = "old host credentials".getBytes(StandardCharsets.UTF_8);
        byte[] aad = OWNER.getBytes(StandardCharsets.UTF_8);
        Cipher original = Cipher.getInstance("AES/GCM/NoPadding");
        original.init(Cipher.ENCRYPT_MODE, KEY, new GCMParameterSpec(128, iv)); original.updateAAD(aad);
        byte[] cipher = original.doFinal(plain);
        byte[] fixture = ByteBuffer.allocate(13 + cipher.length).put((byte) 12).put(iv).put(cipher).array();
        assertArrayEquals(plain, GcmRecord.decrypt(fixture, aad, create -> { assertFalse(create); return KEY; }));
    }
    @Test public void unknownKeysAndOversizedValuesAreRejectedWithoutTruncation() throws Exception {
        AuthStorageRecord record = codec("app.gugu.chat", "install-a", KEY);
        Map<String, String> invalid = values(); invalid.put("other", "secret");
        try { record.encrypt(invalid); fail(); } catch (AuthStorageFailure expected) { }
        invalid = values(); char[] chars = new char[AuthStorageRecord.MAX_BYTES + 1]; Arrays.fill(chars, 'x');
        invalid.put("sb-main-code-verifier", new String(chars));
        try { record.encrypt(invalid); fail(); } catch (AuthStorageFailure expected) { assertEquals("record_too_large", expected.reason); }
    }
}
