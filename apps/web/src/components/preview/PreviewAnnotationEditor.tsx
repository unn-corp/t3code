import {
  AuthOrchestrationOperateScope,
  type PreviewAnnotationPayload,
  type PreviewAnnotationPoint,
  type PreviewAnnotationElementTarget,
} from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { useCallback, useEffect, useRef, useState } from "react";
import { useComposerDraftStore, type ComposerImageAttachment } from "~/composerDraftStore";
import { useClientSettings } from "~/hooks/useSettings";
import {
  annotationPoint,
  annotationRegion,
  appendAnnotationTranscript,
  renderAnnotationScreenshot,
  snapshotElementAt,
} from "~/lib/previewAnnotationEditor";
import { capturePreviewAnnotationScreenshot } from "~/lib/previewAnnotation";
import {
  usePreviewAnnotationEditorStore,
  usePreviewAnnotationSenders,
  type PreviewAnnotationEditorSession,
} from "~/previewAnnotationEditorStore";
import { useEnvironmentScope, readEnvironmentScope } from "~/state/session";
import { OpenWhisprVoiceInput, type VoiceInputPhase } from "../chat/OpenWhisprVoiceInput";
import { VoiceInputWaveform, type VoiceInputAudioSource } from "../chat/VoiceInputWaveform";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { toastManager } from "../ui/toast";
import { cn, randomUUID } from "~/lib/utils";

export function PreviewAnnotationEditorHost() {
  const session = usePreviewAnnotationEditorStore((state) => state.session);
  return session ? <PreviewAnnotationEditor key={session.id} session={session} /> : null;
}

type Tool = "select" | "region" | "draw";
function PreviewAnnotationEditor({ session }: { session: PreviewAnnotationEditorSession }) {
  const settings = useClientSettings();
  const sender = usePreviewAnnotationSenders((state) =>
    state.senders.get(scopedThreadKey(session.threadRef)),
  );
  const canSend =
    useEnvironmentScope(session.threadRef.environmentId, AuthOrchestrationOperateScope) &&
    Boolean(sender);
  const [discardRequested, setDiscardRequested] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [voicePhase, setVoicePhase] = useState<VoiceInputPhase>("idle");
  const [audioSource, setAudioSource] = useState<VoiceInputAudioSource | null>(null);
  const [tool, setTool] = useState<Tool>("select");
  const [gesture, setGesture] = useState<PreviewAnnotationPoint[]>([]);
  const gestureRef = useRef<PreviewAnnotationPoint[]>([]);
  const pointerRef = useRef<number | null>(null);
  const submittingRef = useRef(false);
  const [commentHeight, setCommentHeight] = useState(128);
  const commentResizeRef = useRef<{ pointerId: number; y: number; height: number } | null>(null);
  const resizeComment = (height: number) =>
    setCommentHeight(Math.max(96, Math.min(Math.max(128, window.innerHeight * 0.5), height)));
  const [styleProperty, setStyleProperty] = useState("color");
  const [styleValue, setStyleValue] = useState("");
  const voiceBusy = voicePhase === "recording" || voicePhase === "transcribing";
  const ready = session.status === "ready";
  const annotation = ready ? session.annotation : null;
  const update = useCallback(
    (change: (annotation: PreviewAnnotationPayload) => PreviewAnnotationPayload) => {
      usePreviewAnnotationEditorStore.getState().update(session.id, change);
    },
    [session.id],
  );
  const onTranscript = useCallback(
    (text: string) =>
      update((current) => ({
        ...current,
        comment: appendAnnotationTranscript(current.comment, text),
      })),
    [update],
  );

  useEffect(() => {
    const protectReload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", protectReload);
    return () => window.removeEventListener("beforeunload", protectReload);
  }, []);

  const submit = async (send: boolean) => {
    if (!annotation || discardRequested || voiceBusy || submittingRef.current || (send && !canSend))
      return;
    submittingRef.current = true;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const rendered = await renderAnnotationScreenshot({
        ...annotation,
        comment: annotation.comment.trim(),
      });
      if (usePreviewAnnotationEditorStore.getState().session?.id !== session.id) return;
      const capture = capturePreviewAnnotationScreenshot(rendered);
      if (capture.status !== "captured")
        throw new Error("Could not prepare the screenshot. Your annotation is still saved.");
      const file = capture.file;
      const image: ComposerImageAttachment = {
        type: "image",
        id: rendered.id,
        name: file.name,
        mimeType: file.type,
        sizeBytes: file.size,
        previewUrl: rendered.screenshot!.dataUrl,
        file,
      };
      const drafts = useComposerDraftStore.getState();
      drafts.addPreviewAnnotation(session.threadRef, rendered);
      drafts.addImage(session.threadRef, image);
      const currentSender = usePreviewAnnotationSenders
        .getState()
        .senders.get(scopedThreadKey(session.threadRef));
      if (
        send &&
        currentSender &&
        readEnvironmentScope(session.threadRef.environmentId, AuthOrchestrationOperateScope)
      )
        currentSender(rendered, image);
      else toastManager.add({ type: "success", title: "Annotation attached to draft" });
      usePreviewAnnotationEditorStore.getState().finish(session.id);
    } catch (error) {
      setSubmitError(
        error instanceof Error ? error.message : "Could not attach the annotation. Try again.",
      );
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };
  const toggleElement = (target: PreviewAnnotationElementTarget) =>
    update((current) => {
      const removing = current.elements.some((entry) => entry.id === target.id);
      return {
        ...current,
        elements: removing
          ? current.elements.filter((entry) => entry.id !== target.id)
          : [...current.elements, target],
        styleChanges: removing
          ? current.styleChanges.filter((change) => change.targetId !== target.id)
          : current.styleChanges,
      };
    });
  const selected = annotation?.elements ?? [];
  const requestDiscard = () => {
    if (!submittingRef.current) setDiscardRequested(true);
  };

  return (
    <Dialog
      open
      onOpenChange={(open, details) => {
        if (!open) {
          details.cancel();
          requestDiscard();
        }
      }}
    >
      <DialogPopup
        className="w-full sm:max-w-6xl"
        style={{ height: ready ? "min(52rem, calc(100dvh - 2rem))" : undefined }}
        showCloseButton={false}
        bottomStickOnMobile={false}
        onKeyDown={(event) => {
          if (
            event.key === "Enter" &&
            !event.nativeEvent.isComposing &&
            !event.shiftKey &&
            (event.metaKey || event.ctrlKey)
          ) {
            event.preventDefault();
            event.stopPropagation();
            void submit(true);
          }
        }}
      >
        <DialogHeader>
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <DialogTitle>Annotate snapshot</DialogTitle>
              <DialogDescription>
                Work on this saved image while the browser continues. Your annotation stays here
                until you attach it or confirm discarding it.
              </DialogDescription>
            </div>
            <Button variant="ghost" onClick={requestDiscard} disabled={submitting}>
              Close
            </Button>
          </div>
        </DialogHeader>
        {discardRequested ? (
          <div
            className="mx-6 mb-4 space-y-3 rounded-xl border border-border bg-muted p-4"
            role="alertdialog"
            aria-labelledby="annotation-discard-title"
            aria-describedby="annotation-discard-description"
          >
            <p id="annotation-discard-title" className="font-medium">
              Discard this annotation?
            </p>
            <p id="annotation-discard-description" className="text-sm text-muted-foreground">
              This removes the saved screenshot, marks, and comment.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button autoFocus variant="outline" onClick={() => setDiscardRequested(false)}>
                Keep editing
              </Button>
              <Button
                variant="destructive"
                onClick={() => usePreviewAnnotationEditorStore.getState().discard(session.id, true)}
              >
                Discard annotation
              </Button>
            </div>
          </div>
        ) : null}
        {!ready ? (
          <div className="p-6" role="status">
            {session.status === "error"
              ? session.error
              : "Capturing the screenshot and element details…"}
          </div>
        ) : (
          <div className="grid min-h-0 flex-1 gap-4 overflow-y-auto px-6 pb-4 sm:grid-cols-[minmax(0,1fr)_minmax(16rem,0.45fr)] sm:overflow-hidden">
            <div className="min-w-0 space-y-3 sm:overflow-y-auto">
              <div
                className="flex flex-wrap items-center gap-2"
                role="toolbar"
                aria-label="Annotation tools"
              >
                {(["select", "region", "draw"] as const).map((value) => (
                  <Button
                    key={value}
                    variant={tool === value ? "default" : "outline"}
                    aria-pressed={tool === value}
                    disabled={submitting || discardRequested}
                    onClick={() => {
                      setTool(value);
                      pointerRef.current = null;
                      gestureRef.current = [];
                      setGesture([]);
                    }}
                  >
                    {value === "select"
                      ? "Select element"
                      : value === "region"
                        ? "Mark region"
                        : "Draw"}
                  </Button>
                ))}
                <Button
                  variant="ghost"
                  disabled={submitting || discardRequested}
                  onClick={() =>
                    update((current) => ({
                      ...current,
                      elements: [],
                      regions: [],
                      strokes: [],
                      styleChanges: [],
                    }))
                  }
                >
                  Clear marks
                </Button>
              </div>
              <div className="relative overflow-hidden rounded-xl border border-border bg-muted">
                <img
                  src={session.snapshot.screenshot.dataUrl}
                  alt={`Captured page: ${session.snapshot.pageTitle || session.snapshot.pageUrl}`}
                  className="block h-auto w-full"
                  draggable={false}
                />
                <svg
                  className="absolute inset-0 h-full w-full touch-none select-none text-primary"
                  viewBox={`0 0 ${session.snapshot.width} ${session.snapshot.height}`}
                  aria-label="Select or mark the saved page screenshot"
                  role="img"
                  onPointerDown={(event) => {
                    if (
                      submitting ||
                      discardRequested ||
                      event.button !== 0 ||
                      pointerRef.current !== null
                    )
                      return;
                    const point = annotationPoint(
                      event.currentTarget.getBoundingClientRect(),
                      event.clientX,
                      event.clientY,
                      session.snapshot.width,
                      session.snapshot.height,
                    );
                    if (tool === "select") {
                      const element = snapshotElementAt(session.snapshot.elements, point);
                      if (element) toggleElement(element);
                      return;
                    }
                    pointerRef.current = event.pointerId;
                    event.currentTarget.setPointerCapture(event.pointerId);
                    gestureRef.current = [point];
                    setGesture([point]);
                  }}
                  onPointerMove={(event) => {
                    if (submitting || discardRequested || pointerRef.current !== event.pointerId)
                      return;
                    const point = annotationPoint(
                      event.currentTarget.getBoundingClientRect(),
                      event.clientX,
                      event.clientY,
                      session.snapshot.width,
                      session.snapshot.height,
                    );
                    const points = gestureRef.current;
                    gestureRef.current =
                      tool === "region" ? [points[0]!, point] : [...points.slice(-8191), point];
                    setGesture(gestureRef.current);
                  }}
                  onPointerUp={(event) => {
                    if (submitting || discardRequested || pointerRef.current !== event.pointerId)
                      return;
                    const point = annotationPoint(
                      event.currentTarget.getBoundingClientRect(),
                      event.clientX,
                      event.clientY,
                      session.snapshot.width,
                      session.snapshot.height,
                    );
                    const points = [...gestureRef.current, point];
                    gestureRef.current = [];
                    pointerRef.current = null;
                    setGesture([]);
                    if (tool === "region" && points[0]) {
                      const rect = annotationRegion(points[0], point);
                      if (rect.width > 2 && rect.height > 2)
                        update((current) => ({
                          ...current,
                          regions: [...current.regions, { id: randomUUID(), rect }],
                        }));
                    } else if (points.length > 1) {
                      const bounds = annotationRegion(
                        {
                          x: Math.min(...points.map((p) => p.x)),
                          y: Math.min(...points.map((p) => p.y)),
                        },
                        {
                          x: Math.max(...points.map((p) => p.x)),
                          y: Math.max(...points.map((p) => p.y)),
                        },
                      );
                      update((current) => ({
                        ...current,
                        strokes: [
                          ...current.strokes,
                          { id: randomUUID(), color: "#2563eb", width: 4, points, bounds },
                        ],
                      }));
                    }
                  }}
                  onPointerCancel={() => {
                    gestureRef.current = [];
                    pointerRef.current = null;
                    setGesture([]);
                  }}
                >
                  {[
                    ...selected.map((target) => ({ id: target.id, rect: target.rect })),
                    ...session.annotation.regions,
                  ].map(({ id, rect }) => (
                    <rect
                      key={id}
                      {...rect}
                      fill="currentColor"
                      fillOpacity="0.1"
                      stroke="currentColor"
                      strokeWidth="2"
                    />
                  ))}
                  {session.annotation.strokes.map((stroke) => (
                    <polyline
                      key={stroke.id}
                      points={stroke.points.map((point) => `${point.x},${point.y}`).join(" ")}
                      fill="none"
                      stroke={stroke.color}
                      strokeWidth={stroke.width}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  ))}
                  {gesture.length > 1 && tool === "region" ? (
                    <rect
                      {...annotationRegion(gesture[0]!, gesture.at(-1)!)}
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                    />
                  ) : null}
                  {gesture.length > 1 && tool === "draw" ? (
                    <polyline
                      points={gesture.map((point) => `${point.x},${point.y}`).join(" ")}
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="4"
                    />
                  ) : null}
                </svg>
              </div>
              <p className="break-all text-sm text-muted-foreground">{session.snapshot.pageUrl}</p>
            </div>
            <div className="flex min-h-0 min-w-0 flex-col gap-4 sm:overflow-y-auto">
              <details className="shrink-0">
                <summary className="cursor-pointer text-sm font-medium">
                  Captured elements ({session.snapshot.elements.length})
                </summary>
                <div className="mt-2 max-h-48 space-y-1 overflow-auto">
                  {session.snapshot.elements.map((target) => (
                    <div key={target.id}>
                      <Button
                        variant={
                          selected.some((entry) => entry.id === target.id) ? "default" : "outline"
                        }
                        disabled={submitting || discardRequested}
                        onClick={() => toggleElement(target)}
                      >
                        {target.element.componentName ||
                          target.element.selector ||
                          target.element.tagName}
                      </Button>
                    </div>
                  ))}
                </div>
              </details>
              {selected.length > 0 ? (
                <div className="shrink-0 space-y-2">
                  <p className="text-sm font-medium">Requested style change</p>
                  <label className="block text-sm">
                    Property
                    <select
                      className="mt-1 w-full rounded-md border border-border bg-background p-2"
                      value={styleProperty}
                      onChange={(event) => setStyleProperty(event.currentTarget.value)}
                      disabled={submitting || discardRequested}
                    >
                      {[
                        "color",
                        "background-color",
                        "font-size",
                        "font-weight",
                        "padding",
                        "margin",
                        "border-radius",
                        "width",
                        "height",
                      ].map((property) => (
                        <option key={property}>{property}</option>
                      ))}
                    </select>
                  </label>
                  <label className="block text-sm">
                    Value
                    <input
                      className="mt-1 w-full rounded-md border border-border bg-background p-2"
                      value={styleValue}
                      onChange={(event) => setStyleValue(event.currentTarget.value)}
                      disabled={submitting || discardRequested}
                      placeholder="For example, 16px"
                    />
                  </label>
                  <Button
                    variant="outline"
                    disabled={!styleValue.trim() || submitting || discardRequested}
                    onClick={() => {
                      const value = styleValue.trim();
                      update((current) => ({
                        ...current,
                        styleChanges: [
                          ...current.styleChanges.filter(
                            (change) =>
                              !(
                                change.property === styleProperty &&
                                selected.some((target) => target.id === change.targetId)
                              ),
                          ),
                          ...selected.map((target) => ({
                            targetId: target.id,
                            selector: target.element.selector,
                            property: styleProperty,
                            previousValue: "",
                            value,
                          })),
                        ],
                      }));
                      setStyleValue("");
                    }}
                  >
                    Add style request
                  </Button>
                </div>
              ) : null}
              {session.annotation.styleChanges.map((change) => (
                <p
                  key={`${change.targetId}-${change.property}`}
                  className="shrink-0 break-all text-sm"
                >
                  {change.property}: {change.value}
                </p>
              ))}
              <div
                className={cn(
                  "chat-composer-voice-root relative mb-2 mr-2 flex flex-1 flex-col rounded-xl border border-border",
                  voicePhase === "recording" && "chat-voice-recording-active",
                  voicePhase === "transcribing" && "chat-voice-transcribing-active",
                )}
              >
                <label
                  className="block shrink-0 px-3 pt-3 text-sm font-medium"
                  htmlFor="annotation-comment"
                >
                  Describe the change
                </label>
                {voiceBusy ? (
                  <VoiceInputWaveform audioSource={audioSource} simulateInputLevel={false} />
                ) : null}
                <textarea
                  id="annotation-comment"
                  rows={4}
                  className="relative z-1 block w-full grow shrink-0 resize-none bg-transparent px-3 py-2 text-base outline-none"
                  style={{ height: commentHeight }}
                  value={session.annotation.comment}
                  disabled={submitting || discardRequested}
                  onChange={(event) => {
                    const comment = event.currentTarget.value;
                    update((current) => ({ ...current, comment }));
                  }}
                />
                <div className="relative z-10 flex shrink-0 justify-end p-2">
                  <OpenWhisprVoiceInput
                    environmentId={session.threadRef.environmentId}
                    phase={voicePhase}
                    disabled={submitting || discardRequested}
                    onTranscript={onTranscript}
                    onPhaseChange={setVoicePhase}
                    onRecordingAudioSourceChange={setAudioSource}
                    simulateInputLevel={false}
                    dictationMicrophoneDeviceId={settings.dictationMicrophoneDeviceId}
                    dictationStartKeybinds={settings.dictationStartKeybinds}
                    dictationEndKeybinds={settings.dictationEndKeybinds}
                  />
                </div>
                <button
                  type="button"
                  aria-label="Resize annotation composer"
                  aria-description="Drag to resize, or use the Up and Down arrow keys"
                  disabled={submitting || discardRequested}
                  className="absolute z-20 size-11 touch-none rounded-full text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 cursor-ns-resize"
                  style={{ right: "calc(-1px - 1.5rem)", bottom: "calc(-1px - 1.5rem)" }}
                  onPointerDown={(event) => {
                    if (event.button !== 0 || commentResizeRef.current) return;
                    event.preventDefault();
                    event.currentTarget.focus();
                    event.currentTarget.setPointerCapture(event.pointerId);
                    commentResizeRef.current = {
                      pointerId: event.pointerId,
                      y: event.clientY,
                      height: commentHeight,
                    };
                  }}
                  onPointerMove={(event) => {
                    const drag = commentResizeRef.current;
                    if (!drag || drag.pointerId !== event.pointerId) return;
                    resizeComment(drag.height + event.clientY - drag.y);
                  }}
                  onPointerUp={(event) => {
                    if (commentResizeRef.current?.pointerId !== event.pointerId) return;
                    commentResizeRef.current = null;
                    event.currentTarget.releasePointerCapture(event.pointerId);
                  }}
                  onLostPointerCapture={() => {
                    commentResizeRef.current = null;
                  }}
                  onPointerCancel={() => {
                    commentResizeRef.current = null;
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
                    event.preventDefault();
                    event.stopPropagation();
                    resizeComment(commentHeight + (event.key === "ArrowDown" ? 24 : -24));
                  }}
                >
                  {/* Signed offsets keep the inner and outer arcs concentric with
                      the card's corner, including theme changes. */}
                  {[-2, 2].map((gap) => (
                    <span
                      key={gap}
                      aria-hidden="true"
                      className="pointer-events-none absolute border-r border-b border-current"
                      style={{
                        right: `calc(1.5rem + ${-gap}px)`,
                        bottom: `calc(1.5rem + ${-gap}px)`,
                        width: `calc(var(--radius-xl) + ${gap}px)`,
                        height: `calc(var(--radius-xl) + ${gap}px)`,
                        borderBottomRightRadius: `calc(var(--radius-xl) + ${gap}px)`,
                      }}
                    />
                  ))}
                </button>
              </div>
            </div>
          </div>
        )}
        {submitError ? (
          <p className="px-6 pb-3 text-sm text-destructive" role="alert">
            {submitError}
          </p>
        ) : null}
        <DialogFooter>
          <Button
            variant="outline"
            disabled={!ready || submitting || voiceBusy || discardRequested}
            onClick={() => void submit(false)}
          >
            {submitting ? "Preparing…" : "Attach to draft"}
          </Button>
          <Button
            disabled={!ready || !canSend || submitting || voiceBusy || discardRequested}
            onClick={() => void submit(true)}
          >
            Send annotation
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
