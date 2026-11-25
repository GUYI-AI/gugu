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
import java.nio.file.Files;
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
        String bytes = new String(Files.readAllBytes(encrypted().toPath()), StandardCharsets.ISO_8859_1);
        assertFalse(bytes.contains("PRIVATE_NATIVE_"));
        assertEquals(0600, Os.stat(encrypted().getPath()).st_mode & 0777);
        assertEquals(0700, Os.stat(encrypted().getParent()).st_mode & 0777);
        assertFalse(legacyXml().exists()); assertFalse(new File(legacyXml().getPath() + ".bak").exists());
    }
    @Test public void corruptCiphertextPreservesEvidenceAndDoesNotImportRestoredPlaintext() throws Exception {
        AndroidAuthStore store = new AndroidAuthStore(context); store.put("sb-main", envelope());
        byte[] bad = Files.readAllBytes(encrypted().toPath()); bad[bad.length - 1] ^= 1;
        Files.write(encrypted().toPath(), bad);
        String stale = envelope();
        assertTrue(context.getSharedPreferences(LEGACY, 0).edit().putString("sb-main", stale).commit());
        try { new AndroidAuthStore(context).get("sb-main"); fail("Corruption became absence"); }
        catch (AuthStorageFailure failure) { assertTrue(failure.recovery); assertNull(failure.getCause()); }
        assertArrayEquals(bad, Files.readAllBytes(encrypted().toPath()));
        assertEquals(stale, context.getSharedPreferences(LEGACY, 0).getString("sb-main", null));
    }
    @Test public void malformedLegacyXmlIsNotConvertedIntoAnEmptySignedOutRecord() throws Exception {
        assertTrue(legacyXml().getParentFile().isDirectory() || legacyXml().getParentFile().mkdirs());
        byte[] bad = "<map><string name=\"sb-main\">PRIVATE_BROKEN_CANARY".getBytes(StandardCharsets.UTF_8);
        Files.write(legacyXml().toPath(), bad);
        try { new AndroidAuthStore(context).get("sb-main"); fail("Malformed XML became a successful empty map"); }
        catch (AuthStorageFailure failure) { assertEquals("legacy_xml_invalid", failure.reason); }
        assertArrayEquals(bad, Files.readAllBytes(legacyXml().toPath()));
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
}
