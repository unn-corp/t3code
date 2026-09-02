// @effect-diagnostics nodeBuiltinImport:off - Regression coverage compares the composer DOM and CSS contracts.
import * as NodeFS from "node:fs";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ComposerCommandMenuPortal } from "./ChatComposer";

const VOICE_PHASES = ["recording", "transcribing", "success", "no-audio"] as const;
const DRAWER_STATES = ["command", "stash"] as const;
const DRAWER_CASES = VOICE_PHASES.flatMap((phase) =>
  DRAWER_STATES.map((drawerState) => [phase, drawerState] as const),
);

const chatViewSource = NodeFS.readFileSync(new URL("../ChatView.tsx", import.meta.url), "utf8");
const chatComposerSource = NodeFS.readFileSync(
  new URL("ChatComposer.tsx", import.meta.url),
  "utf8",
);
const composerStyles = NodeFS.readFileSync(new URL("../../index.css", import.meta.url), "utf8");

describe("composer voice halo", () => {
  it("owns the voice phase above the attached drawers and composer shell", () => {
    const voiceRootIndex = chatViewSource.indexOf("chat-composer-voice-root");
    const composerShellIndex = chatViewSource.indexOf("<ComposerSurface.Shell", voiceRootIndex);
    const bannerDockIndex = chatComposerSource.indexOf("<ComposerBanner.Dock");
    const mainSurfaceIndex = chatComposerSource.indexOf("<ComposerSurface.Main", bannerDockIndex);

    expect(voiceRootIndex).toBeGreaterThan(-1);
    expect(composerShellIndex).toBeGreaterThan(voiceRootIndex);
    expect(bannerDockIndex).toBeGreaterThan(-1);
    expect(mainSurfaceIndex).toBeGreaterThan(bannerDockIndex);
  });

  it("draws the halo on each visible attached surface instead of the shell bounds", () => {
    expect(composerStyles).not.toContain(
      ".chat-composer-glass-shell.chat-voice-recording-active::after",
    );
    expect(composerStyles).toContain(".chat-composer-voice-halo-surface::before");
    expect(composerStyles).toContain('[data-composer-banner-surface="attached"]');
    expect(composerStyles).toContain('[data-slot="composer-context-strip"]');
  });

  it.each(DRAWER_CASES)(
    "renders the %s %s drawer in a phase-marked, non-clipping portal wrapper",
    (phase, drawerState) => {
      const markup = renderToStaticMarkup(
        createElement(
          ComposerCommandMenuPortal,
          { voiceInputPhase: phase },
          createElement("div", {
            "data-composer-command-drawer": drawerState === "command" ? "true" : undefined,
            "data-composer-stash-drawer": drawerState === "stash" ? "true" : undefined,
          }),
        ),
      );

      expect(markup).toContain('data-composer-drawer-layer="true"');
      expect(markup).toContain(`data-composer-voice-phase="${phase}"`);
      expect(markup).toContain("chat-composer-voice-portal-halo relative overflow-visible");
      expect(markup).toContain(`data-composer-${drawerState}-drawer="true"`);
      expect(composerStyles).toContain(".chat-composer-voice-portal-halo::before");
    },
  );
});
