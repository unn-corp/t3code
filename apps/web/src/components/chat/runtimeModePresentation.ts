import type { RuntimeMode } from "@t3tools/contracts";
import {
  EyeIcon,
  LockIcon,
  LockOpenIcon,
  PenLineIcon,
  SparklesIcon,
  type LucideIcon,
} from "lucide-react";

export const RUNTIME_MODE_PRESENTATION: Record<
  RuntimeMode,
  { readonly label: string; readonly description: string; readonly icon: LucideIcon }
> = {
  "approval-required": {
    label: "Supervised",
    description: "Ask before commands and file changes.",
    icon: LockIcon,
  },
  "auto-accept-edits": {
    label: "Auto-accept edits",
    description: "Auto-approve edits, ask before other actions.",
    icon: PenLineIcon,
  },
  auto: {
    label: "Auto",
    description: "Supported providers approve routine actions; others still ask.",
    icon: SparklesIcon,
  },
  "automated-review": {
    label: "Read-only automation",
    description: "Run autonomous inspections without file or network writes.",
    icon: EyeIcon,
  },
  "full-access": {
    label: "Full access",
    description: "Allow commands and edits without prompts.",
    icon: LockOpenIcon,
  },
};

export const RUNTIME_MODE_OPTIONS = Object.keys(RUNTIME_MODE_PRESENTATION) as RuntimeMode[];
