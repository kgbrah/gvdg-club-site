package com.gvdgclub.wear;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import org.json.JSONArray;
import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

final class WatchStore {
    private static final String ALIAS = "gvdg-watch-token-v1";
    private static final String TRANSFORM = "AES/GCM/NoPadding";
    private final SharedPreferences storage;

    WatchStore(Context context) {
        storage = context.getSharedPreferences("score-journal", Context.MODE_PRIVATE);
    }

    record State(String token, String code, long expiresAt, JSONObject card, JSONArray queue, String blocked) {
        static State empty() {
            return new State("", "", 0, null, new JSONArray(), "");
        }

        State withQueue(JSONArray nextQueue) {
            return new State(token, code, expiresAt, card, nextQueue, blocked);
        }

        State withBlock(String error) {
            return new State(token, code, expiresAt, card, queue, error);
        }

        State withCard(JSONObject nextCard, JSONArray nextQueue, String error) {
            return new State(token, "", nextCard.optLong("expiresAt", expiresAt), nextCard, nextQueue, error);
        }
    }

    State read() throws Exception {
        JSONObject state = new JSONObject(storage.getString("state", "{}"));
        JSONArray queue = state.optJSONArray("queue");
        String token = state.optString("ciphertext");
        if (!token.isEmpty()) {
            Cipher cipher = Cipher.getInstance(TRANSFORM);
            cipher.init(Cipher.DECRYPT_MODE, key(false), new GCMParameterSpec(128, decode(state.getString("iv"))));
            token = new String(cipher.doFinal(decode(token)), StandardCharsets.UTF_8);
        }
        return new State(token, state.optString("code"), state.optLong("expiresAt"), state.optJSONObject("card"),
                queue == null ? new JSONArray() : queue, state.optString("blocked"));
    }

    boolean write(State state) throws Exception {
        JSONObject saved = new JSONObject();
        if (!state.token().isEmpty()) {
            Cipher cipher = Cipher.getInstance(TRANSFORM);
            cipher.init(Cipher.ENCRYPT_MODE, key(true));
            saved.put("iv", encode(cipher.getIV()));
            saved.put("ciphertext", encode(cipher.doFinal(state.token().getBytes(StandardCharsets.UTF_8))));
        }
        saved.put("code", state.code());
        saved.put("expiresAt", state.expiresAt());
        saved.put("card", state.card());
        saved.put("queue", state.queue());
        saved.put("blocked", state.blocked());
        return storage.edit().putString("state", saved.toString()).commit();
    }

    private static SecretKey key(boolean create) throws Exception {
        KeyStore keys = KeyStore.getInstance("AndroidKeyStore");
        keys.load(null);
        if (keys.containsAlias(ALIAS)) return (SecretKey) keys.getKey(ALIAS, null);
        if (!create) throw new IllegalStateException("Watch key unavailable");
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build());
        return generator.generateKey();
    }

    private static String encode(byte[] value) { return Base64.encodeToString(value, Base64.NO_WRAP); }

    private static byte[] decode(String value) { return Base64.decode(value, Base64.DEFAULT); }
}
