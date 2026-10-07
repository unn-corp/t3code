package com.devotek.t3code.pwa;

import org.junit.Test;
import static org.junit.Assert.*;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONObject;

public class NetworkNotificationPresenceTest {
    private JSONObject snapshot(boolean visible, String state, long expiry) throws Exception {
        return new JSONObject().put("updatedAt", "2026-10-07T00:00:00Z").put("leases", new JSONArray().put(
            new JSONObject().put("visible", visible).put("focused", false).put("recentlyInteracted", false)
                .put("appState", state).put("expiresAt", Iso8601.format(1791331200000L + expiry))));
    }
    @Test public void anyVisibleIdleClientOnAnyHostSuppresses() throws Exception {
        NetworkNotificationPresence presence = new NetworkNotificationPresence();
        presence.configure(Set.of("laptop", "deck"), 1000);
        presence.update("laptop", snapshot(false, "background", 45000), 1000);
        presence.update("deck", snapshot(true, "active", 45000), 1000);
        assertTrue(presence.ready(1000)); assertTrue(presence.suppressed(1000));
        presence.update("deck", snapshot(false, "background", 45000), 2000);
        assertFalse(presence.suppressed(2000));
    }
    @Test public void hiddenMinimizedAndInactiveClientsDoNotSuppress() throws Exception {
        NetworkNotificationPresence presence = new NetworkNotificationPresence();
        presence.configure(Set.of("host"), 1000);
        for (String state : new String[]{"background", "inactive"}) {
            presence.update("host", snapshot(true, state, 45000), 1000);
            assertFalse(presence.suppressed(1000));
        }
        presence.update("host", snapshot(false, "active", 45000), 1000);
        assertFalse(presence.suppressed(1000));
    }
    @Test public void startupWaitsForAllHostsAndUnreachableHostsExpire() throws Exception {
        NetworkNotificationPresence presence = new NetworkNotificationPresence();
        presence.configure(Set.of("a", "b"), 1000);
        presence.update("a", snapshot(false, "background", 45000), 1000);
        assertFalse(presence.ready(45999)); assertTrue(presence.ready(46000));
    }
    @Test public void expiryUsesServerDurationNotPhoneWallClock() throws Exception {
        NetworkNotificationPresence presence = new NetworkNotificationPresence();
        presence.configure(Set.of("host"), 1000);
        presence.update("host", snapshot(true, "active", 5000), 1000);
        assertTrue(presence.suppressed(5999)); assertFalse(presence.suppressed(6000));
        presence.update("host", snapshot(true, "active", -100), 2000);
        assertFalse(presence.suppressed(2000));
    }
    @Test public void removingEnvironmentRemovesOnlyItsPresence() throws Exception {
        NetworkNotificationPresence presence = new NetworkNotificationPresence();
        presence.configure(Set.of("a", "b"), 1000);
        presence.update("a", snapshot(true, "active", 45000), 1000);
        presence.update("b", snapshot(false, "background", 45000), 1000);
        presence.configure(Set.of("b"), 2000);
        assertTrue(presence.ready(2000)); assertFalse(presence.suppressed(2000));
        presence.update("a", snapshot(true, "active", 45000), 2000);
        assertFalse(presence.suppressed(2000));
    }
}
