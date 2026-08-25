import {
  resolveProviderSkillSourceKind,
  type ProviderSkillSourceKind,
} from "@t3tools/client-runtime/providerSkills";
import {
  type ProjectEntry,
  type ProviderDriverKind,
  type ServerProviderSkill,
  type ServerProviderSlashCommand,
} from "@t3tools/contracts";
import {
  BlocksIcon,
  FolderGit2Icon,
  FolderIcon,
  HistoryIcon,
  PackageIcon,
  SettingsIcon,
  UserRoundIcon,
  type LucideIcon,
} from "lucide-react";
import { memo, useLayoutEffect, useMemo, useRef } from "react";

import { type ComposerSlashCommand, type ComposerTriggerKind } from "../../composer-logic";
import { cn } from "~/lib/utils";
import {
  Command,
  CommandGroup,
  CommandGroupLabel,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "../ui/command";
import { PierreEntryIcon } from "./PierreEntryIcon";

export type ComposerCommandItem =
  | {
      id: string;
      type: "path";
      path: string;
      pathKind: ProjectEntry["kind"];
      label: string;
      description: string;
    }
  | {
      id: string;
      type: "slash-command";
      command: ComposerSlashCommand;
      label: string;
      description: string;
    }
  | {
      id: string;
      type: "provider-slash-command";
      provider: ProviderDriverKind;
      command: ServerProviderSlashCommand;
      label: string;
      description: string;
    }
  | {
      id: string;
      /** An existing Codex session on disk, offered by /resume. */
      type: "codex-session";
      sessionId: string;
      label: string;
      description: string;
    }
  | {
      id: string;
      type: "skill";
      provider: ProviderDriverKind;
      skill: ServerProviderSkill;
      label: string;
      description: string;
    };

type ComposerCommandGroup = {
  id: string;
  label: string | null;
  items: ComposerCommandItem[];
};

const SKILL_SOURCE_ICON_BY_KIND: Record<ProviderSkillSourceKind, LucideIcon> = {
  app: BlocksIcon,
  repo: FolderGit2Icon,
  project: FolderIcon,
  personal: UserRoundIcon,
  system: SettingsIcon,
  other: PackageIcon,
};

const SKILL_SOURCE_LABEL_BY_KIND: Record<ProviderSkillSourceKind, string> = {
  app: "App",
  repo: "Repo",
  project: "Project",
  personal: "Personal",
  system: "System",
  other: "Other",
};

function SkillSourceIcon(props: { kind: ProviderSkillSourceKind }) {
  const Icon = SKILL_SOURCE_ICON_BY_KIND[props.kind];
  return (
    <>
      <Icon aria-hidden="true" className="size-4 shrink-0 text-icon-muted" />
      <span className="sr-only">{SKILL_SOURCE_LABEL_BY_KIND[props.kind]} skill</span>
    </>
  );
}

export function groupCommandItems(
  items: ComposerCommandItem[],
  triggerKind: ComposerTriggerKind | null,
  groupSlashCommandSections: boolean,
): ComposerCommandGroup[] {
  if (triggerKind === "skill") {
    return items.length > 0 ? [{ id: "skills", label: "Skills", items }] : [];
  }
  if (triggerKind !== "slash-command" || !groupSlashCommandSections) {
    return [{ id: "default", label: null, items }];
  }

  const builtInItems = items.filter((item) => item.type === "slash-command");
  const providerItems = items.filter((item) => item.type === "provider-slash-command");
  const skillItems = items.filter((item) => item.type === "skill");
  // Sessions get their own group rather than being left out. This branch used to
  // keep only the two command types, so reaching /resume from the bare "/" menu
  // (where grouping is on, because the query is empty) loaded the conversations
  // and then rendered none of them.
  const sessionItems = items.filter((item) => item.type === "codex-session");

  const groups: ComposerCommandGroup[] = [];
  if (sessionItems.length > 0) {
    groups.push({ id: "sessions", label: "Conversations", items: sessionItems });
  }
  if (builtInItems.length > 0) {
    groups.push({ id: "built-in", label: "Built-in", items: builtInItems });
  }
  if (providerItems.length > 0) {
    groups.push({ id: "provider", label: "Provider", items: providerItems });
  }
  if (skillItems.length > 0) {
    groups.push({ id: "skills", label: "Skills", items: skillItems });
  }
  return groups;
}

export const ComposerCommandMenu = memo(function ComposerCommandMenu(props: {
  items: ComposerCommandItem[];
  resolvedTheme: "light" | "dark";
  isLoading: boolean;
  triggerKind: ComposerTriggerKind | null;
  groupSlashCommandSections?: boolean;
  emptyStateText?: string;
  activeItemId: string | null;
  onHighlightedItemChange: (itemId: string | null) => void;
  onSelect: (item: ComposerCommandItem) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const groups = useMemo(() => {
    const grouped = groupCommandItems(
      props.items,
      props.triggerKind,
      props.groupSlashCommandSections ?? true,
    );
    const onlyGroup = grouped.length === 1 ? grouped[0] : undefined;
    return onlyGroup === undefined ? grouped : [{ ...onlyGroup, label: null }];
  }, [props.groupSlashCommandSections, props.items, props.triggerKind]);

  useLayoutEffect(() => {
    if (!props.activeItemId || !listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>(
      `[data-composer-item-id="${CSS.escape(props.activeItemId)}"]`,
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [props.activeItemId]);

  return (
    <Command
      autoHighlight={false}
      mode="none"
      onItemHighlighted={(highlightedValue) => {
        props.onHighlightedItemChange(
          typeof highlightedValue === "string" ? highlightedValue : null,
        );
      }}
    >
      <div
        ref={listRef}
        className="chat-composer-drawer-surface chat-composer-drawer-attached relative w-full overflow-hidden **:data-[slot=scroll-area-scrollbar]:data-[orientation=vertical]:my-4"
        data-composer-command-drawer="true"
      >
        {props.items.length > 0 ? (
          <CommandList className="max-h-72 scroll-pb-6">
            {groups.map((group, groupIndex) => (
              <div key={group.id}>
                {groupIndex > 0 ? <CommandSeparator className="my-0.5" /> : null}
                <CommandGroup>
                  {group.label ? (
                    <CommandGroupLabel className="px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-secondary-label">
                      {group.label}
                    </CommandGroupLabel>
                  ) : null}
                  {group.items.map((item) => (
                    <ComposerCommandMenuItem
                      key={item.id}
                      item={item}
                      triggerKind={props.triggerKind}
                      resolvedTheme={props.resolvedTheme}
                      isActive={props.activeItemId === item.id}
                      onHighlight={props.onHighlightedItemChange}
                      onSelect={props.onSelect}
                    />
                  ))}
                </CommandGroup>
              </div>
            ))}
          </CommandList>
        ) : (
          <div className="px-5 pt-3.5 pb-7">
            {props.triggerKind === "skill" ? (
              <CommandGroup>
                <CommandGroupLabel className="px-0 pt-0 pb-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-secondary-label">
                  Skills
                </CommandGroupLabel>
                <p className="text-secondary-label text-xs">
                  {props.isLoading
                    ? "Searching workspace skills..."
                    : (props.emptyStateText ??
                      "No skills found. Try / to browse provider commands.")}
                </p>
              </CommandGroup>
            ) : (
              <p className="text-secondary-label text-xs">
                {props.isLoading
                  ? "Searching workspace files..."
                  : (props.emptyStateText ??
                    (props.triggerKind === "path"
                      ? "No matching files or folders."
                      : "No matching command."))}
              </p>
            )}
          </div>
        )}
      </div>
    </Command>
  );
});

const ComposerCommandMenuItem = memo(function ComposerCommandMenuItem(props: {
  item: ComposerCommandItem;
  triggerKind: ComposerTriggerKind | null;
  resolvedTheme: "light" | "dark";
  isActive: boolean;
  onHighlight: (itemId: string | null) => void;
  onSelect: (item: ComposerCommandItem) => void;
}) {
  const skillSourceKind =
    props.item.type === "skill" ? resolveProviderSkillSourceKind(props.item.skill) : null;
  const slashSkill =
    props.triggerKind === "slash-command" && props.item.type === "skill" ? props.item.skill : null;

  return (
    <CommandItem
      value={props.item.id}
      data-composer-item-id={props.item.id}
      className={cn(
        "cursor-pointer select-none gap-3 rounded-lg px-3 py-2! hover:bg-transparent hover:text-inherit data-highlighted:bg-transparent data-highlighted:text-inherit",
        props.isActive && "bg-accent! text-accent-foreground!",
      )}
      onMouseMove={() => {
        if (!props.isActive) props.onHighlight(props.item.id);
      }}
      onMouseDown={(event) => {
        event.preventDefault();
      }}
      onClick={() => {
        props.onSelect(props.item);
      }}
    >
      {props.item.type === "path" ? (
        <PierreEntryIcon
          pathValue={props.item.path}
          kind={props.item.pathKind}
          theme={props.resolvedTheme}
        />
      ) : skillSourceKind && !slashSkill ? (
        <SkillSourceIcon kind={skillSourceKind} />
      ) : null}
      {props.item.type === "codex-session" ? (
        <HistoryIcon className="size-4 shrink-0 text-muted-foreground/80" />
      ) : null}
      {/*
        Every other item type has a short, fixed label (`/model`, a basename) and a
        long description, so the label is pinned and the description truncates. A
        session row inverts that: the label is the conversation preview and the
        description is short metadata, so pinning the label overflowed the row and
        pushed the metadata out of view entirely.
      */}
      {props.item.type === "codex-session" ? (
        <span className="flex min-w-0 flex-1 items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate">{props.item.label}</span>
          <span className="shrink-0 text-secondary-label text-xs">{props.item.description}</span>
        </span>
      ) : (
        <span className="flex min-w-0 flex-1 items-baseline gap-3">
          <span className="shrink-0 font-sans text-xs font-medium">
            {slashSkill ? (
              <>
                <span className="text-secondary-label">skill:</span>
                {slashSkill.name}
              </>
            ) : (
              props.item.label
            )}
          </span>
          <span className="min-w-0 flex-1 truncate text-right text-secondary-label text-xs">
            {props.item.description}
          </span>
        </span>
      )}
    </CommandItem>
  );
});
