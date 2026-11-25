package app.gugu.chat;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;

/** Instrumentation IO must run on minSdk 24, before java.nio.file.Files exists. */
final class NativeTestFiles {
    static byte[] read(File file) throws Exception {
        try (FileInputStream input = new FileInputStream(file); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192]; int count;
            while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count);
            return output.toByteArray();
        }
    }
    static void move(File from, File to) throws java.io.IOException {
        try { android.system.Os.rename(from.getPath(), to.getPath()); }
        catch (android.system.ErrnoException error) { throw new java.io.IOException("Test file move failed", error); }
    }
    static void write(File file, byte[] bytes) throws Exception {
        try (FileOutputStream output = new FileOutputStream(file)) { output.write(bytes); output.getFD().sync(); }
    }
}
