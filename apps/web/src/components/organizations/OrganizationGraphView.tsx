import type { Organization, OrganizationRoleId } from "@t3tools/contracts";
import { GripIcon, Maximize2Icon, MinusIcon, PlusIcon } from "lucide-react";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type PointerEvent,
  type WheelEvent,
} from "react";

import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import {
  fitGraphViewport,
  NODE_HEIGHT,
  NODE_WIDTH,
  roleBounds,
  rolePositions,
  zoomGraphAt,
  type GraphViewport,
  type Point,
} from "./organizationGraphLayout";

type PointerSession =
  | {
      readonly kind: "pan";
      readonly pointerId: number;
      readonly clientX: number;
      readonly clientY: number;
      readonly viewport: GraphViewport;
    }
  | {
      readonly kind: "role";
      readonly pointerId: number;
      readonly roleId: OrganizationRoleId;
      readonly clientX: number;
      readonly clientY: number;
      readonly origin: Point;
      readonly zoom: number;
    };

export function OrganizationGraphView({
  organization,
  selectedRoleId,
  search,
  busy,
  onSelectRole,
  onMoveRole,
}: {
  readonly organization: Organization;
  readonly selectedRoleId: string | null;
  readonly search: string;
  readonly busy: boolean;
  readonly onSelectRole: (roleId: string) => void;
  readonly onMoveRole: (roleId: OrganizationRoleId, point: Point) => Promise<boolean>;
}) {
  const markerId = useId();
  const frameRef = useRef<HTMLDivElement | null>(null);
  const fittedOrganizationId = useRef<string | null>(null);
  const lastSelectedRoleId = useRef(selectedRoleId);
  const pointerSessionRef = useRef<PointerSession | null>(null);
  const [viewport, setViewport] = useState<GraphViewport>({ x: 0, y: 0, zoom: 1 });
  const [dragPreview, setDragPreview] = useState<{
    readonly roleId: OrganizationRoleId;
    readonly point: Point;
  } | null>(null);
  const positions = useMemo(() => rolePositions(organization), [organization]);
  const displayedPositions = useMemo(() => {
    const next = new Map(positions);
    if (dragPreview !== null) next.set(dragPreview.roleId, dragPreview.point);
    return next;
  }, [dragPreview, positions]);
  const bounds = useMemo(() => roleBounds(displayedPositions), [displayedPositions]);
  const normalizedSearch = search.trim().toLowerCase();
  const graphWidth = Math.max(1, bounds.maxX + NODE_WIDTH);
  const graphHeight = Math.max(1, bounds.maxY + NODE_HEIGHT);

  function fitToView() {
    const frame = frameRef.current;
    if (!frame) return;
    setViewport(
      fitGraphViewport(roleBounds(positions), {
        width: frame.clientWidth,
        height: frame.clientHeight,
      }),
    );
  }

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame || fittedOrganizationId.current === organization.id) return;
    fittedOrganizationId.current = organization.id;
    const fitted = fitGraphViewport(roleBounds(positions), {
      width: frame.clientWidth,
      height: frame.clientHeight,
    });
    if (frame.clientWidth < 640 && fitted.zoom < 1) {
      const selected =
        organization.graph.roles.find((role) => role.id === selectedRoleId) ??
        organization.graph.roles[0];
      const point = selected ? positions.get(selected.id) : null;
      setViewport(
        point
          ? {
              x: frame.clientWidth / 2 - point.x - NODE_WIDTH / 2,
              y: frame.clientHeight / 2 - point.y - NODE_HEIGHT / 2,
              zoom: 1,
            }
          : fitted,
      );
    } else {
      setViewport(fitted);
    }
  }, [organization.id, organization.graph.roles, positions, selectedRoleId]);

  useEffect(() => {
    if (lastSelectedRoleId.current === selectedRoleId) return;
    lastSelectedRoleId.current = selectedRoleId;
    const selected = organization.graph.roles.find((role) => role.id === selectedRoleId);
    const position = selected ? positions.get(selected.id) : null;
    if (position) revealRole(position);
  }, [organization.graph.roles, positions, selectedRoleId]);

  function zoomBy(factor: number, point?: Point) {
    const frame = frameRef.current;
    if (!frame) return;
    const center = point ?? { x: frame.clientWidth / 2, y: frame.clientHeight / 2 };
    setViewport((current) => zoomGraphAt(current, center, current.zoom * factor));
  }

  function handleWheel(event: WheelEvent<HTMLDivElement>) {
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      const frame = frameRef.current;
      if (!frame) return;
      const rectangle = frame.getBoundingClientRect();
      zoomBy(event.deltaY < 0 ? 1.1 : 1 / 1.1, {
        x: event.clientX - rectangle.left,
        y: event.clientY - rectangle.top,
      });
    } else if (event.shiftKey) {
      event.preventDefault();
      setViewport((current) => ({
        ...current,
        x: current.x - event.deltaX,
        y: current.y - event.deltaY,
      }));
    }
  }

  function startPan(event: PointerEvent<HTMLDivElement>) {
    if (
      event.button !== 0 ||
      event.pointerType === "touch" ||
      (event.target instanceof HTMLElement && event.target.closest("[data-role-node]"))
    )
      return;
    pointerSessionRef.current = {
      kind: "pan",
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      viewport,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function startRoleDrag(event: PointerEvent<HTMLButtonElement>, roleId: OrganizationRoleId) {
    if (event.button !== 0 || busy) return;
    const origin = positions.get(roleId);
    if (!origin) return;
    event.preventDefault();
    event.stopPropagation();
    onSelectRole(roleId);
    pointerSessionRef.current = {
      kind: "role",
      pointerId: event.pointerId,
      roleId,
      clientX: event.clientX,
      clientY: event.clientY,
      origin,
      zoom: viewport.zoom,
    };
    frameRef.current?.setPointerCapture(event.pointerId);
  }

  function positionForPointer(
    session: Extract<PointerSession, { kind: "role" }>,
    event: PointerEvent<HTMLDivElement>,
  ): Point {
    return {
      x: Math.max(0, session.origin.x + (event.clientX - session.clientX) / session.zoom),
      y: Math.max(0, session.origin.y + (event.clientY - session.clientY) / session.zoom),
    };
  }

  function handlePointerMove(event: PointerEvent<HTMLDivElement>) {
    const session = pointerSessionRef.current;
    if (session === null || session.pointerId !== event.pointerId) return;
    if (session.kind === "pan") {
      setViewport({
        ...session.viewport,
        x: session.viewport.x + event.clientX - session.clientX,
        y: session.viewport.y + event.clientY - session.clientY,
      });
    } else {
      setDragPreview({ roleId: session.roleId, point: positionForPointer(session, event) });
    }
  }

  function endPointer(event: PointerEvent<HTMLDivElement>) {
    const session = pointerSessionRef.current;
    if (session === null || session.pointerId !== event.pointerId) return;
    pointerSessionRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    if (session.kind === "role") {
      const point = positionForPointer(session, event);
      if (
        Math.round(point.x) !== Math.round(session.origin.x) ||
        Math.round(point.y) !== Math.round(session.origin.y)
      ) {
        setDragPreview({ roleId: session.roleId, point });
        void onMoveRole(session.roleId, point).finally(() => setDragPreview(null));
      } else {
        setDragPreview(null);
      }
    }
  }

  function cancelPointer(event: PointerEvent<HTMLDivElement>) {
    if (pointerSessionRef.current?.pointerId !== event.pointerId) return;
    pointerSessionRef.current = null;
    setDragPreview(null);
  }

  function revealRole(position: Point) {
    const frame = frameRef.current;
    if (!frame) return;
    setViewport((current) => {
      const margin = 12;
      const left = current.x + position.x * current.zoom;
      const top = current.y + position.y * current.zoom;
      const width = NODE_WIDTH * current.zoom;
      const height = NODE_HEIGHT * current.zoom;
      const x =
        width > frame.clientWidth - margin * 2
          ? frame.clientWidth / 2 - (position.x + NODE_WIDTH / 2) * current.zoom
          : left < margin
            ? current.x + margin - left
            : left + width > frame.clientWidth - margin
              ? current.x + frame.clientWidth - margin - left - width
              : current.x;
      const y =
        height > frame.clientHeight - margin * 2
          ? frame.clientHeight / 2 - (position.y + NODE_HEIGHT / 2) * current.zoom
          : top < margin
            ? current.y + margin - top
            : top + height > frame.clientHeight - margin
              ? current.y + frame.clientHeight - margin - top - height
              : current.y;
      return x === current.x && y === current.y ? current : { ...current, x, y };
    });
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          Drag a role by its handle. Drag empty space with a mouse to pan. Use Shift with the wheel
          to pan, or Ctrl or Command with the wheel to zoom. On touch screens, use the controls
          below or the role outline.
        </p>
        <div className="flex items-center gap-1" aria-label="Graph controls">
          <Button
            size="icon-lg"
            variant="outline"
            aria-label="Zoom out"
            onClick={() => zoomBy(1 / 1.2)}
          >
            <MinusIcon />
          </Button>
          <output className="min-w-12 text-center text-sm tabular-nums" aria-label="Graph zoom">
            {Math.round(viewport.zoom * 100)}%
          </output>
          <Button size="icon-lg" variant="outline" aria-label="Zoom in" onClick={() => zoomBy(1.2)}>
            <PlusIcon />
          </Button>
          <Button size="sm" variant="outline" aria-label="Fit graph to view" onClick={fitToView}>
            <Maximize2Icon /> Fit
          </Button>
        </div>
      </div>
      <div
        ref={frameRef}
        role="region"
        tabIndex={0}
        aria-label="Organization role graph"
        className="relative h-72 overflow-hidden rounded-xl border border-border bg-muted/20 outline-none touch-pan-y focus-visible:ring-2 focus-visible:ring-ring sm:h-96 lg:h-112"
        onWheel={handleWheel}
        onPointerDown={startPan}
        onPointerMove={handlePointerMove}
        onPointerUp={endPointer}
        onPointerCancel={cancelPointer}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          if (event.key === "Home") {
            event.preventDefault();
            fitToView();
          } else if (event.key === "+" || event.key === "=") {
            event.preventDefault();
            zoomBy(1.2);
          } else if (event.key === "-") {
            event.preventDefault();
            zoomBy(1 / 1.2);
          } else if (
            event.key === "ArrowLeft" ||
            event.key === "ArrowRight" ||
            event.key === "ArrowUp" ||
            event.key === "ArrowDown"
          ) {
            event.preventDefault();
            setViewport((current) => ({
              ...current,
              x:
                current.x + (event.key === "ArrowLeft" ? 40 : event.key === "ArrowRight" ? -40 : 0),
              y: current.y + (event.key === "ArrowUp" ? 40 : event.key === "ArrowDown" ? -40 : 0),
            }));
          }
        }}
      >
        <div
          className="absolute left-0 top-0 origin-top-left"
          style={{
            width: graphWidth,
            height: graphHeight,
            transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`,
          }}
        >
          <svg
            className="pointer-events-none absolute inset-0 overflow-visible"
            width={graphWidth}
            height={graphHeight}
            aria-hidden="true"
          >
            <defs>
              <marker
                id={markerId}
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="5"
                markerHeight="5"
                orient="auto-start-reverse"
              >
                <path d="M 0 0 L 10 5 L 0 10 z" className="fill-muted-foreground" />
              </marker>
            </defs>
            {organization.graph.edges.map((edge) => {
              const from = displayedPositions.get(edge.fromRoleId);
              const to = displayedPositions.get(edge.toRoleId);
              if (!from || !to) return null;
              const fromX = from.x + NODE_WIDTH / 2;
              const fromY = from.y + NODE_HEIGHT / 2;
              const toX = to.x + NODE_WIDTH / 2;
              const toY = to.y + NODE_HEIGHT / 2;
              const direction = toY >= fromY ? 1 : -1;
              const startY = fromY + (direction * NODE_HEIGHT) / 2;
              const endY = toY - (direction * NODE_HEIGHT) / 2;
              const controlY = (startY + endY) / 2;
              return (
                <g key={edge.id}>
                  <path
                    d={`M ${fromX} ${startY} C ${fromX} ${controlY}, ${toX} ${controlY}, ${toX} ${endY}`}
                    fill="none"
                    className="stroke-muted-foreground/75"
                    strokeWidth="2"
                    markerEnd={`url(#${markerId})`}
                  />
                  <text
                    x={(fromX + toX) / 2}
                    y={controlY - 7}
                    textAnchor="middle"
                    className="fill-foreground text-sm font-medium"
                    stroke="var(--color-background)"
                    strokeWidth="6"
                    paintOrder="stroke"
                  >
                    {edge.kind}
                  </text>
                </g>
              );
            })}
          </svg>
          {organization.graph.roles.map((role) => {
            const position = displayedPositions.get(role.id);
            if (!position) return null;
            const matches =
              normalizedSearch.length === 0 ||
              `${role.title} ${role.kind} ${role.mandate}`.toLowerCase().includes(normalizedSearch);
            return (
              <div
                key={role.id}
                data-role-node
                onFocus={() => revealRole(position)}
                className={cn(
                  "absolute rounded-xl border bg-card shadow-sm",
                  selectedRoleId === role.id
                    ? "border-primary ring-2 ring-primary/30"
                    : "border-border",
                  !matches && "opacity-40",
                )}
                style={{
                  left: position.x,
                  top: position.y,
                  width: NODE_WIDTH,
                  height: NODE_HEIGHT,
                }}
              >
                <button
                  type="button"
                  aria-pressed={selectedRoleId === role.id}
                  aria-label={`Select ${role.title}`}
                  onClick={() => onSelectRole(role.id)}
                  className="absolute inset-0 w-full rounded-xl px-4 py-3 pr-12 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span className="block truncate text-sm font-semibold">{role.title}</span>
                  <span className="mt-1 block truncate text-sm text-muted-foreground">
                    {role.kind}, pool {role.poolSize}
                  </span>
                </button>
                <button
                  type="button"
                  aria-label={`Move ${role.title}. Use arrow keys for small steps.`}
                  title={`Move ${role.title}`}
                  disabled={busy}
                  onPointerDown={(event) => startRoleDrag(event, role.id)}
                  onKeyDown={(event) => {
                    const delta = event.shiftKey ? 40 : 16;
                    const next =
                      event.key === "ArrowLeft"
                        ? { x: position.x - delta, y: position.y }
                        : event.key === "ArrowRight"
                          ? { x: position.x + delta, y: position.y }
                          : event.key === "ArrowUp"
                            ? { x: position.x, y: position.y - delta }
                            : event.key === "ArrowDown"
                              ? { x: position.x, y: position.y + delta }
                              : null;
                    if (next) {
                      event.preventDefault();
                      event.stopPropagation();
                      void onMoveRole(role.id, { x: Math.max(0, next.x), y: Math.max(0, next.y) });
                    }
                  }}
                  className="absolute right-1 top-1 flex size-11 touch-none cursor-grab items-center justify-center rounded-lg text-muted-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing"
                >
                  <GripIcon className="size-5" />
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
