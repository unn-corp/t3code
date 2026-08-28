import { ArrowUpIcon, LoaderIcon, MessageCircleQuestionIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "./ui/button";
import { Input } from "./ui/input";

export interface AgentDashboardQuestionTarget {
  readonly key: string;
  readonly title: string;
  readonly detail: string;
  readonly kindLabel: "Finding" | "Repository" | "Update";
}

export function AgentDashboardQuestionComposer({
  target,
  modelLabel,
  busy,
  disabled,
  onClose,
  onSubmit,
}: {
  readonly target: AgentDashboardQuestionTarget | null;
  readonly modelLabel: string;
  readonly busy: boolean;
  readonly disabled: boolean;
  readonly onClose: () => void;
  readonly onSubmit: (question: string) => void;
}) {
  const [question, setQuestion] = useState("");
  const canSubmit = target !== null && question.trim().length > 0 && !busy && !disabled;

  if (target === null) {
    return (
      <div className="flex min-h-11 shrink-0 items-center gap-2 border-t border-border/70 bg-card/80 px-4 text-xs text-muted-foreground sm:px-6 lg:px-8">
        <MessageCircleQuestionIcon className="size-3.5" />
        <span>
          Choose <span className="font-medium text-foreground">Ask</span> on any repository or
          finding to start a grounded agent conversation.
        </span>
      </div>
    );
  }

  return (
    <form
      className="shrink-0 border-t border-border/70 bg-card/95 px-4 py-2.5 shadow-[0_-8px_24px_-18px_color-mix(in_oklab,var(--foreground)_25%,transparent)] backdrop-blur sm:px-6 lg:px-8"
      onSubmit={(event) => {
        event.preventDefault();
        if (canSubmit) onSubmit(question);
      }}
    >
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-2 sm:flex-row sm:items-center">
        <div className="flex min-w-0 items-center gap-2 sm:w-64 sm:shrink-0">
          <div className="flex size-7 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
            <MessageCircleQuestionIcon className="size-3.5" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs font-semibold">
              {target.kindLabel}: {target.title}
            </p>
            <p className="truncate text-[11px] text-muted-foreground">{target.detail}</p>
          </div>
        </div>

        <div className="flex min-w-0 flex-1 items-center gap-2">
          <Input
            aria-label={`Ask about ${target.title}`}
            autoFocus
            disabled={busy || disabled}
            onValueChange={setQuestion}
            placeholder={`Ask about ${target.title}`}
            value={question}
          />
          <Button
            aria-label={`Send question about ${target.title}`}
            disabled={!canSubmit}
            size="icon"
            type="submit"
          >
            {busy ? <LoaderIcon className="animate-spin" /> : <ArrowUpIcon />}
          </Button>
          <Button
            aria-label="Close contextual composer"
            onClick={onClose}
            size="icon"
            variant="ghost"
          >
            <XIcon />
          </Button>
        </div>

        <p className="truncate text-[11px] text-muted-foreground sm:max-w-36 sm:text-right">
          Opens a new session with {modelLabel}
        </p>
      </div>
    </form>
  );
}
