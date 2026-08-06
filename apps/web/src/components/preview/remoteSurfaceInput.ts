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

/**
 * How far a finger may travel and still count as a tap. Below this a touch is
 * a click; above it the gesture becomes a scroll and never produces one.
 */
export const TOUCH_SCROLL_THRESHOLD_PX = 8;

export interface TouchGesture {
  readonly pointerId: number;
  readonly startX: number;
  readonly startY: number;
  readonly lastX: number;
  readonly lastY: number;
  /** Latched once the finger has moved far enough to mean scrolling. */
  readonly scrolling: boolean;
}

export interface TouchGestureAdvance {
  readonly gesture: TouchGesture;
  /**
   * Page-space scroll deltas, already inverted: dragging the page down means
   * scrolling up, the way a touchscreen behaves everywhere else.
   */
  readonly scroll: RemoteSurfacePoint | null;
}

export function beginTouchGesture(pointerId: number, x: number, y: number): TouchGesture {
  return { pointerId, startX: x, startY: y, lastX: x, lastY: y, scrolling: false };
}

/**
 * A finger drag has to become a scroll rather than a mouse drag, or a phone
 * cannot move a page at all: the canvas suppresses native panning so the host
 * can receive the gesture, and the host has no notion of touch.
 */
export function advanceTouchGesture(
  gesture: TouchGesture,
  x: number,
  y: number,
  scale: { readonly x: number; readonly y: number },
): TouchGestureAdvance {
  const travelled = Math.hypot(x - gesture.startX, y - gesture.startY);
  const scrolling = gesture.scrolling || travelled > TOUCH_SCROLL_THRESHOLD_PX;
  const next: TouchGesture = { ...gesture, lastX: x, lastY: y, scrolling };
  if (!scrolling) return { gesture: next, scroll: null };
  return {
    gesture: next,
    scroll: {
      x: (gesture.lastX - x) * scale.x,
      y: (gesture.lastY - y) * scale.y,
    },
  };
}

/** A gesture that never crossed the threshold is a tap, and taps click. */
export function isTapGesture(gesture: TouchGesture): boolean {
  return !gesture.scrolling;
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
