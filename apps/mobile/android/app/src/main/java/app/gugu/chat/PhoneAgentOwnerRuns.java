package app.gugu.chat;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;

/** Current is a UI/routing choice, never proof that a predecessor has exited. */
final class PhoneAgentOwnerRuns {
    private static final class Entry {
        final String owner;
        final CompletableFuture<Void> exited;
        final Runnable stop;
        Entry(String owner, CompletableFuture<Void> exited, Runnable stop) { this.owner = owner; this.exited = exited; this.stop = stop; }
        boolean unproven() { return !exited.isDone() || exited.isCompletedExceptionally() || exited.isCancelled(); }
    }
    private final List<Entry> entries = new ArrayList<>();

    void add(String owner, CompletableFuture<Void> exited, Runnable stop) {
        Entry entry = new Entry(owner, exited, stop);
        synchronized (this) { entries.add(entry); }
        exited.whenComplete((ignored, error) -> {
            if (error == null && !exited.isCancelled()) synchronized (this) { entries.remove(entry); }
        });
    }
    synchronized boolean busy(String owner) {
        for (Entry entry : entries) if (owner.equals(entry.owner) && entry.unproven()) return true;
        return false;
    }
    CompletableFuture<Void> stopAndAwait(String owner) {
        List<Entry> owned = new ArrayList<>();
        synchronized (this) {
            for (Entry entry : entries) if (owner.equals(entry.owner) && entry.unproven()) owned.add(entry);
        }
        List<CompletableFuture<Void>> proofs = new ArrayList<>();
        // No callbacks under this monitor: stop/report/exit can re-enter native
        // auth or service locks, and future completion can run inline.
        for (Entry entry : owned) {
            proofs.add(entry.exited);
            try { entry.stop.run(); }
            catch (RuntimeException failure) {
                CompletableFuture<Void> refused = new CompletableFuture<>();
                refused.completeExceptionally(failure); proofs.add(refused);
            }
        }
        return CompletableFuture.allOf(proofs.toArray(new CompletableFuture<?>[0]));
    }
}
