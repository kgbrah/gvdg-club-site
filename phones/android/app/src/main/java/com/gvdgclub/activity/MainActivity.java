package com.gvdgclub.activity;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.res.ColorStateList;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.view.WindowInsets;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.text.DateFormat;
import java.util.Date;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class MainActivity extends Activity {
    private static final int PAPER = Color.rgb(255, 248, 243);
    private static final int INK = Color.rgb(39, 32, 29);
    private static final int MUTED = Color.rgb(92, 76, 69);
    private static final int ACCENT = Color.rgb(174, 52, 21);
    private static final int SOFT = Color.rgb(248, 231, 219);
    private static final int NEUTRAL = Color.rgb(236, 226, 220);
    private static final int LOCATION = 71;
    private static final int NOTIFICATIONS = 72;
    private static final int EXPORT = 73;
    private final ExecutorService network = Executors.newSingleThreadExecutor();
    private TrackJournal journal;
    private ActivityApi.Credentials credentials;
    private LinearLayout body;
    private TextView readout;
    private TextView range;
    private TextView notice;
    private String lastStage = "";
    private String screen = "record";
    private String status = "";
    private String requestedStart;
    private JSONObject pendingExport;
    private boolean busy;

    @Override public void onCreate(Bundle saved) {
        super.onCreate(saved);
        journal = TrackJournal.get(this);
        credentials = new ActivityApi.Credentials(this);
        render();
    }

    @Override public void onResume() {
        super.onResume();
        TrackingService.changed = this::updateStatus;
        render();
    }

    @Override public void onPause() {
        TrackingService.changed = null;
        super.onPause();
    }

    @Override public void onDestroy() {
        network.shutdownNow();
        super.onDestroy();
    }

    private int dp(float value) { return Math.round(getResources().getDisplayMetrics().density * value); }

    private GradientDrawable background(int color, float radius) {
        GradientDrawable result = new GradientDrawable();
        result.setCornerRadius(dp(radius));
        result.setColor(color);
        return result;
    }

    private TextView text(String value, float size, int color, boolean bold) {
        TextView title = new TextView(this);
        title.setText(value);
        title.setTextColor(color);
        title.setTextSize(size);
        if (bold) title.setTypeface(null, Typeface.BOLD);
        title.setLineSpacing(dp(3), 1);
        return title;
    }

    private LinearLayout row() {
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.HORIZONTAL);
        layout.setGravity(Gravity.CENTER_VERTICAL);
        return layout;
    }

    private void append(LinearLayout layout, View view, int top) {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2);
        params.topMargin = dp(top);
        layout.addView(view, params);
    }

    private void wide(LinearLayout layout, View view, int left) {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(0, -2, 1);
        params.leftMargin = dp(left);
        layout.addView(view, params);
    }

    private Button button(String label, boolean primary, Runnable action) {
        Button button = new Button(this);
        button.setText(label);
        button.setTextSize(15);
        button.setTypeface(null, Typeface.BOLD);
        button.setAllCaps(false);
        button.setMinHeight(dp(48));
        button.setPadding(dp(8), dp(8), dp(8), dp(8));
        button.setBackground(new android.graphics.drawable.RippleDrawable(
                ColorStateList.valueOf(Color.rgb(222, 166, 142)), background(primary ? ACCENT : SOFT, 14), null));
        button.setTextColor(primary ? Color.WHITE : INK);
        button.setOnClickListener((view) -> action.run());
        return button;
    }

    private LinearLayout card() {
        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setPadding(dp(16), dp(15), dp(16), dp(16));
        card.setBackground(background(Color.WHITE, 20));
        append(body, card, 14);
        return card;
    }

    private static JSONObject device(JSONObject settings) { return settings.optJSONObject("device"); }
    private static String owner(JSONObject settings) {
        JSONObject device = device(settings);
        return device == null ? null : device.optString("memberId", null);
    }

    private void render() {
        readout = null;
        range = null;
        try {
            JSONObject settings = journal.settings();
            JSONObject active = journal.current();
            lastStage = stage(active);
            ScrollView scroll = new ScrollView(this);
            scroll.setFillViewport(true);
            scroll.setBackgroundColor(PAPER);
            body = new LinearLayout(this);
            body.setOrientation(LinearLayout.VERTICAL);
            body.setPadding(dp(18), dp(12), dp(18), dp(22));
            if (Build.VERSION.SDK_INT >= 30) {
                scroll.setOnApplyWindowInsetsListener((view, insets) -> {
                    var bars = insets.getInsets(WindowInsets.Type.systemBars());
                    body.setPadding(dp(18) + bars.left, dp(12) + bars.top, dp(18) + bars.right, dp(22) + bars.bottom);
                    return insets;
                });
            }
            scroll.addView(body);
            setContentView(scroll);
            append(body, text("GREENVILLE DISC GOLF CLUB", 12, ACCENT, true), 0);
            append(body, text("Round activity", 34, INK, true), 3);
            LinearLayout tabs = row();
            tab(tabs, "record", "Record", 0);
            tab(tabs, "routes", "Routes", 6);
            tab(tabs, "connect", "Connect", 6);
            append(body, tabs, 12);
            notice = text(status, 14, MUTED, true);
            if (Build.VERSION.SDK_INT >= 19) notice.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
            notice.setVisibility(status.isEmpty() ? View.GONE : View.VISIBLE);
            append(body, notice, 8);
            switch (screen) {
                case "routes" -> routes(settings);
                case "connect" -> connection(settings, active);
                default -> record(settings, active);
            }
        } catch (Exception failure) {
            TextView problem = text("Activity storage could not be opened. Your saved files are still on this device.", 17, INK, true);
            problem.setPadding(dp(20), dp(32), dp(20), dp(20));
            setContentView(problem);
        }
    }

    private void tab(LinearLayout tabs, String name, String label, int margin) {
        Button next = button(label, screen.equals(name), () -> { screen = name; render(); });
        next.setSelected(screen.equals(name));
        wide(tabs, next, margin);
    }

    private static String stage(JSONObject active) { return active == null ? "idle" : TrackingService.running ? "tracking" : "paused"; }

    private void updateStatus() {
        String serviceNotice = TrackingService.status;
        if (!serviceNotice.isEmpty()) { status = serviceNotice; TrackingService.status = ""; }
        try {
            JSONObject active = journal.current();
            if (!lastStage.equals(stage(active))) { render(); return; }
            if (readout != null && active != null) readout.setText(TrackJournal.meters(active) + " m");
            if (range != null && TrackingService.running) range.setText(TrackingService.rangeText(journal.settings(), TrackingService.fix, System.currentTimeMillis()));
            if (notice != null) { notice.setText(status); notice.setVisibility(status.isEmpty() ? View.GONE : View.VISIBLE); }
        } catch (Exception failure) { message("The activity file could not be read."); }
    }

    private void record(JSONObject settings, JSONObject active) throws Exception {
        LinearLayout panel = card();
        if (active != null && !TrackingService.allowed(active, settings)) {
            append(panel, text("Another account owns this activity", 20, INK, true), 0);
            append(panel, text("Connect that account to finish or export the saved route.", 15, MUTED, false), 6);
            return;
        }
        boolean running = TrackingService.running;
        String label = active == null ? "Ready to record" : running ? "Recording" : "Paused";
        append(panel, text(label, 17, ACCENT, true), 0);
        if (active != null) {
            readout = text(TrackJournal.meters(active) + " m", 46, INK, true);
            append(panel, readout, 3);
            append(panel, text("Recorded distance", 14, MUTED, false), 0);
        } else {
            append(panel, text("Record your walk", 26, INK, true), 7);
            append(panel, text("Your phone records GPS locations while the activity is running, including when the screen is locked.", 15, MUTED, false), 6);
        }
        if (running) {
            LinearLayout controls = row();
            wide(controls, button("Pause", true, () -> control(TrackingService.PAUSE)), 0);
            wide(controls, button("Stop and save", false, () -> control(TrackingService.STOP)), 8);
            append(panel, controls, 13);
        } else if (active != null) {
            if ("tracking".equals(active.optString("state"))) append(panel, text("Recording was interrupted. Resume to start a new section.", 14, MUTED, false), 6);
            LinearLayout controls = row();
            wide(controls, button("Resume", true, () -> requestStart(TrackingService.RESUME)), 0);
            wide(controls, button("Stop and save", false, () -> control(TrackingService.STOP)), 8);
            append(panel, controls, 13);
        } else append(panel, button("Start activity", true, () -> requestStart(TrackingService.START)), 14);

        LinearLayout basket = card();
        append(basket, text("Distance to basket", 19, INK, true), 0);
        JSONObject device = device(settings);
        JSONObject round = device == null ? null : device.optJSONObject("round");
        if (round != null && device.optLong("expiresAt") > System.currentTimeMillis() && "live".equals(round.optString("status"))) {
            int hole = settings.optInt("hole", round.optInt("startingHole", 1));
            append(basket, text("Hole " + hole + " · " + round.optString("courseName", "Live round"), 15, MUTED, false), 5);
            range = text(running ? TrackingService.rangeText(settings, TrackingService.fix, System.currentTimeMillis()) : "Start or resume for a fresh distance", 16, INK, true);
            append(basket, range, 5);
            append(basket, button("Choose hole", false, () -> selectHole(round)), 10);
            CheckBox lock = new CheckBox(this);
            lock.setText("Show distance on lock screen");
            lock.setChecked(settings.optBoolean("lockDistance"));
            lock.setOnCheckedChangeListener((view, enabled) -> saveLockDisplay(enabled));
            append(basket, lock, 5);
        } else append(basket, text("Pair this app from your live scorecard to bring over its saved basket positions.", 15, MUTED, false), 7);
    }

    private void selectHole(JSONObject round) {
        JSONArray holes = round.optJSONArray("holes");
        if (holes == null || holes.length() == 0) return;
        String[] choices = new String[holes.length()];
        for (int i = 0; i < choices.length; i++) {
            JSONObject hole = holes.optJSONObject(i);
            choices[i] = "Hole " + hole.optInt("hole") + (hole.isNull("basket") ? " · position unavailable" : "");
        }
        new AlertDialog.Builder(this).setTitle("Choose a hole").setItems(choices, (dialog, index) -> {
            try {
                JSONObject settings = journal.settings().put("hole", holes.getJSONObject(index).getInt("hole"));
                journal.settings(settings);
                if (TrackingService.running) control(TrackingService.REFRESH);
                render();
            } catch (Exception failure) { message("The selected hole could not be saved."); }
        }).show();
    }

    private void saveLockDisplay(boolean enabled) {
        try {
            journal.settings(journal.settings().put("lockDistance", enabled));
            if (enabled && Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED)
                requestPermissions(new String[] { Manifest.permission.POST_NOTIFICATIONS }, NOTIFICATIONS);
            if (TrackingService.running) control(TrackingService.REFRESH);
        } catch (Exception failure) { message("The lock screen preference could not be saved."); }
    }

    private void requestStart(String action) {
        if (busy) { message("Wait for the current connection to finish."); return; }
        if (checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED) { control(action); return; }
        requestedStart = action;
        requestPermissions(new String[] { Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION }, LOCATION);
    }

    @Override public void onRequestPermissionsResult(int request, String[] permissions, int[] grant) {
        super.onRequestPermissionsResult(request, permissions, grant);
        if (request == LOCATION) {
            if (checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED && requestedStart != null) control(requestedStart);
            else message("Allow precise location in Settings to record this activity.");
            requestedStart = null;
        } else if (request == NOTIFICATIONS && Build.VERSION.SDK_INT >= 33
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED)
            message("Enable activity notifications in Settings to see distance on the lock screen.");
    }

    private void control(String action) {
        try {
            Intent intent = new Intent(this, TrackingService.class).setAction(action);
            if (TrackingService.START.equals(action) || TrackingService.RESUME.equals(action)) startForegroundService(intent);
            else startService(intent);
        } catch (Exception failure) { message("Activity could not start. Check the phone’s location settings."); }
    }

    private void connection(JSONObject settings, JSONObject active) {
        LinearLayout panel = card();
        JSONObject device = device(settings);
        boolean pending = !settings.optString("pairCode").isEmpty() && settings.optLong("codeExpiresAt") > System.currentTimeMillis();
        append(panel, text(device == null ? "Connect your club account" : "Club account connected", 21, INK, true), 0);
        append(panel, text("Pairing enables private upload and lets this app read basket positions from the live card you pair it with.", 15, MUTED, false), 6);
        if (pending) {
            append(panel, text(settings.optString("pairCode"), 35, ACCENT, true), 7);
            append(panel, text("Enter this code under Phone activity on the club website. Then return here and check the connection.", 15, MUTED, false), 5);
            LinearLayout controls = row();
            wide(controls, button("Open website", false, () -> startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(BuildConfig.PAIR_SITE + "/gvdg-members.html")))), 0);
            wide(controls, button("Check connection", true, this::checkConnection), 8);
            append(panel, controls, 12);
        } else if (device != null) {
            append(panel, text("Expires " + DateFormat.getDateInstance().format(new Date(device.optLong("expiresAt"))), 14, MUTED, false), 8);
            append(panel, button("Refresh connection", true, this::checkConnection), 12);
            if (active == null || !TrackingService.running) append(panel, button("Pair again", false, this::confirmReplace), 8);
        } else {
            append(panel, button("Get pairing code", true, this::beginPairing), 12);
        }
    }

    private void confirmReplace() {
        new AlertDialog.Builder(this).setTitle("Replace the phone connection?")
                .setMessage("Saved activities keep their original owner. To revoke the old connection, remove it from the club website.")
                .setPositiveButton("Get new code", (dialog, which) -> beginPairing()).setNegativeButton("Cancel", null).show();
    }

    private interface Operation { String run() throws Exception; }
    private void submit(Operation task) {
        if (busy) return;
        busy = true;
        message("Connecting…");
        network.execute(() -> {
            String result;
            try { result = task.run(); }
            catch (Exception failure) { result = "Could not complete the request. Check the connection and try again."; }
            final String reply = result;
            runOnUiThread(() -> {
                if (isFinishing() || isDestroyed()) return;
                busy = false;
                status = reply;
                render();
            });
        });
    }

    private void beginPairing() {
        if (TrackingService.running) { message("Pause the activity before replacing the account."); return; }
        submit(() -> {
            var response = ActivityApi.call("/activity/pairings", "POST", null, new JSONObject().put("platform", "android"));
            if (!response.ok()) return "Could not create a code. Try again in a few minutes.";
            JSONObject settings = journal.settings();
            credentials.token(response.data().getString("token"));
            settings.remove("device");
            settings.remove("hole");
            journal.settings(settings.put("pairCode", response.data().getString("code")).put("codeExpiresAt", response.data().getLong("expiresAt")));
            return "Enter the code on the club website.";
        });
    }

    private void checkConnection() {
        submit(() -> {
            String token = credentials.token();
            if (token == null) return "Get a new pairing code to connect.";
            var response = ActivityApi.call("/activity/device", "GET", token, null);
            JSONObject data = response.data();
            if (!response.ok()) {
                if (response.status() == 401) {
                    JSONObject settings = journal.settings();
                    JSONObject former = device(settings);
                    if (former != null) {
                        former.put("round", JSONObject.NULL);
                        former.put("expiresAt", 0);
                    }
                    settings.remove("pairCode");
                    journal.settings(settings);
                    return "This connection expired or was removed. Pair again with the same account to upload its routes.";
                }
                return "Enter the pairing code on the club website, then check again.";
            }
            JSONObject settings = journal.settings();
            JSONObject prior = device(settings);
            if (prior != null && !prior.optString("memberId").equals(data.optString("memberId"))) return "The account changed. Pair again.";
            settings.remove("pairCode");
            journal.settings(settings.put("device", data));
            return data.optBoolean("roundUnavailable") ? "Connected. The paired scorecard is no longer available." : "Club account connected.";
        });
    }

    private void routes(JSONObject settings) throws Exception {
        String owner = owner(settings);
        List<JSONObject> saved = journal.list(owner);
        LinearLayout panel = card();
        append(panel, text("Saved routes", 21, INK, true), 0);
        if (saved.isEmpty()) append(panel, text("Stopped activities will appear here.", 15, MUTED, false), 7);
        for (JSONObject route : saved) {
            String date = DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT).format(new Date(route.optLong("startedAt")));
            append(panel, text(date, 16, INK, true), 14);
            int count = TrackJournal.pointCount(route);
            String sync = route.has("serverId") ? "Uploaded" : "On this phone";
            append(panel, text(TrackJournal.meters(route) + " m · " + count + " GPS fixes · " + sync, 14, MUTED, false), 2);
            LinearLayout actions = row();
            wide(actions, button("Export", false, () -> export(route)), 0);
            boolean canUpload = owner != null && device(settings).optLong("expiresAt") > System.currentTimeMillis() && count > 0 && !route.has("serverId");
            if (canUpload) wide(actions, button("Upload", true, () -> confirmUpload(route, owner)), 8);
            wide(actions, button("Remove", false, () -> confirmRemove(route, owner)), 8);
            append(panel, actions, 6);
        }
    }

    private void confirmUpload(JSONObject route, String owner) {
        String copy = "This uploads the route’s precise GPS positions and times to your private club archive.";
        if (route.isNull("ownerId")) copy += " The route will be linked to this account.";
        new AlertDialog.Builder(this).setTitle("Upload private route?").setMessage(copy)
                .setPositiveButton("Upload", (dialog, which) -> submit(() -> {
                    if (!owner.equals(owner(journal.settings()))) return "Connect the account that owns this route.";
                    String clientId = route.getString("clientId");
                    JSONObject payload = journal.prepare(clientId, owner);
                    var response = ActivityApi.call("/activity/tracks", "POST", credentials.token(), payload);
                    if (!response.ok()) {
                        if (response.status() == 401 || response.status() == 403) return "Sign in with the route’s original account and try again.";
                        if (response.status() == 410) return "This route was removed from the archive. Your phone copy is intact.";
                        if (response.status() == 409) return "The archive already has different data for this route. Your phone copy is intact.";
                        return "The route is saved on this phone. Retry upload when connected.";
                    }
                    if (!clientId.equals(response.data().optString("clientId")) || response.data().optLong("id") < 1)
                        return "The server did not confirm this route. Retry the same upload.";
                    journal.acknowledge(clientId, owner, response.data().getLong("id"));
                    return "Route uploaded to your private club archive.";
                })).setNegativeButton("Keep on phone", null).show();
    }

    private void confirmRemove(JSONObject route, String actor) {
        if (busy) { message("Wait for the current archive request to finish."); return; }
        new AlertDialog.Builder(this).setTitle("Remove route from phone?")
                .setMessage(route.has("serverId") ? "Your uploaded copy can be managed on the club website." : "This route is saved only on this phone.")
                .setPositiveButton("Remove", (dialog, which) -> {
                    try { journal.remove(route.getString("clientId"), actor); status = "Route removed from this phone."; render(); }
                    catch (Exception failure) { message("The route could not be removed."); }
                }).setNegativeButton("Cancel", null).show();
    }

    private void export(JSONObject route) {
        try {
            pendingExport = TrackJournal.payload(route);
            Intent save = new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
                    .setType("application/json").putExtra(Intent.EXTRA_TITLE, "gvdg-activity.json");
            startActivityForResult(save, EXPORT);
        } catch (Exception failure) { message("Could not prepare the route for export."); }
    }

    @Override public void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (request != EXPORT) return;
        JSONObject selected = pendingExport;
        pendingExport = null;
        if (result != RESULT_OK || data == null || data.getData() == null || selected == null) return;
        try (var stream = getContentResolver().openOutputStream(data.getData())) {
            if (stream == null) throw new IllegalStateException("export_unavailable");
            stream.write(selected.toString(2).getBytes(StandardCharsets.UTF_8));
            message("Route exported.");
        } catch (Exception failure) { message("The route export could not be written."); }
    }

    private void message(String value) {
        status = value;
        if (notice != null) { notice.setText(value); notice.setVisibility(View.VISIBLE); }
    }
}
