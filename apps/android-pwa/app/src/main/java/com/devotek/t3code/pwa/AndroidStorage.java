package com.devotek.t3code.pwa;

import android.os.StatFs;
import android.system.Os;
import java.io.File;

/** Reads only free-byte counts and filesystem identity; paths and usage are never persisted or reported. */
final class AndroidStorage {
    private AndroidStorage() { }

    static UpdateCapacity.Snapshot inspect(File stagingDirectory, File installedApk) {
        try {
            File stage = stagingDirectory.getCanonicalFile();
            File install = installedApk.getCanonicalFile();
            if (!stage.isDirectory() || !install.isFile()) return UpdateCapacity.Snapshot.unknown();
            long stagingAvailable = new StatFs(stage.getPath()).getAvailableBytes();
            long installAvailable = new StatFs(install.getPath()).getAvailableBytes();
            boolean sameFilesystem = Os.stat(stage.getPath()).st_dev == Os.stat(install.getPath()).st_dev;
            return new UpdateCapacity.Snapshot(stagingAvailable, installAvailable, sameFilesystem, true);
        } catch (Exception unavailable) {
            // Unknown capacity blocks. The updater never guesses or frees the recovery cache to proceed.
            return UpdateCapacity.Snapshot.unknown();
        }
    }
}
