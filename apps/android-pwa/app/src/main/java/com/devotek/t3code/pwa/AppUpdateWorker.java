package com.devotek.t3code.pwa;

import android.content.Context;
import androidx.annotation.NonNull;
import androidx.work.Constraints;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.Data;
import androidx.work.ExistingWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;
import androidx.work.Worker;
import androidx.work.WorkerParameters;
import java.util.concurrent.TimeUnit;

/** Checks GitHub about every six hours on an unmetered network, then installs only if every guard allows it. */
public final class AppUpdateWorker extends Worker {
    static final String NAME = "t3-app-update-v1";

    public AppUpdateWorker(@NonNull Context context, @NonNull WorkerParameters parameters) { super(context, parameters); }

    @NonNull @Override public Result doWork() {
        // A recheck only applies a waiting request or staged update; the periodic job also checks GitHub.
        boolean recheck = "recheck".equals(getInputData().getString("mode"));
        UpdateEngine.get(getApplicationContext()).run(recheck ? UpdateEngine.Trigger.INTENT : UpdateEngine.Trigger.WORKER);
        // Failures are recorded in updater state and retried at the next period; backoff would only hammer GitHub.
        return Result.success();
    }

    /** One-shot fallback for when the in-process timer is lost to process death. */
    static void scheduleRecheck(Context context, long delayMs) {
        OneTimeWorkRequest request = new OneTimeWorkRequest.Builder(AppUpdateWorker.class)
            .setInitialDelay(Math.max(delayMs, 60_000L), TimeUnit.MILLISECONDS)
            .setInputData(new Data.Builder().putString("mode", "recheck").build()).build();
        WorkManager.getInstance(context).enqueueUniqueWork(NAME + "-recheck", ExistingWorkPolicy.REPLACE, request);
    }

    static void schedule(Context context) {
        PeriodicWorkRequest request = new PeriodicWorkRequest.Builder(AppUpdateWorker.class, 6, TimeUnit.HOURS, 45, TimeUnit.MINUTES)
            .setConstraints(new Constraints.Builder().setRequiredNetworkType(NetworkType.UNMETERED).build()).build();
        WorkManager.getInstance(context).enqueueUniquePeriodicWork(NAME, ExistingPeriodicWorkPolicy.KEEP, request);
    }
}
