package app.gugu.chat;

import org.junit.Test;
import java.io.IOException;
import java.util.Arrays;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import static org.junit.Assert.*;

/** Deterministic source cases. Native compilation/execution is not claimed by this change. */
public class AccountClosureOperationV2Test {
    private static final String A = "11111111-1111-4111-8111-111111111111";
    private static final String B = "22222222-2222-4222-8222-222222222222";
    private static final String SID = "33333333-3333-4333-8333-333333333333";
    private interface Attempt { void run() throws Exception; }
    private static void reject(String code, Attempt action) throws Exception {
        try { action.run(); fail("Expected " + code); }
        catch (CompletionException error) {
            assertTrue(error.getCause() instanceof AccountClosureReceiptStore.Failure);
            assertEquals(code, ((AccountClosureReceiptStore.Failure) error.getCause()).code);
        } catch (AccountClosureReceiptStore.Failure error) { assertEquals(code, error.code); }
    }
    private static final class Fixture implements AccountClosureReceiptStore.Secrets, AccountClosureOperationV2.Runtime {
        final Object lock = new Object();
        final Map<String, byte[]> records = new HashMap<>();
        String owner = A, sid = SID, installation = "native-install", device = "native-device";
        boolean enabled = true, failWrite, busy;
        int entropyCalls, stops;
        int snapshots;
        Attempt beforeDispatch;
        Attempt admissionSnapshot;
        Attempt duringDispatch;
        CompletableFuture<Void> drain = new CompletableFuture<>();
        public byte[] read(String key) { byte[] value = records.get(key); return value == null ? null : value.clone(); }
        public void write(String key, byte[] value) throws Exception {
            if (failWrite) throw new IOException("injected atomic commit failure");
            records.put(key, value.clone());
        }
        public CompletableFuture<Void> stopAndDrain(AccountClosureOperationV2.SideEffects admission) throws Exception {
            assertFalse(Thread.holdsLock(lock));
            assertEquals(1, records.size()); // Receipt and scope MUST already be durable.
            if (beforeDispatch != null) beforeDispatch.run();
            admission.runLocal(() -> {
                if (duringDispatch != null) duringDispatch.run();
                stops++;
            });
            return drain;
        }
        public boolean busy(String owner) { assertFalse(Thread.holdsLock(lock)); return busy; }
        AccountClosureOperationV2 open() {
            return new AccountClosureOperationV2(lock, this,
                () -> {
                    snapshots++;
                    if (snapshots == 3 && admissionSnapshot != null) admissionSnapshot.run();
                    return new AccountClosureOperationV2.Identity(owner, sid, installation, device);
                }, this, enabled,
                bytes -> { entropyCalls++; Arrays.fill(bytes, (byte) entropyCalls); });
        }
        AccountClosureReceiptStore.Scope scope() throws Exception { return new AccountClosureReceiptStore.Scope(A, "operation/../one"); }
        byte[] persisted() { return records.values().iterator().next().clone(); }
    }
    @Test public void disabledCapabilityHasNoStorageEntropyOrStopEffects() throws Exception {
        Fixture f = new Fixture(); f.enabled = false;
        reject("closure_v2_unavailable", () -> f.open().beginOrRestoreOperation(f.scope()));
        assertEquals(0, f.entropyCalls); assertEquals(0, f.stops); assertTrue(f.records.isEmpty());
    }
    @Test public void restartRestoresSameOperationSecretAndGenerationWithoutJournal() throws Exception {
        Fixture f = new Fixture(); AccountClosureOperationV2.Metadata first = f.open().beginOrRestoreOperation(f.scope());
        byte[] original = f.persisted(); AccountClosureOperationV2.Metadata restored = f.open().beginOrRestoreOperation(f.scope());
        assertEquals(first.nativeGeneration, restored.nativeGeneration); assertArrayEquals(original, f.persisted());
        assertEquals(1, f.entropyCalls); assertEquals(1, restored.localRevision); assertEquals(1, f.records.size());
        assertTrue(f.records.keySet().iterator().next().matches("[a-f0-9]{64}"));
    }
    @Test public void unresolvedOwnerCannotReplaceOperationOrSecret() throws Exception {
        Fixture f = new Fixture(); f.open().beginOrRestoreOperation(f.scope()); byte[] original = f.persisted();
        reject("scope_conflict", () -> f.open().beginOrRestoreOperation(new AccountClosureReceiptStore.Scope(A, "different")));
        assertArrayEquals(original, f.persisted()); assertEquals(1, f.entropyCalls);
    }
    @Test public void ownerSessionDeviceAndInstallationChangesCannotAdoptRecord() throws Exception {
        Fixture f = new Fixture(); f.open().beginOrRestoreOperation(f.scope()); byte[] original = f.persisted();
        f.owner = B; reject("wrong_local_owner", () -> f.open().readCapturedOperation(f.scope())); f.owner = A;
        f.sid = B; reject("scope_conflict", () -> f.open().beginOrRestoreOperation(f.scope())); f.sid = SID;
        f.device = "other-device"; reject("scope_conflict", () -> f.open().readCapturedOperation(f.scope())); f.device = "native-device";
        f.installation = "other-install";
        reject("closure_storage_unavailable", () -> f.open().beginOrRestoreOperation(f.scope()));
        assertArrayEquals(original, f.persisted()); assertEquals(1, f.entropyCalls);
    }
    @Test public void metadataContainsNoSecretAndNoCloudAuthority() throws Exception {
        Fixture f = new Fixture(); AccountClosureOperationV2.Metadata m = f.open().beginOrRestoreOperation(f.scope());
        for (java.lang.reflect.Field field : m.getClass().getDeclaredFields()) {
            assertFalse(field.getName().toLowerCase(java.util.Locale.ROOT).contains("receipt"));
            assertFalse(field.getName().toLowerCase(java.util.Locale.ROOT).contains("token"));
        }
        assertNull(m.serverGeneration); assertNull(m.operationRevision); assertNull(m.requestId);
        assertNull(m.confirmationId); assertEquals(0, m.challengeGeneration);
    }
    @Test public void storageFailureDoesNotStopOrPretendToCapture() throws Exception {
        Fixture f = new Fixture(); f.failWrite = true;
        try { f.open().prepare(f.scope()); fail("Expected commit failure"); } catch (IOException expected) { /* storage failure remains failure */ }
        assertEquals(0, f.stops); assertTrue(f.records.isEmpty());
    }
    @Test public void localCasCannotAcceptStaleGenerationOrRendererTerminalStrings() throws Exception {
        Fixture f = new Fixture(); AccountClosureOperationV2 store = f.open();
        AccountClosureOperationV2.Metadata m = store.beginOrRestoreOperation(f.scope());
        for (String event : new String[]{"local_prepared", "deleted", "closed_before_confirm", "cloud_closed", "complete"})
            reject("untrusted_checkpoint", () -> store.checkpointOperation(f.scope(), 1, m.nativeGeneration, event));
        reject("scope_conflict", () -> store.checkpointOperation(f.scope(), 1, B, "request_local_preparation"));
        assertEquals("preparing", store.checkpointOperation(f.scope(), 1, m.nativeGeneration, "request_local_preparation").checkpoint);
        reject("scope_conflict", () -> store.checkpointOperation(f.scope(), 1, m.nativeGeneration, "request_local_preparation"));
    }
    @Test public void preparePersistsBeforeDrainAndOnlyNativeCompletionAdvances() throws Exception {
        Fixture f = new Fixture(); AccountClosureOperationV2 store = f.open();
        CompletableFuture<AccountClosureOperationV2.Metadata> pending = store.prepare(f.scope());
        assertFalse(pending.isDone()); assertEquals("preparing", store.readCapturedOperation(f.scope()).checkpoint);
        f.drain.complete(null); AccountClosureOperationV2.Metadata result = pending.join();
        assertEquals("local_prepared", result.checkpoint); assertEquals(3, result.localRevision); assertNull(result.serverGeneration);
    }
    @Test public void drainCompletionAfterSidSwitchDoesNotMarkPrepared() throws Exception {
        Fixture f = new Fixture(); CompletableFuture<AccountClosureOperationV2.Metadata> pending = f.open().prepare(f.scope());
        f.sid = B; f.drain.complete(null); reject("scope_conflict", pending::join);
        f.sid = SID; assertEquals("preparing", f.open().readCapturedOperation(f.scope()).checkpoint);
    }
    @Test public void failedOrStillBusyDrainKeepsSealAndReceipt() throws Exception {
        Fixture f = new Fixture(); CompletableFuture<AccountClosureOperationV2.Metadata> pending = f.open().prepare(f.scope());
        f.busy = true; f.drain.complete(null); reject("closure_not_prepared", pending::join);
        assertEquals("preparing", f.open().readCapturedOperation(f.scope()).checkpoint);
        reject("closure_v2_pending", () -> AccountClosureOperationV2.requireNoCapturedOperation(f, f.installation, A));
        assertEquals(1, f.entropyCalls);
    }
    @Test public void featureDisableCannotReleaseAnExistingSeal() throws Exception {
        Fixture f = new Fixture(); f.open().beginOrRestoreOperation(f.scope()); f.enabled = false;
        reject("closure_v2_pending", () -> AccountClosureOperationV2.requireNoCapturedOperation(f, f.installation, A));
    }
    @Test public void oldFormatCorruptionOrAppendedAuthorityNeverBecomesFreshOperation() throws Exception {
        Fixture f = new Fixture(); f.open().beginOrRestoreOperation(f.scope()); String key = f.records.keySet().iterator().next();
        byte[] valid = f.persisted(); f.records.put(key, new byte[]{0, 0, 0, 2});
        reject("closure_storage_unavailable", () -> f.open().beginOrRestoreOperation(f.scope()));
        f.records.put(key, Arrays.copyOf(valid, valid.length + 1));
        reject("closure_storage_unavailable", () -> f.open().beginOrRestoreOperation(f.scope()));
        assertEquals(1, f.entropyCalls);
    }
    @Test public void noLocalCheckpointCanAuthorizeBindCancelOrErase() throws Exception {
        Fixture f = new Fixture(); AccountClosureOperationV2 store = f.open(); store.beginOrRestoreOperation(f.scope());
        reject("trusted_result_unavailable", () -> store.bindServerResult(f.scope()));
        reject("trusted_result_unavailable", () -> store.cancel(f.scope()));
        reject("trusted_result_unavailable", () -> store.erase(f.scope()));
        assertEquals(0, f.stops); assertEquals(1, f.records.size());
    }
    @Test public void failedPreparedCheckpointRetainsRecoverablePreparingRecord() throws Exception {
        Fixture f = new Fixture(); CompletableFuture<AccountClosureOperationV2.Metadata> pending = f.open().prepare(f.scope());
        f.failWrite = true; f.drain.complete(null);
        try { pending.join(); fail("Expected durable checkpoint failure"); }
        catch (CompletionException error) { assertTrue(error.getCause() instanceof IOException); }
        f.failWrite = false;
        AccountClosureOperationV2.Metadata recovered = f.open().readCapturedOperation(f.scope());
        assertEquals("preparing", recovered.checkpoint); assertEquals(2, recovered.localRevision);
        assertEquals(1, f.entropyCalls);
    }
    @Test public void otherOwnerCannotReadAAndDoesNotReplaceItsProtectedRecord() throws Exception {
        Fixture f = new Fixture(); f.open().beginOrRestoreOperation(f.scope()); byte[] original = f.persisted();
        String aKey = f.records.keySet().iterator().next(); f.owner = B;
        reject("wrong_local_owner", () -> f.open().readCapturedOperation(f.scope()));
        AccountClosureOperationV2.Metadata b = f.open().beginOrRestoreOperation(new AccountClosureReceiptStore.Scope(B, "B-operation"));
        assertEquals(B, b.ownerId); assertEquals(2, f.records.size()); assertArrayEquals(original, f.records.get(aKey));
    }
    @Test public void serializedProtocolIsDistinctAndReceiptIsExactly32Bytes() throws Exception {
        Fixture f = new Fixture(); f.open().beginOrRestoreOperation(f.scope());
        try (java.io.DataInputStream input = new java.io.DataInputStream(new java.io.ByteArrayInputStream(f.persisted()))) {
            assertEquals(0x47554332, input.readInt()); assertEquals(3, input.readInt()); assertEquals(2, input.readInt());
            for (int i = 0; i < 7; i++) input.readUTF();
            assertEquals(1, input.readLong()); byte[] receipt = new byte[32]; input.readFully(receipt);
            for (byte value : receipt) assertEquals(1, value);
            assertFalse(input.readBoolean()); assertEquals(0, input.available());
        }
    }
    @Test public void lostJournalCanDiscoverOnlyCurrentNativeOwnerWithoutNewSecret() throws Exception {
        Fixture f = new Fixture(); AccountClosureOperationV2.Metadata first = f.open().beginOrRestoreOperation(f.scope());
        AccountClosureOperationV2.Metadata found = f.open().readCapturedOperationForCurrentOwner();
        assertEquals(first.localOperationId, found.localOperationId); assertEquals(first.nativeGeneration, found.nativeGeneration);
        assertEquals(1, f.entropyCalls); f.owner = B;
        reject("closure_context_missing", () -> f.open().readCapturedOperationForCurrentOwner());
        assertEquals(1, f.records.size());
    }
    @Test public void sid2CommittedAfterPreparingIsRejectedBeforeAnySideEffect() throws Exception {
        Fixture f = new Fixture();
        // Native Auth port now observes SID2 at the admission snapshot: SID1's
        // record is already durable/preparing. No runtime/grant mutation may run.
        f.admissionSnapshot = () -> f.sid = B;
        reject("scope_conflict", () -> f.open().prepare(f.scope()));
        assertEquals(B, f.sid); assertEquals(0, f.stops); assertEquals(1, f.entropyCalls);
        assertFalse(AccountClosureOperationV2.hasSideEffectAdmission(f.lock));
        f.sid = SID; assertEquals("preparing", f.open().readCapturedOperation(f.scope()).checkpoint);
    }
    @Test public void nativeAuthWriterCannotCrossSameGenerationSideEffectAdmission() throws Exception {
        Fixture f = new Fixture();
        f.duringDispatch = () -> {
            assertTrue(Thread.holdsLock(f.lock));
            AccountClosureOperationV2.requireAuthMutation(f.lock, A, SID); // same SID refresh
            reject("scope_conflict", () -> AccountClosureOperationV2.requireAuthMutation(f.lock, A, B));
            reject("scope_conflict", () -> AccountClosureOperationV2.requireAuthMutation(f.lock, B, SID));
            reject("scope_conflict", () -> AccountClosureOperationV2.requireAuthMutation(f.lock, null, null));
        };
        CompletableFuture<AccountClosureOperationV2.Metadata> pending = f.open().prepare(f.scope());
        assertEquals(1, f.stops); assertFalse(pending.isDone());
        assertFalse(AccountClosureOperationV2.hasSideEffectAdmission(f.lock));
        // The dispatch fence is gone BEFORE drain completes; the ordinary
        // post-drain scope check must still reject a later SID replacement.
        synchronized (f.lock) { AccountClosureOperationV2.requireAuthMutation(f.lock, A, B); f.sid = B; }
        f.drain.complete(null); reject("scope_conflict", pending::join);
    }
    @Test public void failedStopDispatchAlwaysReleasesAdmissionWithoutAdvancingPreparation() throws Exception {
        Fixture f = new Fixture(); f.beforeDispatch = () -> { throw new IOException("stop dispatch refused"); };
        try { f.open().prepare(f.scope()); fail("Expected dispatch failure"); } catch (IOException expected) { /* remains preparing */ }
        assertFalse(AccountClosureOperationV2.hasSideEffectAdmission(f.lock)); assertEquals(0, f.stops);
        assertEquals("preparing", f.open().readCapturedOperation(f.scope()).checkpoint);
    }
    @Test public void v1CancelThenV2SealRejectsTheLateV1CompletionWithoutRewritingStopped() throws Exception {
        Fixture f = new Fixture(); final int[] v1State = {AccountClosurePreparation.STOPPING};
        final String g1 = SID;
        AccountClosureReceiptStore receipts = new AccountClosureReceiptStore(f.lock, f, () -> f.installation,
            () -> f.owner, scope -> false, java.util.Collections.emptyList(), java.util.Collections::emptyList,
            (scope, capturing) -> g1);
        // V1 drain remains pending. A valid G1 receipt is put AFTER STOPPING,
        // removed, then cancelled while state < ERASING, exactly as the bridge permits.
        receipts.put(f.scope(), "V1-G1-receipt"); receipts.remove(f.scope());
        assertEquals(g1, receipts.requireCancelledReceipt(f.scope())); v1State[0] = 0;
        AccountClosureOperationV2.Metadata v2 = f.open().beginOrRestoreOperation(f.scope());
        synchronized (f.lock) {
            reject("closure_v2_pending", () -> AccountClosurePreparation.completeCaptured(
                AccountClosurePreparation.STOPPING, g1, v1State[0], g1,
                () -> AccountClosureOperationV2.requireNoCapturedOperation(f, f.installation, A),
                () -> v1State[0] = AccountClosurePreparation.STOPPED));
        }
        assertEquals(0, v1State[0]);
        assertEquals(v2.nativeGeneration, f.open().readCapturedOperation(f.scope()).nativeGeneration);
    }
    @Test public void cancelledOrReplacedV1GenerationCannotCompleteEvenWithoutV2() throws Exception {
        final int[] state = {0}; final int[] commits = {0};
        reject("scope_conflict", () -> AccountClosurePreparation.completeCaptured(
            AccountClosurePreparation.STOPPING, SID, state[0], SID, () -> {}, () -> commits[0]++));
        state[0] = AccountClosurePreparation.STOPPING;
        reject("scope_conflict", () -> AccountClosurePreparation.completeCaptured(
            AccountClosurePreparation.STOPPING, SID, state[0], B, () -> {}, () -> commits[0]++));
        assertEquals(0, commits[0]);
        AccountClosurePreparation.completeCaptured(AccountClosurePreparation.STOPPING, SID, state[0], SID,
            () -> {}, () -> commits[0]++);
        assertEquals(1, commits[0]);
    }
}
