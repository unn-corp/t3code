import type { ScopedProjectRef } from "@t3tools/contracts";
import { scopedProjectKey, scopeProjectRef } from "@t3tools/client-runtime/environment";
import { ChevronDownIcon } from "lucide-react";
import { useMemo } from "react";

import { useNewThreadHandler } from "~/hooks/useHandleNewThread";
import { useProjects, useThreadShells } from "~/state/entities";
import { sortProjectsForSidebar } from "../Sidebar.logic";
import { Menu, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "../ui/menu";

interface DraftHeroHeadlineProps {
  readonly activeProjectRef: ScopedProjectRef | null;
  readonly activeProjectTitle: string | null;
}

export function DraftHeroHeadline({
  activeProjectRef,
  activeProjectTitle,
}: DraftHeroHeadlineProps) {
  const projects = useProjects();
  const threads = useThreadShells();
  const handleNewThread = useNewThreadHandler();

  const orderedProjects = useMemo(
    () => sortProjectsForSidebar(projects, threads, "updated_at"),
    [projects, threads],
  );
  const projectByKey = useMemo(
    () =>
      new Map(
        orderedProjects.map(
          (project) =>
            [
              scopedProjectKey(scopeProjectRef(project.environmentId, project.id)),
              project,
            ] as const,
        ),
      ),
    [orderedProjects],
  );
  const activeProjectKey = activeProjectRef === null ? "" : scopedProjectKey(activeProjectRef);

  const projectLabel = activeProjectTitle ?? "this project";
  return (
    <h1 className="mx-auto w-full max-w-3xl text-center font-semibold text-2xl text-foreground sm:text-3xl">
      What should we do in{" "}
      {orderedProjects.length > 1 ? (
        <Menu>
          <MenuTrigger className="pointer-events-auto inline-flex cursor-pointer items-baseline gap-1.5 rounded-md text-muted-foreground/60 transition-colors hover:text-foreground/80 focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring">
            {projectLabel}
            <span
              aria-hidden="true"
              className="mr-1.5 flex size-4 shrink-0 items-center justify-center self-center rounded-full bg-muted-foreground/12 sm:size-5"
            >
              <ChevronDownIcon className="size-2.5 sm:size-3" />
            </span>
          </MenuTrigger>
          <MenuPopup align="center" className="max-h-80 w-64 overflow-y-auto">
            <MenuRadioGroup
              value={activeProjectKey}
              onValueChange={(value) => {
                const project = projectByKey.get(value as string);
                if (!project || value === activeProjectKey) {
                  return;
                }
                void handleNewThread(scopeProjectRef(project.environmentId, project.id), {
                  replace: true,
                });
              }}
            >
              {orderedProjects.map((project) => {
                const key = scopedProjectKey(scopeProjectRef(project.environmentId, project.id));
                return (
                  <MenuRadioItem key={key} value={key} closeOnClick>
                    <span className="min-w-0 truncate">{project.title}</span>
                  </MenuRadioItem>
                );
              })}
            </MenuRadioGroup>
          </MenuPopup>
        </Menu>
      ) : (
        <span className="text-muted-foreground/60">{projectLabel}</span>
      )}
      ?
    </h1>
  );
}
