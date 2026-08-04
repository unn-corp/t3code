import { describe, expect, it } from "vite-plus/test";

import { toKeyEvent, toModifiers, toMouseButton, toPagePoint } from "./remoteSurfaceInput";

const geometry = {
  elementWidth: 400,
  elementHeight: 300,
  pageWidth: 1200,
  pageHeight: 900,
};

describe("toPagePoint", () => {
  it("scales a canvas offset up to the page coordinate space", () => {
    expect(toPagePoint(geometry, { offsetX: 100, offsetY: 150 })).toEqual({ x: 300, y: 450 });
  });

  it("maps the origin to the origin", () => {
    expect(toPagePoint(geometry, { offsetX: 0, offsetY: 0 })).toEqual({ x: 0, y: 0 });
  });

  it("clamps a pointer that left the canvas to the page bounds", () => {
    expect(toPagePoint(geometry, { offsetX: 900, offsetY: -40 })).toEqual({ x: 1200, y: 0 });
  });

  it("returns null when the canvas has not been laid out yet", () => {
    expect(toPagePoint({ ...geometry, elementWidth: 0 }, { offsetX: 10, offsetY: 10 })).toBeNull();
  });

  it("returns null before a frame has reported a page size", () => {
    expect(
      toPagePoint({ ...geometry, pageWidth: 0, pageHeight: 0 }, { offsetX: 10, offsetY: 10 }),
    ).toBeNull();
  });

  it("returns null rather than emitting NaN for non-finite geometry", () => {
    expect(
      toPagePoint({ ...geometry, elementWidth: Number.NaN }, { offsetX: 10, offsetY: 10 }),
    ).toBeNull();
  });
});

describe("toMouseButton", () => {
  it("maps the DOM button indices", () => {
    expect(toMouseButton(0)).toBe("left");
    expect(toMouseButton(1)).toBe("middle");
    expect(toMouseButton(2)).toBe("right");
  });

  it("falls back to left for buttons the host has no name for", () => {
    expect(toMouseButton(4)).toBe("left");
  });
});

describe("toModifiers", () => {
  const none = { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false };

  it("is zero with no modifiers held", () => {
    expect(toModifiers(none)).toBe(0);
  });

  it("packs each modifier into its CDP bit", () => {
    expect(toModifiers({ ...none, altKey: true })).toBe(1);
    expect(toModifiers({ ...none, ctrlKey: true })).toBe(2);
    expect(toModifiers({ ...none, metaKey: true })).toBe(4);
    expect(toModifiers({ ...none, shiftKey: true })).toBe(8);
  });

  it("combines held modifiers", () => {
    expect(toModifiers({ altKey: true, ctrlKey: false, metaKey: true, shiftKey: true })).toBe(13);
  });
});

describe("toKeyEvent", () => {
  it("sends printable text alongside a character keydown", () => {
    expect(toKeyEvent({ kind: "keyDown", key: "a", code: "KeyA", modifiers: 0 })).toEqual({
      _tag: "key",
      kind: "keyDown",
      key: "a",
      code: "KeyA",
      modifiers: 0,
      text: "a",
    });
  });

  it("omits text for named keys so the host does not type their name", () => {
    const event = toKeyEvent({ kind: "keyDown", key: "Enter", code: "Enter", modifiers: 0 });
    expect(event.text).toBeUndefined();
  });

  it("omits text on keyup", () => {
    const event = toKeyEvent({ kind: "keyUp", key: "a", code: "KeyA", modifiers: 0 });
    expect(event.text).toBeUndefined();
  });

  it("treats a control or meta chord as a shortcut rather than typed text", () => {
    expect(
      toKeyEvent({ kind: "keyDown", key: "a", code: "KeyA", modifiers: 2 }).text,
    ).toBeUndefined();
    expect(
      toKeyEvent({ kind: "keyDown", key: "a", code: "KeyA", modifiers: 4 }).text,
    ).toBeUndefined();
  });

  it("still sends text for a shifted character", () => {
    expect(toKeyEvent({ kind: "keyDown", key: "A", code: "KeyA", modifiers: 8 }).text).toBe("A");
  });

  it("keeps multi-byte characters as one printable unit", () => {
    expect(toKeyEvent({ kind: "keyDown", key: "😀", code: "", modifiers: 0 }).text).toBe("😀");
  });
});
