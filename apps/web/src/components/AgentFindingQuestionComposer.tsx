import {
  DEFAULT_RUNTIME_MODE,
  type ModelSelection,
  type ProviderInstanceId,
  type RuntimeMode,
} from "@t3tools/contracts";
import type { ClientSettings } from "@t3tools/contracts/settings";
import { createModelSelection } from "@t3tools/shared/model";
import { ChevronDownIcon, MessageCircleQuestionIcon, MicIcon } from "lucide-react";
import { memo, useCallback, useEffect, useState } from "react";

import { cn } from "../lib/utils";
import type { AppModelOption } from "../modelSelection";
import type { ProviderInstanceEntry } from "../providerInstances";
import { ComposerPrimaryActions } from "./chat/ComposerPrimaryActions";
import { getComposerProviderState } from "./chat/composerProviderState";
import { OpenWhisprVoiceInput, type VoiceInputPhase } from "./chat/OpenWhisprVoiceInput";
import { ProviderModelPicker } from "./chat/ProviderModelPicker";
import { RUNTIME_MODE_OPTIONS, RUNTIME_MODE_PRESENTATION } from "./chat/runtimeModePresentation";
import { TraitsPicker } from "./chat/TraitsPicker";
import { type VoiceInputAudioSource, VoiceInputWaveform } from "./chat/VoiceInputWaveform";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "./ui/collapsible";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "./ui/select";

const noop = () => {};

function appendTranscript(prompt: string, transcript: string): string {
  const nextTranscript = transcript.trim();
  if (!nextTranscript) return prompt;
  if (!prompt || /\s$/.test(prompt)) return `${prompt}${nextTranscript}`;
  return `${prompt} ${nextTranscript}`;
}

export const AgentFindingQuestionComposer = memo(function AgentFindingQuestionComposer({
  findingId,
  findingTitle,
  busy,
  disabled,
  voiceDisabled,
  settings,
  initialModelSelection,
  providerInstanceEntries,
  modelOptionsByInstance,
  onSubmit,
  onVoiceActivityChange,
}: {
  readonly findingId: string;
  readonly findingTitle: string;
  readonly busy: boolean;
  readonly disabled: boolean;
  readonly voiceDisabled: boolean;
  readonly settings: Pick<
    ClientSettings,
    "dictationMicrophoneDeviceId" | "dictationStartKeybinds" | "dictationEndKeybinds"
  >;
  readonly initialModelSelection: ModelSelection;
  readonly providerInstanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  readonly modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<AppModelOption>>;
  readonly onSubmit: (input: {
    readonly question: string;
    readonly modelSelection: ModelSelection;
    readonly runtimeMode: RuntimeMode;
  }) => void;
  readonly onVoiceActivityChange: (findingId: string, active: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState("");
  const [modelSelection, setModelSelection] = useState<ModelSelection>(initialModelSelection);
  const [runtimeMode, setRuntimeMode] = useState<RuntimeMode>(DEFAULT_RUNTIME_MODE);
  const [voiceInputPhase, setVoiceInputPhase] = useState<VoiceInputPhase>("idle");
  const [voiceInputAudioSource, setVoiceInputAudioSource] = useState<VoiceInputAudioSource | null>(
    null,
  );
  const simulateVoiceInputLevel =
    import.meta.env.DEV &&
    typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).get("simulateMic") === "1";
  const voiceInputBusy = voiceInputPhase === "recording" || voiceInputPhase === "transcribing";
  const canSubmit = question.trim().length > 0 && !disabled && !busy && !voiceInputBusy;
  const selectedProviderEntry = providerInstanceEntries.find(
    (entry) => entry.instanceId === modelSelection.instanceId,
  );
  const runtimeModeOption = RUNTIME_MODE_PRESENTATION[runtimeMode];
  const RuntimeModeIcon = runtimeModeOption.icon;

  useEffect(() => {
    if (
      selectedProviderEntry?.enabled &&
      selectedProviderEntry.isAvailable &&
      modelSelection.model.trim().length > 0
    ) {
      return;
    }
    setModelSelection(initialModelSelection);
  }, [initialModelSelection, modelSelection.model, selectedProviderEntry]);

  const handleVoicePhaseChange = useCallback(
    (phase: VoiceInputPhase) => {
      setVoiceInputPhase(phase);
      onVoiceActivityChange(findingId, phase === "recording" || phase === "transcribing");
    },
    [findingId, onVoiceActivityChange],
  );

  useEffect(
    () => () => {
      onVoiceActivityChange(findingId, false);
    },
    [findingId, onVoiceActivityChange],
  );

  return (
    <Collapsible
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && voiceInputBusy) return;
        setOpen(nextOpen);
      }}
    >
      <CollapsibleTrigger
        className="flex min-h-11 w-full min-w-0 items-center gap-3 rounded-xl border border-border/70 bg-muted/20 px-3 py-2.5 text-left outline-none transition-colors hover:bg-muted/35 focus-visible:ring-2 focus-visible:ring-ring data-panel-open:[&>svg]:rotate-180"
        disabled={busy || voiceInputBusy}
      >
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-background text-muted-foreground">
          <MicIcon className="size-4.5" />
        </div>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium text-foreground">Ask about this finding</span>
          <span className="block truncate text-xs text-muted-foreground">
            Type a follow-up or dictate with your microphone
          </span>
        </span>
        <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground transition-transform" />
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <div className="p-1 pt-3">
          <form
            aria-label={`Ask about ${findingTitle}`}
            onSubmit={(event) => {
              event.preventDefault();
              if (canSubmit) onSubmit({ question: question.trim(), modelSelection, runtimeMode });
            }}
          >
            <div
              className={cn(
                "chat-composer-glass-shell relative w-full",
                voiceInputPhase === "recording" && "chat-voice-recording-active",
                voiceInputPhase === "transcribing" && "chat-voice-transcribing-active",
                voiceInputPhase === "success" && "chat-voice-success-active",
                voiceInputPhase === "no-audio" && "chat-voice-no-audio-active",
              )}
            >
              <div className="chat-composer-glass-host relative z-10 w-full rounded-[22px]">
                <div className="chat-composer-glass rounded-[20px] border border-black/12 transition-colors duration-200 has-focus-visible:border-foreground/40 dark:border-transparent dark:inset-ring-1 dark:inset-ring-white/5">
                  <div className="relative grid grid-cols-[minmax(0,1fr)_4.25rem] overflow-visible rounded-[18px]">
                    {voiceInputBusy ? (
                      <VoiceInputWaveform
                        audioSource={voiceInputAudioSource}
                        simulateInputLevel={simulateVoiceInputLevel}
                      />
                    ) : null}
                    {voiceInputPhase === "no-audio" ? (
                      <div className="sr-only" role="status">
                        No audio detected
                      </div>
                    ) : null}
                    <div className="relative z-1 min-w-0">
                      <label className="sr-only" htmlFor={`finding-question-${findingId}`}>
                        Ask about this finding
                      </label>
                      <textarea
                        aria-describedby={`finding-question-help-${findingId}`}
                        className="field-sizing-content block max-h-50 min-h-17.5 w-full resize-none overflow-y-auto bg-transparent px-4 py-3 text-base leading-relaxed text-foreground outline-none placeholder:text-muted-foreground/35 disabled:cursor-not-allowed disabled:opacity-60 sm:text-sm"
                        disabled={disabled}
                        id={`finding-question-${findingId}`}
                        onChange={(event) => setQuestion(event.currentTarget.value)}
                        onKeyDown={(event) => {
                          if (
                            event.key !== "Enter" ||
                            event.shiftKey ||
                            event.nativeEvent.isComposing
                          ) {
                            return;
                          }
                          event.preventDefault();
                          if (canSubmit) event.currentTarget.form?.requestSubmit();
                        }}
                        placeholder="Ask anything about this finding"
                        rows={2}
                        value={question}
                      />
                    </div>
                    <div className="relative z-10 flex h-17.5 items-center justify-center">
                      <OpenWhisprVoiceInput
                        phase={voiceInputPhase}
                        disabled={disabled || voiceDisabled}
                        onTranscript={(transcript) =>
                          setQuestion((current) => appendTranscript(current, transcript))
                        }
                        onPhaseChange={handleVoicePhaseChange}
                        onRecordingAudioSourceChange={setVoiceInputAudioSource}
                        simulateInputLevel={simulateVoiceInputLevel}
                        dictationMicrophoneDeviceId={settings.dictationMicrophoneDeviceId}
                        dictationStartKeybinds={settings.dictationStartKeybinds}
                        dictationEndKeybinds={settings.dictationEndKeybinds}
                      />
                    </div>
                  </div>
                  <div className="relative z-10 flex min-w-0 items-center justify-between gap-3 px-3 pb-3 sm:px-4 sm:pb-4">
                    <div className="-m-1 flex min-w-0 flex-1 items-center gap-1 overflow-x-auto p-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                      {selectedProviderEntry ? (
                        <ProviderModelPicker
                          activeInstanceId={modelSelection.instanceId}
                          compact
                          disabled={disabled || busy}
                          instanceEntries={providerInstanceEntries}
                          lockedProvider={null}
                          model={modelSelection.model}
                          modelOptionsByInstance={modelOptionsByInstance}
                          onInstanceModelChange={(instanceId, model) => {
                            const entry = providerInstanceEntries.find(
                              (candidate) => candidate.instanceId === instanceId,
                            );
                            if (!entry) return;
                            const providerState = getComposerProviderState({
                              provider: entry.driverKind,
                              model,
                              models: entry.models,
                              planModeEnabled: false,
                              modelOptions:
                                modelSelection.instanceId === instanceId
                                  ? modelSelection.options
                                  : undefined,
                            });
                            setModelSelection(
                              createModelSelection(
                                instanceId,
                                model,
                                providerState.modelOptionsForDispatch,
                              ),
                            );
                          }}
                          triggerAriaLabel="Choose model for finding question"
                          triggerClassName="-ms-px ps-0"
                        />
                      ) : null}
                      {selectedProviderEntry ? (
                        <TraitsPicker
                          allowPromptInjectedEffort
                          instanceId={modelSelection.instanceId}
                          model={modelSelection.model}
                          modelOptions={modelSelection.options}
                          models={selectedProviderEntry.models}
                          planModeEnabled={false}
                          onModelOptionsChange={(options) =>
                            setModelSelection(
                              createModelSelection(
                                modelSelection.instanceId,
                                modelSelection.model,
                                options,
                              ),
                            )
                          }
                          onPromptChange={setQuestion}
                          prompt={question}
                          provider={selectedProviderEntry.driverKind}
                        />
                      ) : null}
                      <Select
                        disabled={disabled || busy}
                        value={runtimeMode}
                        onValueChange={(value) => value && setRuntimeMode(value as RuntimeMode)}
                      >
                        <SelectTrigger
                          aria-label="Access level for finding question"
                          className="h-8 w-auto min-w-0 shrink-0 gap-1.5 border-0 bg-transparent px-2 text-xs shadow-none"
                        >
                          <RuntimeModeIcon className="size-3.5 text-muted-foreground" />
                          <SelectValue>{runtimeModeOption.label}</SelectValue>
                        </SelectTrigger>
                        <SelectPopup alignItemWithTrigger={false}>
                          {RUNTIME_MODE_OPTIONS.map((mode) => {
                            const option = RUNTIME_MODE_PRESENTATION[mode];
                            const OptionIcon = option.icon;
                            return (
                              <SelectItem
                                className="min-w-64 py-2"
                                hideIndicator
                                key={mode}
                                value={mode}
                              >
                                <div className="grid min-w-0 gap-0.5">
                                  <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
                                    <OptionIcon className="size-3.5 text-muted-foreground" />
                                    {option.label}
                                  </span>
                                  <span className="text-xs text-muted-foreground">
                                    {option.description}
                                  </span>
                                </div>
                              </SelectItem>
                            );
                          })}
                        </SelectPopup>
                      </Select>
                    </div>
                    <div className="flex shrink-0 items-center justify-end">
                      <ComposerPrimaryActions
                        compact
                        pendingAction={null}
                        isRunning={false}
                        showPlanFollowUpPrompt={false}
                        promptHasText={question.trim().length > 0}
                        isSendBusy={busy}
                        sendDisabledReason={
                          voiceInputBusy
                            ? "Finish voice input"
                            : disabled && !busy
                              ? "Conversation unavailable"
                              : null
                        }
                        isConnecting={false}
                        isEnvironmentUnavailable={false}
                        isPreparingWorktree={false}
                        hasSendableContent={question.trim().length > 0}
                        preserveComposerFocusOnPointerDown
                        onPreviousPendingQuestion={noop}
                        onInterrupt={noop}
                        onImplementPlanInNewThread={noop}
                      />
                    </div>
                  </div>
                  <div
                    className="flex min-w-0 items-center gap-1.5 px-4 pb-3 text-xs text-muted-foreground"
                    id={`finding-question-help-${findingId}`}
                  >
                    <MessageCircleQuestionIcon className="size-4 shrink-0" />
                    <span className="truncate">Finding context attached</span>
                    <span aria-hidden="true" className="hidden sm:inline">
                      ·
                    </span>
                    <span className="hidden sm:inline">Enter sends</span>
                  </div>
                </div>
              </div>
            </div>
          </form>
        </div>
      </CollapsiblePanel>
    </Collapsible>
  );
});
