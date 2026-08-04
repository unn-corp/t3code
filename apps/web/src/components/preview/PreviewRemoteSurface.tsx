"use client";

import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, PreviewInputEvent, ThreadId } from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { previewEnvironment } from "~/state/preview";
import { useAtomCommand } from "~/state/use-atom-command";

import {
  toKeyEvent,
  toModifiers,
  toMouseButton,
  toPagePoint,
  type RemoteSurfaceGeometry,
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
}) {
  const { environmentId, threadId, tabId } = props;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const geometryRef = useRef<RemoteSurfaceGeometry>({
    elementWidth: 0,
    elementHeight: 0,
    pageWidth: 0,
    pageHeight: 0,
  });
  const lastSequenceRef = useRef(-1);
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

  const handlePointer = useCallback(
    (kind: "mousePressed" | "mouseReleased" | "mouseMoved") =>
      (reactEvent: React.PointerEvent<HTMLCanvasElement>) => {
        const point = pointFor(reactEvent.clientX, reactEvent.clientY);
        if (!point) return;
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
    [dispatch, pointFor],
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

  return (
    <div className={props.className}>
      <canvas
        ref={canvasRef}
        tabIndex={0}
        className="h-full w-full touch-none bg-background object-contain outline-none"
        aria-label="Remote browser preview"
        onPointerDown={handlePointer("mousePressed")}
        onPointerUp={handlePointer("mouseReleased")}
        onPointerMove={handlePointer("mouseMoved")}
        onWheel={handleWheel}
        onKeyDown={handleKey("keyDown")}
        onKeyUp={handleKey("keyUp")}
      />
      {!hasFrame ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-6 text-center text-sm text-muted-foreground">
          {unavailable ?? "Connecting to the browser on your other device..."}
        </div>
      ) : null}
    </div>
  );
}
