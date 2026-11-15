package com.gvdgclub.activity;

final class RouteMath {
    static final long GAP_MS = 90_000;
    static final long FRESH_MS = 45_000;
    static final long MAX_DURATION_MS = 86_400_000;
    static final int MAX_POINTS = 4096;

    record Point(long at, double lat, double lng, double accuracyM) {
        boolean valid() {
            return Double.isFinite(lat) && Math.abs(lat) <= 90 && Double.isFinite(lng) && Math.abs(lng) <= 180
                    && Double.isFinite(accuracyM) && accuracyM >= 0 && accuracyM <= 50;
        }
    }

    static double meters(double aLat, double aLng, double bLat, double bLng) {
        double r = Math.PI / 180;
        double x = Math.sin((bLat - aLat) * r / 2);
        double y = Math.sin((bLng - aLng) * r / 2);
        double h = x * x + Math.cos(aLat * r) * Math.cos(bLat * r) * y * y;
        return 12_742_000 * Math.asin(Math.sqrt(Math.max(0, Math.min(1, h))));
    }

    static double distance(Point previous, Point point) {
        if (previous == null) return 0;
        long elapsed = point.at() - previous.at();
        if (elapsed <= 0 || elapsed > GAP_MS) return 0;
        double meters = meters(previous.lat(), previous.lng(), point.lat(), point.lng());
        double threshold = Math.max(5, Math.min(20, Math.max(previous.accuracyM(), point.accuracyM()) / 2));
        return meters >= threshold && meters <= 15 * elapsed / 1000.0 ? meters : 0;
    }

    static boolean fresh(Point point, long now) {
        return point != null && point.valid() && point.at() >= now - FRESH_MS && point.at() <= now + 2000;
    }
}
