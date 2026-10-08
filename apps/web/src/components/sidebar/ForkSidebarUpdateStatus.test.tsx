// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { SidebarProvider } from "../ui/sidebar";
import { TooltipProvider } from "../ui/tooltip";
import { ForkSidebarUpdateStatus } from "./ForkSidebarUpdateStatus";

const update = vi.hoisted(() => ({
  phase: "available" as "available" | "failed" | "idle" | "completed",
  blockers: [
    { label: "Known fork installations must be registered before automatic installation." },
  ],
  lastError: null as string | null,
}));
vi.mock("../../state/forkUpdates", () => ({
  localForkUpdateController: () => null,
  useForkUpdates: () => ({ status: update }),
}));
vi.mock("~/hooks/useMediaQuery", () => ({ useIsMobile: () => false }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, hash, ...props }: ComponentProps<"a"> & { to: string; hash: string }) => (
    <a href={`${to}#${hash}`} {...props} />
  ),
}));

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
      unobserve() {}
    },
  );
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    value: () => [],
  });
  update.phase = "available";
  update.lastError = null;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  Reflect.deleteProperty(Element.prototype, "getAnimations");
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function renderStatus() {
  await act(async () =>
    root.render(
      <TooltipProvider delay={0}>
        <SidebarProvider>
          <ul>
            <ForkSidebarUpdateStatus />
          </ul>
        </SidebarProvider>
      </TooltipProvider>,
    ),
  );
}

it("keeps update prose out of the sidebar and reveals the blocker on hover", async () => {
  await renderStatus();
  expect(container.textContent).toBe("");
  const trigger = container.querySelector("a")!;
  expect(trigger.querySelector("svg")).not.toBeNull();
  expect(trigger.getAttribute("href")).toBe("/settings/general#app-updates");
  expect(document.querySelector('[data-slot="tooltip-popup"]')).toBeNull();
  await act(async () => {
    trigger.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    trigger.dispatchEvent(new MouseEvent("mouseenter"));
    trigger.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(100);
  });
  const tooltip = document.querySelector('[data-slot="tooltip-popup"]');
  expect(tooltip?.textContent).toContain("Update available");
  expect(tooltip?.textContent).toContain(update.blockers[0]!.label);
  expect(container.textContent).toBe("");
});

it("exposes failure details to keyboard focus and removes the icon when updates complete", async () => {
  update.phase = "failed";
  update.lastError = "The running installer could not be cached for recovery.";
  await renderStatus();
  const trigger = container.querySelector("a")!;
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab" }));
    trigger.focus();
    await vi.advanceTimersByTimeAsync(100);
  });
  expect(document.querySelector('[data-slot="tooltip-popup"]')?.textContent).toContain(
    update.lastError,
  );
  update.phase = "completed";
  await renderStatus();
  expect(container.querySelector("a")).toBeNull();
  expect(document.querySelector('[data-slot="tooltip-popup"]')).toBeNull();
});
