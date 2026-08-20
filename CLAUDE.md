@AGENTS.md

## Packaging

Never stamp AppImage, DMG, or NSIS artifacts with fork suffixes or nicknames. Use the stock `apps/desktop/package.json` version. Do not set `T3CODE_DESKTOP_VERSION` / `--build-version` unless it matches that version exactly.
