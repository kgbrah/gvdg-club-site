package com.gvdgclub.activity;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;

import org.json.JSONArray;
import org.json.JSONObject;

public final class TrackingService extends Service implements LocationListener {
    static final String START = "com.gvdgclub.activity.START_TRACK";
    static final String RESUME = "com.gvdgclub.activity.RESUME_TRACK";
    static final String PAUSE = "com.gvdgclub.activity.PAUSE_TRACK";
    static final String STOP = "com.gvdgclub.activity.STOP_TRACK";
    static final String REFRESH = "com.gvdgclub.activity.REFRESH_DISPLAY";
    private static final String CHANNEL = "round-activity";
    private static final int NOTIFICATION_ID = 67;
    static volatile boolean running;
    static RouteMath.Point fix;
    static String status = "";
    static Runnable changed;
    private final Handler timer = new Handler(Looper.getMainLooper());
    private LocationManager locations;
    private NotificationManager notifications;
    private TrackJournal tracks;
    private final Runnable tick = new Runnable() {
        @Override public void run() {
            if (!running) return;
            updateDisplay();
            timer.postDelayed(this, 12_000);
        }
    };

    @Override public void onCreate() {
        super.onCreate();
        tracks = TrackJournal.get(this);
        locations = getSystemService(LocationManager.class);
        notifications = getSystemService(NotificationManager.class);
        NotificationChannel channel = new NotificationChannel(CHANNEL, "Round activity", NotificationManager.IMPORTANCE_LOW);
        channel.setDescription("Visible while GVDG is recording an activity");
        channel.setLockscreenVisibility(Notification.VISIBILITY_PRIVATE);
        notifications.createNotificationChannel(channel);
    }

    @Override public IBinder onBind(Intent intent) { return null; }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? null : intent.getAction();
        try {
            if (START.equals(action) || RESUME.equals(action)) begin(START.equals(action));
            else if (PAUSE.equals(action)) end(false, "Activity paused.");
            else if (STOP.equals(action)) end(true, "Activity saved on this phone.");
            else if (REFRESH.equals(action) && running) updateDisplay();
            else if (!running) stopSelf();
        } catch (Exception error) {
            if (running) {
                try { tracks.setTracking(false); }
                catch (Exception persistenceError) { /* preserved previous completed write */ }
            }
            status = "Activity paused. Check location permissions or device storage.";
            stopUpdates();
            stopSelf();
            publish();
        }
        return START_NOT_STICKY;
    }

    @SuppressLint("MissingPermission")
    private void begin(boolean newTrack) throws Exception {
        if (running) return;
        if (checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED
                || locations == null || !locations.isProviderEnabled(LocationManager.GPS_PROVIDER)) {
            status = "Turn on location services and allow precise location to start recording.";
            stopSelf();
            publish();
            return;
        }
        Notification notification = new Notification.Builder(this, CHANNEL).setContentTitle("GVDG round activity")
                .setContentText("Starting location recording…").setSmallIcon(R.drawable.ic_activity).build();
        if (Build.VERSION.SDK_INT >= 29) startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION);
        else startForeground(NOTIFICATION_ID, notification);
        JSONObject settings = tracks.settings();
        JSONObject device = settings.optJSONObject("device");
        if (newTrack) tracks.start(device == null ? null : device.optString("memberId", null), device, System.currentTimeMillis());
        else {
            JSONObject active = tracks.current();
            if (active == null || !allowed(active, settings)) throw new IllegalStateException("activity_owner_mismatch");
            tracks.setTracking(true);
        }
        running = true;
        fix = null;
        status = "";
        locations.requestLocationUpdates(LocationManager.GPS_PROVIDER, 5000L, 0, this, Looper.getMainLooper());
        updateDisplay();
        timer.postDelayed(tick, 12_000);
    }

    static boolean allowed(JSONObject activity, JSONObject settings) {
        if (activity.isNull("ownerId")) return true;
        JSONObject actor = settings.optJSONObject("device");
        return actor != null && actor.optString("memberId").equals(activity.optString("ownerId"));
    }

    private void end(boolean stop, String message) throws Exception {
        JSONObject current = tracks.current();
        if (current != null && allowed(current, tracks.settings())) {
            if (stop) tracks.stop();
            else tracks.setTracking(false);
            status = message;
        }
        stopUpdates();
        stopSelf();
        publish();
    }

    @Override public void onLocationChanged(Location location) {
        if (!running || !location.hasAccuracy() || (Build.VERSION.SDK_INT >= 31 && location.isMock())) return;
        RouteMath.Point point = new RouteMath.Point(location.getTime(), location.getLatitude(), location.getLongitude(), location.getAccuracy());
        if (!RouteMath.fresh(point, System.currentTimeMillis()) || fix != null && point.at() <= fix.at()) return;
        try {
            tracks.sample(point);
            fix = point;
            updateDisplay();
        } catch (Exception error) {
            status = "Recording paused. The last saved route is intact. Stop or resume in the app.";
            try { tracks.setTracking(false); } catch (Exception ignored) { /* next launch marks interrupted */ }
            stopUpdates();
            stopSelf();
            publish();
        }
    }

    @Override public void onProviderEnabled(String provider) {}
    @Override public void onStatusChanged(String provider, int status, Bundle extras) {}

    @Override public void onProviderDisabled(String provider) {
        if (!running) return;
        try { end(false, "Location is off. Activity paused."); }
        catch (Exception ignored) { stopUpdates(); stopSelf(); publish(); }
    }

    static void publish() { if (changed != null) changed.run(); }

    private void updateDisplay() {
        try {
            JSONObject settings = tracks.settings();
            String message = settings.optBoolean("lockDistance")
                    ? rangeText(settings, fix, System.currentTimeMillis()) : "Location recording is active";
            Intent launch = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
            PendingIntent open = PendingIntent.getActivity(this, 2, launch, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
            Notification publicCopy = new Notification.Builder(this, CHANNEL).setContentTitle("GVDG round activity")
                    .setContentText("Location recording is active").setSmallIcon(R.drawable.ic_activity).build();
            Notification notice = new Notification.Builder(this, CHANNEL).setOnlyAlertOnce(true).setOngoing(true)
                    .setContentTitle("GVDG round activity").setContentText(message).setSmallIcon(R.drawable.ic_activity).setContentIntent(open)
                    .setVisibility(Notification.VISIBILITY_PRIVATE).setPublicVersion(publicCopy)
                    .addAction(new Notification.Action.Builder(null, "Pause", action(PAUSE, 3)).build())
                    .addAction(new Notification.Action.Builder(null, "Stop", action(STOP, 4)).build()).build();
            notifications.notify(NOTIFICATION_ID, notice);
        } catch (Exception ignored) { /* continue with the foreground notification */ }
        publish();
    }

    static String rangeText(JSONObject settings, RouteMath.Point fix, long now) {
        if (!RouteMath.fresh(fix, now)) return "Waiting for a fresh GPS fix";
        JSONObject device = settings.optJSONObject("device");
        JSONObject round = device == null ? null : device.optJSONObject("round");
        JSONArray holes = round == null ? null : round.optJSONArray("holes");
        if (holes == null || device.optLong("expiresAt") <= now || !"live".equals(round.optString("status"))) return "No basket selected";
        int chosen = settings.optInt("hole", round.optInt("startingHole", 1));
        for (int index = 0; index < holes.length(); index++) {
            JSONObject hole = holes.optJSONObject(index);
            if (hole == null || hole.optInt("hole") != chosen) continue;
            JSONObject basket = hole.optJSONObject("basket");
            if (basket == null) return "Basket position unavailable";
            double lat = basket.optDouble("lat"), lng = basket.optDouble("lng");
            if (!Double.isFinite(lat) || !Double.isFinite(lng)) return "Basket position unavailable";
            long feet = Math.round(RouteMath.meters(fix.lat(), fix.lng(), lat, lng) * 3.2808399);
            return feet + " ft to basket";
        }
        return "No basket selected";
    }

    private PendingIntent action(String action, int code) {
        Intent intent = new Intent(this, TrackingService.class).setAction(action);
        return PendingIntent.getService(this, code, intent, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    private void stopUpdates() {
        running = false;
        fix = null;
        timer.removeCallbacks(tick);
        if (locations != null) locations.removeUpdates(this);
        stopForeground(STOP_FOREGROUND_REMOVE);
    }

    @Override public void onDestroy() {
        if (running) {
            try { tracks.setTracking(false); } catch (Exception ignored) { /* reconstructed on next launch */ }
        }
        stopUpdates();
        super.onDestroy();
    }
}
