import { XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Kbd, KbdGroup } from "../ui/kbd";
import { dictationKeybindingFromKeyboardEvent } from "./DictationKeybindRecorder.logic";

const KEY_LABELS: Readonly<Record<string, string>> = {
  alt: "Alt",
  arrowdown: "Down",
  arrowleft: "Left",
  arrowright: "Right",
  arrowup: "Up",
  backspace: "Backspace",
  ctrl: "Ctrl",
  delete: "Delete",
  end: "End",
  enter: "Enter",
  esc: "Esc",
  home: "Home",
  meta: "Meta",
  pagedown: "Page Down",
  pageup: "Page Up",
  shift: "Shift",
  space: "Space",
  tab: "Tab",
};

function keyTokenLabel(token: string): string {
  if (token === "meta" && navigator.platform.toLowerCase().includes("mac")) return "⌘";
  return KEY_LABELS[token] ?? (token.length === 1 ? token.toUpperCase() : token.toUpperCase());
}

function KeybindingPill({ value }: { value: string }) {
  return (
    <KbdGroup className="min-w-0 bg-transparent p-0 shadow-none">
      {value.split("+").map((token) => (
        <Kbd key={token} className="min-w-6 shrink-0 justify-center px-1.5">
          {keyTokenLabel(token)}
        </Kbd>
      ))}
    </KbdGroup>
  );
}

export function DictationKeybindRecorder({
  label,
  value,
  onValueChange,
}: {
  label: string;
  value: readonly string[];
  onValueChange: (value: string[]) => void;
}) {
  const [isRecording, setIsRecording] = useState(false);
  const [recordingValue, setRecordingValue] = useState<string | null>(null);
  const onValueChangeRef = useRef(onValueChange);
  onValueChangeRef.current = onValueChange;

  useEffect(() => {
    if (!isRecording) return;
    const pressedKeys = new Set<string>();
    let pendingKeybinding: string | null = null;
    let cancelOnRelease = false;

    const consumeEvent = (event: globalThis.KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
    };
    const eventIdentity = (event: globalThis.KeyboardEvent) => event.code || event.key;
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      consumeEvent(event);
      if (event.repeat) return;
      pressedKeys.add(eventIdentity(event));
      if (event.key === "Escape") {
        pendingKeybinding = null;
        cancelOnRelease = true;
        setRecordingValue(null);
        return;
      }

      const next = dictationKeybindingFromKeyboardEvent(event, navigator.platform);
      if (next) {
        pendingKeybinding = next;
        setRecordingValue(next);
      }
    };
    const handleKeyUp = (event: globalThis.KeyboardEvent) => {
      consumeEvent(event);
      pressedKeys.delete(eventIdentity(event));
      if (pressedKeys.size > 0) return;
      if (cancelOnRelease) {
        setRecordingValue(null);
        setIsRecording(false);
        return;
      }
      if (!pendingKeybinding) return;
      onValueChangeRef.current([pendingKeybinding]);
      setRecordingValue(null);
      setIsRecording(false);
    };

    window.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("keypress", consumeEvent, true);
    window.addEventListener("keyup", handleKeyUp, true);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("keypress", consumeEvent, true);
      window.removeEventListener("keyup", handleKeyUp, true);
    };
  }, [isRecording]);

  return (
    <div className="grid min-w-0 grid-cols-[2.75rem_minmax(0,1fr)_1.75rem] items-center gap-2">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <button
        type="button"
        data-keybinding-capture=""
        aria-label={`${label} dictation keybind${isRecording ? ", listening" : ""}`}
        aria-pressed={isRecording}
        className={cn(
          "group flex h-8 min-w-0 cursor-pointer items-center justify-center gap-2 rounded-md border border-input bg-background px-2 text-xs outline-none transition-[border-color,background-color,box-shadow]",
          "hover:bg-accent/40 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/24",
          isRecording && "border-primary/70 bg-primary/5 ring-[3px] ring-primary/15",
        )}
        onBlur={() => {
          setRecordingValue(null);
          setIsRecording(false);
        }}
        onClick={() => {
          setRecordingValue(null);
          setIsRecording(true);
        }}
      >
        {isRecording ? (
          <>
            <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-primary" />
            {recordingValue ? (
              <KeybindingPill value={recordingValue} />
            ) : (
              <span className="truncate">Press shortcut…</span>
            )}
            <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
              {recordingValue ? "Release to save" : "Esc to cancel"}
            </span>
          </>
        ) : value.length > 0 ? (
          <>
            <div className="flex min-w-0 items-center gap-1.5 overflow-hidden">
              {value.map((keybinding, index) => (
                <span className="flex min-w-0 items-center gap-1.5" key={`${keybinding}:${index}`}>
                  {index > 0 ? <span className="text-muted-foreground/60">then</span> : null}
                  <KeybindingPill value={keybinding} />
                </span>
              ))}
            </div>
            <span className="ml-auto shrink-0 text-[10px] uppercase tracking-[0.08em] text-muted-foreground/0 transition-colors group-hover:text-muted-foreground/70 group-focus-visible:text-muted-foreground/70">
              Change
            </span>
          </>
        ) : (
          <span className="text-muted-foreground">Record shortcut</span>
        )}
      </button>
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        className="size-7"
        disabled={value.length === 0}
        aria-label={`Clear ${label.toLowerCase()} dictation keybind`}
        onClick={() => onValueChange([])}
      >
        <XIcon className="size-3.5" />
      </Button>
    </div>
  );
}
