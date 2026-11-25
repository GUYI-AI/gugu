package app.gugu.chat;

import android.content.Context;
import android.content.ContextWrapper;
import android.content.SharedPreferences;
import android.util.Base64;
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

/** Actual Android JSON/Keystore/files. Isolated local identities, no HTTP or account deletion. */
@RunWith(AndroidJUnit4.class)
public class AccountClosureV2NativeTest {
    @Rule public final TemporaryFolder temporary = new TemporaryFolder(InstrumentationRegistry.getInstrumentation().getTargetContext().getCacheDir());
    private Context context;
    private String a, b, sid, prefix;
    private interface Attempt { void run() throws Exception; }
    private static void refuses(Attempt attempt) throws Exception {
        try { attempt.run(); fail("Expected refusal"); } catch (Exception expected) { /* no fallthrough success */ }
    }
    @Before public void createIsolatedContext() throws Exception {
        a = UUID.randomUUID().toString(); b = UUID.randomUUID().toString(); sid = UUID.randomUUID().toString(); prefix = "closure-v2-test-" + a + "-";
        File files = temporary.newFolder("files"), backup = temporary.newFolder("no-backup"), cache = temporary.newFolder("cache");
        context = new ContextWrapper(InstrumentationRegistry.getInstrumentation().getTargetContext()) {
            @Override public Context getApplicationContext() { return this; }
            @Override public File getFilesDir() { return files; }
            @Override public File getNoBackupFilesDir() { return backup; }
            @Override public File getCacheDir() { return cache; }
            @Override public SharedPreferences getSharedPreferences(String name, int mode) { return super.getSharedPreferences(prefix + name, mode); }
            @Override public boolean deleteSharedPreferences(String name) { return super.deleteSharedPreferences(prefix + name); }
        };
        signIn(a); GuguPhoneInstallation.identity(context);
    }
    @After public void clearOnlyOwnPreferences() {
        for (String name : new String[]{"gugu-auth-storage", "phone-agent-grants"})
            assertTrue(context.getSharedPreferences(name, Context.MODE_PRIVATE).edit().clear().commit());
    }
    private String envelope(String owner) throws Exception {
        String claims = Base64.encodeToString(new JSONObject().put("sub", owner).put("session_id", sid).toString().getBytes(StandardCharsets.UTF_8),
            Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
        return new JSONObject().put("state", "SESSION").put("raw", new JSONObject().put("access_token", "local." + claims + ".local")
            .put("refresh_token", "test-refresh").put("user", new JSONObject().put("id", owner)).toString()).toString();
    }
    private void signIn(String owner) throws Exception {
        new AndroidAuthStore(context).put("sb-main", envelope(owner));
    }
    private void retire() throws Exception {
        new AndroidAuthStore(context).put("sb-main", "{\"state\":\"RETIRED_EMPTY\"}");
    }
    private AccountClosureReceiptStore.Scope scope() throws Exception { return new AccountClosureReceiptStore.Scope(a, UUID.randomUUID().toString()); }
    private static File file(File parent, String path, String content) throws Exception {
        File file = new File(parent, path); assertTrue(file.getParentFile().isDirectory() || file.getParentFile().mkdirs());
        Files.write(file.toPath(), content.getBytes(StandardCharsets.UTF_8)); return file;
    }
    @Test public void protectedIndexAndOriginalOperationSurviveAuthRetirementWithoutReceiptInSnapshot() throws Exception {
        AndroidAccountClosureV2 nativeV2 = new AndroidAccountClosureV2(context, true);
        AccountClosureReceiptStore.Scope scope = scope(); AccountClosureOperationV2.Metadata captured = nativeV2.operation(a).beginOrRestoreOperation(scope);
        String secret = nativeV2.operation(a).nativeReceipt(scope, captured.localRevision, captured.nativeGeneration, false);
        assertTrue(secret.matches("[a-f0-9]{64}"));
        assertFalse(AndroidAccountClosureV2Facade.snapshot(captured).toString().contains(secret));
        assertFalse(context.getSharedPreferences("gugu-auth-storage", 0).getAll().toString().contains(secret));
        retire(); AccountClosureOperationV2.Metadata restored = new AndroidAccountClosureV2(context, true).discover();
        assertEquals(captured.localOperationId, restored.localOperationId); assertEquals(captured.nativeGeneration, restored.nativeGeneration);
        assertEquals(secret, nativeV2.operation(a, true).nativeReceipt(scope, restored.localRevision, restored.nativeGeneration, true));
        refuses(() -> nativeV2.operation(a).beginOrRestoreOperation(scope));
    }
    @Test public void currentBCannotDiscoverOrAdoptAsPendingRecord() throws Exception {
        AndroidAccountClosureV2 nativeV2 = new AndroidAccountClosureV2(context, true);
        AccountClosureOperationV2.Metadata captured = nativeV2.operation(a).beginOrRestoreOperation(scope());
        signIn(b); assertNull(nativeV2.discover());
        refuses(() -> nativeV2.resolve(captured.localOperationId, captured.nativeGeneration, captured.localRevision));
        retire(); assertEquals(captured.nativeGeneration, nativeV2.discover().nativeGeneration);
    }
    @Test public void realScopedCleanupPreservesBAndBlocksLateAAuthWrites() throws Exception {
        AndroidAccountClosureV2 nativeV2 = new AndroidAccountClosureV2(context, true);
        AccountClosureReceiptStore.Scope scope = scope(); AccountClosureOperationV2 store = nativeV2.operation(a);
        AccountClosureOperationV2.Metadata captured = store.beginOrRestoreOperation(scope);
        File own = file(context.getFilesDir(), "phone-agent/" + a + "/state", "A");
        File other = file(context.getFilesDir(), "phone-agent/" + b + "/state", "B");
        File installation = new File(context.getNoBackupFilesDir(), "phone-installation/registration"); byte[] marker = Files.readAllBytes(installation.toPath());
        AccountClosureV2Receiver.Reply deleted = new AccountClosureV2Receiver.Reply();
        deleted.httpStatus = 200; deleted.operationId = UUID.randomUUID().toString(); deleted.state = "deleted"; deleted.revision = 1;
        captured = AccountClosureV2Receiver.accept(store, scope, captured, "result", captured.backendIdentity, deleted);
        AccountClosureOperationV2.Metadata complete = new AndroidAccountClosureV2Facade(context).cleanDeleted(captured);
        assertEquals(4, complete.protocol.cleanupStep); assertFalse(own.exists());
        assertEquals("B", new String(Files.readAllBytes(other.toPath()), StandardCharsets.UTF_8));
        assertArrayEquals(marker, Files.readAllBytes(installation.toPath()));
        assertNull(AndroidAccountClosureV2.storedSession(context));
        synchronized (GuguAuthStoragePlugin.STORAGE_LOCK) {
            refuses(() -> AccountClosurePreparation.requireAuthWrite(context, envelope(a)));
            AccountClosurePreparation.requireAuthWrite(context, envelope(b));
        }
        AccountClosureOperationV2.Metadata finalized = nativeV2.operation(a, true).finalizeDeleted(scope, complete);
        assertTrue(finalized.protocol.finalized);
        refuses(() -> AccountClosurePreparation.requireOpen(context, a));
    }
    @Test public void wireRequiresFixedPolicyAndBoundCancelAuthorityIncludingUnpreparedResultTombstone() throws Exception {
        String op = "\"operation_id\":\"" + UUID.randomUUID() + "\",\"revision\":1,\"challenge_generation\":0,\"request_id\":null,\"can_retry\":false";
        String preparation = "\"preparation\":{\"cancelled\":true,\"native_generation\":\"" + sid + "\",\"server_generation\":null}";
        String good = "{\"operation\":{" + op + ",\"state\":\"closed_before_confirm\",\"can_release_preparation\":true}," + preparation + "}";
        AccountClosureV2Receiver.Reply reply = AccountClosureV2Wire.operation(http(200, good), "result");
        assertTrue(reply.cancelled); assertTrue(reply.canReleasePreparation); assertNull(reply.serverGeneration);
        refuses(() -> AccountClosureV2Wire.operation(http(200, good.replace("\"can_release_preparation\":true", "\"can_release_preparation\":false")), "result"));
        refuses(() -> AccountClosureV2Wire.policy(http(200, "{\"policy\":{\"available\":false}}")));
        refuses(() -> AccountClosureV2Wire.operation(http(422, "{\"error\":\"verification_failed\"}"), "confirm"));
        refuses(() -> AccountClosureV2Wire.operation(http(200, good.replace("\"revision\":1", "\"revision\":1.5")), "result"));
        assertTrue(AccountClosureV2Wire.cancellationBlocked(http(409, "not-json")));
        assertTrue(AccountClosureV2Wire.cancellationBlocked(http(503, "{\"error\":\"request_active\"}")));
        assertFalse(AccountClosureV2Wire.cancellationBlocked(http(503, "{\"error\":\"unavailable\"}")));
    }
    @Test public void onlyBoundPersistedRejectionIsParsedAsKnownWhileBare422StaysUnknown() throws Exception {
        String id = UUID.randomUUID().toString();
        String json = new JSONObject().put("error", "verification_failed").put("operation", new JSONObject()
            .put("operation_id", id).put("state", "open").put("revision", 2).put("challenge_generation", 1)
            .put("request_id", JSONObject.NULL).put("can_retry", false).put("confirmation", new JSONObject()
                .put("confirmation_id", sid).put("challenge_generation", 1).put("state", "rejected").put("error_code", "verification_failed"))).toString();
        AccountClosureV2Receiver.Reply parsed = AccountClosureV2Wire.operation(http(422, json), "confirm");
        assertTrue(parsed.rejectedConfirmation); assertEquals(sid, parsed.rejectedConfirmationId);
        assertEquals(1, parsed.rejectedChallengeGeneration);
        assertTrue(AccountClosureV2Wire.operation(http(200, json), "result").rejectedConfirmation);
        refuses(() -> AccountClosureV2Wire.operation(http(422, json.replace("\"state\":\"rejected\"", "\"state\":\"verifying\"")), "confirm"));
        refuses(() -> AccountClosureV2Wire.operation(http(422, json.replace("\"error_code\":\"verification_failed\"", "\"error_code\":null")), "confirm"));
        refuses(() -> AccountClosureV2Wire.operation(http(422, "{\"error\":\"verification_failed\"}"), "confirm"));
    }
    @Test public void completedSendSummaryIsBoundAndMicrosecondExpiryIsReadWithoutEmailDeliveryClaims() throws Exception {
        String request = UUID.randomUUID().toString();
        JSONObject summary = new JSONObject().put("request_id", request).put("state", "challenge")
            .put("expires_at", "2030-01-02T03:04:05.123456+00:00").put("last_error", JSONObject.NULL).put("can_retry", false);
        JSONObject operation = new JSONObject().put("operation_id", UUID.randomUUID().toString()).put("state", "open")
            .put("revision", 2).put("challenge_generation", 1).put("request_id", request).put("can_retry", false).put("request", summary);
        JSONObject response = new JSONObject().put("operation", operation);
        AccountClosureV2Receiver.Reply known = AccountClosureV2Wire.operation(http(200, response.toString()), "result");
        assertTrue(known.knownSentRequest); assertTrue(known.challengeExpiresAt > 0);
        summary.put("last_error", "email_outcome_unknown");
        assertFalse(AccountClosureV2Wire.operation(http(200, response.toString()), "result").knownSentRequest);
        summary.put("last_error", JSONObject.NULL).put("request_id", UUID.randomUUID().toString());
        assertFalse(AccountClosureV2Wire.operation(http(200, response.toString()), "result").knownSentRequest);
        summary.put("request_id", request); summary.remove("expires_at");
        assertFalse(AccountClosureV2Wire.operation(http(200, response.toString()), "result").knownSentRequest);
    }
    @Test public void cancelledPreparationKeepsNativePauseUntilCurrentOwnersExplicitResume() throws Exception {
        AndroidAccountClosureV2 nativeV2 = new AndroidAccountClosureV2(context, true);
        AccountClosureReceiptStore.Scope scope = scope(); AccountClosureOperationV2 store = nativeV2.operation(a);
        store.beginOrRestoreOperation(scope);
        AccountClosureOperationV2.Metadata ready = store.prepare(scope).get(5, java.util.concurrent.TimeUnit.SECONDS);
        AccountClosureOperationV2.Metadata pending = store.updateProtocol(scope, ready.localRevision, ready.nativeGeneration, false, facts -> facts.pendingRoute = "cancel");
        AccountClosureV2Receiver.Reply cancelled = new AccountClosureV2Receiver.Reply();
        cancelled.httpStatus = 200; cancelled.operationId = UUID.randomUUID().toString(); cancelled.state = "closed_before_confirm";
        cancelled.revision = 1; cancelled.hasPreparation = true; cancelled.cancelled = true; cancelled.canReleasePreparation = true;
        cancelled.nativeGeneration = pending.nativeGeneration;
        AccountClosureV2Receiver.accept(store, scope, pending, "cancel", pending.backendIdentity, cancelled);
        refuses(() -> AccountClosurePreparation.requireOpen(context, a));
        signIn(b); refuses(() -> AndroidAccountClosureV2.resumeAfterCancellation(context, a));
        signIn(a); AndroidAccountClosureV2.resumeAfterCancellation(context, a);
        AccountClosurePreparation.requireOpen(context, a);
        assertFalse(store.readForRecovery(scope).protocol.resumeRequired);
    }
    private static AccountClosureHttp.Reply http(int status, String json) { return new AccountClosureHttp.Reply(status, json.getBytes(StandardCharsets.UTF_8)); }
}
