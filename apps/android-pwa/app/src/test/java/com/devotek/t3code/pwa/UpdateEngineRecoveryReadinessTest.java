package com.devotek.t3code.pwa;

import static org.junit.Assert.*;
import java.io.File;
import java.nio.file.Files;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

public final class UpdateEngineRecoveryReadinessTest {
    @Rule public TemporaryFolder folder = new TemporaryFolder();

    private UpdateState pairedState(File directory, byte[] bytes) throws Exception {
        String digest = ApkVerifier.sha256(bytes);
        UpdateState state = new UpdateState();
        state.target = new UpdateState.Target();
        state.target.sha256 = "b".repeat(64);
        state.target.recoverySha256 = digest;
        UpdateState.Recovery recovery = new UpdateState.Recovery();
        recovery.sha256 = digest;
        recovery.file = digest + ".apk";
        recovery.bytes = bytes.length;
        recovery.commit = "c".repeat(40); // The predecessor may be the currently installed source.
        state.recovery.add(recovery);
        state.identity = new UpdateState.Identity();
        state.identity.commit = recovery.commit;
        Files.write(new File(directory, recovery.file).toPath(), bytes);
        return state;
    }

    @Test public void stagedTargetUsesItsPairedCacheEntryEvenWhenRollbackListWouldOmitSameSource() throws Exception {
        File directory = folder.newFolder("recovery-cache");
        UpdateState state = pairedState(directory, new byte[] {1, 2, 3});

        assertTrue(UpdateEngine.pairedRecoveryReady(state, directory));
    }

    @Test public void missingTargetOrPairedRecordIsNotReadyEvenWhenAnotherRecoveryIsCached() throws Exception {
        File directory = folder.newFolder("recovery-cache");
        UpdateState noTarget = pairedState(directory, new byte[] {1, 2, 3});
        noTarget.target = null;
        assertFalse(UpdateEngine.pairedRecoveryReady(noTarget, directory));

        UpdateState wrongRecord = pairedState(directory, new byte[] {1, 2, 3});
        wrongRecord.recovery.get(0).sha256 = "d".repeat(64);
        assertFalse(UpdateEngine.pairedRecoveryReady(wrongRecord, directory));
    }

    @Test public void revalidationKeepsTheExactRecoveryDigestBoundToTheInstalledSource() throws Exception {
        ReleaseManifest manifest = Fixtures.manifest();
        UpdateState.Target target = new UpdateState.Target();
        target.sha256 = Fixtures.NORMAL_SHA;
        target.versionCode = Fixtures.NORMAL_CODE;
        target.recoverySha256 = Fixtures.RECOVERY_SHA;
        target.manifestSha256 = "a".repeat(64);

        assertTrue(UpdateEngine.exactTargetPair(target, manifest, target.manifestSha256, "1.0.0", Fixtures.PREVIOUS_COMMIT));
        assertFalse(UpdateEngine.exactTargetPair(target, manifest, "f".repeat(64), "1.0.0", Fixtures.PREVIOUS_COMMIT));
        target.recoverySha256 = "d".repeat(64);
        assertFalse(UpdateEngine.exactTargetPair(target, manifest, target.manifestSha256, "1.0.0", Fixtures.PREVIOUS_COMMIT));
        assertFalse(UpdateEngine.exactTargetPair(target, manifest, target.manifestSha256, "9.9.9", Fixtures.PREVIOUS_COMMIT));
    }

    @Test public void missingWrongSizeWrongDigestAndEscapingCacheFilesAreNotReady() throws Exception {
        File directory = folder.newFolder("recovery-cache");
        UpdateState state = pairedState(directory, new byte[] {1, 2, 3});
        File apk = new File(directory, state.target.recoverySha256 + ".apk");

        assertTrue(apk.delete());
        assertFalse(UpdateEngine.pairedRecoveryReady(state, directory));

        Files.write(apk.toPath(), new byte[] {1, 2});
        assertFalse(UpdateEngine.pairedRecoveryReady(state, directory));

        Files.write(apk.toPath(), new byte[] {3, 2, 1});
        assertFalse(UpdateEngine.pairedRecoveryReady(state, directory));

        state.recovery.get(0).file = "../outside.apk";
        assertFalse(UpdateEngine.pairedRecoveryReady(state, directory));
    }
}
