package com.devotek.t3code.pwa;

import static org.junit.Assert.*;
import java.util.List;
import org.junit.Test;

public final class InstallerSessionsTest {
    private static final String OWN = "com.devotek.t3code.pwa";
    private InstallerSessions.Session session(int id, long created, String installer, String target, boolean active) {
        return new InstallerSessions.Session(id, created, installer, target, active);
    }
    private List<InstallerSessions.Session> selected() { return List.of(session(83, 123, OWN, OWN, false)); }
    @Test public void exactInactiveAppOwnedSessionIsAccepted() { assertNull(InstallerSessions.refusal(selected(), selected(), OWN, false)); }
    @Test public void aRecordedInstallationIsNeverDiscarded() { assertNotNull(InstallerSessions.refusal(selected(), selected(), OWN, true)); }
    @Test public void explicitlyConfirmedActiveOrphanCanBeCancelled() {
        List<InstallerSessions.Session> active = List.of(session(83, 123, OWN, OWN, true));
        assertNull(InstallerSessions.refusal(active, active, OWN, false));
        assertNotNull(InstallerSessions.refusal(active, active, OWN, true));
    }
    @Test public void changingActivityRequiresFreshConfirmation() {
        assertNotNull(InstallerSessions.refusal(selected(), List.of(session(83, 123, OWN, OWN, true)), OWN, false));
    }
    @Test public void changedSessionIdentityInvalidatesConfirmation() {
        assertNotNull(InstallerSessions.refusal(selected(), List.of(session(84, 123, OWN, OWN, false)), OWN, false));
        assertNotNull(InstallerSessions.refusal(selected(), List.of(session(83, 124, OWN, OWN, false)), OWN, false));
    }
    @Test public void anotherInstallerOrTargetIsNeverDiscarded() {
        assertNotNull(InstallerSessions.refusal(selected(), List.of(session(83, 123, "other", OWN, false)), OWN, false));
        assertNotNull(InstallerSessions.refusal(selected(), List.of(session(83, 123, OWN, "other", false)), OWN, false));
        assertNotNull(InstallerSessions.refusal(selected(), List.of(session(83, 123, OWN, null, false)), OWN, false));
    }
    @Test public void aNewUnconfirmedSessionBlocksTheEntireAction() {
        assertNotNull(InstallerSessions.refusal(selected(), List.of(selected().get(0), session(84, 124, OWN, OWN, false)), OWN, false));
    }
    @Test public void duplicatesAndMissingSessionsAreRejected() {
        assertNotNull(InstallerSessions.refusal(List.of(selected().get(0), selected().get(0)), List.of(selected().get(0), selected().get(0)), OWN, false));
        assertNotNull(InstallerSessions.refusal(selected(), List.of(), OWN, false));
        assertNotNull(InstallerSessions.refusal(List.of(), List.of(), OWN, false));
    }
}
