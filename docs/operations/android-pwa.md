# Private Android PWA build

`apps/android-pwa` bundles the existing web interface in an Android WebView. The app opens
**Settings → Connections** independently of any computer, including offline. Add environments
through the existing pairing flow. Its settings and environment credentials belong to this app;
Chrome's PWA storage is separate. Keep the phone's Tailscale VPN connected to reach tailnet hosts.
Tailscale connectivity does not replace T3's per-environment authorization.

## Build and install

Use Linux, macOS, or WSL with the repository dependencies installed, JDK 17, Android SDK platform
36, and Android SDK build-tools. Set `JAVA_HOME` and `ANDROID_HOME`. The checked-in wrapper verifies
Gradle 8.13's checksum. Keep a private signing keystore and its password file outside the checkout,
and retain both for future APK updates.

```bash
node scripts/build-android-pwa.ts \
  --keystore /private/t3-pwa.jks \
  --password-file /private/t3-pwa-password \
  --version-name 1.0
adb install -r release/android-pwa/t3-code-pwa.apk
```

The build bundles a separate web output, runs Android lint, and verifies the signed APK. It never
bakes a primary server URL into the app. `--version-code` overrides the default minutes-since-epoch
code; updates must increase it and retain the package and signing certificate. Web interface
updates require a new APK. Website verification and `assetlinks.json` are no longer required.

The app keeps the web client's installed-PWA layout and preserves the WebView when the display
changes size or orientation. Microphone/camera access prompts for Android permissions. File
attachments use Android's picker; blob downloads use its Save dialog (up to 32 MB). External links
open in the browser. Release builds disable WebView debugging. Android backup and device transfer
exclude app credentials.

Browser Web Push is unavailable in WebView. This build does not provide background push
notifications; use the browser PWA when those are needed. SSH provisioning remains a desktop
capability. Direct environments use the same server authorization as the web client. HTTPS is
recommended; explicit HTTP endpoints are supported for private networks such as Tailscale.
