package app.gugu.chat;

import java.util.concurrent.CompletableFuture;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.Test;
import static org.junit.Assert.*;

public class PhoneAgentOwnerRunsTest {
    @Test public void returningToAWaitsForItsSupersededRunAndDoesNotStopB() {
        PhoneAgentOwnerRuns runs = new PhoneAgentOwnerRuns();
        CompletableFuture<Void> oldA = new CompletableFuture<>(), currentB = new CompletableFuture<>();
        AtomicInteger stoppedA = new AtomicInteger(), stoppedB = new AtomicInteger();
        runs.add("A", oldA, stoppedA::incrementAndGet);
        runs.add("B", currentB, stoppedB::incrementAndGet);
        CompletableFuture<Void> prepared = runs.stopAndAwait("A");
        assertEquals(1, stoppedA.get()); assertEquals(0, stoppedB.get());
        assertTrue(runs.busy("A")); assertFalse(prepared.isDone());
        oldA.complete(null); prepared.join();
        assertFalse(runs.busy("A")); assertTrue(runs.busy("B"));
    }
    @Test public void allAsPredecessorsNeedProofNotJustItsNewestRun() {
        PhoneAgentOwnerRuns runs = new PhoneAgentOwnerRuns();
        CompletableFuture<Void> first = new CompletableFuture<>(), newest = new CompletableFuture<>();
        runs.add("A", first, () -> {}); runs.add("A", newest, () -> {});
        CompletableFuture<Void> prepared = runs.stopAndAwait("A");
        newest.complete(null); assertFalse(prepared.isDone()); assertTrue(runs.busy("A"));
        first.complete(null); prepared.join(); assertFalse(runs.busy("A"));
    }
    @Test public void failedAndCancelledExitProofsRemainUnsafe() {
        for (boolean cancel : new boolean[] { false, true }) {
            PhoneAgentOwnerRuns runs = new PhoneAgentOwnerRuns();
            CompletableFuture<Void> exit = new CompletableFuture<>();
            runs.add("A", exit, () -> {});
            if (cancel) exit.cancel(false); else exit.completeExceptionally(new IllegalStateException("exit unproven"));
            assertTrue(runs.busy("A")); assertTrue(runs.stopAndAwait("A").isCompletedExceptionally());
        }
    }
    @Test public void inlineExitCompletionCannotReenterWhileTheRegistryIsLocked() {
        PhoneAgentOwnerRuns runs = new PhoneAgentOwnerRuns();
        CompletableFuture<Void> exit = new CompletableFuture<>();
        runs.add("A", exit, () -> {
            assertFalse(Thread.holdsLock(runs));
            exit.complete(null);
        });
        runs.stopAndAwait("A").join(); assertFalse(runs.busy("A"));
    }
    @Test public void aFailedStopStillAttemptsEveryOtherOwnedRunAndNeverReturnsSuccess() {
        PhoneAgentOwnerRuns runs = new PhoneAgentOwnerRuns();
        AtomicInteger stops = new AtomicInteger();
        CompletableFuture<Void> first = new CompletableFuture<>(), second = new CompletableFuture<>();
        runs.add("A", first, () -> { first.complete(null); throw new IllegalStateException("stop failed"); });
        runs.add("A", second, () -> { stops.incrementAndGet(); second.complete(null); });
        assertTrue(runs.stopAndAwait("A").isCompletedExceptionally()); assertEquals(1, stops.get());
    }
    @Test public void anArrivalAfterTheDrainSnapshotStillPreventsReadiness() {
        PhoneAgentOwnerRuns runs = new PhoneAgentOwnerRuns();
        assertTrue(runs.stopAndAwait("A").isDone());
        CompletableFuture<Void> late = new CompletableFuture<>(); runs.add("A", late, () -> {});
        assertTrue(runs.busy("A")); late.complete(null); assertFalse(runs.busy("A"));
    }
}
