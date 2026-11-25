package app.gugu.chat;

import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import java.security.KeyStore;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;

/** Key generation is serialized; aliases remain purpose-specific. API 23+. */
final class PlatformSecretKey {
    private PlatformSecretKey() {}
    static synchronized SecretKey get(String alias, boolean create) throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore"); store.load(null);
        if (store.containsAlias(alias)) {
            SecretKey key = (SecretKey) store.getKey(alias, null);
            if (key == null) throw new AuthStorageFailure("key_missing", true);
            return key;
        }
        if (!create) throw new AuthStorageFailure("key_missing", true);
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setKeySize(256).setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setRandomizedEncryptionRequired(true).build());
        return generator.generateKey();
    }
}
