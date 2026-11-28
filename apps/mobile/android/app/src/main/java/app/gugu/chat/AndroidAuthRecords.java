package app.gugu.chat;

import android.content.Context;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Map;

/** The only physical canonical-login record. Keys and plaintext never enter preferences. */
final class AndroidAuthRecords implements AuthStorageMigration.Records {
    private final File root, target, marker;
    private final AuthStorageRecord codec;
    private final byte[] authority;
    AndroidAuthRecords(Context context) throws Exception {
        String installation = GuguPhoneInstallation.identity(context).key;
        // Android may expose /data/user/0 through an OS-managed symlink. Trust the
        // canonical sandbox root, then reject symlinks inside our own directory.
        File base = context.getNoBackupFilesDir().getCanonicalFile();
        ProtectedFile.sync(new File(base, "phone-installation"));
        ProtectedFile.sync(base);
        root = new File(base, "gugu-auth");
        ProtectedFile.directory(root);
        target = new File(root, "state.enc"); marker = new File(root, "authority.v1");
        authority = ("gugu-auth-authority-v1\n" + context.getPackageName() + "\n" + installation + "\n").getBytes(StandardCharsets.UTF_8);
        codec = new AuthStorageRecord(context.getPackageName(), installation,
            create -> PlatformSecretKey.get("gugu-auth-storage-v1", create), AndroidAuthStore::ownerOf);
    }
    @Override public Map<String, String> read() throws Exception {
        byte[] markerBytes = ProtectedFile.read(marker, 1024);
        if (markerBytes != null && !Arrays.equals(markerBytes, authority)) throw new AuthStorageFailure("authority_invalid", true);
        byte[] bytes = ProtectedFile.read(target, AuthStorageRecord.MAX_BYTES);
        if (bytes == null) {
            if (markerBytes != null) throw new AuthStorageFailure("record_missing", true);
            return null;
        }
        return codec.decrypt(bytes);
    }
    @Override public void write(Map<String, String> values) throws Exception {
        byte[] bytes = codec.encrypt(values);
        ProtectedFile.write(target, bytes);
        // This is a fresh final-file read, not a comparison with the write buffer.
        Map<String, String> saved = read();
        if (!values.equals(saved)) throw new AuthStorageFailure("readback_mismatch", false);
    }
    @Override public void markAuthority() throws Exception {
        byte[] before = ProtectedFile.read(marker, 1024);
        if (before != null && !Arrays.equals(before, authority)) throw new AuthStorageFailure("authority_invalid", true);
        if (before == null) ProtectedFile.write(marker, authority);
        if (!Arrays.equals(ProtectedFile.read(marker, 1024), authority)) throw new AuthStorageFailure("authority_readback_failed", false);
        File[] temporary = root.listFiles((directory, name) -> name.startsWith("record-") && name.endsWith(".tmp"));
        if (temporary == null) throw new AuthStorageFailure("temporary_cleanup_failed", false);
        for (File file : temporary) {
            ProtectedFile.path(file);
            if (!file.isFile() || !file.delete()) throw new AuthStorageFailure("temporary_cleanup_failed", false);
        }
        ProtectedFile.sync(root);
    }
}
