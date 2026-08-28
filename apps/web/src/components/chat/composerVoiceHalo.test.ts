// @effect-diagnostics nodeBuiltinImport:off - Regression coverage compares the composer DOM and CSS contracts.
import * as NodeFS from "node:fs";

import { describe, expect, it } from "vite-plus/test";

const chatViewSource = NodeFS.readFileSync(new URL("../ChatView.tsx", import.meta.url), "utf8");
const composerStyles = NodeFS.readFileSync(new URL("../../index.css", import.meta.url), "utf8");

describe("composer voice halo", () => {
  it("owns the voice phase above the attached drawers and composer shell", () => {
    const voiceRootIndex = chatViewSource.indexOf("chat-composer-voice-root");
    const bannerStackIndex = chatViewSource.indexOf("<ComposerBannerStack", voiceRootIndex);
    const composerShellIndex = chatViewSource.indexOf("chat-composer-glass-shell", voiceRootIndex);

    expect(voiceRootIndex).toBeGreaterThan(-1);
    expect(bannerStackIndex).toBeGreaterThan(voiceRootIndex);
    expect(composerShellIndex).toBeGreaterThan(bannerStackIndex);
  });

  it("draws the halo on each visible attached surface instead of the shell bounds", () => {
    expect(composerStyles).not.toContain(
      ".chat-composer-glass-shell.chat-voice-recording-active::after",
    );
    expect(composerStyles).toContain(".chat-composer-voice-halo-surface::before");
    expect(composerStyles).toContain(
      ":is(.chat-composer-drawer-surface, .chat-composer-top-drawer)::after",
    );
    expect(composerStyles).toContain(".chat-composer-context-strip::after");
  });
});
