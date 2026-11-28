package app.gugu.chat;

import android.system.Os;
import android.system.OsConstants;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileDescriptor;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;

/** API-24-safe, private atomic replacement. Only ciphertext/authority metadata enter here. */
final class ProtectedFile {
    private ProtectedFile() {}
    static void path(File file) throws Exception {
        if (!file.getAbsoluteFile().equals(file.getCanonicalFile())) throw new IOException("Protected path changed");
    }
    static byte[] read(File file, int limit) throws Exception {
        path(file);
        if (!file.exists()) return null;
        if (!file.isFile() || file.length() > limit) throw new IOException("Invalid protected file");
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        try (FileInputStream input = new FileInputStream(file)) {
            byte[] buffer = new byte[8192]; int count;
            while ((count = input.read(buffer)) != -1) {
                if (bytes.size() + count > limit) throw new IOException("Invalid protected file");
                bytes.write(buffer, 0, count);
            }
        }
        return bytes.toByteArray();
    }
    static void directory(File root) throws Exception {
        path(root);
        boolean created = !root.exists();
        if (created && !root.mkdir()) throw new IOException("Cannot create protected directory");
        if (!root.isDirectory()) throw new IOException("Invalid protected directory");
        Os.chmod(root.getAbsolutePath(), 0700);
        if (created) sync(root.getParentFile());
    }
    static void write(File target, byte[] bytes) throws Exception {
        File root = target.getParentFile(); directory(root); path(target);
        File temporary = File.createTempFile("record-", ".tmp", root);
        try {
            path(temporary); Os.chmod(temporary.getAbsolutePath(), 0600);
            try (FileOutputStream output = new FileOutputStream(temporary)) {
                output.write(bytes); output.getFD().sync();
            }
            path(root); path(target);
            Os.rename(temporary.getAbsolutePath(), target.getAbsolutePath());
            sync(root);
        } finally {
            if (temporary.exists() && !temporary.delete()) throw new IOException("Cannot remove incomplete protected file");
        }
    }
    static void sync(File directory) throws Exception {
        FileDescriptor fd = Os.open(directory.getAbsolutePath(), OsConstants.O_RDONLY | OsConstants.O_NOFOLLOW, 0);
        try { Os.fsync(fd); } finally { Os.close(fd); }
    }
}
