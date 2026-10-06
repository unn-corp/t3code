# Fork Android app

This is this fork's standalone Android app, package `com.devotek.t3code.pwa`. It bundles
`apps/web` in a native Android WebView and adds native notifications and a phone browser.
It primarily connects to T3 environments over Tailscale using the web client's Connections screen.

- [Install, pair, and use the app](../../docs/user/android-fork.md)
- [Build, install updates, edit, test, and understand the backend](../../docs/operations/android-pwa.md)

The app updates itself from this fork's GitHub releases through a native updater with an install
guard and a native recovery screen; the runbook's
[In-app updates and recovery](../../docs/operations/android-pwa.md#in-app-updates-and-recovery)
section explains how it decides, verifies, installs, and recovers.

Use `scripts/build-android-pwa.ts` from the repository root for a complete APK build. A direct
Gradle build requires the generated web assets from that helper first. This app does not use
Expo, Metro, EAS, or the upstream store app under `apps/mobile`.
