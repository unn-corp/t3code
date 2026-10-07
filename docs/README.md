# Arcwright Code docs

## Using Arcwright Code

See [Fork maintenance and feature ownership](./operations/fork-maintenance.md) when changing retained fork behavior.
The [fork release runbook](./operations/fork-releases.md) owns nightly/stable publishing and recovery;
[Updating this fork](./user/updating.md) owns client and host routes.

This fork ships its own Android APK from `apps/android-pwa`, with the web interface and native
phone features. Its primary connection path is direct pairing over Tailscale. The upstream
store/Expo app in `apps/mobile` has a separate build and notification system.

- [Fork Android app: installation, Tailscale, and everyday use](./user/android-fork.md)

- [Install Arcwright Code](./user/install.md)
- [Messages and context](./user/composer.md)
- [Working with threads](./user/thread-sidebar.md)
- [Permission modes](./user/permission-modes.md)
- [Terminal history](./user/terminal.md)
- [Source control](./user/source-control.md)
- [Project settings](./user/project-settings.md)
- [Organizations](./user/organizations.md)
- [Appearance and themes](./user/appearance.md)
- [Keyboard shortcuts](./user/keybindings.md)
- [Voice dictation](./user/voice-dictation.md)
- [Organizing threads](./user/thread-sidebar.md)
- [Review usage](./user/usage.md)
- [Customize a project icon](./user/project-settings.md)
- [Remote access](./user/remote-access.md)
- [Keeping app and server in sync](./user/updating.md)
- [Source control integrations](./user/source-control.md)
- [Background service (Linux)](./user/background-service.md)
- Providers: [Codex](./user/providers-codex.md) · [Claude](./user/providers-claude.md) · [Hermes](./user/providers-hermes.md) · [OpenCode](./user/providers-opencode.md)

Upstream Expo/React Native mobile app: [apps/mobile/README.md](../apps/mobile/README.md)

- [SnapShots](./user/snap-shot.md)
- [Visual replies](./user/html-renders.md)
- [Import browser sessions](./user/browser-import.md)
- [Devices](./user/devices.md)
- [Usage and limits](./user/usage.md)
- [Product usage data](./user/telemetry.md)
- [Remote access](./user/remote-access.md)
- [Outside agents (MCP)](./user/outside-agents.md)
- [Running in the background](./user/background-service.md)
- [Updating Arcwright Code](./user/updating.md)
- Provider guides: [Codex](./user/providers-codex.md) · [Claude](./user/providers-claude.md) · [OpenCode](./user/providers-opencode.md) · [Antigravity](./user/providers-antigravity.md) · [Pi](./user/providers-pi.md)

---

## Working on Arcwright Code

Start with the [development runbook](./operations/development.md) and
[contribution policy](../CONTRIBUTING.md).

Internal notes preserve architectural decisions, constraints, and implementation traps that the
source alone does not explain. Most code changes do not need an internal documentation update. Follow the
[documentation rules](../AGENTS.md#documentation) before adding one.

- [Architecture overview](./internals/overview.md)
- [Glossary](./internals/glossary.md)
- [Connection runtime](./internals/connection-runtime.md)
- [Providers](./internals/providers.md)
- [Pull request file revisions](./internals/pull-request-file-revisions.md)
- [Model classification](./internals/model-manifest.md)
- [Remote environments](./internals/remote.md)
- [Server updates](./internals/server-updates.md)
- [Resource telemetry](./internals/resource-telemetry.md)
- [Product analytics](./internals/product-analytics.md)
- [Environment auth](./internals/environment-auth.md)
- [Organizations architecture](./internals/organizations.md)
- [T3 Connect](./internals/t3-connect.md)
- [PWA Web Push](./internals/pwa-web-push.md)
- [Remote preview viewing](./internals/preview-remote-viewing.md)
- [Assistant citations](./internals/assistant-citations.md)
- [Mobile navigation](./internals/mobile-navigation.md)
- [Mobile development lifecycle](./internals/mobile-development.md)
- [Terminal runtime](./internals/terminal-runtime.md)
- [Devices](./internals/devices.md)
- [Voice input](./internals/voice-input.md)

### Runbooks

- [Fork Android APK: build, install, edit, and backend connections](./operations/android-pwa.md)

- [Development and local builds](./operations/development.md)
- [T3 Connect setup](./operations/connect-setup.md)
- [Release](./operations/release.md)
- [Observability](./operations/observability.md)
- [Relay observability](./operations/relay-observability.md)
- [Mobile app store screenshots](./operations/mobile-app-store-screenshots.md)
