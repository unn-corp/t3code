import type { PreviewInputEvent, PreviewInputMouseButton } from "@t3tools/contracts";

/**
 * Pure mapping from browser events on the viewer's canvas to the page
 * coordinates the host will replay.
 *
 * The canvas is laid out to fit its container, so it is almost never the same
 * size as the page it shows. Every pointer coordinate therefore has to be
 * rescaled through the frame's declared page size before it means anything on
 * the host. Keeping that arithmetic here (rather than inline in the component)
 * is what makes it testable without a DOM.
 */
export interface RemoteSurfaceGeometry {
  /** On-screen size of the canvas element, in CSS pixels. */
  readonly elementWidth: number;
  readonly elementHeight: number;
  /** Page viewport size the current frame was captured from. */
  readonly pageWidth: number;
  readonly pageHeight: number;
}

export interface RemoteSurfacePointer {
  /** Pointer position relative to the canvas element's top-left corner. */
  readonly offsetX: number;
  readonly offsetY: number;
}

export interface RemoteSurfacePoint {
  readonly x: number;
  readonly y: number;
}

const clamp = (value: number, max: number): number => Math.min(Math.max(value, 0), max);

/**
 * Maps a pointer offset to a page coordinate. Returns null when the geometry
 * cannot produce a meaningful answer (zero-sized canvas or a frame that never
 * reported a page size), so callers drop the event instead of dispatching a
 * NaN into the host's input pipeline.
 */
export function toPagePoint(
  geometry: RemoteSurfaceGeometry,
  pointer: RemoteSurfacePointer,
): RemoteSurfacePoint | null {
  if (
    geometry.elementWidth <= 0 ||
    geometry.elementHeight <= 0 ||
    geometry.pageWidth <= 0 ||
    geometry.pageHeight <= 0
  ) {
    return null;
  }
  const x = (pointer.offsetX / geometry.elementWidth) * geometry.pageWidth;
  const y = (pointer.offsetY / geometry.elementHeight) * geometry.pageHeight;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return {
    x: clamp(x, geometry.pageWidth),
    y: clamp(y, geometry.pageHeight),
  };
}

const MOUSE_BUTTONS: ReadonlyArray<PreviewInputMouseButton> = ["left", "middle", "right"];

/** DOM `MouseEvent.button` to the CDP button name. */
export function toMouseButton(button: number): PreviewInputMouseButton {
  return MOUSE_BUTTONS[button] ?? "left";
}

/**
 * CDP packs modifiers into a bitfield: alt 1, control 2, meta 4, shift 8.
 */
export function toModifiers(input: {
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
}): number {
  return (
    (input.altKey ? 1 : 0) |
    (input.ctrlKey ? 2 : 0) |
    (input.metaKey ? 4 : 0) |
    (input.shiftKey ? 8 : 0)
  );
}

/**
 * A key press is only forwarded as text when it is a single printable
 * character. Sending `text` for "Enter" or "ArrowLeft" would make the host type
 * the literal key name into the page.
 */
export function toKeyEvent(input: {
  readonly kind: "keyDown" | "keyUp";
  readonly key: string;
  readonly code: string;
  readonly modifiers: number;
}): Extract<PreviewInputEvent, { _tag: "key" }> {
  const printable =
    input.kind === "keyDown" &&
    Array.from(input.key).length === 1 &&
    // A modified key is a shortcut, not typed text.
    (input.modifiers & (2 | 4)) === 0;
  return {
    _tag: "key",
    kind: input.kind,
    key: input.key.slice(0, 32),
    code: input.code.slice(0, 32),
    modifiers: input.modifiers,
    ...(printable ? { text: input.key } : {}),
  };
}
