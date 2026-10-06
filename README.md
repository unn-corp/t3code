# T3 Code

T3 Code is an "agent harness control surface" for agents running on your computers.

This is the [unn-corp fork](https://github.com/unn-corp/t3code). It includes its own Android app in
[`apps/android-pwa`](./apps/android-pwa), packaged as `com.devotek.t3code.pwa`. It bundles this fork's
web interface and native phone features, and primarily connects to your environments over Tailscale.
It is separate from the upstream Google Play app and the Expo/React Native app in `apps/mobile`.

Start with the [fork Android guide](./docs/user/android-fork.md) for installation and pairing, or the
[Android build and development runbook](./docs/operations/android-pwa.md) to build, edit, and understand
its backend connections. Web and Electron clients are also available.

Works with your subscriptions on Claude Code, Codex, Cursor, Grok Build, OpenCode, and Google Antigravity. If they're set up on your computer, T3 Code can control them.

## "Wait, what are you selling me?"

Nothing. We built T3 Code because we wanted the best possible development experience with agents. We were inspired by existing solutions like the Codex desktop app, Conductor, Claude Desktop and Cursor Glass, but none met our bar.

We wanted something performant, remote-ready, and truly open. If we ever go the wrong direction, we want you to have everything you need to fork and build the editor that you want.

## Installation

Use [this fork's releases](https://github.com/unn-corp/t3code/releases) for Android,
Windows x64, and Linux x64. The [update guide](./docs/user/updating.md) explains
channels, stopped-work checks, and recovery. The [release runbook](./docs/operations/fork-releases.md)
owns baseline commissioning and nightly/stable publishing. Build the standalone
Android APK with the [Android runbook](./docs/operations/android-pwa.md); upstream
Expo/store mobile distribution is separate.

> [!WARNING]
> T3 Code currently supports Codex, Claude, Cursor, Grok Build, OpenCode, and Antigravity. Install and authenticate at least one provider before use:
>
> - Codex: install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`
> - Claude: install [Claude Code](https://claude.com/product/claude-code) and run `claude auth login`
> - Cursor: install [Cursor CLI](https://cursor.com/cli) and run `agent login`
> - Grok Build: install [Grok Build CLI](https://x.ai/cli) and run `grok login`
> - OpenCode: install [OpenCode](https://opencode.ai) and run `opencode auth login`
> - Antigravity: enable it in Settings, then use **Install Antigravity** and **Sign in with Google**. No CLI is required.

### Command line

After the fork updater baseline and its first eligible release are commissioned:

```bash
curl -fsSL https://raw.githubusercontent.com/unn-corp/t3code/main/scripts/install.sh | sh
```

The Linux installer needs Python 3 to validate release metadata. On Windows,
run in PowerShell:

```powershell
irm https://raw.githubusercontent.com/unn-corp/t3code/main/scripts/install.ps1 | iex
```

These install the fork's server archives, not the upstream npm package. Stop all
fork work before manually replacing or restarting runtimes. Run `t3 --help` for
the supported CLI and [read the update guide](./docs/user/updating.md) before maintenance.

### Desktop and Android

Use the Windows NSIS installer or Linux AppImage/`.deb` from
[this fork's releases](https://github.com/unn-corp/t3code/releases). Steam Deck
uses AppImage. Installing a `.deb` can require Linux administrator authorization.
Use the fork APK and keep its package/signing identity when updating Android;
never uninstall or clear storage to update saved connections.

Upstream winget, Homebrew, AUR, `t3.codes` installers, and `npx t3` install upstream
T3 Code. They do not deliver this fork's updater or Android app.

## Some notes

We are very very early in this project. Expect bugs.

We are (mostly) not accepting contributions yet. Small fixes may be considered. Big features will not be.

## Documentation

Full docs live in [docs/](./docs). There's no docs site yet.

- [Fork Android app: install, pair, and use](./docs/user/android-fork.md)
- [Fork Android app: build, edit, and backend connections](./docs/operations/android-pwa.md)
- [Install and first run](./docs/user/install.md)
- [Permission modes](./docs/user/permission-modes.md)
- [Keyboard shortcuts](./docs/user/keybindings.md)
- [Project settings](./docs/user/project-settings.md)
- [Appearance preferences](./docs/user/appearance.md)
- [Remote access from a phone or another machine](./docs/user/remote-access.md)
- [Keeping app and server in sync](./docs/user/updating.md)
- [Source control integrations](./docs/user/source-control.md)
- Multiple accounts: [Codex](./docs/user/providers-codex.md) · [Claude](./docs/user/providers-claude.md)
- [Run T3 Code as a background service](./docs/user/background-service.md)

Building from source? Start at [docs/internals/overview.md](./docs/internals/overview.md).

## If you REALLY want to contribute still.... read this first

### Install `vp`

T3 Code uses Vite+ so you'll need to install the global `vp` command-line tool.

#### macOS / Linux

```bash
curl -fsSL https://vite.plus | bash
```

#### Windows

```bash
irm https://vite.plus/ps1 | iex
```

Checkout their getting started guide for more information: https://viteplus.dev/guide/

### Install dependencies

```bash
vp i
```

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before reporting a bug or opening a PR.

Have a feature request? Start an [Ideas discussion](https://github.com/pingdotgg/t3code/discussions/categories/ideas).

Need support? Join the [Discord](https://discord.gg/jn4EGJjrvv).
