import {
  OrganizationEdgeId,
  OrganizationRoleId,
  type Organization,
  type OrganizationChange,
  type OrganizationRole,
} from "@t3tools/contracts";
import { PlusIcon, Redo2Icon, Trash2Icon, Undo2Icon } from "lucide-react";
import { useState } from "react";

import { randomUUID } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardPanel } from "../ui/card";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { OrganizationGraphView } from "./OrganizationGraphView";
import { inverseOrganizationChange } from "./organizationDesignerHistory";
import { layoutWithMovedRole, rolePositions, type Point } from "./organizationGraphLayout";

const ROLE_KINDS = [
  "engineering",
  "qa",
  "security",
  "research",
  "custom",
] as const satisfies ReadonlyArray<OrganizationRole["kind"]>;
const EDGE_KINDS = ["reports-to", "delegates-to", "reviews", "consults", "escalates-to"] as const;
const SELECT_CLASS =
  "min-h-10 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-ring";

interface HistoryEntry {
  readonly forward: OrganizationChange;
  readonly inverse: OrganizationChange;
}

interface DesignerHistory {
  readonly revision: number;
  readonly past: ReadonlyArray<HistoryEntry>;
  readonly future: ReadonlyArray<HistoryEntry>;
}

function RoleInspector({
  role,
  protectedRole,
  busy,
  onChange,
}: {
  readonly role: OrganizationRole;
  readonly protectedRole: boolean;
  readonly busy: boolean;
  readonly onChange: (change: OrganizationChange) => Promise<boolean>;
}) {
  const [title, setTitle] = useState(role.title);
  const [mandate, setMandate] = useState(role.mandate);
  const [poolSize, setPoolSize] = useState(String(role.poolSize));
  const nextPoolSize = Number(poolSize);
  const canSave = title.trim().length > 0 && Number.isInteger(nextPoolSize) && nextPoolSize >= 1;

  return (
    <Card>
      <CardPanel className="space-y-4 p-5">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-lg font-semibold">Role details</h3>
          <Badge variant="outline">{role.kind}</Badge>
        </div>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!canSave) return;
            void onChange({
              type: "update-role",
              roleId: role.id,
              title: title.trim(),
              mandate,
              poolSize: nextPoolSize,
            });
          }}
        >
          <label className="block space-y-1.5 text-sm font-medium">
            <span>Name</span>
            <Input aria-label="Role name" value={title} onValueChange={setTitle} disabled={busy} />
          </label>
          <label className="block space-y-1.5 text-sm font-medium">
            <span>Mandate</span>
            <Textarea
              aria-label="Role mandate"
              value={mandate}
              onChange={(event) => setMandate(event.currentTarget.value)}
              disabled={busy}
            />
          </label>
          <label className="block space-y-1.5 text-sm font-medium">
            <span>Worker pool size</span>
            <Input
              aria-label="Worker pool size"
              type="number"
              min={1}
              step={1}
              value={poolSize}
              onValueChange={setPoolSize}
              disabled={busy}
            />
          </label>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={busy || !canSave}>
              Save role
            </Button>
            {!protectedRole ? (
              <Button
                type="button"
                variant="destructive-outline"
                disabled={busy}
                onClick={() => void onChange({ type: "remove-role", roleId: role.id })}
              >
                <Trash2Icon /> Remove role
              </Button>
            ) : null}
          </div>
        </form>
      </CardPanel>
    </Card>
  );
}

function PositionEditor({
  role,
  position,
  busy,
  onMoveRole,
}: {
  readonly role: OrganizationRole;
  readonly position: Point;
  readonly busy: boolean;
  readonly onMoveRole: (roleId: OrganizationRoleId, point: Point) => Promise<boolean>;
}) {
  const [horizontal, setHorizontal] = useState(String(Math.round(position.x)));
  const [vertical, setVertical] = useState(String(Math.round(position.y)));
  const x = Number(horizontal);
  const y = Number(vertical);
  const valid = Number.isFinite(x) && Number.isFinite(y) && x >= 0 && y >= 0;
  return (
    <Card>
      <CardPanel className="space-y-4 p-5">
        <h3 className="text-lg font-semibold">Canvas position</h3>
        <p className="text-sm text-muted-foreground">
          Placement changes how the graph looks. It does not change responsibility or permissions.
        </p>
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (valid) void onMoveRole(role.id, { x, y });
          }}
        >
          <label className="block space-y-1.5 text-sm font-medium">
            <span>Horizontal</span>
            <Input
              type="number"
              min={0}
              step={1}
              value={horizontal}
              onValueChange={setHorizontal}
              disabled={busy}
            />
          </label>
          <label className="block space-y-1.5 text-sm font-medium">
            <span>Vertical</span>
            <Input
              type="number"
              min={0}
              step={1}
              value={vertical}
              onValueChange={setVertical}
              disabled={busy}
            />
          </label>
          <Button
            variant="outline"
            type="submit"
            disabled={
              busy ||
              !valid ||
              (Math.round(x) === Math.round(position.x) && Math.round(y) === Math.round(position.y))
            }
          >
            Save position
          </Button>
        </form>
      </CardPanel>
    </Card>
  );
}

export function OrganizationDesigner({
  organization,
  busy,
  onChange,
}: {
  readonly organization: Organization;
  readonly busy: boolean;
  readonly onChange: (change: OrganizationChange) => Promise<boolean>;
}) {
  const [selectedRoleId, setSelectedRoleId] = useState<string | null>(organization.directorRoleId);
  const [newRoleTitle, setNewRoleTitle] = useState("");
  const [newRoleKind, setNewRoleKind] = useState<OrganizationRole["kind"]>("engineering");
  const [fromRoleId, setFromRoleId] = useState<string>(organization.directorRoleId);
  const [toRoleId, setToRoleId] = useState<string>(organization.architectRoleId);
  const [edgeKind, setEdgeKind] =
    useState<Organization["graph"]["edges"][number]["kind"]>("reports-to");
  const [search, setSearch] = useState("");
  const [history, setHistory] = useState<DesignerHistory>({
    revision: organization.draftRevision,
    past: [],
    future: [],
  });
  const selectedRole =
    organization.graph.roles.find((role) => role.id === selectedRoleId) ??
    organization.graph.roles[0] ??
    null;
  const normalizedSearch = search.trim().toLowerCase();
  const matchingRoles = organization.graph.roles.filter((role) =>
    `${role.title} ${role.kind} ${role.mandate}`.toLowerCase().includes(normalizedSearch),
  );
  const historyIsCurrent = history.revision === organization.draftRevision;

  async function applyDesignerChange(change: OrganizationChange): Promise<boolean> {
    if (busy) return false;
    const inverse = inverseOrganizationChange(organization, change);
    const saved = await onChange(change);
    if (saved) {
      setHistory({
        revision: organization.draftRevision + 1,
        past:
          inverse === null
            ? []
            : [...(historyIsCurrent ? history.past : []), { forward: change, inverse }],
        future: [],
      });
    }
    return saved;
  }

  async function moveRole(roleId: OrganizationRoleId, point: Point): Promise<boolean> {
    const current = rolePositions(organization).get(roleId);
    if (
      !current ||
      (Math.round(current.x) === Math.round(point.x) &&
        Math.round(current.y) === Math.round(point.y))
    )
      return false;
    return applyDesignerChange({
      type: "set-layout",
      layout: layoutWithMovedRole(organization, roleId, point),
    });
  }

  async function undo() {
    if (busy || !historyIsCurrent || history.past.length === 0) return;
    const entry = history.past.at(-1)!;
    if (await onChange(entry.inverse)) {
      setHistory({
        revision: organization.draftRevision + 1,
        past: history.past.slice(0, -1),
        future: [...history.future, entry],
      });
    }
  }

  async function redo() {
    if (busy || !historyIsCurrent || history.future.length === 0) return;
    const entry = history.future.at(-1)!;
    if (await onChange(entry.forward)) {
      setHistory({
        revision: organization.draftRevision + 1,
        past: [...history.past, entry],
        future: history.future.slice(0, -1),
      });
    }
  }

  return (
    <div
      className="space-y-5"
      onKeyDown={(event) => {
        if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "z") return;
        if (
          event.target instanceof HTMLElement &&
          event.target.closest("input, textarea, [contenteditable='true']")
        )
          return;
        event.preventDefault();
        if (event.shiftKey) void redo();
        else void undo();
      }}
    >
      <div className="flex flex-wrap items-end justify-between gap-3">
        <label className="min-w-0 flex-1 space-y-1.5 text-sm font-medium sm:max-w-sm">
          <span>Find a role</span>
          <Input
            type="search"
            aria-label="Find a role"
            value={search}
            onValueChange={setSearch}
            placeholder="Search names, kinds, or mandates"
          />
        </label>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={busy || !historyIsCurrent || history.past.length === 0}
            onClick={() => void undo()}
          >
            <Undo2Icon /> Undo
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy || !historyIsCurrent || history.future.length === 0}
            onClick={() => void redo()}
          >
            <Redo2Icon /> Redo
          </Button>
        </div>
      </div>
      {!historyIsCurrent && history.past.length > 0 ? (
        <p role="status" className="text-sm text-muted-foreground">
          The draft changed outside this editing sequence. Make a new edit to start a new undo
          history.
        </p>
      ) : null}
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(17rem,20rem)]">
        <div className="min-w-0 space-y-5">
          <section aria-labelledby="organization-graph-heading" className="space-y-3">
            <div>
              <h2 id="organization-graph-heading" className="text-lg font-semibold">
                Role graph
              </h2>
              <p className="text-sm text-muted-foreground">
                Select or move a role on the graph. Relationships describe responsibility and do not
                grant permissions.
              </p>
            </div>
            <OrganizationGraphView
              organization={organization}
              selectedRoleId={selectedRole?.id ?? null}
              search={search}
              busy={busy}
              onSelectRole={setSelectedRoleId}
              onMoveRole={moveRole}
            />
          </section>
          <section aria-labelledby="organization-outline-heading" className="space-y-3">
            <h2 id="organization-outline-heading" className="text-lg font-semibold">
              Role outline ({matchingRoles.length})
            </h2>
            <ul className="grid min-w-0 gap-2 sm:grid-cols-2">
              {matchingRoles.map((role) => (
                <li key={role.id} className="min-w-0">
                  <Button
                    className="w-full min-w-0 justify-start whitespace-normal text-left"
                    variant={selectedRole?.id === role.id ? "secondary" : "outline"}
                    aria-pressed={selectedRole?.id === role.id}
                    onClick={() => setSelectedRoleId(role.id)}
                  >
                    <span className="min-w-0 break-all">
                      {role.title} <span className="text-muted-foreground">({role.kind})</span>
                    </span>
                  </Button>
                </li>
              ))}
            </ul>
            {matchingRoles.length === 0 ? (
              <p role="status" className="text-sm text-muted-foreground">
                No roles match this search.
              </p>
            ) : null}
          </section>
          <Card>
            <CardPanel className="space-y-4 p-5">
              <h2 className="text-lg font-semibold">Relationships</h2>
              <ul className="space-y-2 text-sm">
                {organization.graph.edges.length === 0 ? (
                  <li className="text-muted-foreground">No relationships yet.</li>
                ) : null}
                {organization.graph.edges.map((edge) => (
                  <li
                    key={edge.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border p-3"
                  >
                    <span className="min-w-0 flex-1 break-all">
                      {organization.graph.roles.find((role) => role.id === edge.fromRoleId)
                        ?.title ?? edge.fromRoleId}{" "}
                      <strong>{edge.kind}</strong>{" "}
                      {organization.graph.roles.find((role) => role.id === edge.toRoleId)?.title ??
                        edge.toRoleId}
                    </span>
                    <Button
                      size="sm"
                      variant="ghost-destructive"
                      disabled={busy}
                      aria-label={`Remove ${edge.kind} relationship`}
                      onClick={() =>
                        void applyDesignerChange({ type: "remove-edge", edgeId: edge.id })
                      }
                    >
                      <Trash2Icon /> Remove
                    </Button>
                  </li>
                ))}
              </ul>
              <form
                className="grid gap-3 sm:grid-cols-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (fromRoleId === toRoleId) return;
                  void applyDesignerChange({
                    type: "add-edge",
                    edge: {
                      id: OrganizationEdgeId.make(randomUUID()),
                      fromRoleId: OrganizationRoleId.make(fromRoleId),
                      toRoleId: OrganizationRoleId.make(toRoleId),
                      kind: edgeKind,
                    },
                  });
                }}
              >
                <label className="space-y-1 text-sm font-medium">
                  <span>From</span>
                  <select
                    className={SELECT_CLASS}
                    value={fromRoleId}
                    onChange={(event) => setFromRoleId(event.currentTarget.value)}
                    disabled={busy}
                  >
                    {organization.graph.roles.map((role) => (
                      <option key={role.id} value={role.id}>
                        {role.title}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="space-y-1 text-sm font-medium">
                  <span>Relationship</span>
                  <select
                    className={SELECT_CLASS}
                    value={edgeKind}
                    onChange={(event) => {
                      const value = EDGE_KINDS.find((kind) => kind === event.currentTarget.value);
                      if (value) setEdgeKind(value);
                    }}
                    disabled={busy}
                  >
                    {EDGE_KINDS.map((kind) => (
                      <option key={kind} value={kind}>
                        {kind}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="space-y-1 text-sm font-medium">
                  <span>To</span>
                  <select
                    className={SELECT_CLASS}
                    value={toRoleId}
                    onChange={(event) => setToRoleId(event.currentTarget.value)}
                    disabled={busy}
                  >
                    {organization.graph.roles.map((role) => (
                      <option key={role.id} value={role.id}>
                        {role.title}
                      </option>
                    ))}
                  </select>
                </label>
                <Button
                  className="sm:col-span-3 sm:justify-self-start"
                  type="submit"
                  disabled={busy || fromRoleId === toRoleId}
                >
                  <PlusIcon /> Add relationship
                </Button>
              </form>
            </CardPanel>
          </Card>
        </div>
        <aside className="min-w-0 space-y-5" aria-label="Role inspector">
          {selectedRole ? (
            <RoleInspector
              key={`${selectedRole.id}:${organization.draftRevision}`}
              role={selectedRole}
              protectedRole={
                selectedRole.id === organization.directorRoleId ||
                selectedRole.id === organization.architectRoleId
              }
              busy={busy}
              onChange={applyDesignerChange}
            />
          ) : null}
          {selectedRole ? (
            <PositionEditor
              key={`position:${selectedRole.id}:${organization.draftRevision}`}
              role={selectedRole}
              position={rolePositions(organization).get(selectedRole.id) ?? { x: 0, y: 0 }}
              busy={busy}
              onMoveRole={moveRole}
            />
          ) : null}
          <Card>
            <CardPanel className="space-y-4 p-5">
              <h2 className="text-lg font-semibold">Add role</h2>
              <form
                className="space-y-4"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!newRoleTitle.trim()) return;
                  void applyDesignerChange({
                    type: "add-role",
                    role: {
                      id: OrganizationRoleId.make(randomUUID()),
                      kind: newRoleKind,
                      title: newRoleTitle.trim(),
                      mandate: "",
                      poolSize: 1,
                    },
                  }).then((saved) => {
                    if (saved) setNewRoleTitle("");
                  });
                }}
              >
                <label className="block space-y-1.5 text-sm font-medium">
                  <span>Name</span>
                  <Input
                    aria-label="New role name"
                    value={newRoleTitle}
                    onValueChange={setNewRoleTitle}
                    disabled={busy}
                  />
                </label>
                <label className="block space-y-1.5 text-sm font-medium">
                  <span>Kind</span>
                  <select
                    className={SELECT_CLASS}
                    value={newRoleKind}
                    onChange={(event) => {
                      const value = ROLE_KINDS.find((kind) => kind === event.currentTarget.value);
                      if (value) setNewRoleKind(value);
                    }}
                    disabled={busy}
                  >
                    {ROLE_KINDS.map((kind) => (
                      <option key={kind} value={kind}>
                        {kind}
                      </option>
                    ))}
                  </select>
                </label>
                <Button type="submit" disabled={busy || !newRoleTitle.trim()}>
                  <PlusIcon /> Add role
                </Button>
              </form>
            </CardPanel>
          </Card>
        </aside>
      </div>
    </div>
  );
}
