import type { ComponentType } from "react";
import { LoaderIcon } from "lucide-react";

import { cn } from "../lib/utils";
import { Button } from "./ui/button";

export interface AgentFindingAction {
  readonly id: string;
  readonly label: string;
  readonly pendingLabel?: string;
  readonly icon: ComponentType<{ readonly className?: string | undefined }>;
  readonly onSelect: () => void;
  readonly pending?: boolean;
  readonly disabled?: boolean;
  readonly variant?: "default" | "outline" | "ghost";
  readonly title?: string | undefined;
}

export function AgentFindingActions({
  actions,
  className,
  size = "sm",
}: {
  readonly actions: ReadonlyArray<AgentFindingAction | null | false | undefined | "">;
  readonly className?: string;
  readonly size?: "sm" | "default";
}) {
  return (
    <div className={cn("flex flex-wrap gap-2", className)}>
      {actions
        .filter((action): action is AgentFindingAction => Boolean(action))
        .map((action) => {
          const Icon = action.pending ? LoaderIcon : action.icon;
          return (
            <Button
              className="shrink-0"
              disabled={action.disabled || action.pending}
              key={action.id}
              onClick={action.onSelect}
              size={size}
              title={action.title}
              variant={action.variant}
            >
              <Icon className={action.pending ? "animate-spin" : undefined} />
              {action.pending ? (action.pendingLabel ?? action.label) : action.label}
            </Button>
          );
        })}
    </div>
  );
}
