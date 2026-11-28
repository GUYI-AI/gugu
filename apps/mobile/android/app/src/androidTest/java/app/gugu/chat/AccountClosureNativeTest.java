package app.gugu.chat;

import android.content.Context;
import android.system.Os;
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
            @Override public boolean deleteSharedPreferences(String name) { return super.deleteSharedPreferences(prefix + name); }
        };
        signIn(a);
    }
    @After public void cleanup() {
        for (String name : new String[] {"gugu-auth-storage", "phone-agent-grants"})
            assertTrue(context.getSharedPreferences(name, Context.MODE_PRIVATE).edit().clear().commit());
    }
    private SharedPreferences auth() { return context.getSharedPreferences("gugu-auth-storage", Context.MODE_PRIVATE); }
    private String savedAuth() throws Exception { return new AndroidAuthStore(context).get("sb-main"); }
    private String envelope(String owner) throws Exception {
        return new JSONObject().put("state", "SESSION").put("raw", new JSONObject()
            .put("access_token", "test-access").put("refresh_token", "test-refresh")
            .put("user", new JSONObject().put("id", owner)).toString()).toString();
    }
    private void signIn(String owner) throws Exception { new AndroidAuthStore(context).put("sb-main", envelope(owner)); }
    private AccountClosureReceiptStore.Scope scope(String operation) throws Exception { return new AccountClosureReceiptStore.Scope(a, operation); }
    private void ready(AndroidAccountClosure closure) throws Exception {
        closure.prepareSignOut(a).get(5, TimeUnit.SECONDS);
        // Local acknowledgement only: SDK/HTTP device removal is not exercised here.
        closure.retireDevice(a, closure.deviceId(a));
    }
    private static File write(File base, String relative, String value) throws Exception {
        File file = new File(base, relative); assertTrue(file.getParentFile().isDirectory() || file.getParentFile().mkdirs());
        NativeTestFiles.write(file, value.getBytes(StandardCharsets.UTF_8)); return file;
    }
    private static String read(File file) throws Exception { return new String(NativeTestFiles.read(file), StandardCharsets.UTF_8); }
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
        assertEquals("RETIRED_EMPTY", new JSONObject(savedAuth()).getString("state"));
        assertEquals("opaque-A", closure.receipts.get(scope)); closure.receipts.remove(scope); assertNull(closure.receipts.get(scope));
        assertEquals("complete", closure.erase(scope).status);
    }
    @Test public void switchingToBRejectsEveryOperationUsingAsScope() throws Exception {
        AndroidAccountClosure closure = new AndroidAccountClosure(context); ready(closure);
        AccountClosureReceiptStore.Scope scope = scope("captured-A"); closure.receipts.put(scope, "opaque-A"); signIn(b);
        String before = savedAuth();
        reject("wrong_local_owner", () -> closure.receipts.get(scope));
        reject("wrong_local_owner", () -> closure.receipts.remove(scope));
        reject("wrong_local_owner", () -> closure.erase(scope));
        reject("wrong_local_owner", () -> closure.prepareSignOut(a));
        assertEquals(before, savedAuth());
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
        byte[] bad = NativeTestFiles.read(file); bad[bad.length - 1] ^= 1; NativeTestFiles.write(file, bad);
        reject("closure_storage_unavailable", () -> new AndroidAccountClosure(context).receipts.get(scope));
        assertArrayEquals(bad, NativeTestFiles.read(file));
    }

    @Test public void migrationRetiresTheCommittedRegistrationInsteadOfTheInstallationKey() throws Exception {
        String installation = GuguPhoneInstallation.identity(context).key, registration = UUID.randomUUID().toString();
        PhoneRegistrationIdentity.open(context.getNoBackupFilesDir(), installation, () -> registration,
            (temporary, target) -> NativeTestFiles.move(temporary, target));
        AndroidAccountClosure closure = new AndroidAccountClosure(context);
        String committed = "phone-" + registration + "-" + a;
        assertNotEquals(installation, registration); assertEquals(committed, closure.deviceId(a));
        closure.prepareSignOut(a).get(5, TimeUnit.SECONDS);
        reject("closure_not_prepared", () -> closure.retireDevice(a, "phone-" + installation + "-" + a));
        closure.retireDevice(a, committed);
        assertEquals(AccountClosurePreparation.RETIRED, new AccountClosurePreparation(context).state(a));
        assertEquals(committed, new AndroidAccountClosure(context).deviceId(a));
    }

    @Test public void returningToAWaitsForTheOriginalAExitAndLeavesBRunning() throws Exception {
        java.util.concurrent.CompletableFuture<Void> oldA = new java.util.concurrent.CompletableFuture<>();
        java.util.concurrent.CompletableFuture<Void> currentB = new java.util.concurrent.CompletableFuture<>();
        java.util.concurrent.atomic.AtomicInteger stoppedA = new java.util.concurrent.atomic.AtomicInteger(), stoppedB = new java.util.concurrent.atomic.AtomicInteger();
        GuguAgentHostService.OWNED_RUNS.add(a, oldA, stoppedA::incrementAndGet);
        signIn(b); GuguAgentHostService.OWNED_RUNS.add(b, currentB, stoppedB::incrementAndGet); GuguAgentHostService.reserveOwner(b);
        try {
            signIn(a); AndroidAccountClosure closure = new AndroidAccountClosure(context);
            AccountClosureReceiptStore.Scope scope = scope("returning-A"); closure.receipts.put(scope, "opaque-A");
            java.util.concurrent.CompletableFuture<Void> prepared = closure.prepareSignOut(a);
            assertFalse(prepared.isDone()); assertTrue(GuguAgentHostService.ownerIsBusy(a));
            assertEquals(AccountClosurePreparation.STOPPING, new AccountClosurePreparation(context).state(a));
            reject("closure_not_prepared", () -> closure.retireDevice(a, closure.deviceId(a)));
            reject("closure_not_prepared", () -> closure.erase(scope));
            assertEquals(1, stoppedA.get()); assertEquals(0, stoppedB.get());
            oldA.complete(null); prepared.get(5, TimeUnit.SECONDS);
            closure.retireDevice(a, closure.deviceId(a)); assertEquals("complete", closure.erase(scope).status);
            assertTrue(GuguAgentHostService.ownerIsBusy(b)); assertEquals(0, stoppedB.get());
        } finally { oldA.complete(null); currentB.complete(null); GuguAgentHostService.releaseReservation(b); }
    }

    private static final class AttachedLegacyService extends GuguAgentService {
        void attach(Context context) { attachBaseContext(context); }
    }
    private static void field(Class<?> type, Object target, String name, Object value) throws Exception {
        java.lang.reflect.Field field = type.getDeclaredField(name); field.setAccessible(true); field.set(target, value);
    }
    private static void eof(GuguAgentService service) throws Exception {
        java.lang.reflect.Method method = GuguAgentService.class.getDeclaredMethod("recordUnexpectedExit");
        method.setAccessible(true); method.invoke(service);
    }
    @Test public void legacyEofDoesNotHoldAgentLockWhileWaitingForAuthAdmission() throws Exception {
        AttachedLegacyService service = new AttachedLegacyService(); service.attach(context);
        field(GuguAgentService.class, service, "owner", a);
        field(GuguAgentService.class, null, "snapshot", new com.getcapacitor.JSObject().put("ownerId", a).put("status", "running"));
        assertTrue(GuguAgentService.claim(a));
        java.util.concurrent.CountDownLatch authHeld = new java.util.concurrent.CountDownLatch(1), releaseAuth = new java.util.concurrent.CountDownLatch(1);
        java.util.concurrent.atomic.AtomicBoolean attemptClaim = new java.util.concurrent.atomic.AtomicBoolean(), claimedWithoutDeadlock = new java.util.concurrent.atomic.AtomicBoolean();
        java.util.concurrent.atomic.AtomicReference<Throwable> failure = new java.util.concurrent.atomic.AtomicReference<>();
        Thread admission = new Thread(() -> {
            synchronized (GuguAuthStoragePlugin.STORAGE_LOCK) {
                authHeld.countDown();
                try {
                    if (!releaseAuth.await(5, TimeUnit.SECONDS)) throw new AssertionError("Auth test gate was not released");
                    if (attemptClaim.get()) { GuguAgentService.claim(b); claimedWithoutDeadlock.set(true); }
                } catch (Throwable error) { failure.set(error); }
            }
        });
        Thread worker = new Thread(() -> { try { eof(service); } catch (Throwable error) { failure.set(error); } });
        java.util.concurrent.CompletableFuture<Boolean> probe = new java.util.concurrent.CompletableFuture<>();
        Thread observer = new Thread(() -> probe.complete(GuguAgentService.isRunning()));
        boolean lockAvailable = false;
        try {
            admission.start(); assertTrue(authHeld.await(5, TimeUnit.SECONDS)); worker.start();
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(3);
            while (worker.getState() != Thread.State.BLOCKED && worker.isAlive() && System.nanoTime() < deadline) Thread.yield();
            assertEquals(Thread.State.BLOCKED, worker.getState()); observer.start();
            try { lockAvailable = probe.get(2, TimeUnit.SECONDS); }
            catch (java.util.concurrent.TimeoutException expectedOldLockOrderFailure) { /* release below before failing */ }
            attemptClaim.set(lockAvailable);
        } finally {
            releaseAuth.countDown(); admission.join(5000); worker.join(5000); observer.join(5000);
            GuguAgentService.release();
        }
        assertTrue("EOF held the Agent monitor while blocked by auth", lockAvailable);
        assertTrue(claimedWithoutDeadlock.get()); assertNull(failure.get());
        assertFalse(admission.isAlive()); assertFalse(worker.isAlive()); assertFalse(observer.isAlive());
        assertEquals("failed", GuguAgentService.readState(context, a).getString("status"));
        GuguAgentService.forgetClosedOwner(a);
    }
}
