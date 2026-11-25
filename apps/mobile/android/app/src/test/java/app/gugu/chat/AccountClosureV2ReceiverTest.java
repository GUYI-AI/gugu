package app.gugu.chat;

import org.junit.Test;
import java.io.IOException;
import java.util.Arrays;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import static org.junit.Assert.*;

public class AccountClosureV2ReceiverTest {
    private static final String A = "11111111-1111-4111-8111-111111111111", B = "22222222-2222-4222-8222-222222222222";
    private static final String SID = "33333333-3333-4333-8333-333333333333", SERVER = "44444444-4444-4444-8444-444444444444";
    private static final String PREPARATION = "55555555-5555-4555-8555-555555555555", BACKEND = "https://native.example.invalid";
    private interface Attempt { void run() throws Exception; }
    private static void rejects(Attempt action) throws Exception {
        try { action.run(); fail("Expected refusal"); } catch (AccountClosureReceiptStore.Failure expected) { /* fixed failure */ }
    }
    private static final class Memory implements AccountClosureReceiptStore.Secrets {
        final Map<String, byte[]> values = new HashMap<>(); boolean failWrite;
        public byte[] read(String key) { byte[] value = values.get(key); return value == null ? null : value.clone(); }
        public void write(String key, byte[] value) throws Exception {
            if (failWrite) throw new IOException("atomic replacement failed"); values.put(key, value.clone());
        }
    }
    private static final class Fixture {
        final Object lock = new Object(); final Memory files = new Memory();
        final AccountClosureIndexedSecrets secrets = new AccountClosureIndexedSecrets(files);
        final AccountClosureReceiptStore.Scope scope = new AccountClosureReceiptStore.Scope(A, "original-operation");
        String owner = A, sid = SID, backend = BACKEND; boolean authenticated = true, busy;
        Runnable onBusy;
        int stops, entropy;
        final AccountClosureOperationV2 store;
        Fixture() throws Exception {
            store = new AccountClosureOperationV2(lock, secrets,
                () -> new AccountClosureOperationV2.Identity(owner, sid, "native-installation", "native-device", backend, authenticated),
                new AccountClosureOperationV2.Runtime() {
                    public CompletableFuture<Void> stopAndDrain(AccountClosureOperationV2.SideEffects proof) throws Exception {
                        proof.runLocal(() -> stops++); return CompletableFuture.completedFuture(null);
                    }
                    public boolean busy(String owner) { if (onBusy != null) onBusy.run(); return busy; }
                }, true, bytes -> { entropy++; Arrays.fill(bytes, (byte)7); });
        }
        AccountClosureOperationV2.Metadata capture() throws Exception { return store.beginOrRestoreOperation(scope); }
        AccountClosureOperationV2.Metadata latest() throws Exception { return store.readForRecovery(scope); }
        AccountClosureOperationV2.Metadata pending(String route) throws Exception {
            AccountClosureOperationV2.Metadata m = latest();
            return store.updateProtocol(scope, m.localRevision, m.nativeGeneration, false, state -> {
                state.pendingRoute = route;
                if ("challenge".equals(route)) state.attemptedChallengeGeneration = 1;
            });
        }
        AccountClosureOperationV2.Metadata receive(AccountClosureOperationV2.Metadata sent, String route, AccountClosureV2Receiver.Reply reply) throws Exception {
            return AccountClosureV2Receiver.accept(store, scope, sent, route, BACKEND, reply);
        }
        AccountClosureOperationV2.Metadata registered() throws Exception {
            capture(); return receive(pending("register"), "register", reply("open", 1));
        }
    }
    private static AccountClosureV2Receiver.Reply reply(String state, long revision) {
        AccountClosureV2Receiver.Reply reply = new AccountClosureV2Receiver.Reply();
        reply.httpStatus = 200; reply.operationId = SERVER; reply.state = state; reply.revision = revision; return reply;
    }
    private static AccountClosureV2Receiver.Reply preparation(AccountClosureOperationV2.Metadata original, boolean cancelled, String server) {
        AccountClosureV2Receiver.Reply reply = reply(cancelled ? "closed_before_confirm" : "open", 2);
        if (original.operationRevision != null) reply.revision = original.operationRevision + 1;
        reply.hasPreparation = true; reply.nativeGeneration = original.nativeGeneration; reply.serverGeneration = server;
        reply.prepared = !cancelled; reply.cancelled = cancelled; reply.canReleasePreparation = cancelled; return reply;
    }
    @Test public void indexedAtomicCustodyDiscoversOriginalSecretAfterRestart() throws Exception {
        Fixture f = new Fixture(); AccountClosureOperationV2.Metadata original = f.capture();
        AccountClosureIndexedSecrets restarted = new AccountClosureIndexedSecrets(f.files);
        assertEquals(1, f.files.values.size()); assertEquals(1, restarted.discover().size());
        assertEquals(A, restarted.discover().get(0).owner);
        assertEquals(original.localOperationId, AccountClosureOperationV2.protectedMetadata(restarted, "native-installation", A).localOperationId);
        assertEquals(1, f.entropy);
    }
    @Test public void failedAtomicIndexReplacementKeepsBothDiscoveryAndOldRecord() throws Exception {
        Fixture f = new Fixture(); AccountClosureOperationV2.Metadata original = f.capture();
        byte[] before = f.files.values.values().iterator().next().clone(); f.files.failWrite = true;
        try { f.pending("register"); fail("Expected storage failure"); } catch (IOException expected) { }
        assertArrayEquals(before, f.files.values.values().iterator().next());
        assertEquals(original.localRevision, f.latest().localRevision); assertNull(f.latest().protocol.pendingRoute);
    }
    @Test public void corruptIndexNeverLooksLikeNoPendingOperation() throws Exception {
        Fixture f = new Fixture(); f.capture(); String key = f.files.values.keySet().iterator().next();
        f.files.values.put(key, new byte[]{1, 2}); rejects(() -> f.secrets.discover()); rejects(f::capture);
        assertEquals(1, f.entropy);
    }
    @Test public void ownerRecordCannotBeMisindexedUnderAnotherLookupKey() throws Exception {
        Fixture f = new Fixture(); f.capture(); AccountClosureIndexedSecrets.Entry original = f.secrets.discover().get(0);
        rejects(() -> f.secrets.write("0000000000000000000000000000000000000000000000000000000000000000", original.bytes));
        assertEquals(1, f.secrets.discover().size()); assertArrayEquals(original.bytes, f.secrets.read(original.key));
    }
    @Test public void otherAccountRecordsSurviveNewOwnerCaptureByteForByte() throws Exception {
        Fixture f = new Fixture(); f.capture(); AccountClosureIndexedSecrets.Entry a = f.secrets.discover().get(0);
        f.owner = B;
        f.store.beginOrRestoreOperation(new AccountClosureReceiptStore.Scope(B, "B-operation"));
        assertEquals(2, f.secrets.discover().size()); assertEquals(1, f.files.values.size());
        assertArrayEquals(a.bytes, f.secrets.read(a.key));
        rejects(() -> f.store.readForRecovery(f.scope));
    }
    @Test public void oldPrivateRawRecordIsNotHiddenByTheNewIndex() throws Exception {
        Fixture f = new Fixture(); f.capture(); AccountClosureIndexedSecrets.Entry entry = f.secrets.discover().get(0);
        f.files.values.clear(); f.files.values.put(entry.key, entry.bytes);
        rejects(f::capture); assertEquals(1, f.entropy);
    }
    @Test public void signedOutResultUsesOriginalScopeButCannotCaptureOrDispatchAuthenticatedEffects() throws Exception {
        Fixture f = new Fixture(); f.capture(); AccountClosureOperationV2.Metadata original = f.pending("register");
        f.authenticated = false;
        assertEquals(original.nativeGeneration, f.latest().nativeGeneration);
        rejects(f::capture); rejects(() -> f.store.prepare(f.scope));
        AccountClosureOperationV2.Metadata recovered = f.receive(original, "result", reply("open", 1));
        assertEquals(SERVER, recovered.serverOperationId); assertNull(recovered.protocol.pendingRoute);
        assertEquals(1, f.entropy); assertEquals(0, f.stops);
    }
    @Test public void prepareResponseLossRecoversServerGenerationBeforeSafeCancel() throws Exception {
        Fixture f = new Fixture(); f.registered(); AccountClosureOperationV2.Metadata sent = f.pending("prepare_device");
        AccountClosureOperationV2.Metadata recovered = f.receive(sent, "result", preparation(sent, false, PREPARATION));
        assertEquals(PREPARATION, recovered.serverGeneration); assertNull(recovered.protocol.pendingRoute);
        AccountClosureOperationV2.Metadata cancel = f.pending("cancel");
        AccountClosureOperationV2.Metadata cancelled = f.receive(cancel, "cancel", preparation(cancel, true, PREPARATION));
        assertTrue(cancelled.protocol.cancelled);
        AccountClosureOperationV2.requireNoCapturedOperation(f.secrets, "native-installation", A);
    }
    @Test public void missingPreparationOnResultDoesNotReleaseOrInventAGeneration() throws Exception {
        Fixture f = new Fixture(); f.registered(); AccountClosureOperationV2.Metadata sent = f.pending("prepare_device");
        AccountClosureOperationV2.Metadata recovered = f.receive(sent, "result", reply("open", 2));
        assertNull(recovered.serverGeneration); assertEquals("prepare_device", recovered.protocol.pendingRoute);
        rejects(() -> AccountClosureOperationV2.requireNoCapturedOperation(f.secrets, "native-installation", A));
    }
    @Test public void foreignGenerationOrBackendCannotChangeProtectedFacts() throws Exception {
        Fixture f = new Fixture(); f.registered(); AccountClosureOperationV2.Metadata sent = f.pending("prepare_device");
        AccountClosureV2Receiver.Reply wrong = preparation(sent, false, PREPARATION); wrong.nativeGeneration = B;
        rejects(() -> f.receive(sent, "prepare_device", wrong));
        rejects(() -> AccountClosureV2Receiver.accept(f.store, f.scope, sent, "result", "https://other.invalid", reply("deleted", 2)));
        f.backend = "https://other.invalid"; rejects(f::latest); f.backend = BACKEND;
        assertNull(f.latest().serverGeneration);
    }
    @Test public void staleHandleAndLateRepliesCannotOverwriteNewerNativeCas() throws Exception {
        Fixture f = new Fixture(); f.registered(); AccountClosureOperationV2.Metadata sent = f.pending("prepare_device");
        f.pending("cancel"); rejects(() -> f.receive(sent, "prepare_device", preparation(sent, false, PREPARATION)));
        assertEquals("cancel", f.latest().protocol.pendingRoute); assertNull(f.latest().serverGeneration);
    }
    @Test public void unknownConfirmationOpenResultNeverAuthorizesASecondConfirmation() throws Exception {
        Fixture f = new Fixture(); f.registered(); AccountClosureOperationV2.Metadata sent = f.pending("confirm");
        AccountClosureOperationV2.Metadata recovered = f.receive(sent, "result", reply("open", 2));
        assertEquals("confirm", recovered.protocol.pendingRoute); assertFalse(recovered.protocol.released());
    }
    private static AccountClosureOperationV2.Metadata cancelIntent(Fixture f) throws Exception {
        AccountClosureOperationV2.Metadata m = f.latest();
        return f.store.updateProtocol(f.scope, m.localRevision, m.nativeGeneration, false,
            AccountClosureProtocolRecord::requestCancellation);
    }
    @Test public void lostCancelCanBeExplicitlyRetriedWithoutReplacingUnknownConfirmation() throws Exception {
        Fixture f = new Fixture(); AccountClosureOperationV2.Metadata confirm = confirming(f);
        AccountClosureOperationV2.Metadata first = cancelIntent(f);
        assertTrue(first.protocol.cancelRequested); assertFalse(first.protocol.confirmCancellationBlocked);
        assertEquals("confirm", first.protocol.pendingRoute); assertEquals(confirm.confirmationId, first.confirmationId);
        // No response (or a 503) commits no authority; only another explicit command records a retry.
        AccountClosureV2Receiver.Reply open = reply("open", 2); open.challengeGeneration = 1;
        AccountClosureOperationV2.Metadata recovered = f.receive(first, "result", open);
        assertEquals("confirm", recovered.protocol.pendingRoute); assertTrue(recovered.protocol.cancelRequested);
        AccountClosureOperationV2.Metadata retry = cancelIntent(f);
        assertEquals(confirm.confirmationId, retry.confirmationId); assertEquals(confirm.nativeGeneration, retry.nativeGeneration);
        AccountClosureV2Receiver.Reply ack = preparation(retry, true, null); ack.challengeGeneration = 1;
        AccountClosureOperationV2.Metadata closed = f.receive(retry, "cancel", ack);
        assertTrue(closed.protocol.cancelled); assertNull(closed.protocol.pendingRoute);
        assertFalse(closed.protocol.cancelRequested); assertEquals(confirm.confirmationId, closed.confirmationId);
    }
    @Test public void activeCancelBlocksFurtherDispatchButOriginalResultCanRecoverClosedAck() throws Exception {
        Fixture f = new Fixture(); AccountClosureOperationV2.Metadata confirm = confirming(f);
        AccountClosureOperationV2.Metadata sent = cancelIntent(f);
        AccountClosureOperationV2.Metadata blocked = f.store.updateProtocol(f.scope, sent.localRevision, sent.nativeGeneration,
            false, AccountClosureProtocolRecord::blockCancellation);
        assertTrue(f.latest().protocol.confirmCancellationBlocked); rejects(() -> cancelIntent(f));
        assertEquals("confirm", blocked.protocol.pendingRoute); assertEquals(confirm.confirmationId, blocked.confirmationId);
        f.authenticated = false;
        AccountClosureV2Receiver.Reply ack = preparation(blocked, true, null); ack.challengeGeneration = 1;
        AccountClosureOperationV2.Metadata closed = f.receive(blocked, "result", ack);
        assertTrue(closed.protocol.cancelled); assertFalse(closed.protocol.confirmCancellationBlocked);
    }
    @Test public void matchingRejectionReopensNormalCancelAfterAnActiveUnknownCancel() throws Exception {
        Fixture f = new Fixture(); confirming(f); AccountClosureOperationV2.Metadata sent = cancelIntent(f);
        AccountClosureOperationV2.Metadata blocked = f.store.updateProtocol(f.scope, sent.localRevision, sent.nativeGeneration,
            false, AccountClosureProtocolRecord::blockCancellation);
        AccountClosureV2Receiver.Reply rejection = rejected(); rejection.httpStatus = 200;
        AccountClosureOperationV2.Metadata known = f.receive(blocked, "result", rejection);
        assertTrue(known.protocol.confirmationRejected); assertNull(known.protocol.pendingRoute);
        assertFalse(known.protocol.confirmCancellationBlocked); assertFalse(known.protocol.cancelRequested);
        assertEquals("cancel", cancelIntent(f).protocol.pendingRoute);
    }
    @Test public void failedCancelIntentPersistenceLeavesOriginalNonceAndSealUntouched() throws Exception {
        Fixture f = new Fixture(); AccountClosureOperationV2.Metadata confirm = confirming(f); f.files.failWrite = true;
        try { cancelIntent(f); fail("Expected atomic write failure"); } catch (IOException expected) { }
        f.files.failWrite = false; AccountClosureOperationV2.Metadata original = f.latest();
        assertEquals(confirm.localRevision, original.localRevision); assertFalse(original.protocol.cancelRequested);
        assertEquals("confirm", original.protocol.pendingRoute); assertEquals(confirm.confirmationId, original.confirmationId);
        rejects(() -> AccountClosureOperationV2.requireNoCapturedOperation(f.secrets, "native-installation", A));
    }
    private static AccountClosureOperationV2.Metadata confirming(Fixture f) throws Exception {
        AccountClosureOperationV2.Metadata m = f.registered();
        return f.store.updateProtocol(f.scope, m.localRevision, m.nativeGeneration, false, state -> {
            state.pendingRoute = "confirm"; state.confirmationId = PREPARATION; state.challengeGeneration = 1;
        });
    }
    private static AccountClosureV2Receiver.Reply rejected() {
        AccountClosureV2Receiver.Reply rejected = reply("open", 2); rejected.httpStatus = 422; rejected.challengeGeneration = 1;
        rejected.rejectedConfirmation = true; rejected.rejectedConfirmationId = PREPARATION; rejected.rejectedChallengeGeneration = 1;
        return rejected;
    }
    @Test public void acknowledgedExactRejectionPersistsBeforeClearingIntentButNeverUnseals() throws Exception {
        Fixture f = new Fixture(); AccountClosureOperationV2.Metadata pending = confirming(f);
        AccountClosureOperationV2.Metadata known = f.receive(pending, "confirm", rejected());
        assertTrue(known.protocol.confirmationRejected); assertNull(known.protocol.pendingRoute);
        assertTrue(f.latest().protocol.confirmationRejected); assertFalse(f.latest().protocol.cancelled);
        rejects(() -> AccountClosureOperationV2.requireNoCapturedOperation(f.secrets, "native-installation", A));
    }
    @Test public void rejectionMustMatchOriginalConfirmationAndChallenge() throws Exception {
        Fixture f = new Fixture(); AccountClosureOperationV2.Metadata pending = confirming(f);
        AccountClosureV2Receiver.Reply wrong = rejected(); wrong.rejectedConfirmationId = B;
        rejects(() -> f.receive(pending, "confirm", wrong));
        wrong.rejectedConfirmationId = PREPARATION; wrong.rejectedChallengeGeneration = 2;
        rejects(() -> f.receive(pending, "confirm", wrong));
        AccountClosureV2Receiver.Reply bare = reply("open", 2); bare.httpStatus = 422;
        rejects(() -> f.receive(pending, "confirm", bare));
        assertEquals("confirm", f.latest().protocol.pendingRoute); assertFalse(f.latest().protocol.confirmationRejected);
    }
    @Test public void lostRejectionAckIsRecoveredOnlyFromMatchingOriginalResult() throws Exception {
        Fixture f = new Fixture(); AccountClosureOperationV2.Metadata pending = confirming(f); f.authenticated = false;
        AccountClosureV2Receiver.Reply reply = rejected(); reply.httpStatus = 200;
        AccountClosureOperationV2.Metadata known = f.receive(pending, "result", reply);
        assertNull(known.protocol.pendingRoute); assertTrue(known.protocol.confirmationRejected); assertFalse(known.protocol.released());
    }
    @Test public void failedRejectionCommitKeepsConfirmationUnknown() throws Exception {
        Fixture f = new Fixture(); AccountClosureOperationV2.Metadata pending = confirming(f); f.files.failWrite = true;
        try { f.receive(pending, "confirm", rejected()); fail("Expected atomic failure"); } catch (IOException expected) { }
        f.files.failWrite = false; assertEquals("confirm", f.latest().protocol.pendingRoute); assertFalse(f.latest().protocol.confirmationRejected);
    }
    @Test public void evenDirectConfirmOpenReplyWithoutRejectionProofRemainsUnknown() throws Exception {
        Fixture f = new Fixture(); AccountClosureOperationV2.Metadata pending = confirming(f);
        AccountClosureV2Receiver.Reply open = reply("open", 2); open.challengeGeneration = 1;
        AccountClosureOperationV2.Metadata known = f.receive(pending, "confirm", open);
        assertEquals("confirm", known.protocol.pendingRoute); assertFalse(known.protocol.confirmationRejected);
    }
    @Test public void lostSendAckCanRecoverOnlyMatchingServerCompletedSendAndExpiry() throws Exception {
        Fixture f = new Fixture(); f.registered(); AccountClosureOperationV2.Metadata pending = f.pending("challenge");
        AccountClosureV2Receiver.Reply sent = reply("open", 2); sent.challengeGeneration = 1;
        sent.requestId = PREPARATION; sent.knownSentRequest = true; sent.challengeExpiresAt = 2000000000000L;
        AccountClosureOperationV2.Metadata known = f.receive(pending, "result", sent);
        assertTrue(known.protocol.codeSent); assertNull(known.protocol.pendingRoute); assertEquals(sent.challengeExpiresAt, known.protocol.challengeExpiresAt);
        assertFalse(known.protocol.released()); assertEquals(0, f.stops);
    }
    @Test public void partialOrWrongGenerationSendSummaryCannotGrantResendOrPreparation() throws Exception {
        Fixture f = new Fixture(); f.registered(); AccountClosureOperationV2.Metadata pending = f.pending("challenge");
        AccountClosureV2Receiver.Reply unknown = reply("open", 2); unknown.challengeGeneration = 1;
        AccountClosureOperationV2.Metadata stillUnknown = f.receive(pending, "result", unknown);
        assertEquals("challenge", stillUnknown.protocol.pendingRoute); assertFalse(stillUnknown.protocol.codeSent);
        AccountClosureV2Receiver.Reply otherGeneration = reply("open", 3); otherGeneration.challengeGeneration = 2;
        otherGeneration.requestId = PREPARATION; otherGeneration.knownSentRequest = true; otherGeneration.challengeExpiresAt = 2000000000000L;
        AccountClosureOperationV2.Metadata mismatch = f.receive(stillUnknown, "result", otherGeneration);
        assertEquals("challenge", mismatch.protocol.pendingRoute); assertFalse(mismatch.protocol.codeSent);
    }
    @Test public void cancelledPreparedOwnerStaysPausedUntilExplicitNativeResumeAndNoNewOperationClearsIt() throws Exception {
        Fixture f = new Fixture(); f.registered(); f.store.prepare(f.scope).join();
        AccountClosureOperationV2.Metadata pending = f.pending("cancel");
        AccountClosureOperationV2.Metadata cancelled = f.receive(pending, "cancel", preparation(pending, true, null));
        assertTrue(cancelled.protocol.cancelled); assertTrue(cancelled.protocol.resumeRequired);
        rejects(() -> AccountClosureOperationV2.requireNoCapturedOperation(f.secrets, "native-installation", A));
        f.store.resumeCurrentOwnerAfterCancellation();
        AccountClosureOperationV2.requireNoCapturedOperation(f.secrets, "native-installation", A);
        assertFalse(f.latest().protocol.resumeRequired); assertEquals(1, f.stops);
    }
    @Test public void newCancellationCycleCannotLaunderAnExistingPauseAndBMayNotResumeA() throws Exception {
        Fixture f = new Fixture(); f.registered(); f.store.prepare(f.scope).join();
        AccountClosureOperationV2.Metadata pending = f.pending("cancel");
        f.receive(pending, "cancel", preparation(pending, true, null));
        AccountClosureReceiptStore.Scope nextScope = new AccountClosureReceiptStore.Scope(A, "second-operation");
        AccountClosureOperationV2.Metadata next = f.store.beginOrRestoreOperation(nextScope);
        assertTrue(next.protocol.resumeRequired);
        AccountClosureOperationV2.Metadata cancel = f.store.updateProtocol(nextScope, next.localRevision, next.nativeGeneration, false, state -> state.pendingRoute = "cancel");
        AccountClosureV2Receiver.accept(f.store, nextScope, cancel, "cancel", BACKEND, preparation(cancel, true, null));
        rejects(() -> AccountClosureOperationV2.requireNoCapturedOperation(f.secrets, "native-installation", A));
        f.owner = B; f.store.resumeCurrentOwnerAfterCancellation(); // B has no fence to change.
        f.owner = A; assertTrue(f.store.readForRecovery(nextScope).protocol.resumeRequired);
        f.busy = true; rejects(() -> f.store.resumeCurrentOwnerAfterCancellation()); f.busy = false;
        f.sid = B; f.store.resumeCurrentOwnerAfterCancellation(); // A's explicit new authenticated session may resume only terminal cancellation.
        assertFalse(AccountClosureOperationV2.protectedMetadata(f.secrets, "native-installation", A).protocol.resumeRequired);
        AccountClosureOperationV2.requireNoCapturedOperation(f.secrets, "native-installation", A);
    }
    @Test public void explicitResumeCannotCrossASessionReplacementDuringNativeAdmission() throws Exception {
        Fixture f = new Fixture(); f.registered(); f.store.prepare(f.scope).join();
        AccountClosureOperationV2.Metadata pending = f.pending("cancel");
        f.receive(pending, "cancel", preparation(pending, true, null));
        f.onBusy = () -> f.sid = B;
        rejects(() -> f.store.resumeCurrentOwnerAfterCancellation());
        assertTrue(AccountClosureOperationV2.protectedMetadata(f.secrets, "native-installation", A).protocol.resumeRequired);
    }
    @Test public void bareClosedStateAndMissingReleasePermissionNeverUnseal() throws Exception {
        Fixture f = new Fixture(); f.registered(); AccountClosureOperationV2.Metadata sent = f.pending("cancel");
        AccountClosureOperationV2.Metadata closed = f.receive(sent, "result", reply("closed_before_confirm", 2));
        assertFalse(closed.protocol.cancelled);
        AccountClosureV2Receiver.Reply noAuthority = preparation(closed, true, null); noAuthority.canReleasePreparation = false;
        rejects(() -> f.receive(closed, "result", noAuthority));
        rejects(() -> AccountClosureOperationV2.requireNoCapturedOperation(f.secrets, "native-installation", A));
    }
    @Test public void unregisteredOperationCanAcceptOnlyAuthoritativeBoundCancelTombstone() throws Exception {
        Fixture f = new Fixture(); f.capture(); AccountClosureOperationV2.Metadata sent = f.pending("cancel");
        AccountClosureOperationV2.Metadata cancelled = f.receive(sent, "cancel", preparation(sent, true, null));
        assertTrue(cancelled.protocol.cancelled); assertNull(cancelled.serverGeneration); assertEquals(SERVER, cancelled.serverOperationId);
        AccountClosureOperationV2.requireNoCapturedOperation(f.secrets, "native-installation", A);
        AccountClosureV2Receiver.Reply late = reply("open", 3); rejects(() -> f.receive(cancelled, "result", late));
    }
    @Test public void cancelAckLossCanBeRecoveredByOriginalReceiptResult() throws Exception {
        Fixture f = new Fixture(); f.capture(); AccountClosureOperationV2.Metadata sent = f.pending("cancel"); f.authenticated = false;
        AccountClosureOperationV2.Metadata cancelled = f.receive(sent, "result", preparation(sent, true, null));
        assertTrue(cancelled.protocol.cancelled); assertEquals(0, f.stops);
    }
    @Test public void changedServerOperationOrCountersNeverBecomeAuthority() throws Exception {
        Fixture f = new Fixture(); AccountClosureOperationV2.Metadata registered = f.registered();
        AccountClosureV2Receiver.Reply changed = reply("deleted", 2); changed.operationId = B;
        rejects(() -> f.receive(registered, "result", changed));
        rejects(() -> f.receive(registered, "result", reply("deleted", 1)));
        assertEquals("open", f.latest().protocol.serverState);
    }
    @Test public void cleanupRequiresDeletedNativeDrainAndNeverUsesAnUntrustedCheckpoint() throws Exception {
        Fixture f = new Fixture(); AccountClosureOperationV2.Metadata registered = f.registered(); final int[] erases = {0};
        AccountClosureOperationV2.Cleanup cleanup = new AccountClosureOperationV2.Cleanup() {
            public void erase(int step, String owner) { erases[0]++; }
            public java.util.List<String> retained() { return java.util.Collections.emptyList(); }
        };
        rejects(() -> f.store.cleanDeleted(f.scope, registered, cleanup));
        rejects(() -> f.store.prepareForDeletion(f.scope)); assertEquals(0, erases[0]);
        AccountClosureOperationV2.Metadata deleted = f.receive(registered, "result", reply("deleted", 2));
        rejects(() -> f.store.cleanDeleted(f.scope, deleted, cleanup));
        AccountClosureOperationV2.Metadata drained = f.store.prepareForDeletion(f.scope).join();
        f.busy = true; rejects(() -> f.store.cleanDeleted(f.scope, drained, cleanup)); assertEquals(0, erases[0]);
    }
    @Test public void deletedSignedOutCleanupResumesAtDurableStepAndKeepsPermanentOwnerFence() throws Exception {
        Fixture f = new Fixture(); AccountClosureOperationV2.Metadata registered = f.registered();
        f.receive(registered, "result", reply("deleted", 2)); f.authenticated = false;
        AccountClosureOperationV2.Metadata drained = f.store.prepareForDeletion(f.scope).join(); final int[] calls = {0};
        AccountClosureOperationV2.Cleanup interrupted = new AccountClosureOperationV2.Cleanup() {
            public void erase(int step, String owner) throws Exception { assertEquals(A, owner); calls[0]++; if (step == 2) throw new IOException("interrupted"); }
            public java.util.List<String> retained() { return java.util.Collections.emptyList(); }
        };
        try { f.store.cleanDeleted(f.scope, drained, interrupted); fail("Expected interruption"); } catch (IOException expected) { }
        assertEquals(2, f.latest().protocol.cleanupStep);
        AccountClosureOperationV2.Metadata complete = f.store.cleanDeleted(f.scope, f.latest(), new AccountClosureOperationV2.Cleanup() {
            public void erase(int step, String owner) { assertTrue(step >= 2); calls[0]++; }
            public java.util.List<String> retained() { return Arrays.asList("auth-code-verifier"); }
        });
        assertEquals(4, complete.protocol.cleanupStep); assertEquals(5, calls[0]);
        AccountClosureOperationV2.Metadata finalState = f.store.finalizeDeleted(f.scope, complete);
        assertTrue(finalState.protocol.finalized); assertEquals(1, f.entropy);
        rejects(() -> f.store.nativeReceipt(f.scope, finalState.localRevision, finalState.nativeGeneration, true));
        rejects(() -> AccountClosureOperationV2.requireNoCapturedOperation(f.secrets, "native-installation", A));
        f.authenticated = true;
        rejects(() -> f.store.beginOrRestoreOperation(new AccountClosureReceiptStore.Scope(A, "new-after-deletion")));
    }
    @Test public void switchingToBPreventsEvenTrustedADeletionFromErasingLocalFiles() throws Exception {
        Fixture f = new Fixture(); AccountClosureOperationV2.Metadata registered = f.registered();
        f.receive(registered, "result", reply("deleted", 2)); AccountClosureOperationV2.Metadata drained = f.store.prepareForDeletion(f.scope).join();
        f.owner = B;
        rejects(() -> f.store.cleanDeleted(f.scope, drained, new AccountClosureOperationV2.Cleanup() {
            public void erase(int step, String owner) { fail("B must be untouched"); }
            public java.util.List<String> retained() { fail("B must be untouched"); return null; }
        }));
    }
}
