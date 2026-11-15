package com.gvdgclub.wear;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.nio.charset.StandardCharsets;

final class WatchApi {
    private static final int MAX_BODY = 512_000;

    record Reply(int status, JSONObject data) {
        boolean ok() { return status >= 200 && status < 300; }

        boolean retry() { return status == 0 || status == 429 || status >= 500; }

        String error() { return data.optString("error"); }
    }

    static Reply request(String method, String path, String token, JSONObject body) {
        HttpURLConnection request = null;
        try {
            request = (HttpURLConnection) URI.create(BuildConfig.API_BASE + path).toURL().openConnection();
            request.setInstanceFollowRedirects(false);
            request.setUseCaches(false);
            request.setConnectTimeout(8_000);
            request.setReadTimeout(8_000);
            request.setRequestMethod(method);
            request.setRequestProperty("Accept", "application/json");
            if (!token.isEmpty()) request.setRequestProperty("Authorization", "Bearer " + token);
            if (body != null) {
                byte[] payload = body.toString().getBytes(StandardCharsets.UTF_8);
                request.setDoOutput(true);
                request.setRequestProperty("Content-Type", "application/json");
                request.setFixedLengthStreamingMode(payload.length);
                try (OutputStream out = request.getOutputStream()) {
                    out.write(payload);
                }
            }
            int status = request.getResponseCode();
            InputStream stream = status < 400 ? request.getInputStream() : request.getErrorStream();
            if (stream == null) return new Reply(status, new JSONObject());
            try (InputStream input = stream) {
                byte[] chunk = new byte[2048];
                ByteArrayOutputStream result = new ByteArrayOutputStream();
                for (int read; (read = input.read(chunk)) != -1; ) {
                    if (result.size() + read > MAX_BODY) throw new IOException("Response too large");
                    result.write(chunk, 0, read);
                }
                String json = result.toString(StandardCharsets.UTF_8.name());
                return new Reply(status, json.isEmpty() ? new JSONObject() : new JSONObject(json));
            }
        } catch (Exception ignored) {
            // A malformed acknowledgement is retried with the same sequenced payload.
            return new Reply(0, new JSONObject());
        } finally {
            if (request != null) request.disconnect();
        }
    }
}
