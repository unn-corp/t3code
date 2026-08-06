"use client";

import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, PreviewInputEvent, ThreadId } from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { previewEnvironment } from "~/state/preview";
import { useAtomCommand } from "~/state/use-atom-command";

import {
  advanceTouchGesture,
  beginTouchGesture,
  isTapGesture,
  toKeyEvent,
  toModifiers,
  toMouseButton,
  toPagePoint,
  type RemoteSurfaceGeometry,
  type TouchGesture,
} from "./remoteSurfaceInput";

/**
 * The preview surface for a client that cannot render the page itself.
 *
 * The host owns the real browser; this draws the frames it publishes and sends
 * pointer and key events back. Frames are drawn to a canvas rather than an
 * <img> so a stale frame never flashes: the canvas keeps the last painted
 * pixels while the next one decodes.
 */
export function PreviewRemoteSurface(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly tabId: string;
  readonly className?: string;
  /**
   * While set, the next tap resolves the element under it instead of clicking
   * through. The page cannot host a picker overlay for a viewer that is only
   * receiving frames, so selection happens by asking the renderer.
   */
  readonly onPickAt?: (point: { readonly x: number; readonly y: number }) => void;
}) {
  const { environmentId, threadId, tabId, onPickAt } = props;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const geometryRef = useRef<RemoteSurfaceGeometry>({
    elementWidth: 0,
    elementHeight: 0,
    pageWidth: 0,
    pageHeight: 0,
  });
  const lastSequenceRef = useRef(-1);
  const touchRef = useRef<TouchGesture | null>(null);
  const keyboardRef = useRef<HTMLTextAreaElement | null>(null);
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [hasFrame, setHasFrame] = useState(false);

  const sendInput = useAtomCommand(previewEnvironment.sendInput, { reportFailure: false });

  // Attaching is what tells the server a viewer wants frames, so the
  // subscription lives and dies with this component. The parent only mounts it
  // while the surface is actually on screen, which is what stops the host's
  // screencast when nobody is looking.
  const framesAtom = useMemo(
    () => previewEnvironment.frames({ environmentId, input: { threadId, tabId } }),
    [environmentId, threadId, tabId],
  );
  const frameResult = useAtomValue(framesAtom);

  useEffect(() => {
    if (!AsyncResult.isSuccess(frameResult)) return;
    const event = frameResult.value;
    if (event._tag === "unavailable") {
      setUnavailable(event.reason);
      return;
    }
    if (event._tag === "attached") {
      setUnavailable(null);
      return;
    }
    const frame = event.frame;
    // Frames can overtake each other on a lossy link. Anything older than what
    // is already painted is dropped rather than rewinding the picture.
    if (frame.seq <= lastSequenceRef.current && lastSequenceRef.current - frame.seq < 1_000) {
      return;
    }
    lastSequenceRef.current = frame.seq;
    geometryRef.current = {
      ...geometryRef.current,
      pageWidth: frame.pageWidth,
      pageHeight: frame.pageHeight,
    };
    const canvas = canvasRef.current;
    if (!canvas) return;
    const image = new Image();
    image.addEventListener(
      "load",
      () => {
        const context = canvas.getContext("2d");
        if (!context) return;
        if (canvas.width !== frame.width || canvas.height !== frame.height) {
          canvas.width = frame.width;
          canvas.height = frame.height;
        }
        context.drawImage(image, 0, 0, frame.width, frame.height);
        setHasFrame(true);
        setUnavailable(null);
      },
      { once: true },
    );
    image.src = `data:image/jpeg;base64,${frame.data}`;
  }, [frameResult]);

  const measure = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    geometryRef.current = {
      ...geometryRef.current,
      elementWidth: rect.width,
      elementHeight: rect.height,
    };
  }, []);

  useEffect(() => {
    measure();
    const canvas = canvasRef.current;
    if (!canvas || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [measure]);

  const dispatch = useCallback(
    (event: PreviewInputEvent) => {
      void sendInput({ environmentId, input: { threadId, tabId, event } });
    },
    [environmentId, sendInput, tabId, threadId],
  );

  const pointFor = useCallback((clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    return toPagePoint(geometryRef.current, {
      offsetX: clientX - rect.left,
      offsetY: clientY - rect.top,
    });
  }, []);

  /** Canvas-pixel to page-pixel ratio, for turning a drag into a scroll. */
  const pageScale = useCallback(() => {
    const { elementWidth, elementHeight, pageWidth, pageHeight } = geometryRef.current;
    if (elementWidth <= 0 || elementHeight <= 0) return null;
    return { x: pageWidth / elementWidth, y: pageHeight / elementHeight };
  }, []);

  const tapAt = useCallback(
    (point: { readonly x: number; readonly y: number }, modifiers: number) => {
      for (const kind of ["mousePressed", "mouseReleased"] as const) {
        dispatch({
          _tag: "mouse",
          kind,
          x: point.x,
          y: point.y,
          button: "left",
          clickCount: 1,
          modifiers,
        });
      }
    },
    [dispatch],
  );

  /**
   * Touch is handled apart from mouse and pen. A finger has no hover and no
   * buttons, and the page it is driving only understands a mouse, so a drag
   * has to become a scroll and a stationary press has to become a click. The
   * host never sees the difference.
   */
  const handleTouchDown = useCallback((reactEvent: React.PointerEvent<HTMLCanvasElement>) => {
    touchRef.current = beginTouchGesture(
      reactEvent.pointerId,
      reactEvent.clientX,
      reactEvent.clientY,
    );
    reactEvent.currentTarget.setPointerCapture(reactEvent.pointerId);
  }, []);

  const handleTouchMove = useCallback(
    (reactEvent: React.PointerEvent<HTMLCanvasElement>) => {
      const gesture = touchRef.current;
      const scale = pageScale();
      if (!gesture || gesture.pointerId !== reactEvent.pointerId || !scale) return;
      const advanced = advanceTouchGesture(gesture, reactEvent.clientX, reactEvent.clientY, scale);
      touchRef.current = advanced.gesture;
      if (!advanced.scroll) return;
      const point = pointFor(reactEvent.clientX, reactEvent.clientY);
      if (!point) return;
      dispatch({
        _tag: "wheel",
        x: point.x,
        y: point.y,
        deltaX: advanced.scroll.x,
        deltaY: advanced.scroll.y,
        modifiers: toModifiers(reactEvent),
      });
    },
    [dispatch, pageScale, pointFor],
  );

  const handleTouchUp = useCallback(
    (reactEvent: React.PointerEvent<HTMLCanvasElement>) => {
      const gesture = touchRef.current;
      touchRef.current = null;
      if (reactEvent.currentTarget.hasPointerCapture(reactEvent.pointerId)) {
        reactEvent.currentTarget.releasePointerCapture(reactEvent.pointerId);
      }
      if (!gesture || gesture.pointerId !== reactEvent.pointerId) return;
      if (!isTapGesture(gesture)) return;
      const point = pointFor(reactEvent.clientX, reactEvent.clientY);
      if (!point) return;
      if (onPickAt) {
        // Picking must not also click: activating the thing being selected
        // would navigate away from what the user meant to point at.
        onPickAt(point);
        return;
      }
      tapAt(point, toModifiers(reactEvent));
      // A canvas cannot raise the on-screen keyboard, so a tap hands focus to
      // a hidden field. Whatever the page focused now receives what is typed.
      keyboardRef.current?.focus();
    },
    [onPickAt, pointFor, tapAt],
  );

  const handlePointer = useCallback(
    (kind: "mousePressed" | "mouseReleased" | "mouseMoved") =>
      (reactEvent: React.PointerEvent<HTMLCanvasElement>) => {
        if (reactEvent.pointerType === "touch") {
          if (kind === "mousePressed") handleTouchDown(reactEvent);
          else if (kind === "mouseMoved") handleTouchMove(reactEvent);
          else handleTouchUp(reactEvent);
          return;
        }
        const point = pointFor(reactEvent.clientX, reactEvent.clientY);
        if (!point) return;
        if (onPickAt) {
          if (kind === "mousePressed") onPickAt(point);
          return;
        }
        if (kind === "mousePressed") {
          // Keeps keystrokes flowing to the surface after a tap.
          reactEvent.currentTarget.focus();
          reactEvent.currentTarget.setPointerCapture(reactEvent.pointerId);
        }
        if (
          kind === "mouseReleased" &&
          reactEvent.currentTarget.hasPointerCapture(reactEvent.pointerId)
        ) {
          reactEvent.currentTarget.releasePointerCapture(reactEvent.pointerId);
        }
        dispatch({
          _tag: "mouse",
          kind,
          x: point.x,
          y: point.y,
          button: kind === "mouseMoved" ? "none" : toMouseButton(reactEvent.button),
          clickCount: kind === "mouseMoved" ? 0 : 1,
          modifiers: toModifiers(reactEvent),
        });
      },
    [dispatch, handleTouchDown, handleTouchMove, handleTouchUp, onPickAt, pointFor],
  );

  const handleWheel = useCallback(
    (reactEvent: React.WheelEvent<HTMLCanvasElement>) => {
      const point = pointFor(reactEvent.clientX, reactEvent.clientY);
      if (!point) return;
      dispatch({
        _tag: "wheel",
        x: point.x,
        y: point.y,
        deltaX: reactEvent.deltaX,
        deltaY: reactEvent.deltaY,
        modifiers: toModifiers(reactEvent),
      });
    },
    [dispatch, pointFor],
  );

  const handleKey = useCallback(
    (kind: "keyDown" | "keyUp") => (reactEvent: React.KeyboardEvent<HTMLCanvasElement>) => {
      // The page owns these keys while the surface is focused; letting them
      // bubble would scroll the chat behind it.
      reactEvent.preventDefault();
      dispatch(
        toKeyEvent({
          kind,
          key: reactEvent.key,
          code: reactEvent.code,
          modifiers: toModifiers(reactEvent),
        }),
      );
    },
    [dispatch],
  );

  /**
   * Text typed into the hidden field is replayed as character input. A phone
   * keyboard reports most keys only through composition and input events, so
   * keydown alone would drop everything a soft keyboard produces.
   */
  const handleKeyboardInput = useCallback(
    (reactEvent: React.ChangeEvent<HTMLTextAreaElement>) => {
      const typed = reactEvent.target.value;
      reactEvent.target.value = "";
      for (const character of typed) {
        dispatch({
          _tag: "key",
          kind: "char",
          key: character,
          code: "",
          text: character,
          modifiers: 0,
        });
      }
    },
    [dispatch],
  );

  const handleKeyboardKeyDown = useCallback(
    (reactEvent: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // Printable keys arrive through onChange as characters; these do not,
      // and a page cannot be used without them.
      if (reactEvent.key.length === 1 && !reactEvent.metaKey && !reactEvent.ctrlKey) return;
      reactEvent.preventDefault();
      for (const kind of ["keyDown", "keyUp"] as const) {
        dispatch(
          toKeyEvent({
            kind,
            key: reactEvent.key,
            code: reactEvent.code,
            modifiers: toModifiers(reactEvent),
          }),
        );
      }
    },
    [dispatch],
  );

  return (
    <div className={props.className}>
      <canvas
        ref={canvasRef}
        tabIndex={0}
        className="h-full w-full touch-none bg-background object-contain outline-none"
        aria-label="Remote browser preview"
        onPointerDown={handlePointer("mousePressed")}
        onPointerUp={handlePointer("mouseReleased")}
        onPointerCancel={handlePointer("mouseReleased")}
        onPointerMove={handlePointer("mouseMoved")}
        onWheel={handleWheel}
        onKeyDown={handleKey("keyDown")}
        onKeyUp={handleKey("keyUp")}
      />
      {/*
       * Off-screen rather than hidden: a field the browser considers invisible
       * will not summon the on-screen keyboard, which is the only reason this
       * exists. Autocorrect and capitalisation are off so the page receives
       * exactly what was typed.
       */}
      <textarea
        ref={keyboardRef}
        aria-label="Send keystrokes to the remote page"
        className="pointer-events-none fixed -left-[9999px] top-0 size-px resize-none opacity-0"
        autoCapitalize="off"
        autoCorrect="off"
        autoComplete="off"
        spellCheck={false}
        onChange={handleKeyboardInput}
        onKeyDown={handleKeyboardKeyDown}
      />
      {!hasFrame ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-6 text-center text-sm text-muted-foreground">
          {unavailable ?? "Connecting to the browser on your other device..."}
        </div>
      ) : null}
    </div>
  );
}
