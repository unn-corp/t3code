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
  new URL("./ChatComposer.tsx", import.meta.url),
  "utf8",
);
const composerStyles = NodeFS.readFileSync(new URL("../../index.css", import.meta.url), "utf8");

describe("composer voice halo", () => {
  it("carries the active phase into the body portal for both drawer states", () => {
    expect(chatViewSource).toContain("chat-composer-voice-root");
    expect(chatComposerSource).toContain("voiceInputPhase={voiceInputPhase}");
    expect(chatComposerSource).toContain("chat-composer-voice-portal-halo");
    expect(composerStyles).toContain(".chat-composer-voice-portal-halo::before");
  });

  it.each(DRAWER_CASES)(
    "renders the %s %s drawer in a phase-marked, non-clipping portal wrapper",
    (phase, drawerState) => {
      const markup = renderToStaticMarkup(
        createElement(
          ComposerCommandMenuPortal,
          { voiceInputPhase: phase },
          createElement("div", {
            className: "chat-composer-drawer-surface relative w-full overflow-hidden",
            "data-composer-command-drawer": drawerState === "command" ? "true" : undefined,
            "data-composer-stash-drawer": drawerState === "stash" ? "true" : undefined,
          }),
        ),
      );
      const haloIndex = markup.indexOf("chat-composer-voice-portal-halo");
      const drawerIndex = markup.indexOf("chat-composer-drawer-surface");

      expect(markup).toContain('data-composer-drawer-layer="true"');
      expect(markup).toContain(`data-composer-voice-phase="${phase}"`);
      expect(markup).toContain("chat-composer-voice-portal-halo relative overflow-visible");
      expect(markup).toContain(`data-composer-${drawerState}-drawer="true"`);
      expect(markup).toContain("overflow-hidden");
      expect(haloIndex).toBeGreaterThan(-1);
      expect(drawerIndex).toBeGreaterThan(haloIndex);
      expect(composerStyles).toContain(".chat-composer-voice-portal-halo::before");
      expect(composerStyles).toContain('content: "";');
    },
  );
});
