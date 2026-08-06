# Hermes

T3 Code connects to Hermes through its ACP server. Install Hermes with ACP
support, configure a model/provider in Hermes, then run:

```sh
hermes acp --setup
```

Add Hermes from **Settings → Providers**. The optional binary path selects a
different Hermes executable. The optional **HERMES_HOME path** is passed only
as `HERMES_HOME`; T3 Code never changes `HOME`.

Hermes owns credentials and provider setup. T3 Code does not install Hermes,
store its credentials, or offer a credential wizard. A failed provider health
check links the remedy to `hermes acp --setup`.

Models are discovered from the active Hermes ACP configuration. Their IDs are
opaque and may be provider-qualified, for example `openrouter:model-id`.
Custom model IDs must match the exact ID Hermes expects. Model selection,
favorites, visibility, and ordering are scoped to each Hermes instance.

Hermes supports regular approval-required sessions and full-access sessions.
T3 Code maps these to Hermes ACP's `default` and `dont_ask` modes.
Hermes does not expose T3 Code's planning-mode toggle.
