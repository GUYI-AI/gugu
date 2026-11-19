package app.gugu.chat;

/** A visible viewer borrows the Activity's orientation, without changing system rotation settings. */
final class WatchOrientationLease {
    interface Window {
        int requested();
        void request(int orientation);
    }

    private final Window window;
    private String owner;
    private Integer previous;

    WatchOrientationLease(Window window) { this.window = window; }

    void set(String id, int orientation) {
        if (previous == null) previous = window.requested();
        owner = id;
        window.request(orientation);
    }

    boolean release(String id) {
        if (!id.equals(owner)) return false;
        restore();
        return true;
    }

    void restore() {
        if (previous == null) return;
        int orientation = previous;
        owner = null;
        previous = null;
        window.request(orientation);
    }
}
