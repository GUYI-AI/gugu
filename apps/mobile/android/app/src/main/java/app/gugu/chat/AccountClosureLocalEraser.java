package app.gugu.chat;

import java.io.File;
import java.io.IOException;
import java.util.UUID;

/** Fixed native owner roots. No root or relative path is accepted from JavaScript. */
final class AccountClosureLocalEraser {
    interface Sync { void directory(File directory) throws Exception; }
    private final File files, noBackup;
    private final Sync sync;
    AccountClosureLocalEraser(File files, File noBackup, Sync sync) throws IOException {
        this.files = files.getCanonicalFile(); this.noBackup = noBackup.getCanonicalFile(); this.sync = sync;
    }
    void erase(int step, String owner) throws Exception {
        if (owner == null || !UUID.fromString(owner).toString().equals(owner)) throw new AccountClosureReceiptStore.Failure("invalid_scope");
        File base;
        switch (step) {
            case 0: base = new File(files, "phone-agent"); break;
            case 1: base = new File(noBackup, "phone-agent-host"); break;
            case 2: base = new File(noBackup, "phone-agent-runtime"); break;
            default: throw new AccountClosureReceiptStore.Failure("invalid_scope");
        }
        requireDirectory(base.getParentFile());
        if (!base.exists()) return;
        requireDirectory(base);
        File target = new File(base, owner);
        if (!target.getAbsoluteFile().equals(target.getCanonicalFile())) throw new IOException("Owner storage path changed");
        if (!target.exists()) return;
        requireDirectory(target);
        remove(target, 0);
        sync.directory(base);
    }
    private static void requireDirectory(File path) throws IOException {
        if (!path.getAbsoluteFile().equals(path.getCanonicalFile()) || !path.isDirectory()) throw new IOException("Owner storage path changed");
    }
    private static void remove(File path, int depth) throws IOException {
        if (depth > 128) throw new IOException("Owner storage exceeds supported depth");
        // A link inside the stopped owner's tree belongs to that tree, its
        // destination does not. Unlink the entry itself; never enumerate it.
        boolean link = !path.getAbsoluteFile().equals(path.getCanonicalFile());
        if (!link && path.isDirectory()) {
            File[] children = path.listFiles();
            if (children == null) throw new IOException("Cannot inspect owner storage");
            for (File child : children) remove(child, depth + 1);
        }
        if (!path.delete()) throw new IOException("Cannot clear owner storage");
    }
}
