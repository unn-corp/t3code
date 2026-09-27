import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { OrganizationId } from "@t3tools/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowRightIcon, NetworkIcon, PlusIcon, RefreshCwIcon } from "lucide-react";
import { useState } from "react";

import { randomUUID } from "../../lib/utils";
import { organizationEnvironment, useOrganizations } from "../../state/organizations";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardHeader, CardPanel, CardTitle } from "../ui/card";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { OrganizationPageShell } from "./OrganizationPageShell";
import { OrganizationRepositoryLoader } from "./OrganizationRepository";

export function OrganizationsPage() {
  const navigate = useNavigate();
  const organizations = useOrganizations();
  const create = useAtomCommand(organizationEnvironment.create);
  const [title, setTitle] = useState("");
  const [mission, setMission] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const records = organizations.data?.organizations ?? [];

  async function handleCreate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (organizations.environmentId === null || title.trim().length === 0 || isCreating) return;
    setIsCreating(true);
    setActionError(null);
    try {
      const result = await create({
        environmentId: organizations.environmentId,
        input: {
          organizationId: OrganizationId.make(randomUUID()),
          mutationId: randomUUID(),
          title: title.trim(),
          mission: mission.trim(),
          actor: "user",
        },
      });
      if (result._tag === "Failure") {
        const error = squashAtomCommandFailure(result);
        setActionError(error instanceof Error ? error.message : String(error));
        return;
      }
      organizations.refresh();
      void navigate({
        to: "/organizations/$organizationId",
        params: { organizationId: result.value.id },
      });
    } finally {
      setIsCreating(false);
    }
  }

  return (
    <OrganizationPageShell>
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border/70 pb-5">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Organizations</h1>
          <p className="mt-2 max-w-prose text-sm text-muted-foreground">
            Create a standing organization or load a shared one, then choose the Projects it can
            access.
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={organizations.refresh}
          disabled={organizations.environmentId === null}
        >
          <RefreshCwIcon /> Refresh
        </Button>
      </header>

      {organizations.environmentId === null ? (
        <p
          role="status"
          className="rounded-xl border border-border p-4 text-sm text-muted-foreground"
        >
          Connect an environment to create or view Organizations.
        </p>
      ) : null}
      {organizations.error ? (
        <div
          role="alert"
          className="rounded-xl border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive-foreground"
        >
          Could not load Organizations: {organizations.error}
        </div>
      ) : null}
      {organizations.isPending && organizations.data === null ? (
        <p role="status" className="text-sm text-muted-foreground">
          Loading Organizations…
        </p>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(16rem,22rem)]">
        <section aria-label="Organizations" className="min-w-0 space-y-3">
          {organizations.isSuccess && records.length === 0 ? (
            <Card>
              <CardPanel className="p-6">
                <NetworkIcon className="mb-3 size-6 text-muted-foreground" aria-hidden="true" />
                <h2 className="text-lg font-semibold">No Organizations yet</h2>
                <p className="mt-2 text-sm text-muted-foreground">
                  Create one here. You can link Projects later.
                </p>
              </CardPanel>
            </Card>
          ) : null}
          {records.map((organization) => (
            <Card key={organization.id}>
              <CardHeader className="flex-row items-start justify-between gap-3">
                <div className="min-w-0">
                  <CardTitle>{organization.title}</CardTitle>
                  <p className="mt-2 line-clamp-2 text-sm text-muted-foreground">
                    {organization.mission || "No mission set yet."}
                  </p>
                </div>
                <Badge variant={organization.lifecycle === "active" ? "success" : "outline"}>
                  {organization.lifecycle}
                </Badge>
              </CardHeader>
              <CardPanel className="flex flex-wrap items-center justify-between gap-3 px-6 pb-5 text-sm text-muted-foreground">
                <span>
                  {organization.bindings.filter((binding) => binding.detachedAt === null).length}{" "}
                  linked Projects
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  render={
                    <Link
                      to="/organizations/$organizationId"
                      params={{ organizationId: organization.id }}
                    />
                  }
                >
                  Open <ArrowRightIcon />
                </Button>
              </CardPanel>
            </Card>
          ))}
        </section>

        <div className="space-y-4">
          <Card className="h-fit">
            <CardHeader>
              <CardTitle>Create Organization</CardTitle>
            </CardHeader>
            <CardPanel className="px-6 pb-6">
              <form onSubmit={(event) => void handleCreate(event)} className="space-y-4">
                <label className="block space-y-1.5 text-sm font-medium">
                  <span>Name</span>
                  <Input
                    aria-label="Organization name"
                    value={title}
                    onValueChange={setTitle}
                    disabled={isCreating || organizations.environmentId === null}
                    required
                  />
                </label>
                <label className="block space-y-1.5 text-sm font-medium">
                  <span>Mission</span>
                  <Textarea
                    aria-label="Organization mission"
                    value={mission}
                    onChange={(event) => setMission(event.currentTarget.value)}
                    disabled={isCreating || organizations.environmentId === null}
                  />
                </label>
                {actionError ? (
                  <p role="alert" className="text-sm text-destructive-foreground">
                    {actionError}
                  </p>
                ) : null}
                <Button
                  type="submit"
                  disabled={
                    isCreating || organizations.environmentId === null || title.trim().length === 0
                  }
                >
                  <PlusIcon /> {isCreating ? "Creating…" : "Create Organization"}
                </Button>
              </form>
            </CardPanel>
          </Card>
          <OrganizationRepositoryLoader />
        </div>
      </div>
    </OrganizationPageShell>
  );
}
