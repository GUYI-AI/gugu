package app.gugu.chat;

import org.junit.Test;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import static org.junit.Assert.*;

/** Real migration state machine with injected persistence failures, no Android/Keystore claim. */
public class AuthStorageMigrationTest {
    private static final String MAIN = "sb-main", TEMP = "sb-main-code-verifier", PENDING = "sb-main-oauth-pending";
    private static final AuthStorageRecord.Owner OWNER = value -> {
        if (value == null || value.equals("retired")) return null;
        if (!value.startsWith("owner:")) throw new AuthStorageFailure("legacy_envelope_invalid", true);
        return value.split(":")[1];
    };
    private static class Fixture implements AuthStorageMigration.Records {
        final Object lock = new Object();
        Map<String, String> secure, old = new LinkedHashMap<>();
        boolean authority, failWrite, mismatch, failRead, failMark, failClear;
        int writes, clears;
        final AuthStorageMigration.Legacy legacy = new AuthStorageMigration.Legacy() {
            @Override public Map<String, String> read() { return new LinkedHashMap<>(old); }
            @Override public void clear() throws Exception { Fixture.this.clear(); }
        };
        AuthStorageMigration store() { return new AuthStorageMigration(lock, this, legacy, OWNER); }
        @Override public Map<String, String> read() throws Exception {
            if (failRead || secure == null && authority) throw new AuthStorageFailure("record_unreadable", true);
            return secure == null ? null : new LinkedHashMap<>(secure);
        }
        @Override public void write(Map<String, String> value) throws Exception {
            writes++;
            if (failWrite) throw new AuthStorageFailure("write_failed", false);
            secure = new LinkedHashMap<>(value);
            if (mismatch) secure.put(MAIN, "owner:wrong:PRIVATE_OLD_CANARY");
        }
        @Override public void markAuthority() throws Exception {
            if (failMark) throw new AuthStorageFailure("marker_failed", false);
            authority = true;
        }
        public void clear() throws Exception {
            clears++;
            if (failClear) throw new AuthStorageFailure("cleanup_failed", false);
            old.clear();
        }
    }
    private static Fixture legacySession() {
        Fixture f = new Fixture(); f.old.put(MAIN, "owner:A:PRIVATE_ACCESS_REFRESH_CANARY");
        f.old.put(TEMP, "PRIVATE_PKCE_CANARY"); f.old.put(PENDING, "PRIVATE_PENDING_CANARY"); return f;
    }
    @Test public void upgradeRetainsEveryByteAndTemporaryValueAcrossColdReopenWithoutRefresh() throws Exception {
        Fixture f = legacySession(); Map<String, String> before = new LinkedHashMap<>(f.old);
        assertEquals(before.get(MAIN), f.store().get(MAIN));
        assertEquals(before, f.secure); assertTrue(f.old.isEmpty()); assertTrue(f.authority);
        assertEquals(before.get(TEMP), f.store().get(TEMP));
        assertEquals(before.get(PENDING), f.store().get(PENDING)); assertEquals(1, f.writes);
    }
    @Test public void writeReadbackAndAuthorityFailuresNeverClearTheOnlyLegacyCopy() throws Exception {
        for (String phase : Arrays.asList("write", "readback", "marker")) {
            Fixture f = legacySession(); Map<String, String> before = new LinkedHashMap<>(f.old);
            f.failWrite = phase.equals("write"); f.mismatch = phase.equals("readback"); f.failMark = phase.equals("marker");
            try { f.store().get(MAIN); fail(phase); } catch (AuthStorageFailure expected) { }
            assertEquals(before, f.old); assertEquals(0, f.clears);
        }
    }
    @Test public void interruptedCommitAndFailedCleanupResumeFromCiphertextNotStaleLegacy() throws Exception {
        Fixture f = legacySession(); f.failClear = true;
        try { f.store().get(MAIN); fail(); } catch (AuthStorageFailure expected) { }
        assertFalse(f.old.isEmpty()); assertEquals("owner:A:PRIVATE_ACCESS_REFRESH_CANARY", f.secure.get(MAIN));
        f.old.put(MAIN, "owner:stale:PRIVATE_OLD_CANARY"); f.failClear = false;
        assertEquals("owner:A:PRIVATE_ACCESS_REFRESH_CANARY", f.store().get(MAIN));
        assertTrue(f.old.isEmpty()); assertEquals(1, f.writes);
    }
    @Test public void corruptedOrMissingSecureRecordIsNotAbsenceAndNeverImportsOldSession() throws Exception {
        for (boolean missing : new boolean[] {false, true}) {
            Fixture f = legacySession(); f.authority = true; f.failRead = !missing;
            if (!missing) f.secure = new LinkedHashMap<>(f.old);
            try { f.store().get(MAIN); fail(); } catch (AuthStorageFailure expected) { assertTrue(expected.recovery); }
            assertEquals(0, f.writes); assertEquals(0, f.clears); assertFalse(f.old.isEmpty());
        }
    }
    @Test public void retiredAndSwitchedAuthorityWinOverRestoredLegacyAndTemporaryRemovalKeepsSession() throws Exception {
        Fixture f = legacySession(); AuthStorageMigration store = f.store(); store.get(MAIN);
        store.put(MAIN, "owner:B:PRIVATE_NEW_CANARY"); f.old.put(MAIN, "owner:A:PRIVATE_OLD_CANARY");
        assertEquals("owner:B:PRIVATE_NEW_CANARY", f.store().get(MAIN));
        store.removeTemporary(TEMP);
        assertNull(store.get(TEMP)); assertEquals("owner:B:PRIVATE_NEW_CANARY", store.get(MAIN));
        store.put(MAIN, "retired"); f.old.put(MAIN, "owner:A:PRIVATE_OLD_CANARY");
        assertEquals("retired", f.store().get(MAIN)); assertTrue(f.old.isEmpty());
        try { store.removeTemporary(MAIN); fail(); } catch (AuthStorageFailure expected) { }
    }
    @Test public void preloginPkceSurvivesWithoutInventingOwnerOrSession() throws Exception {
        Fixture f = new Fixture(); f.old.put(TEMP, "PRIVATE_PKCE_CANARY");
        assertNull(f.store().get(MAIN)); assertEquals("PRIVATE_PKCE_CANARY", f.store().get(TEMP));
        f.store().put(PENDING, "attempt"); assertNull(f.store().get(MAIN));
        f.store().put(MAIN, "owner:A:session"); assertEquals("PRIVATE_PKCE_CANARY", f.store().get(TEMP));
    }
    @Test public void invalidLegacyStaysUntouchedInsteadOfBecomingSignedOut() throws Exception {
        Fixture f = legacySession(); f.old.put(MAIN, "malformed");
        try { f.store().get(MAIN); fail(); } catch (AuthStorageFailure expected) { }
        assertEquals("malformed", f.old.get(MAIN)); assertNull(f.secure); assertEquals(0, f.clears);
    }
    @Test public void concurrentFirstReadAndRefreshCannotPublishAStaleMigrationSnapshot() throws Exception {
        Fixture f = legacySession(); ExecutorService pool = Executors.newFixedThreadPool(2);
        CountDownLatch committed = new CountDownLatch(1), finish = new CountDownLatch(1);
        AuthStorageMigration.Records blocked = new AuthStorageMigration.Records() {
            @Override public Map<String, String> read() throws Exception { return f.read(); }
            @Override public void write(Map<String, String> values) throws Exception {
                f.write(values); committed.countDown();
                if (!finish.await(5, TimeUnit.SECONDS)) throw new AssertionError("Migration gate timed out");
            }
            @Override public void markAuthority() throws Exception { f.markAuthority(); }
        };
        try {
            Future<String> migration = pool.submit(() -> new AuthStorageMigration(f.lock, blocked, f.legacy, OWNER).get(MAIN));
            assertTrue(committed.await(5, TimeUnit.SECONDS));
            Future<?> refresh = pool.submit(() -> { f.store().put(MAIN, "owner:A:PRIVATE_REFRESHED_CANARY"); return null; });
            finish.countDown(); assertEquals("owner:A:PRIVATE_ACCESS_REFRESH_CANARY", migration.get(5, TimeUnit.SECONDS)); refresh.get(5, TimeUnit.SECONDS);
            assertEquals("owner:A:PRIVATE_REFRESHED_CANARY", f.store().get(MAIN)); assertTrue(f.old.isEmpty());
        } finally { finish.countDown(); pool.shutdownNow(); }
    }
    @Test public void failureMessagesOfferOneActionAndContainNoInternalReasonOrCanary() {
        assertEquals("请重试", new AuthStorageFailure("legacy_clear_failed", false).getMessage());
        assertEquals("请联系支持恢复登录", new AuthStorageFailure("key_missing", true).getMessage());
        assertNull(new AuthStorageFailure("record_unreadable", true).getCause());
    }
}
