# t3code UI profile

Companion to the [adoption entry](UNNDEV-UI-STANDARDS.md) and [shared core](UNNDEV-UI-STANDARDS-CORE.md).

## Applicable surfaces

WEB + EDITOR for browser and Electron web views; NATIVE + TOUCH for mobile and native shell behavior. Select the relevant tags per changed surface.

## Local authority and preservation

- [Agent agreement](../AGENTS.md) and [design authority](../DESIGN.md) remain in force. Retain the compact, native-feeling workspace, restrained accents and existing light/dark themes.
- [Web primitives](../apps/web/src/components/ui/) own their visual variants and sizes. Do not restyle them with className; layout belongs on the parent and generic new looks belong in explicit variants.
- [Shared client runtime](../packages/client-runtime/) and [contracts](../packages/contracts/) preserve behavior across clients. Check entry points, providers, reverse states and connection modes for each applicable feature.
- Avoid continuously repainting animations. Show truthful connection, queued/running/completed and failure states without hiding stale or unavailable information.
- Native mobile evaluation uses platform accessibility and scaling behavior; web conformance is not a blanket claim for native clients.

## Verification

Use focused tests and targeted lint/typecheck under the existing agent rules. Do not run repo-wide checks or launch browsers/dev servers without the existing required authorization. These documents record durable cross-surface constraints, not a duplicate feature catalog.

For each future implementation, record the affected states and input methods, relevant core rule IDs, focused checks and manual evidence. Documentation installation alone establishes neither runtime compliance nor completion of the existing release gates.

## Exceptions

No new exception is granted by this profile. Keep named existing local exceptions with their governing source. Any new exception must identify the rule ID, bounded surface, reason, owner, compensating behavior, verification and review date. Escalate unresolved conflicts before implementation.
