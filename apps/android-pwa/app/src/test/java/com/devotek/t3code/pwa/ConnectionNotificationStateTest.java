package com.devotek.t3code.pwa;

import org.junit.Test;
import static org.junit.Assert.*;

public final class ConnectionNotificationStateTest {
    @Test public void repeatedAppRefreshDoesNotRestartTheNotification() {
        ConnectionNotificationState state = new ConnectionNotificationState();
        assertTrue(state.start());
        assertEquals("Background agent alerts are ready", state.changedStatus(3, 3));
        assertFalse(state.start());
        assertNull(state.changedStatus(3, 3));
    }

    @Test public void healthyConfigurationChangesDoNotResurfaceTheNotification() {
        ConnectionNotificationState state = new ConnectionNotificationState();
        state.start();
        state.changedStatus(3, 3);
        assertNull(state.changedStatus(2, 2));
        assertNull(state.changedStatus(4, 4));
    }

    @Test public void lostConnectivityUpdatesOnceThenRecovers() {
        ConnectionNotificationState state = new ConnectionNotificationState();
        state.start();
        state.changedStatus(3, 3);
        assertEquals("2 of 3 environments connected · Reconnecting", state.changedStatus(2, 3));
        assertNull(state.changedStatus(2, 3));
        assertEquals("0 of 3 environments connected · Reconnecting", state.changedStatus(0, 3));
        assertEquals("Background agent alerts are ready", state.changedStatus(3, 3));
        assertNull(state.changedStatus(3, 3));
    }

    @Test public void aNewServiceInstancePostsItsRequiredInitialNotification() {
        ConnectionNotificationState first = new ConnectionNotificationState();
        first.start();
        first.changedStatus(3, 3);
        assertTrue(new ConnectionNotificationState().start());
    }
}
