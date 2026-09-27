import type { ReactNode } from "react";

import { isElectron } from "../../env";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { SidebarInset } from "../ui/sidebar";

export function OrganizationPageShell({ children }: { readonly children: ReactNode }) {
  return (
    <SidebarInset className="flex h-dvh min-h-0 min-w-0 flex-col bg-background">
      <WorkspacePageHeader electron={isElectron} className="border-b border-border/70" />
      <main className="min-w-0 flex-1 overflow-y-auto" id="organization-main">
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
          {children}
        </div>
      </main>
    </SidebarInset>
  );
}
