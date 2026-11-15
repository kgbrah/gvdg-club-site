package com.gvdgclub.activity;

import android.content.Context;
import android.util.AtomicFile;
import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileNotFoundException;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.List;
import java.util.UUID;

final class TrackJournal {
    private static TrackJournal instance;
    private final File directory;
    private final AtomicFile active;
    private final AtomicFile settings;

    static synchronized TrackJournal get(Context context) {
        if (instance == null) instance = new TrackJournal(context.getApplicationContext());
        return instance;
    }

    private TrackJournal(Context context) {
        directory = new File(context.getNoBackupFilesDir(), "activity");
        active = new AtomicFile(new File(directory, "active.json"));
        settings = new AtomicFile(new File(directory, "settings.json"));
    }

    private AtomicFile snapshot(String clientId) { return new AtomicFile(new File(directory, clientId + ".json")); }

    static JSONObject copy(JSONObject original) throws Exception { return new JSONObject(original.toString()); }
    static JSONObject binding(JSONObject device) throws Exception {
        JSONObject round = device == null ? null : device.optJSONObject("round");
        if (round == null || device.optLong("expiresAt") <= System.currentTimeMillis() || !"live".equals(round.optString("status"))) return null;
        return new JSONObject().put("key", round.getString("key")).put("generation", round.getString("generation"));
    }

    synchronized JSONObject current() throws Exception {
        JSONObject round = read(active);
        if (round != null && round.has("stoppedAt")) {
            commit(snapshot(round.getString("clientId")), round);
            active.delete();
            return null;
        }
        return round;
    }

    synchronized JSONObject start(String owner, JSONObject device, long now) throws Exception {
        if (current() != null) throw new IllegalStateException("active_track");
        JSONObject round = binding(device);
        JSONObject record = new JSONObject().put("version", 1).put("clientId", UUID.randomUUID().toString())
                .put("ownerId", owner == null ? JSONObject.NULL : owner).put("startedAt", now)
                .put("round", round == null ? JSONObject.NULL : round)
                .put("state", "tracking").put("newSegment", true).put("segments", new JSONArray());
        commit(active, record);
        return record;
    }

    synchronized void setTracking(boolean enabled) throws Exception {
        JSONObject record = current();
        if (record == null) return;
        if (enabled && System.currentTimeMillis() >= record.getLong("startedAt") + RouteMath.MAX_DURATION_MS)
            throw new IllegalStateException("activity_duration_limit");
        record.put("state", enabled ? "tracking" : "paused").put("newSegment", true);
        commit(active, record);
    }

    synchronized void sample(RouteMath.Point point) throws Exception {
        JSONObject record = current();
        if (record == null || !"tracking".equals(record.optString("state")) || point.at() < record.getLong("startedAt")) return;
        if (point.at() >= record.getLong("startedAt") + RouteMath.MAX_DURATION_MS || pointCount(record) >= RouteMath.MAX_POINTS)
            throw new IllegalStateException("activity_duration_limit");
        JSONArray segments = record.getJSONArray("segments");
        JSONArray lastSegment = segments.length() > 0 ? segments.getJSONArray(segments.length() - 1) : null;
        RouteMath.Point last = lastSegment != null && lastSegment.length() > 0 ? point(lastSegment.getJSONObject(lastSegment.length() - 1)) : null;
        if (last != null && point.at() <= last.at()) return;
        boolean split = last == null || record.optBoolean("newSegment") || point.at() - last.at() > RouteMath.GAP_MS;
        if (!split && point.at() - last.at() < 10_000) return;
        if (split) {
            lastSegment = new JSONArray();
            segments.put(lastSegment);
        }
        lastSegment.put(new JSONObject().put("at", point.at()).put("lat", point.lat()).put("lng", point.lng()).put("accuracyM", point.accuracyM()));
        record.put("newSegment", false);
        commit(active, record);
    }

    synchronized void stop() throws Exception {
        JSONObject record = current();
        if (record == null) return;
        long startedAt = record.getLong("startedAt");
        long end = Math.max(startedAt, Math.min(System.currentTimeMillis(), startedAt + RouteMath.MAX_DURATION_MS));
        for (JSONArray segment : segments(record)) end = Math.max(end, segment.getJSONObject(segment.length() - 1).getLong("at"));
        record.put("state", "stopped").put("stoppedAt", end);
        commit(active, record);
        commit(snapshot(record.getString("clientId")), record);
        active.delete();
    }

    synchronized List<JSONObject> list(String owner) throws Exception {
        current();
        List<JSONObject> records = new ArrayList<>();
        File[] files = directory.listFiles((dir, name) -> name.matches("[a-f0-9-]{36}[.]json"));
        if (files != null) for (File file : files) {
            JSONObject record = read(new AtomicFile(file));
            if (record != null && (record.isNull("ownerId") || record.optString("ownerId").equals(owner))) records.add(record);
        }
        records.sort(Comparator.comparingLong((JSONObject row) -> row.optLong("startedAt")).reversed());
        return records;
    }

    synchronized JSONObject prepare(String clientId, String owner) throws Exception {
        AtomicFile file = snapshot(clientId);
        JSONObject record = read(file);
        if (record == null || owner == null || (!record.isNull("ownerId") && !owner.equals(record.optString("ownerId"))))
            throw new IllegalStateException("activity_owner_mismatch");
        if (record.isNull("ownerId")) {
            record.put("ownerId", owner);
            commit(file, record);
        }
        return payload(record);
    }

    synchronized void acknowledge(String clientId, String owner, long serverId) throws Exception {
        AtomicFile file = snapshot(clientId);
        JSONObject record = read(file);
        if (record == null || !owner.equals(record.optString("ownerId"))) throw new IllegalStateException("activity_owner_mismatch");
        record.put("serverId", serverId);
        commit(file, record);
    }

    synchronized void remove(String clientId, String owner) throws Exception {
        AtomicFile file = snapshot(clientId);
        JSONObject record = read(file);
        if (record != null && (record.isNull("ownerId") || owner != null && owner.equals(record.optString("ownerId")))) file.delete();
    }

    synchronized JSONObject settings() throws Exception {
        JSONObject row = read(settings);
        return row == null ? new JSONObject() : row;
    }

    synchronized void settings(JSONObject value) throws Exception { commit(settings, value); }

    static JSONObject payload(JSONObject record) throws Exception {
        return new JSONObject().put("version", 1).put("clientId", record.getString("clientId"))
                .put("ownerId", record.opt("ownerId")).put("startedAt", record.getLong("startedAt"))
                .put("stoppedAt", record.getLong("stoppedAt")).put("round", record.opt("round"))
                .put("segments", record.getJSONArray("segments"));
    }

    static int pointCount(JSONObject track) throws Exception {
        int count = 0;
        for (JSONArray segment : segments(track)) count += segment.length();
        return count;
    }

    static long meters(JSONObject track) throws Exception {
        double sum = 0;
        for (JSONArray segment : segments(track)) {
            RouteMath.Point previous = null;
            for (int index = 0; index < segment.length(); index++) {
                RouteMath.Point point = point(segment.getJSONObject(index));
                sum += RouteMath.distance(previous, point);
                previous = point;
            }
        }
        return Math.round(sum);
    }

    private static RouteMath.Point point(JSONObject sample) throws Exception {
        return new RouteMath.Point(sample.getLong("at"), sample.getDouble("lat"), sample.getDouble("lng"), sample.getDouble("accuracyM"));
    }

    private static List<JSONArray> segments(JSONObject track) throws Exception {
        List<JSONArray> result = new ArrayList<>();
        JSONArray rows = track.getJSONArray("segments");
        for (int index = 0; index < rows.length(); index++) result.add(rows.getJSONArray(index));
        return result;
    }

    private static JSONObject read(AtomicFile file) throws Exception {
        try { return new JSONObject(new String(file.readFully(), StandardCharsets.UTF_8)); }
        catch (FileNotFoundException missing) { return null; }
    }

    private void commit(AtomicFile file, JSONObject record) throws Exception {
        if (!directory.isDirectory() && !directory.mkdirs()) throw new IllegalStateException("activity_storage_unavailable");
        byte[] data = record.toString().getBytes(StandardCharsets.UTF_8);
        FileOutputStream output = file.startWrite();
        try {
            output.write(data);
            file.finishWrite(output);
        } catch (Exception failure) {
            file.failWrite(output);
            throw failure;
        }
        if (!Arrays.equals(file.readFully(), data)) throw new IllegalStateException("activity_write_unconfirmed");
    }
}
