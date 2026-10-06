package com.devotek.t3code.pwa;

import static org.junit.Assert.*;
import org.junit.Test;

public final class BrowserPolicyTest {
    @Test public void acceptsPublicAndTailnetPages() {
        assertTrue(BrowserPolicy.allowedUrl("https://example.com/path?tab=1"));
        assertTrue(BrowserPolicy.allowedUrl("http://devotek-pc.taild35bee.ts.net:5173/"));
        assertTrue(BrowserPolicy.allowedUrl("http://[fd7a:115c:a1e0::1]:3000/"));
        assertTrue(BrowserPolicy.allowedUrl("about:blank"));
    }
    @Test public void browserCannotLoadTrustedShellOrAndroidFiles() {
        for (String url : new String[]{"https://appassets.androidplatform.net/", "http://APPASSETS.ANDROIDPLATFORM.NET/settings", "file:///data/data/app/secret", "content://app/secret", "javascript:alert(1)", "data:text/html,hello", "intent://app", "https://user:password@example.com/", "https:///missing-host", "/settings"}) {
            assertFalse(url, BrowserPolicy.allowedUrl(url));
        }
    }
    @Test public void convertsFoldViewportBoundsUsingCurrentShellScale() {
        assertEquals(1200, BrowserPolicy.pixels(400, 3));
        assertEquals(800, BrowserPolicy.pixels(400, 2));
        assertEquals(0, BrowserPolicy.pixels(0, 3));
    }
    @Test public void rejectsInvalidBounds() {
        for (double value : new double[]{Double.NaN, Double.POSITIVE_INFINITY, -1, 20000}) {
            try { BrowserPolicy.pixels(value, 3); fail("Accepted invalid bounds"); }
            catch (IllegalArgumentException expected) { }
        }
    }
}
