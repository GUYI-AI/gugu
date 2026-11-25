package app.gugu.chat;

import android.content.Context;
import android.content.ContextWrapper;
import android.content.SharedPreferences;
import android.system.Os;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;
import org.junit.runner.RunWith;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import static org.junit.Assert.*;

/** Real platform Keystore and real preference XML; only synthetic values on a clean test target. */
@RunWith(AndroidJUnit4.class)
public class AndroidAuthStoreTest {
    private static final String LEGACY = "gugu-auth-storage";
    @Rule public final TemporaryFolder temporary = new TemporaryFolder(
        InstrumentationRegistry.getInstrumentation().getTargetContext().getCacheDir());
    private Context context;
    private String prefix;
    @Before public void prepare() throws Exception {
        Context target = InstrumentationRegistry.getInstrumentation().getTargetContext();
        // Never replace an existing user's login if someone misdirects instrumentation.
        assertTrue("Use a clean test installation", target.getSharedPreferences(LEGACY, 0).getAll().isEmpty());
        File noBackup = temporary.newFolder("no-backup").getCanonicalFile();
        prefix = "auth-store-test-" + UUID.randomUUID() + "-";
        context = new ContextWrapper(target) {
            @Override public File getNoBackupFilesDir() { return noBackup; }
            @Override public SharedPreferences getSharedPreferences(String name, int mode) {
                return super.getSharedPreferences(LEGACY.equals(name) ? name : prefix + name, mode);
            }
            @Override public boolean deleteSharedPreferences(String name) {
                return super.deleteSharedPreferences(LEGACY.equals(name) ? name : prefix + name);
            }
        };
    }
    @After public void cleanup() {
        if (context != null) {
            assertTrue(context.deleteSharedPreferences(LEGACY));
            context.deleteSharedPreferences("phone-agent-grants");
        }
    }
    private String envelope() throws Exception {
        return new JSONObject().put("state", "SESSION").put("raw", new JSONObject()
            .put("access_token", "PRIVATE_NATIVE_ACCESS_CANARY").put("refresh_token", "PRIVATE_NATIVE_REFRESH_CANARY")
            .put("user", new JSONObject().put("id", UUID.randomUUID().toString())).toString()).toString();
    }
    private File encrypted() { return new File(context.getNoBackupFilesDir(), "gugu-auth/state.enc"); }
    private File legacyXml() { return new File(context.getApplicationInfo().dataDir, "shared_prefs/" + LEGACY + ".xml"); }
    @Test public void migratesRealXmlWithKeystoreAndColdReopensWithoutPlaintext() throws Exception {
        String original = envelope();
        assertTrue(context.getSharedPreferences(LEGACY, 0).edit().putString("sb-main", original)
            .putString("sb-main-code-verifier", "PRIVATE_NATIVE_PKCE_CANARY&<中文").commit());
        assertTrue(legacyXml().isFile());
        assertEquals(original, new AndroidAuthStore(context).get("sb-main"));
        assertEquals(original, new AndroidAuthStore(context).get("sb-main"));
        assertEquals("PRIVATE_NATIVE_PKCE_CANARY&<中文", new AndroidAuthStore(context).get("sb-main-code-verifier"));
        String bytes = new String(NativeTestFiles.read(encrypted()), StandardCharsets.ISO_8859_1);
        assertFalse(bytes.contains("PRIVATE_NATIVE_"));
        assertEquals(0600, Os.stat(encrypted().getPath()).st_mode & 0777);
        assertEquals(0700, Os.stat(encrypted().getParent()).st_mode & 0777);
        assertFalse(legacyXml().exists()); assertFalse(new File(legacyXml().getPath() + ".bak").exists());
    }
    @Test public void corruptCiphertextPreservesEvidenceAndDoesNotImportRestoredPlaintext() throws Exception {
        AndroidAuthStore store = new AndroidAuthStore(context); store.put("sb-main", envelope());
        byte[] bad = NativeTestFiles.read(encrypted()); bad[bad.length - 1] ^= 1;
        NativeTestFiles.write(encrypted(), bad);
        String stale = envelope();
        assertTrue(context.getSharedPreferences(LEGACY, 0).edit().putString("sb-main", stale).commit());
        try { new AndroidAuthStore(context).get("sb-main"); fail("Corruption became absence"); }
        catch (AuthStorageFailure failure) { assertTrue(failure.recovery); assertNull(failure.getCause()); }
        assertArrayEquals(bad, NativeTestFiles.read(encrypted()));
        assertEquals(stale, context.getSharedPreferences(LEGACY, 0).getString("sb-main", null));
    }
    @Test public void malformedLegacyXmlIsNotConvertedIntoAnEmptySignedOutRecord() throws Exception {
        assertTrue(legacyXml().getParentFile().isDirectory() || legacyXml().getParentFile().mkdirs());
        byte[] bad = "<map><string name=\"sb-main\">PRIVATE_BROKEN_CANARY".getBytes(StandardCharsets.UTF_8);
        NativeTestFiles.write(legacyXml(), bad);
        try { new AndroidAuthStore(context).get("sb-main"); fail("Malformed XML became a successful empty map"); }
        catch (AuthStorageFailure failure) { assertEquals("legacy_xml_invalid", failure.reason); }
        assertArrayEquals(bad, NativeTestFiles.read(legacyXml()));
        assertFalse(encrypted().exists());
    }
    @Test public void missingCommittedRecordCannotResurrectLegacyAndRetirementWinsAfterReopen() throws Exception {
        AndroidAuthStore store = new AndroidAuthStore(context); store.put("sb-main", envelope());
        store.put("sb-main", "{\"state\":\"RETIRED_EMPTY\"}");
        assertTrue(context.getSharedPreferences(LEGACY, 0).edit().putString("sb-main", envelope()).commit());
        assertEquals("{\"state\":\"RETIRED_EMPTY\"}", new AndroidAuthStore(context).get("sb-main"));
        assertFalse(legacyXml().exists());
        assertTrue(encrypted().delete());
        String stale = envelope();
        assertTrue(context.getSharedPreferences(LEGACY, 0).edit().putString("sb-main", stale).commit());
        try { new AndroidAuthStore(context).get("sb-main"); fail("A committed record disappeared silently"); }
        catch (AuthStorageFailure failure) { assertEquals("record_missing", failure.reason); }
        assertEquals(stale, context.getSharedPreferences(LEGACY, 0).getString("sb-main", null));
    }
    @Test public void explicitReloginReplacesOnlyBrokenAuthAndRejectsStaleRecoveryTicket() throws Exception {
        AndroidAuthStore store = new AndroidAuthStore(context); store.put("sb-main", envelope());
        byte[] bad = NativeTestFiles.read(encrypted()); bad[bad.length - 1] ^= 1; NativeTestFiles.write(encrypted(), bad);
        AndroidAuthRecovery.State observed = AndroidAuthRecovery.inspect(context);
        assertTrue(observed.canReset);
        File unrelated = new File(context.getNoBackupFilesDir(), "keep-host-evidence");
        NativeTestFiles.write(unrelated, "KEEP".getBytes(StandardCharsets.UTF_8));
        AndroidAuthRecovery.reset(context, observed.revision);
        assertEquals("{\"state\":\"RETIRED_EMPTY\"}", new AndroidAuthStore(context).get("sb-main"));
        assertEquals("KEEP", new String(NativeTestFiles.read(unrelated), StandardCharsets.UTF_8));
        assertFalse(new File(encrypted().getParentFile(), "relogin-reset.v1").exists());
        String next = envelope(); new AndroidAuthStore(context).put("sb-main", next);
        try { AndroidAuthRecovery.reset(context, observed.revision); fail("Stale UI discarded new login"); }
        catch (AuthStorageFailure failure) { assertFalse(failure.recovery); }
        assertEquals(next, new AndroidAuthStore(context).get("sb-main"));
    }
    @Test public void missingKeyNeedsConsentAndClosureEvidenceBlocksReset() throws Exception {
        new AndroidAuthStore(context).put("sb-main", envelope());
        java.security.KeyStore keys = java.security.KeyStore.getInstance("AndroidKeyStore"); keys.load(null);
        keys.deleteEntry("gugu-auth-storage-v1");
        byte[] before = NativeTestFiles.read(encrypted());
        AndroidAuthRecovery.State observed = AndroidAuthRecovery.inspect(context);
        assertTrue(observed.canReset); assertArrayEquals(before, NativeTestFiles.read(encrypted()));
        assertFalse(keys.containsAlias("gugu-auth-storage-v1"));
        File closure = new File(context.getNoBackupFilesDir(), "account-closure"); assertTrue(closure.mkdir());
        File receipt = new File(closure, "retained.enc"); NativeTestFiles.write(receipt, new byte[] {1, 2, 3});
        assertFalse(AndroidAuthRecovery.inspect(context).canReset);
        try { AndroidAuthRecovery.reset(context, observed.revision); fail("Unfinished closure was erased"); }
        catch (AuthStorageFailure failure) { assertEquals("closure_recovery_pending", failure.reason); }
        assertArrayEquals(before, NativeTestFiles.read(encrypted())); assertArrayEquals(new byte[] {1, 2, 3}, NativeTestFiles.read(receipt));
        assertTrue(receipt.delete()); assertTrue(closure.delete());
        AndroidAuthRecovery.reset(context, observed.revision);
        assertEquals("{\"state\":\"RETIRED_EMPTY\"}", new AndroidAuthStore(context).get("sb-main"));
    }
    @Test public void interruptedUserResetResumesBeforeAnyLegacyImport() throws Exception {
        assertTrue(context.getSharedPreferences(LEGACY, 0).edit().putString("sb-main", envelope()).commit());
        File root = new File(context.getNoBackupFilesDir(), "gugu-auth"); ProtectedFile.directory(root);
        ProtectedFile.write(new File(root, "relogin-reset.v1"), "gugu-auth-user-relogin-v1\n".getBytes(StandardCharsets.US_ASCII));
        assertEquals("{\"state\":\"RETIRED_EMPTY\"}", new AndroidAuthStore(context).get("sb-main"));
        assertFalse(legacyXml().exists()); assertFalse(new File(root, "relogin-reset.v1").exists());
    }

}
