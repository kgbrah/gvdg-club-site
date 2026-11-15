package com.gvdgclub.activity;

import org.junit.Test;
import static org.junit.Assert.*;

public class RouteMathTest {
    @Test public void distanceIgnoresJitterGapsAndSpikes() {
        var first = new RouteMath.Point(2000, 35, -82, 6);
        var jitter = new RouteMath.Point(12_000, 35, -81.999999, 5);
        var walked = new RouteMath.Point(12_000, 35, -81.9999, 5);
        var spike = new RouteMath.Point(12_000, 35, -81.97, 5);
        var gap = new RouteMath.Point(200_000, 35, -81.998, 5);
        assertEquals(0, RouteMath.distance(first, jitter), 0);
        assertEquals(9.1, RouteMath.distance(first, walked), 0.25);
        assertEquals(0, RouteMath.distance(first, spike), 0);
        assertEquals(0, RouteMath.distance(first, gap), 0);
        assertEquals(0, RouteMath.distance(walked, first), 0);
    }

    @Test public void staleAndImpreciseFixesCannotDriveRange() {
        long now = 100_000;
        assertTrue(RouteMath.fresh(new RouteMath.Point(now - 44_000, 35, -82, 10), now));
        assertFalse(RouteMath.fresh(new RouteMath.Point(now - 46_000, 35, -82, 10), now));
        assertFalse(RouteMath.fresh(new RouteMath.Point(now, 35, -82, 100), now));
        assertFalse(RouteMath.fresh(new RouteMath.Point(now, Double.NaN, -82, 6), now));
    }
}
