package com.gvdgclub.wear;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Typeface;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.view.Gravity;
import android.view.InputDevice;
import android.view.MotionEvent;
import android.view.View;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class ScoreActivity extends Activity {
    private static final int GREEN = Color.rgb(175, 241, 174);
    private static final int MUTED = Color.rgb(181, 201, 188);
    private static final int QUEUE_LIMIT = 180;
    private static final int LOCATION_PERMISSION = 1;
    private final ExecutorService network = Executors.newSingleThreadExecutor();
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable nextSync = this::sync;
    private final Runnable rangeTick = new Runnable() {
        @Override public void run() {
            if (!active || !rangeEnabled) return;
            updateRangeReadout();
            handler.postDelayed(this, 5_000);
        }
    };
    private WatchStore journal;
    private WatchStore.State session;
    private ScrollView scroll;
    private LinearLayout content;
    private TextView rangeReadout;
    private int holeOffset;
    private boolean active;
    private boolean inFlight;
    private boolean storageFailed;
    private String notice = "";
    private LocationManager locationManager;
    private Location fix;
    private Location throwStart;
    private Integer lastThrowFeet;
    private boolean rangeEnabled;

    private final LocationListener locationListener = location -> {
        if (fix == null || fix.getElapsedRealtimeNanos() < location.getElapsedRealtimeNanos()) fix = location;
        updateRangeReadout();
    };

    @Override public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        journal = new WatchStore(this);
        locationManager = getSystemService(LocationManager.class);
        try {
            session = journal.read();
        } catch (Exception failure) {
            session = WatchStore.State.empty();
            storageFailed = true;
            notice = "Saved card could not be opened.";
        }
        holeOffset = savedInstanceState != null ? savedInstanceState.getInt("holeOffset") : startingOffset();
        render(false);
    }

    @Override protected void onSaveInstanceState(Bundle state) {
        super.onSaveInstanceState(state);
        state.putInt("holeOffset", holeOffset);
    }

    @Override protected void onStart() {
        super.onStart();
        active = true;
        if (rangeEnabled) startLocation();
        sync();
    }

    @Override protected void onStop() {
        active = false;
        handler.removeCallbacks(nextSync);
        stopLocation();
        super.onStop();
    }

    @Override protected void onDestroy() {
        network.shutdownNow();
        super.onDestroy();
    }

    private boolean save(WatchStore.State proposed) {
        try {
            if (!journal.write(proposed)) throw new IllegalStateException("Journal commit failed");
            session = proposed;
            storageFailed = false;
            return true;
        } catch (Exception failure) {
            storageFailed = true;
            notice = "Watch storage is unavailable. Free space, then retry.";
            return false;
        }
    }

    private void sync() {
        handler.removeCallbacks(nextSync);
        if (!active || inFlight || session.token().isEmpty() || !session.blocked().isEmpty() || storageFailed) return;
        JSONObject head = session.queue().optJSONObject(0);
        if (head == null) fetchCard(false);
        else request("POST", "/watch/score", session.token(), head, reply -> updateScore(head, reply));
    }

    private void schedule(long milliseconds) {
        if (active) {
            handler.removeCallbacks(nextSync);
            handler.postDelayed(nextSync, milliseconds);
        }
    }

    private interface Receive { void response(WatchApi.Reply reply); }

    private void request(String method, String path, String token, JSONObject body, Receive receive) {
        inFlight = true;
        network.execute(() -> {
            WatchApi.Reply reply = WatchApi.request(method, path, token, body);
            handler.post(() -> {
                if (isDestroyed()) return;
                inFlight = false;
                receive.response(reply);
            });
        });
    }

    private void beginPairing() {
        if (inFlight || storageFailed) return;
        notice = "Requesting a code…";
        request("POST", "/watch/pairings", "", null, reply -> {
            JSONObject data = reply.data();
            if (reply.ok() && !data.optString("token").isEmpty() && data.optString("code").length() == 8) {
                if (save(new WatchStore.State(data.optString("token"), data.optString("code"), data.optLong("expiresAt"),
                        null, new JSONArray(), ""))) {
                    notice = "";
                    schedule(3_000);
                }
            } else notice = reply.status() == 429 ? "Try again in a few minutes." : "Connect the watch to request a code.";
            render(false);
        });
        render(false);
    }

    private void fetchCard(boolean discardQueue) {
        request("GET", "/watch/card", session.token(), null, reply -> {
            if (reply.ok() && reply.data().optJSONArray("holes") != null && reply.data().optJSONArray("targets") != null) {
                boolean firstCard = session.card() == null;
                JSONArray queue = discardQueue ? new JSONArray() : session.queue();
                String blocked = discardQueue ? "" : session.blocked();
                boolean changed = firstCard || !reply.data().toString().equals(session.card().toString()) || discardQueue;
                notice = "";
                if (changed && save(session.withCard(reply.data(), queue, blocked)) && firstCard) holeOffset = startingOffset();
                // A score can be entered while the GET is in flight. Its existing precondition stays intact.
                schedule(session.queue().length() == 0 ? 15_000 : 0);
            } else if (reply.error().equals("watch_pairing_pending")) {
                notice = "";
                schedule(3_000);
            } else if (reply.retry() || reply.ok()) {
                notice = session.card() == null ? "Connect the watch to finish pairing." : "Offline. New scores stay on this watch.";
                schedule(reply.status() == 429 ? 60_000 : 12_000);
            } else if (session.card() == null) {
                if (save(WatchStore.State.empty())) notice = "Pairing expired. Request a fresh code.";
            } else {
                block(reply.error(), reply.status());
            }
            render(true);
        });
    }

    private void updateScore(JSONObject head, WatchApi.Reply reply) {
        long sequence = head.optLong("sequence");
        if (reply.ok() && reply.data().optLong("sequence") == sequence) {
            try {
                JSONObject card = new JSONObject(session.card().toString());
                card.put("lastSequence", sequence);
                JSONObject target = findTarget(card.optJSONArray("targets"), head.optString("targetId"));
                if (target != null) {
                    JSONObject votes = target.getJSONObject("votes");
                    String hole = head.getString("hole");
                    if (head.isNull("strokes")) votes.remove(hole);
                    else votes.put(hole, head.get("strokes"));
                }
                JSONArray remaining = new JSONArray();
                for (int index = 1; index < session.queue().length(); index++) remaining.put(session.queue().get(index));
                notice = "";
                if (save(session.withCard(card, remaining, ""))) schedule(0);
            } catch (JSONException failure) {
                storageFailed = true;
                notice = "Saved score could not be updated. Reopen GVDG to retry.";
            }
        } else if (reply.retry() || reply.ok()) {
            notice = "Scores saved on this watch. Waiting to sync.";
            schedule(reply.status() == 429 ? 60_000 : 12_000);
        } else {
            block(reply.error(), reply.status());
        }
        render(true);
    }

    private void block(String error, int status) {
        String reason = switch (error) {
            case "watch_score_conflict" -> "This score changed on the phone. Review both versions before syncing.";
            case "watch_card_changed", "watch_round_changed", "not_on_card" -> "Your card changed. Check the current scores on your phone.";
            case "card_locked", "not_live" -> "The card is closed. Review your saved edits on the watch.";
            case "watch_target_changed", "no_target" -> "Players on this card changed. Review your saved edits.";
            default -> status == 401 ? "Watch access ended. Review your saved edits, then pair again." : "A saved score needs review.";
        };
        save(session.withBlock(reason));
    }

    private void edit(JSONObject target, int hole, Integer strokes) {
        if (storageFailed || !session.blocked().isEmpty()) return;
        JSONArray queue = session.queue();
        if (queue.length() >= QUEUE_LIMIT) {
            notice = "Sync the saved scores before adding more.";
            render(true);
            return;
        }
        Integer previous = displayedVote(target, hole);
        if (java.util.Objects.equals(previous, strokes)) return;
        try {
            JSONObject last = queue.optJSONObject(queue.length() - 1);
            long sequence = last == null ? session.card().optLong("lastSequence") : last.getLong("sequence");
            JSONObject operation = new JSONObject();
            operation.put("sequence", sequence + 1);
            operation.put("targetId", target.getString("id"));
            operation.put("binding", target.getString("binding"));
            operation.put("hole", hole);
            operation.put("previous", previous == null ? JSONObject.NULL : previous);
            operation.put("strokes", strokes == null ? JSONObject.NULL : strokes);
            JSONArray next = new JSONArray(queue.toString()).put(operation);
            if (save(session.withQueue(next))) sync();
        } catch (JSONException failure) {
            notice = "The score could not be saved.";
        }
        render(true);
    }

    private Integer displayedVote(JSONObject target, int hole) {
        JSONArray queue = session.queue();
        for (int index = queue.length() - 1; index >= 0; index--) {
            JSONObject operation = queue.optJSONObject(index);
            if (operation != null && operation.optInt("hole") == hole && operation.optString("targetId").equals(target.optString("id")) &&
                    operation.optString("binding").equals(target.optString("binding"))) {
                return operation.isNull("strokes") ? null : operation.optInt("strokes");
            }
        }
        JSONObject votes = target.optJSONObject("votes");
        String key = Integer.toString(hole);
        return votes == null || votes.isNull(key) ? null : votes.optInt(key);
    }

    private static JSONObject findTarget(JSONArray targets, String id) {
        if (targets == null) return null;
        for (int index = 0; index < targets.length(); index++) {
            JSONObject target = targets.optJSONObject(index);
            if (target != null && target.optString("id").equals(id)) return target;
        }
        return null;
    }

    private int startingOffset() {
        if (session.card() == null) return 0;
        int start = session.card().optInt("startingHole");
        JSONArray holes = session.card().optJSONArray("holes");
        if (holes == null) return 0;
        for (int index = 0; index < holes.length(); index++) if (holes.optJSONObject(index).optInt("hole") == start) return index;
        return 0;
    }

    private JSONObject currentHole() {
        if (session.card() == null) return null;
        JSONArray holes = session.card().optJSONArray("holes");
        if (holes == null || holes.length() == 0) return null;
        return holes.optJSONObject(holeOffset % holes.length());
    }

    private void render(boolean retainScroll) {
        int previous = retainScroll && scroll != null ? scroll.getScrollY() : 0;
        scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        scroll.setVerticalScrollBarEnabled(false);
        content = new LinearLayout(this);
        content.setOrientation(LinearLayout.VERTICAL);
        content.setGravity(Gravity.CENTER_HORIZONTAL);
        content.setPadding(dp(18), dp(23), dp(18), dp(21));
        scroll.addView(content);
        rangeReadout = null;
        JSONObject hole = currentHole();
        if (hole == null) renderPairing();
        else renderScorecard(hole);
        setContentView(scroll);
        if (previous > 0) scroll.post(() -> scroll.scrollTo(0, previous));
    }

    private void renderPairing() {
        content.addView(label("GVDG", 22, GREEN, true));
        if (session.code().isEmpty()) {
            content.addView(label("Pair your watch", 16, Color.WHITE, true));
            content.addView(button("Get a code", !inFlight && !storageFailed, this::beginPairing));
        } else {
            String code = session.code();
            content.addView(label(code.substring(0, 4) + " " + code.substring(4), 24, Color.WHITE, true));
            content.addView(label("Enter at " + getString(R.string.pair_site) + " in your scorecard’s Pair a watch menu.", 14, MUTED, false));
            content.addView(button("Check pairing", !inFlight, this::sync));
            content.addView(button("New code", !inFlight, this::beginPairing));
        }
        if (!notice.isEmpty()) content.addView(label(notice, 14, MUTED, false));
        if (storageFailed) content.addView(button("Clear watch data", true, this::confirmClear));
    }

    private void renderScorecard(JSONObject hole) {
        JSONObject card = session.card();
        int number = hole.optInt("hole");
        int par = hole.optInt("par", 3);
        boolean putting = card.optString("scoringStyle").equals("putting");
        content.addView(label(card.optString("courseName", "GVDG"), 13, GREEN, false));
        content.addView(label((putting ? "Station " : "Hole ") + number + (putting ? "" : " · Par " + par), 20, Color.WHITE, true));
        int length = card.optJSONArray("holes").length();
        LinearLayout navigation = new LinearLayout(this);
        addWeighted(navigation, button("Previous", length > 1, () -> moveHole(-1)));
        addWeighted(navigation, button("Next", length > 1, () -> moveHole(1)));
        content.addView(navigation);

        if (!putting) {
            rangeReadout = label("", 14, GREEN, false);
            content.addView(rangeReadout);
            updateRangeReadout();
            if (rangeEnabled) content.addView(button("Stop GPS", true, this::disableLocation));
            else if (hole.optJSONObject("basket") != null) content.addView(button("GPS range", true, this::enableLocation));
        }

        boolean editable = !card.optBoolean("locked") && session.blocked().isEmpty() && !storageFailed;
        JSONArray targets = card.optJSONArray("targets");
        for (int index = 0; index < targets.length(); index++) {
            JSONObject target = targets.optJSONObject(index);
            if (target != null) addScoreRow(target, number, par, putting, editable);
        }
        int pending = session.queue().length();
        if (pending > 0) content.addView(label(pending + (pending == 1 ? " edit saved" : " edits saved") + " on watch", 14, GREEN, true));
        if (!notice.isEmpty()) content.addView(label(notice, 14, MUTED, false));
        if (!session.blocked().isEmpty()) {
            content.addView(label(session.blocked(), 14, MUTED, true));
            if (pending > 0) content.addView(button("Saved edits", true, this::showPending));
            content.addView(button("Load phone scores", !inFlight, this::confirmDiscard));
        } else if (card.optBoolean("locked")) {
            content.addView(label("Card closed", 14, MUTED, true));
        }
        if (storageFailed) content.addView(button("Retry storage", true, () -> {
            if (save(session)) sync();
            render(true);
        }));
        if (!putting) {
            content.addView(button(throwStart == null ? "Measure throw" : "Finish measurement", true, this::measureThrow));
            if (lastThrowFeet != null) content.addView(label("Last measured throw · " + lastThrowFeet + " ft", 14, MUTED, false));
        }
        if (!session.blocked().isEmpty() || card.optBoolean("locked") || pending == 0) {
            content.addView(button("Clear this card", !inFlight, this::confirmClear));
        }
    }

    private void addScoreRow(JSONObject target, int hole, int par, boolean putting, boolean editable) {
        String name = target.optString("name", "Player");
        Integer current = displayedVote(target, hole);
        JSONObject consensus = target.optJSONObject("scores");
        String key = Integer.toString(hole);
        String other = current == null && consensus != null && !consensus.isNull(key) ? " · Card " + consensus.optInt(key) : "";
        JSONArray conflicts = target.optJSONArray("conflicts");
        for (int index = 0; conflicts != null && index < conflicts.length(); index++) {
            if (conflicts.optInt(index) == hole) other = " · Check card";
        }
        content.addView(label(name + other, 14, Color.WHITE, true));
        int min = putting ? 0 : 1;
        int max = putting ? Math.min(10, par) : 30;
        int seed = putting ? 0 : par;
        LinearLayout row = new LinearLayout(this);
        row.setGravity(Gravity.CENTER);
        Button down = button("−", editable && current != null && current > min, () -> edit(target, hole, current - 1));
        down.setContentDescription("Lower score for " + name);
        Button value = button(current == null ? "–" : current.toString(), editable, () -> chooseScore(target, hole, min, max));
        value.setContentDescription("Set score for " + name + ", " + (current == null ? "unentered" : current));
        Button up = button("+", editable && (current == null || current < max), () -> edit(target, hole, current == null ? seed : current + 1));
        up.setContentDescription("Raise score for " + name);
        addWeighted(row, down);
        addWeighted(row, value);
        addWeighted(row, up);
        content.addView(row);
    }

    private void chooseScore(JSONObject target, int hole, int min, int max) {
        String[] values = new String[max - min + 1];
        for (int index = 0; index < values.length; index++) values[index] = String.valueOf(index + min);
        new AlertDialog.Builder(this).setTitle(target.optString("name", "Score"))
                .setItems(values, (dialog, selected) -> edit(target, hole, selected + min))
                .setNeutralButton("Clear score", (dialog, which) -> edit(target, hole, null))
                .setNegativeButton("Cancel", null).show();
    }

    private void showPending() {
        JSONArray queue = session.queue();
        String[] lines = new String[queue.length()];
        for (int index = 0; index < queue.length(); index++) {
            JSONObject operation = queue.optJSONObject(index);
            JSONObject target = findTarget(session.card().optJSONArray("targets"), operation.optString("targetId"));
            String name = target == null ? "Player" : target.optString("name", "Player");
            lines[index] = "Hole " + operation.optInt("hole") + " · " + name + " · " +
                    (operation.isNull("strokes") ? "Cleared" : operation.optInt("strokes"));
        }
        new AlertDialog.Builder(this).setTitle("Saved on watch").setItems(lines, null).setPositiveButton("Close", null).show();
    }

    private void confirmDiscard() {
        if (session.queue().length() == 0) {
            fetchCard(true);
            return;
        }
        new AlertDialog.Builder(this).setTitle("Use phone scores?")
                .setMessage("Connecting will replace the saved edits on this watch with the current card.")
                .setNegativeButton("Keep edits", null)
                .setPositiveButton("Use phone scores", (dialog, which) -> fetchCard(true)).show();
    }

    private void confirmClear() {
        String message = session.queue().length() > 0 ? "This removes the scores waiting on this watch." : "Pair a new code to score again.";
        new AlertDialog.Builder(this).setTitle("Clear saved card?").setMessage(message).setNegativeButton("Cancel", null)
                .setPositiveButton("Clear card", (dialog, which) -> {
                    if (save(WatchStore.State.empty())) {
                        holeOffset = 0;
                        notice = "";
                        throwStart = null;
                        lastThrowFeet = null;
                        rangeEnabled = false;
                        stopLocation();
                    }
                    render(false);
                }).show();
    }

    private void moveHole(int direction) {
        int count = session.card().optJSONArray("holes").length();
        holeOffset = (holeOffset + count + direction) % count;
        render(false);
    }

    private void enableLocation() {
        if (!locationAllowed()) {
            requestPermissions(new String[]{Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION}, LOCATION_PERMISSION);
            return;
        }
        rangeEnabled = true;
        startLocation();
        render(true);
    }

    private boolean locationAllowed() {
        return checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED ||
                checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    private void disableLocation() {
        rangeEnabled = false;
        throwStart = null;
        stopLocation();
        render(true);
    }

    @Override public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(requestCode, permissions, results);
        if (requestCode != LOCATION_PERMISSION) return;
        if (locationAllowed()) enableLocation();
        else {
            notice = "Location permission is needed for watch distance tools.";
            render(true);
        }
    }

    private void startLocation() {
        if (!active || !locationAllowed() || locationManager == null) return;
        try {
            locationManager.removeUpdates(locationListener);
            for (String provider : locationManager.getProviders(true)) {
                if (provider.equals(LocationManager.PASSIVE_PROVIDER)) continue;
                if (provider.equals(LocationManager.GPS_PROVIDER) &&
                        checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) continue;
                locationManager.requestLocationUpdates(provider, 4_000, 2, locationListener, Looper.getMainLooper());
            }
            handler.removeCallbacks(rangeTick);
            handler.post(rangeTick);
        } catch (SecurityException ignored) {
            rangeEnabled = false;
        }
    }

    private void stopLocation() {
        if (locationManager != null) locationManager.removeUpdates(locationListener);
        handler.removeCallbacks(rangeTick);
        fix = null;
    }

    private boolean freshLocation() {
        return fix != null && fix.hasAccuracy() && fix.getAccuracy() <= 20 &&
                SystemClock.elapsedRealtimeNanos() - fix.getElapsedRealtimeNanos() <= 20_000_000_000L;
    }

    private void updateRangeReadout() {
        JSONObject hole = currentHole();
        if (hole == null || rangeReadout == null) return;
        JSONObject basket = hole.optJSONObject("basket");
        if (basket != null && rangeEnabled && freshLocation()) {
            Location target = new Location("basket");
            target.setLatitude(basket.optDouble("lat"));
            target.setLongitude(basket.optDouble("lng"));
            rangeReadout.setText(feet(fix.distanceTo(target)) + " ft to basket");
        } else if (basket != null && rangeEnabled) rangeReadout.setText(
                locationManager != null && !locationManager.isLocationEnabled() ? "Turn on watch location" : "Waiting for a precise GPS fix");
        else if (!hole.isNull("distanceFt")) rangeReadout.setText(hole.optInt("distanceFt") + " ft listed");
        else rangeReadout.setText("");
    }

    private void measureThrow() {
        if (!rangeEnabled) {
            enableLocation();
            return;
        }
        if (!freshLocation()) {
            notice = "Wait for an accurate GPS fix, then tap again.";
        } else if (throwStart == null) {
            throwStart = new Location(fix);
            notice = "Walk to the disc, then finish the measurement.";
        } else {
            lastThrowFeet = feet(throwStart.distanceTo(fix));
            throwStart = null;
            notice = "";
        }
        render(true);
    }

    private static int feet(float metres) { return Math.round(metres * 3.28084f); }

    @Override public boolean onGenericMotionEvent(MotionEvent event) {
        if (event.getAction() == MotionEvent.ACTION_SCROLL && event.isFromSource(InputDevice.SOURCE_ROTARY_ENCODER)) {
            scroll.smoothScrollBy(0, (int) (-event.getAxisValue(MotionEvent.AXIS_SCROLL) * dp(38)));
            return true;
        }
        return super.onGenericMotionEvent(event);
    }

    private int dp(int amount) { return Math.round(amount * getResources().getDisplayMetrics().density); }

    private TextView label(String value, int size, int color, boolean bold) {
        TextView label = new TextView(this);
        label.setText(value);
        label.setTextSize(size);
        label.setTextColor(color);
        label.setGravity(Gravity.CENTER);
        label.setPadding(dp(2), dp(3), dp(2), dp(3));
        if (bold) label.setTypeface(null, Typeface.BOLD);
        return label;
    }

    private Button button(String value, boolean enabled, Runnable click) {
        Button button = new Button(this);
        button.setText(value);
        button.setTextSize(13);
        button.setAllCaps(false);
        button.setMinWidth(0);
        button.setMinimumWidth(0);
        button.setMinimumHeight(dp(45));
        button.setPadding(dp(4), 0, dp(4), 0);
        button.setEnabled(enabled);
        button.setOnClickListener(view -> click.run());
        return button;
    }

    private void addWeighted(LinearLayout row, View view) {
        row.addView(view, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1));
    }
}
