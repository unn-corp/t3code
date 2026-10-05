# Private Android PWA build

`apps/android-pwa` launches the existing web app in a Trusted Web Activity. It uses the browser's
PWA engine and the same Connections screen, pairing, environments, and responsive layout. It does
not embed a second UI or server credentials. Interface updates come from the configured PWA host.

## Build

Use Linux, macOS, or WSL with JDK 17, Android SDK platform 36, and Android SDK build-tools installed.
Set `JAVA_HOME` and `ANDROID_HOME`. The checked-in wrapper downloads Gradle 8.13 and verifies its
checksum. Use a private signing keystore with alias `t3-pwa`; keep its password in a separate private
file. Keep both outside the checkout and retain them for future APK updates.

```bash
node scripts/build-android-pwa.ts \
  --url https://your-machine.your-tailnet.ts.net/ \
  --keystore /private/t3-pwa.jks \
  --password-file /private/t3-pwa-password \
  --version-name 1.0
```

The build produces `release/android-pwa/t3-code-pwa.apk` and `assetlinks.json`, runs Android lint,
and verifies the APK signature. `--url` accepts an HTTPS origin, including a custom port, without
pairing tokens, credentials, or paths. `--version-code` can override the default minutes-since-epoch
code for reproducible builds.

## Website verification and installation

Serve the generated `assetlinks.json` at the PWA origin's `/.well-known/assetlinks.json` with a JSON
content type and no authentication or redirect. This binds the website to the APK's package and
signing certificate. For a standalone T3 runtime, copy it into `client/.well-known/assetlinks.json`
beside the runtime executable. Preserve that file when replacing the runtime's client directory.
The certificate fingerprint is public; the signing key and password remain private.

Install the APK on the phone with Tailscale connected and an up-to-date browser supporting Trusted
Web Activities, such as Chrome. Add machines through the existing **Settings → Connections** flow.
Saved environments are shared with the PWA when it uses the same browser profile and origin.

Before website verification succeeds, the browser can display its address toolbar. The APK still
opens the same PWA. Machines need reachable T3 endpoints and normal device pairing; the APK does
not grant additional machine permissions. Direct Tailscale access retains the PWA's existing
notification behavior.
