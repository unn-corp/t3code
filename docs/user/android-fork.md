# This fork's Android app

This fork includes a standalone Android app, package `com.devotek.t3code.pwa`. It puts the fork's
web interface in an Android app with native notifications, file pickers, and a phone browser.
The APK is built from `apps/android-pwa`; the upstream Google Play app is a separate product.

## Install and update

Build a signed APK using the [Android runbook](../operations/android-pwa.md#build-a-signed-apk),
or use an APK provided by your fork maintainer. On Android 7.0 or newer, open the APK and allow
installation from that source when Android asks. You can also install over USB with:

```bash
adb devices
# Finish phone browser commands, uploads, and dialogs; background T3 Code for two minutes.
adb install -r t3-code-pwa.apk
```

Install the first updater-equipped version this way. After that, the app updates itself.
Uninstalling the app or clearing its storage removes your saved connections, so never do either
to update. Chrome's installed PWA has separate storage; its connections are not automatically
imported.

### Automatic updates

T3 Code checks this fork's GitHub releases when it opens and about every six hours on Wi-Fi.
New versions are downloaded and verified in the background. An update never installs while you
are using the phone: T3 Code waits until it has been in the background for 2 minutes and no
browser command, file upload, or system dialog is in progress. This applies when you tap
**Install** too. The tap records your request for exactly the version you reviewed and shows
**Waiting**; leave the app and it installs after the wait, even if automatic installation is off.
Agents running on your computers are not interrupted, since they run on those computers.

- **Channel.** Existing installations follow nightly builds, which includes stable releases.
  New installations follow stable. Change it in the app's update settings.
- **Automatic installation.** Turn it off to install only after you tap **Install**. Your request
  never changes this setting.
- **Pin.** Hold this version until you tap **Resume**. A rollback pins automatically.
- **Allow installing.** The first time, Android asks you to let T3 Code install updates. Without it,
  updates download and wait.

Android may ask you to confirm the install. T3 Code shows a notification when it needs you.
Your paired computers, drafts, and queued messages stay in place. Updates need Android 9 or newer;
older phones need the APK installed by hand.

### If an update goes wrong

Before installing a new version, T3 Code keeps a verified copy of the previous version. If the app
repeatedly fails to start, or an update does not match what was verified, it opens a **Recovery**
screen instead. You can also open it any time from the **Recovery** shortcut when you long-press
the T3 Code icon. From there you can continue to the app, request the saved previous version, or
download the latest recovery build. A requested recovery build also waits for the 2 minutes away from
the app, then replaces it in place and keeps your connections; it does not uninstall anything. If even that screen will not open, ask your fork maintainer for the
signed recovery APK and install it over the existing app.

The interface is bundled inside the APK, so updating a host's website does not update the phone's
interface. Some features also require an updated fork server on each connected host.

## Connect over Tailscale

1. Connect the phone and each host computer to your Tailscale network. Keep Tailscale connected
   while using T3 Code.
2. Start this fork's T3 server on each computer, or keep its desktop app running. Configure and
   authenticate the coding providers on those computers.
3. On a desktop host, enable **Tailscale HTTPS** in **Settings → Connections** and create a pairing
   link. On a command-line host, start `t3 serve --tailscale-serve`, or run `t3 pair --tailscale`
   for an existing server. Use the `t3` binary built from this fork.
4. Open the Android app's **Settings → Connections → Add environment** and enter the full pairing
   link. Repeat for each host. A link should use a reachable address such as
   `https://machine.tailnet.ts.net/`, rather than the host's `localhost` address.

The app uses the phone's existing Tailscale VPN; it does not manage the VPN itself. Direct private-network
HTTP endpoints are also supported, although the primary setup above uses Tailscale HTTPS.

Pairing authorizes the app to reconnect later. Tailscale provides network access and does not
replace that authorization. Generate a fresh one-time pairing link for each device. The app's
Connections screen remains available without a host connection, so you can add or change hosts
while others are offline.

The phone is a client of the selected environment. Agents, terminals, repositories, provider
credentials, and conversation history stay on that environment's computer. The APK does not
run its own T3 server or automatically discover and gain access to every machine in the tailnet.
For host exposure options and pairing details, see [remote access](./remote-access.md#tailscale-https).

## Notifications

In **Settings → General**, enable **Notifications on this phone**, grant Android's notification
permission, and enable **Keep alerts connected in the background**. Use **Send test** to verify
Android delivery without starting an agent. Completion, failure, proposed-plan, and input or
approval alerts open their thread when tapped.

Background alerts work while the app is closed or the phone is locked by keeping a native
foreground service connected to enabled, directly paired environments. An ongoing notification
shows its connection count and lets you stop it. This delivery path does not require Firebase,
Google Play services, or a T3 Connect account. Cloud DPoP connections are not supported by the
native background transport.

Keep Tailscale connected and allow unrestricted battery use for both apps when you need timely
background alerts. Offline hosts and Android power saving can delay delivery. Open T3 Code once
after reboot or force-stop to resume background connections. Disabling alerts stops this
background delivery without deleting the app's saved environments.

## Browser on the phone

The **Browser** panel renders sites in a separate phone WebView. Agents can navigate, inspect,
click, type, scroll, and capture that tab while T3 Code is open. Keep the panel visible for
screenshots. The phone browser has its own cookies and adapts to the current display size,
including folding or unfolding the phone. Close unused tabs before reaching the eight-tab limit.

On environments that support temporary sharing, opening an HTTP localhost development URL or
an environment-port target creates a Tailscale HTTPS URL the phone can reach. That share closes
when its last owning tab closes, when the server shuts down, or after one hour without a browser
page visit. Hiding the panel does not close it. Health probes, background fetches, assets, and
WebSocket traffic do not reset the timer. Existing manually configured Tailscale routes are
outside this automatic cleanup.

Desktop browser profiles, recording, and device emulation are not available in the phone browser.
Browser control requires the app to be open; background notifications can continue independently.

For building, modifying, and troubleshooting the app, see the
[Android runbook](../operations/android-pwa.md).
