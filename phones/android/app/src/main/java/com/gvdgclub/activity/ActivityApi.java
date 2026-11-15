package com.gvdgclub.activity;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import org.json.JSONObject;

import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

final class ActivityApi {
    record Reply(int status, JSONObject data) { boolean ok() { return status >= 200 && status < 300; } }

    static Reply call(String path, String method, String token, JSONObject body) throws Exception {
        HttpURLConnection request = (HttpURLConnection) new URL(BuildConfig.API_BASE + path).openConnection();
        request.setRequestMethod(method);
        request.setInstanceFollowRedirects(false);
        request.setConnectTimeout(12_000);
        request.setReadTimeout(15_000);
        request.setRequestProperty("Accept", "application/json");
        request.setRequestProperty("Cache-Control", "no-store");
        if (token != null) request.setRequestProperty("Authorization", "Bearer " + token);
        try {
            if (body != null) {
                byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
                request.setRequestProperty("Content-Type", "application/json");
                request.setFixedLengthStreamingMode(bytes.length);
                request.setDoOutput(true);
                try (var output = request.getOutputStream()) { output.write(bytes); }
            }
            int status = request.getResponseCode();
            try (InputStream input = status < 400 ? request.getInputStream() : request.getErrorStream()) {
                if (input == null) return new Reply(status, new JSONObject());
                var output = new java.io.ByteArrayOutputStream();
                byte[] chunk = new byte[4096];
                int count;
                while ((count = input.read(chunk)) != -1) {
                    if (output.size() + count > 128_000) throw new IllegalStateException("invalid_reply");
                    output.write(chunk, 0, count);
                }
                return new Reply(status, new JSONObject(new String(output.toByteArray(), StandardCharsets.UTF_8)));
            }
        } finally { request.disconnect(); }
    }

    static final class Credentials {
        private static final String ALIAS = "gvdg-activity-phone-v1";
        private static final String TRANSFORM = "AES/GCM/NoPadding";
        private final SharedPreferences prefs;

        Credentials(Context context) { prefs = context.getSharedPreferences("activity-credential", Context.MODE_PRIVATE); }

        String token() throws Exception {
            String encrypted = prefs.getString("ciphertext", "");
            if (encrypted == null || encrypted.isEmpty()) return null;
            Cipher cipher = Cipher.getInstance(TRANSFORM);
            cipher.init(Cipher.DECRYPT_MODE, key(false), new GCMParameterSpec(128, Base64.decode(prefs.getString("iv", ""), Base64.DEFAULT)));
            return new String(cipher.doFinal(Base64.decode(encrypted, Base64.DEFAULT)), StandardCharsets.UTF_8);
        }

        void token(String token) throws Exception {
            if (token == null) {
                if (!prefs.edit().clear().commit()) throw new IllegalStateException("credential_write_failed");
                return;
            }
            if (!token.matches("gvdga_[A-Za-z0-9_-]{43}")) throw new IllegalStateException("invalid_credential");
            Cipher cipher = Cipher.getInstance(TRANSFORM);
            cipher.init(Cipher.ENCRYPT_MODE, key(true));
            String iv = Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP);
            String encrypted = Base64.encodeToString(cipher.doFinal(token.getBytes(StandardCharsets.UTF_8)), Base64.NO_WRAP);
            if (!prefs.edit().putString("ciphertext", encrypted).putString("iv", iv).commit())
                throw new IllegalStateException("credential_write_failed");
        }

        private static SecretKey key(boolean create) throws Exception {
            KeyStore keys = KeyStore.getInstance("AndroidKeyStore");
            keys.load(null);
            if (keys.containsAlias(ALIAS)) return (SecretKey) keys.getKey(ALIAS, null);
            if (!create) throw new IllegalStateException("credential_key_unavailable");
            KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
            generator.init(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setKeySize(256).build());
            return generator.generateKey();
        }
    }
}
