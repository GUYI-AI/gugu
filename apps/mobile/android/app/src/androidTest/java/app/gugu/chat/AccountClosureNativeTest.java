package app.gugu.chat;

import android.content.Context;
import android.content.ContextWrapper;
import android.content.SharedPreferences;
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
import java.util.HashSet;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import static org.junit.Assert.*;

/** Real Android Keystore/auth/files, test-only namespaces, no network or real account. */
@RunWith(AndroidJUnit4.class)
public class AccountClosureNativeTest {
    @Rule public final TemporaryFolder temporary = new TemporaryFolder(
        InstrumentationRegistry.getInstrumentation().getTargetContext().getCacheDir());
    private Context context;
    private String a, b, prefix;
    private interface Attempt { void run() throws Exception; }
    private static void reject(String code, Attempt run) throws Exception {
        try { run.run(); fail("Expected a native refusal"); }
        catch (AccountClosureReceiptStore.Failure failure) { assertEquals(code, failure.code); }
    }
    @Before public void prepare() throws Exception {
        a = UUID.randomUUID().toString(); b = UUID.randomUUID().toString(); prefix = "closure-test-" + a + "-";
        File files = temporary.newFolder("files").getCanonicalFile();
        File backup = temporary.newFolder("no-backup").getCanonicalFile();
        File cache = temporary.newFolder("cache").getCanonicalFile();
        context = new ContextWrapper(InstrumentationRegistry.getInstrumentation().getTargetContext()) {
            @Override public Context getApplicationContext() { return this; }
            @Override public File getFilesDir() { return files; }
            @Override public File getNoBackupFilesDir() { return backup; }
            @Override public File getCacheDir() { return cache; }
            @Override public SharedPreferences getSharedPreferences(String name, int mode) { return super.getSharedPreferences(prefix + name, mode); }
        };
        signIn(a);
    }
    @After public void cleanup() {
        for (String name : new String[] {"gugu-auth-storage", "phone-agent-grants"})
            assertTrue(context.getSharedPreferences(name, Context.MODE_PRIVATE).edit().clear().commit());
    }
    private SharedPreferences auth() { return context.getSharedPreferences("gugu-auth-storage", Context.MODE_PRIVATE); }
    private String envelope(String owner) throws Exception {
        return new JSONObject().put("state", "SESSION").put("raw", new JSONObject()
            .put("user", new JSONObject().put("id", owner)).toString()).toString();
    }
    private void signIn(String owner) throws Exception { assertTrue(auth().edit().putString("sb-main", envelope(owner)).commit()); }
    private AccountClosureReceiptStore.Scope scope(String operation) throws Exception { return new AccountClosureReceiptStore.Scope(a, operation); }
    private void ready(AndroidAccountClosure closure) throws Exception {
        closure.prepareSignOut(a).get(5, TimeUnit.SECONDS);
        // Local acknowledgement only: SDK/HTTP device removal is not exercised here.
        closure.retireDevice(a, closure.deviceId(a));
    }
    private static File write(File base, String relative, String value) throws Exception {
        File file = new File(base, relative); assertTrue(file.getParentFile().isDirectory() || file.getParentFile().mkdirs());
        Files.write(file.toPath(), value.getBytes(StandardCharsets.UTF_8)); return file;
    }
    private static String read(File file) throws Exception { return new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8); }
    private Set<String> protectedNames() {
        String[] names = new File(context.getNoBackupFilesDir(), "account-closure").list();
        Set<String> result = new HashSet<>(); if (names != null) java.util.Collections.addAll(result, names); return result;
    }
    @Test public void keystoreReceiptSurvivesRecreationWithoutPlaintextFallback() throws Exception {
        AndroidAccountClosure first = new AndroidAccountClosure(context); ready(first);
        AccountClosureReceiptStore.Scope scope = scope("opaque/../stable operation"); String receipt = "opaque-proof-" + UUID.randomUUID();
        first.receipts.put(scope, receipt);
        assertEquals(receipt, new AndroidAccountClosure(context).receipts.get(scope));
        for (String name : protectedNames()) assertFalse(read(new File(context.getNoBackupFilesDir(), "account-closure/" + name)).contains(receipt));
        assertFalse(auth().getAll().toString().contains(receipt));
        reject("closure_context_missing", () -> first.receipts.get(scope("never-captured")));
    }
    @Test public void erasesOnlyAAndPreservesBInstallationAndUnattributedFiles() throws Exception {
        AndroidAccountClosure closure = new AndroidAccountClosure(context); String installation = GuguPhoneInstallation.identity(context).key;
        SharedPreferences grants = context.getSharedPreferences("phone-agent-grants", Context.MODE_PRIVATE);
        assertTrue(grants.edit().putString("owner", b).putBoolean("enabled", true).commit());
        ready(closure); AccountClosureReceiptStore.Scope scope = scope("close-A"); closure.receipts.put(scope, "opaque-A");
        File own = write(context.getFilesDir(), "phone-agent/" + a + "/state.json", "A");
        File other = write(context.getFilesDir(), "phone-agent/" + b + "/state.json", "B state");
        write(context.getNoBackupFilesDir(), "phone-agent-host/" + a + "/config.enc", "A credentials");
        File otherHost = write(context.getNoBackupFilesDir(), "phone-agent-host/" + b + "/config.enc", "B credentials");
        write(context.getNoBackupFilesDir(), "phone-agent-runtime/" + a + "/hosts/ledger", "A ledger");
        File otherLedger = write(context.getNoBackupFilesDir(), "phone-agent-runtime/" + b + "/hosts/ledger", "B ledger");
        File shared = write(context.getCacheDir(), "share-in/export", "unattributed export");
        AccountClosureReceiptStore.Outcome result = closure.erase(scope);
        assertEquals("complete", result.status); assertTrue(result.retainedUnattributed.contains("shared-incoming-file-cache"));
        assertFalse(own.exists()); assertEquals("B state", read(other)); assertEquals("B credentials", read(otherHost));
        assertEquals("B ledger", read(otherLedger)); assertEquals("unattributed export", read(shared));
        assertEquals(b, grants.getString("owner", null)); assertTrue(grants.getBoolean("enabled", false));
        assertEquals(installation, GuguPhoneInstallation.identity(context).key);
        assertEquals("RETIRED_EMPTY", new JSONObject(auth().getString("sb-main", "")).getString("state"));
        assertEquals("opaque-A", closure.receipts.get(scope)); closure.receipts.remove(scope); assertNull(closure.receipts.get(scope));
        assertEquals("complete", closure.erase(scope).status);
    }
    @Test public void switchingToBRejectsEveryOperationUsingAsScope() throws Exception {
        AndroidAccountClosure closure = new AndroidAccountClosure(context); ready(closure);
        AccountClosureReceiptStore.Scope scope = scope("captured-A"); closure.receipts.put(scope, "opaque-A"); signIn(b);
        String before = auth().getString("sb-main", null);
        reject("wrong_local_owner", () -> closure.receipts.get(scope));
        reject("wrong_local_owner", () -> closure.receipts.remove(scope));
        reject("wrong_local_owner", () -> closure.erase(scope));
        reject("wrong_local_owner", () -> closure.prepareSignOut(a));
        assertEquals(before, auth().getString("sb-main", null));
    }
    @Test public void unpreparedReceiptIsCapturedButCannotEraseAnyData() throws Exception {
        AndroidAccountClosure closure = new AndroidAccountClosure(context); AccountClosureReceiptStore.Scope scope = scope("unprepared");
        File data = write(context.getFilesDir(), "phone-agent/" + a + "/state.json", "A");
        closure.receipts.put(scope, "opaque-before-prepare"); assertEquals("opaque-before-prepare", closure.receipts.get(scope));
        reject("closure_not_prepared", () -> closure.erase(scope)); assertEquals("A", read(data));
    }
    @Test public void cancellationCannotReleaseALaterGenerationOrRestartAnAgent() throws Exception {
        AndroidAccountClosure closure = new AndroidAccountClosure(context); ready(closure);
        AccountClosureReceiptStore.Scope old = scope("old"); closure.receipts.put(old, "opaque-old"); closure.receipts.remove(old);
        closure.cancelPreparation(old); AccountClosurePreparation.requireOpen(context, a);
        assertFalse(GuguAgentHostService.ownerIsBusy(a)); assertFalse(GuguAgentService.ownerIsBusy(a));
        ready(closure); reject("scope_conflict", () -> closure.cancelPreparation(old));
        reject("closure_not_prepared", () -> AccountClosurePreparation.requireOpen(context, a));
        AccountClosurePreparation preparation = new AccountClosurePreparation(context);
        preparation.set(a, AccountClosurePreparation.ERASING);
        reject("closure_not_prepared", () -> AccountClosurePreparation.requireWritableState(context, a));
        reject("closure_not_prepared", () -> AccountClosurePreparation.requireAuthWrite(context, envelope(a)));
        AccountClosurePreparation.requireAuthWrite(context, envelope(b));
    }
    @Test public void anotherOwnersNativeRuntimeClaimsSurviveAsPreparationAndErase() throws Exception {
        AndroidAccountClosure closure = new AndroidAccountClosure(context);
        GuguAgentHostService.reserveOwner(b); assertTrue(GuguAgentService.claim(b));
        try {
            assertTrue(GuguAgentHostService.ownerIsBusy(b)); assertTrue(GuguAgentService.ownerIsBusy(b));
            ready(closure); AccountClosureReceiptStore.Scope scope = scope("only-A"); closure.receipts.put(scope, "opaque-A");
            assertEquals("complete", closure.erase(scope).status);
            assertTrue(GuguAgentHostService.ownerIsBusy(b)); assertTrue(GuguAgentService.ownerIsBusy(b));
        } finally { GuguAgentHostService.releaseReservation(b); GuguAgentService.release(); }
    }
    @Test public void corruptCiphertextRejectsWithoutReplacingItOrReturningNull() throws Exception {
        AndroidAccountClosure closure = new AndroidAccountClosure(context); ready(closure); Set<String> before = protectedNames();
        AccountClosureReceiptStore.Scope scope = scope("corrupt"); closure.receipts.put(scope, "opaque-corrupt");
        Set<String> after = protectedNames(); after.removeAll(before); assertEquals(1, after.size());
        File file = new File(context.getNoBackupFilesDir(), "account-closure/" + after.iterator().next());
        byte[] bad = Files.readAllBytes(file.toPath()); bad[bad.length - 1] ^= 1; Files.write(file.toPath(), bad);
        reject("closure_storage_unavailable", () -> new AndroidAccountClosure(context).receipts.get(scope));
        assertArrayEquals(bad, Files.readAllBytes(file.toPath()));
    }
}
