// @vitest-environment jsdom
import source from "../../../android-pwa/app/src/main/assets/t3-browser-runtime.js?raw";
import { beforeEach, expect, it, vi } from "vite-plus/test";

const run = new Function(`return ${source}`)() as (
  operation: string,
  input: Record<string, unknown>,
) => Promise<Record<string, unknown>>;
beforeEach(() => {
  document.body.innerHTML =
    '<label for="message">Message</label><input id="message" value="old"><button id="send">Send</button><button id="other">Other</button>';
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
    x: 10,
    y: 20,
    width: 120,
    height: 40,
    left: 10,
    top: 20,
    right: 130,
    bottom: 60,
    toJSON: () => ({}),
  });
  Element.prototype.scrollIntoView = vi.fn();
});
it("snapshots usable selectors and semantic names for agent actions", async () => {
  const snapshot = await run("snapshot", {});
  expect(snapshot.interactiveElements).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        tag: "input",
        role: "textbox",
        name: "Message",
        selector: '[data-t3-phone-ref="e1"]',
      }),
      expect.objectContaining({ tag: "button", role: "button", name: "Send" }),
    ]),
  );
  expect(await run("click", { locator: "ref=e2" })).toEqual({ x: 70, y: 40 });
});
it("fills controlled inputs and emits input events", async () => {
  const input = document.querySelector<HTMLInputElement>("#message")!;
  const changed = vi.fn();
  input.addEventListener("input", changed);
  await run("type", { locator: "role=textbox[name='Message']", text: "hello", clear: true });
  expect(input.value).toBe("hello");
  expect(changed).toHaveBeenCalledOnce();
  await run("type", { selector: "#message", text: " world" });
  expect(input.value).toBe("hello world");
});
it("converts locators and snapshot bounds to the visible viewport after phone zoom", async () => {
  vi.stubGlobal("visualViewport", { offsetLeft: 20, offsetTop: 10 });
  try {
    expect(await run("click", { selector: "#send" })).toEqual({ x: 50, y: 30 });
    expect(await run("click", { x: 15, y: 25 })).toEqual({ x: 15, y: 25 });
    const snapshot = await run("snapshot", {});
    expect(snapshot.interactiveElements).toEqual(
      expect.arrayContaining([expect.objectContaining({ x: -10, y: 10 })]),
    );
  } finally {
    vi.unstubAllGlobals();
  }
});
it("refuses ambiguous and disabled click targets", async () => {
  document.querySelector("#other")!.textContent = "Send";
  await expect(run("click", { locator: "role=button[name='Send']" })).rejects.toThrow(
    "More than one",
  );
  document.querySelector<HTMLButtonElement>("#send")!.disabled = true;
  await expect(run("click", { selector: "#send" })).rejects.toThrow("disabled");
});
it("waits for asynchronous changes and reports a timeout", async () => {
  vi.useFakeTimers();
  const pending = run("waitFor", { selector: "#ready", timeoutMs: 200 });
  const element = document.createElement("button");
  element.id = "ready";
  document.body.append(element);
  await vi.advanceTimersByTimeAsync(50);
  await expect(pending).resolves.toEqual(expect.objectContaining({ title: document.title }));
  const failed = expect(run("waitFor", { selector: "#missing", timeoutMs: 100 })).rejects.toThrow(
    "timed out",
  );
  await vi.advanceTimersByTimeAsync(150);
  await failed;
  vi.useRealTimers();
});
it("awaits evaluations without installing any native bridge in the page", async () => {
  expect(await run("evaluate", { expression: "Promise.resolve({answer:42})" })).toEqual({
    answer: 42,
  });
  await expect(run("evaluate", { expression: "1", returnByValue: false })).rejects.toThrow(
    "values only",
  );
  expect(window.t3Browser).toBeUndefined();
  expect(window.t3Notifications).toBeUndefined();
});
