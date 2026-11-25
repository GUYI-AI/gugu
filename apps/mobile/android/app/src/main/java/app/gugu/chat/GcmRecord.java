package app.gugu.chat;

import java.nio.ByteBuffer;
import java.security.GeneralSecurityException;
import javax.crypto.Cipher;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** The existing host wire format: IV length, random 12-byte IV, ciphertext/tag. */
final class GcmRecord {
    interface Keys { SecretKey get(boolean create) throws Exception; }
    private GcmRecord() {}
    static byte[] encrypt(byte[] plain, byte[] aad, Keys keys) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, keys.get(true));
        cipher.updateAAD(aad);
        byte[] encrypted = cipher.doFinal(plain), iv = cipher.getIV();
        if (iv.length != 12) throw new GeneralSecurityException("Unsupported IV");
        return ByteBuffer.allocate(1 + iv.length + encrypted.length).put((byte) iv.length).put(iv).put(encrypted).array();
    }
    static byte[] decrypt(byte[] body, byte[] aad, Keys keys) throws Exception {
        if (body.length < 29 || body[0] != 12) throw new GeneralSecurityException("Invalid encrypted record");
        ByteBuffer input = ByteBuffer.wrap(body); input.get();
        byte[] iv = new byte[12]; input.get(iv);
        byte[] encrypted = new byte[input.remaining()]; input.get(encrypted);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        // Reading must never regenerate a missing key and overwrite evidence.
        cipher.init(Cipher.DECRYPT_MODE, keys.get(false), new GCMParameterSpec(128, iv));
        cipher.updateAAD(aad);
        return cipher.doFinal(encrypted);
    }
}
