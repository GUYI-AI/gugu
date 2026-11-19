package app.gugu.chat;

import org.junit.Test;
import static org.junit.Assert.*;

public class WatchOrientationLeaseTest {
    private static class Window implements WatchOrientationLease.Window {
        int orientation = -1;
        public int requested() { return orientation; }
        public void request(int value) { orientation = value; }
    }

    @Test public void restoresTheActualPreviousRequestAfterSwitchingConversations() {
        Window window = new Window();
        window.orientation = 4;
        WatchOrientationLease lease = new WatchOrientationLease(window);
        lease.set("first", 6);
        lease.set("second", 7);
        assertFalse(lease.release("first"));
        assertEquals(7, window.orientation);
        assertTrue(lease.release("second"));
        assertEquals(4, window.orientation);
        assertFalse(lease.release("second"));
    }

    @Test public void destructionRestoresTheWindowAndANewLeaseStartsFromItsCurrentState() {
        Window window = new Window();
        WatchOrientationLease lease = new WatchOrientationLease(window);
        lease.set("first", 6);
        lease.restore();
        assertEquals(-1, window.orientation);
        window.orientation = 5;
        lease.set("second", 6);
        lease.release("second");
        assertEquals(5, window.orientation);
    }
}
