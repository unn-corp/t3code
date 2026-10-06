package com.devotek.t3code.pwa;

import static org.junit.Assert.*;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

public final class ApkVerifierTest {
    @Rule public TemporaryFolder folder = new TemporaryFolder();

    private static ApkVerifier.Facts facts(ReleaseManifest.Artifact expected) {
        ApkVerifier.Facts facts = new ApkVerifier.Facts();
        facts.packageName = expected.packageName; facts.versionCode = expected.versionCode; facts.signers.add(expected.signerSha256);
        facts.sourceCommit = expected.sourceCommit; facts.sourceVersion = expected.sourceVersion; facts.protocol = expected.updaterProtocol;
        return facts;
    }
    private interface Change { void apply(ApkVerifier.Facts facts); }
    private static void rejects(boolean recovery, Change change) throws Exception {
        ReleaseManifest manifest = Fixtures.manifest();
        ReleaseManifest.Artifact expected = recovery ? manifest.recovery : manifest.normal;
        ApkVerifier.Facts facts = facts(expected); facts.recovery = recovery;
        change.apply(facts);
        try { ApkVerifier.verifyFacts(facts, expected, recovery, Fixtures.installed()); fail("Accepted a bad archive"); }
        catch (ApkVerifier.Failure expectedFailure) { /* fail closed */ }
    }

    @Test public void acceptsTheNormalAndRecoveryBuildsTheReleaseDescribes() throws Exception {
        ReleaseManifest manifest = Fixtures.manifest();
        ApkVerifier.verifyFacts(facts(manifest.normal), manifest.normal, false, Fixtures.installed());
        ApkVerifier.Facts recovery = facts(manifest.recovery); recovery.recovery = true;
        ApkVerifier.verifyFacts(recovery, manifest.recovery, true, Fixtures.installed());
    }
    @Test public void rejectsEveryDisagreementBetweenTheFileAndItsRelease() throws Exception {
        rejects(false, facts -> facts.packageName = "com.example.other");
        rejects(false, facts -> { facts.signers.clear(); facts.signers.add("d".repeat(64)); });
        rejects(false, facts -> facts.signers.add("d".repeat(64)));
        rejects(false, facts -> facts.multipleSigners = true);
        rejects(false, facts -> facts.signers.clear());
        rejects(false, facts -> facts.versionCode = Fixtures.NORMAL_CODE + 1);
        rejects(false, facts -> facts.versionCode = Fixtures.INSTALLED_CODE);
        rejects(false, facts -> facts.sourceCommit = "9".repeat(40));
        rejects(false, facts -> facts.sourceVersion = "9.9.9");
        rejects(false, facts -> facts.protocol = 0);
        rejects(false, facts -> facts.recovery = true);
        rejects(true, facts -> facts.recovery = false);
    }
    @Test public void aNormalBuildCannotMasqueradeAsRecoveryOrTheReverse() throws Exception {
        ReleaseManifest manifest = Fixtures.manifest();
        ApkVerifier.Facts normal = facts(manifest.normal);
        try { ApkVerifier.verifyFacts(normal, manifest.normal, true, Fixtures.installed()); fail(); } catch (ApkVerifier.Failure expected) { }
    }
    @Test public void digestAndSizeMustBothMatchTheRecordedValues() throws Exception {
        File file = folder.newFile("update.apk");
        byte[] bytes = "t3-update".getBytes(StandardCharsets.UTF_8);
        Files.write(file.toPath(), bytes);
        String sha = ApkVerifier.sha256(bytes);
        assertEquals(sha, ApkVerifier.sha256(file));
        ApkVerifier.verifyFile(file, sha, bytes.length);
        try { ApkVerifier.verifyFile(file, sha, bytes.length + 1); fail(); } catch (ApkVerifier.Failure expected) { }
        try { ApkVerifier.verifyFile(file, "0".repeat(64), bytes.length); fail(); } catch (ApkVerifier.Failure expected) { }
        try { ApkVerifier.verifyFile(new File(folder.getRoot(), "missing.apk"), sha, bytes.length); fail(); } catch (ApkVerifier.Failure expected) { }
    }
    @Test public void computesStandardSha256() {
        assertEquals("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", ApkVerifier.sha256(new byte[0]));
    }
}
