package app.gugu.chat;

import android.content.Context;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.system.Os;
import android.system.OsConstants;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileDescriptor;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** AndroidKeyStore-backed AES-GCM records live only under no_backup. */
final class AccountClosureEncryptedFiles implements AccountClosureReceiptStore.Secrets {
    private static final String ALIAS = "gugu-account-closure-v1";
    private final File root;
    private final String installation;
    AccountClosureEncryptedFiles(Context context, String installation) throws Exception {
        this.installation = installation;
        File parent = context.getNoBackupFilesDir().getCanonicalFile();
        requirePath(parent);
        root = new File(parent, "account-closure");
        if (!root.exists() && !root.mkdir()) throw new java.io.IOException("Cannot create protected storage");
        requirePath(root);
    }
    @Override public synchronized byte[] read(String key) throws Exception {
        File target = target(key);
        if (!target.exists()) return null;
        if (!target.isFile() || target.length() < 33 || target.length() > 100100) throw new java.io.IOException("Invalid protected record");
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        try (FileInputStream input = new FileInputStream(target)) {
            byte[] buffer = new byte[8192]; int count;
            while ((count = input.read(buffer)) != -1) {
                bytes.write(buffer, 0, count);
                if (bytes.size() > 100100) throw new java.io.IOException("Invalid protected record");
            }
        }
        ByteBuffer body = ByteBuffer.wrap(bytes.toByteArray());
        if (body.getInt() != 1 || body.get() != 12) throw new java.io.IOException("Invalid protected record");
        byte[] iv = new byte[12]; body.get(iv);
        byte[] encrypted = new byte[body.remaining()]; body.get(encrypted);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, key(false), new GCMParameterSpec(128, iv));
        cipher.updateAAD(aad(key));
        return cipher.doFinal(encrypted);
    }
    @Override public synchronized void write(String key, byte[] bytes) throws Exception {
        if (bytes.length > 100000) throw new java.io.IOException("Invalid protected record");
        File target = target(key);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, key(true)); cipher.updateAAD(aad(key));
        byte[] encrypted = cipher.doFinal(bytes), iv = cipher.getIV();
        if (iv.length != 12) throw new java.io.IOException("Unsupported protected record IV");
        byte[] envelope = ByteBuffer.allocate(5 + iv.length + encrypted.length).putInt(1).put((byte) iv.length).put(iv).put(encrypted).array();
        File temporary = File.createTempFile("record-", ".tmp", root);
        try {
            requirePath(temporary);
            try (FileOutputStream output = new FileOutputStream(temporary)) { output.write(envelope); output.getFD().sync(); }
            requirePath(root); requirePath(target);
            Os.rename(temporary.getAbsolutePath(), target.getAbsolutePath());
            FileDescriptor directory = Os.open(root.getAbsolutePath(), OsConstants.O_RDONLY | OsConstants.O_DIRECTORY | OsConstants.O_NOFOLLOW, 0);
            try { Os.fsync(directory); } finally { Os.close(directory); }
        } finally {
            if (temporary.exists() && !temporary.delete()) throw new java.io.IOException("Cannot remove incomplete protected record");
        }
    }
    private File target(String key) throws Exception {
        if (key == null || !key.matches("[a-f0-9]{64}")) throw new java.io.IOException("Invalid protected record key");
        requirePath(root);
        File target = new File(root, key + ".enc"); requirePath(target); return target;
    }
    private byte[] aad(String key) { return ("gugu-account-closure-v1\u0000" + installation + "\u0000" + key).getBytes(StandardCharsets.UTF_8); }
    private static void requirePath(File file) throws Exception {
        if (!file.getAbsoluteFile().equals(file.getCanonicalFile())) throw new java.io.IOException("Protected storage path changed");
    }
    private static synchronized SecretKey key(boolean create) throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore"); store.load(null);
        if (store.containsAlias(ALIAS)) return (SecretKey) store.getKey(ALIAS, null);
        if (!create) throw new java.io.IOException("Protected storage key is missing");
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());
        return generator.generateKey();
    }
}
