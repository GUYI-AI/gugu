package app.gugu.chat;

import org.junit.Test;
import java.io.IOException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import static org.junit.Assert.*;

public class AccountClosureReceiptStoreTest {
    private static final String A = "11111111-1111-4111-8111-111111111111", B = "22222222-2222-4222-8222-222222222222";
    private interface Attempt { void run() throws Exception; }
    private static void reject(String code, Attempt run) throws Exception {
        try { run.run(); fail("Expected rejection " + code); }
        catch (AccountClosureReceiptStore.Failure error) { assertEquals(code, error.code); }
    }
    private static final class MemorySecrets implements AccountClosureReceiptStore.Secrets {
        final Map<String, byte[]> values = new HashMap<>();
        boolean failRead, failWrite;
        @Override public byte[] read(String key) throws Exception {
            if (failRead) throw new IOException("injected read failure");
            byte[] value = values.get(key); return value == null ? null : value.clone();
        }
        @Override public void write(String key, byte[] value) throws Exception {
            if (failWrite) { failWrite = false; throw new IOException("injected write failure"); }
            values.put(key, value.clone());
        }
    }
    private static final class Fixture {
        final MemorySecrets secrets = new MemorySecrets();
        final Map<String, String> data = new HashMap<>();
        String owner = A, installation = "install-one";
        boolean prepared = true, draining, failCheckpoint;
        int effects;
        final List<AccountClosureReceiptStore.Step> steps = new ArrayList<>();
        Fixture() {
            data.put(A, "A private bytes"); data.put(B, "B unchanged bytes");
            steps.add(scope -> { effects++; data.remove(scope.ownerId); if (failCheckpoint) { failCheckpoint = false; secrets.failWrite = true; } return true; });
        }
        AccountClosureReceiptStore open() {
            return new AccountClosureReceiptStore(this, secrets, () -> installation, () -> owner,
                scope -> { if (!prepared) throw new AccountClosureReceiptStore.Failure("closure_not_prepared"); return !draining; },
                steps, () -> Arrays.asList("shared-incoming-file-cache"));
        }
        AccountClosureReceiptStore.Scope a() throws Exception { return new AccountClosureReceiptStore.Scope(A, "opaque/../operation:A"); }
    }
    @Test public void missingContextIsNotAnEmptyReceiptOrSuccessfulErase() throws Exception {
        Fixture f = new Fixture(); AccountClosureReceiptStore store = f.open();
        reject("closure_context_missing", () -> store.get(f.a()));
        reject("closure_context_missing", () -> store.remove(f.a()));
        reject("closure_context_missing", () -> store.eraseLocal(f.a()));
        assertEquals(0, f.effects);
    }
    @Test public void localOwnerAndCapturedScopeAreRequiredEvenAfterAccountSwitch() throws Exception {
        Fixture f = new Fixture(); AccountClosureReceiptStore store = f.open(); store.put(f.a(), "opaque-A");
        f.owner = B;
        reject("wrong_local_owner", () -> store.put(f.a(), "opaque-A"));
        reject("wrong_local_owner", () -> store.get(f.a()));
        reject("wrong_local_owner", () -> store.remove(f.a()));
        reject("wrong_local_owner", () -> store.eraseLocal(f.a()));
        assertEquals("B unchanged bytes", f.data.get(B)); assertEquals("A private bytes", f.data.get(A));
    }
    @Test public void opaqueOperationDoesNotBecomeAPathAndRepeatedPutIsIdempotent() throws Exception {
        Fixture f = new Fixture(); AccountClosureReceiptStore store = f.open();
        store.put(f.a(), "opaque\nUnicode回执"); store.put(f.a(), "opaque\nUnicode回执");
        assertEquals("opaque\nUnicode回执", store.get(f.a())); assertEquals(1, f.secrets.values.size());
        assertTrue(f.secrets.values.keySet().iterator().next().matches("[a-f0-9]{64}"));
        reject("scope_conflict", () -> store.put(f.a(), "another-receipt"));
    }
    @Test public void unpreparedRefusesEveryStepAndPendingRetainsTheReceipt() throws Exception {
        Fixture f = new Fixture(); AccountClosureReceiptStore store = f.open(); store.put(f.a(), "opaque-A");
        f.prepared = false; reject("closure_not_prepared", () -> store.eraseLocal(f.a())); assertEquals(0, f.effects);
        f.prepared = true; f.draining = true;
        assertEquals("pending", store.eraseLocal(f.a()).status); assertEquals("opaque-A", store.get(f.a())); assertEquals(0, f.effects);
    }
    @Test public void deleteOnlyCapturedOwnerAndKeepTombstoneForRepeatedCompletion() throws Exception {
        Fixture f = new Fixture(); AccountClosureReceiptStore store = f.open(); store.put(f.a(), "opaque-A");
        f.owner = null;
        AccountClosureReceiptStore.Outcome result = store.eraseLocal(f.a());
        assertEquals("complete", result.status); assertEquals(Arrays.asList("shared-incoming-file-cache"), result.retainedUnattributed);
        assertNull(f.data.get(A)); assertEquals("B unchanged bytes", f.data.get(B));
        store.remove(f.a()); store.remove(f.a()); assertNull(store.get(f.a()));
        assertEquals("complete", store.eraseLocal(f.a()).status); assertEquals(1, f.effects);
    }
    @Test public void removingReceiptBeforeCompletionCannotAuthorizeErasure() throws Exception {
        Fixture f = new Fixture(); AccountClosureReceiptStore store = f.open(); store.put(f.a(), "opaque-A"); store.remove(f.a());
        reject("receipt_missing", () -> store.eraseLocal(f.a())); assertEquals(0, f.effects);
    }
    @Test public void interruptionAfterEffectBeforeCheckpointRepeatsOnlyIdempotentStep() throws Exception {
        Fixture f = new Fixture(); AccountClosureReceiptStore first = f.open(); first.put(f.a(), "opaque-A"); f.failCheckpoint = true;
        reject("closure_storage_unavailable", () -> first.eraseLocal(f.a())); assertNull(f.data.get(A));
        AccountClosureReceiptStore restarted = f.open(); assertEquals("opaque-A", restarted.get(f.a()));
        assertEquals("complete", restarted.eraseLocal(f.a()).status); assertEquals(2, f.effects); assertEquals("B unchanged bytes", f.data.get(B));
    }
    @Test public void storageFaultsDoNotBecomeMissingValuesOrSuccess() throws Exception {
        Fixture f = new Fixture(); AccountClosureReceiptStore store = f.open();
        f.secrets.failWrite = true; reject("closure_storage_unavailable", () -> store.put(f.a(), "opaque-A")); assertTrue(f.secrets.values.isEmpty());
        store.put(f.a(), "opaque-A"); f.secrets.failRead = true;
        reject("closure_storage_unavailable", () -> store.get(f.a())); reject("closure_storage_unavailable", () -> store.eraseLocal(f.a())); assertEquals(0, f.effects);
    }
    @Test public void malformedScopeAndInvalidUnicodeAreRejected() throws Exception {
        Fixture f = new Fixture();
        reject("invalid_scope", () -> new AccountClosureReceiptStore.Scope(A, ""));
        reject("invalid_scope", () -> new AccountClosureReceiptStore.Scope("../other", "operation"));
        reject("invalid_scope", () -> new AccountClosureReceiptStore.Scope(A, "\ud800"));
        reject("invalid_scope", () -> f.open().put(f.a(), "\ud800"));
    }
}
