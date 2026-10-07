import { SidebarPointerSensor } from "./Sidebar.pointer";

/** Padding belongs to the repository beside it. Hit-testing only descendants
 * made a release a few pixels beside a row silently discard an otherwise valid drag. */
export function sidebarRepositoryTargetAt(
  list: HTMLElement,
  viewport: HTMLElement,
  point: { x: number; y: number },
): string | null {
  const bounds = viewport.getBoundingClientRect();
  if (
    point.x < bounds.left ||
    point.x >= bounds.right ||
    point.y < bounds.top ||
    point.y >= bounds.bottom
  )
    return null;
  const hit = list.ownerDocument.elementFromPoint(point.x, point.y);
  if (!hit || !viewport.contains(hit)) return null;
  const direct = hit.closest<HTMLElement>("[data-repository-group-drop-key]");
  if (direct && list.contains(direct)) return direct.dataset.repositoryGroupDropKey ?? null;
  // Only the vertical extent of the repository rows accepts padding drops.
  // Search, utility controls, the settled shelf and other overlays stay outside.
  let nearest: HTMLElement | null = null;
  let distance = Infinity;
  let top = Infinity;
  let bottom = -Infinity;
  for (const row of list.querySelectorAll<HTMLElement>("[data-repository-group-drop-key]")) {
    const rect = row.getBoundingClientRect();
    if (rect.height === 0) continue;
    top = Math.min(top, rect.top);
    bottom = Math.max(bottom, rect.bottom);
    const offset = Math.max(rect.top - point.y, point.y - rect.bottom, 0);
    if (offset < distance) {
      nearest = row;
      distance = offset;
    }
  }
  return point.y >= top && point.y < bottom
    ? (nearest?.dataset.repositoryGroupDropKey ?? null)
    : null;
}

/** Repository grips use the same release/cancellation rules as thread grips, including touch.
 * Resolve the release point again: a last pointermove may never reach the document. */
export function startSidebarRepositoryDrag(
  event: PointerEvent,
  input: {
    sourceKey: string;
    targetAt: (point: { x: number; y: number }) => string | null;
    onStart: () => void;
    onTarget: (key: string | null) => void;
    onDrop: (source: string, target: string) => void;
    onFinish: () => void;
    scrollElement?: HTMLElement | null | undefined;
  },
): SidebarPointerSensor | null {
  if (!event.isPrimary || event.button !== 0) return null;
  let started = false;
  let target: string | null = null;
  let point: { x: number; y: number } | null = null;
  let frame: number | null = null;
  let lastFrameTime: number | null = null;
  const scrollElement = input.scrollElement;
  const view = scrollElement?.ownerDocument.defaultView;
  const updateTarget = (position: { x: number; y: number }) => {
    target = input.targetAt(position);
    input.onTarget(target === input.sourceKey ? null : target);
  };
  // Unlike thread sorting, repository gestures run outside dnd-kit's auto-scroller.
  // Animate only while an edge can actually scroll; cancel owns the pending frame.
  const scrollAtEdge = (time: number) => {
    frame = null;
    if (!point || !scrollElement || !view) return;
    const bounds = scrollElement.getBoundingClientRect();
    if (
      point.x < bounds.left ||
      point.x > bounds.right ||
      point.y < bounds.top ||
      point.y > bounds.bottom
    )
      return;
    const edge = Math.min(32, bounds.height / 4);
    const direction = point.y < bounds.top + edge ? -1 : point.y > bounds.bottom - edge ? 1 : 0;
    if (direction === 0) return;
    const before = scrollElement.scrollTop;
    scrollElement.scrollTop +=
      direction * Math.min(32, lastFrameTime === null ? 16 : time - lastFrameTime) * 0.75;
    lastFrameTime = time;
    if (scrollElement.scrollTop === before) return;
    updateTarget(point);
    frame = view.requestAnimationFrame(scrollAtEdge);
  };
  return new SidebarPointerSensor({
    active: input.sourceKey,
    event,
    options: {
      distance: 6,
      onAttach: () => undefined,
      onFinish: () => {
        if (frame !== null) view?.cancelAnimationFrame(frame);
        input.onFinish();
      },
      onDrop: (point) => {
        target = input.targetAt(point);
        return false;
      },
    },
    onPending: () => undefined,
    onAbort: () => undefined,
    onCancel: () => undefined,
    onStart: () => {
      started = true;
      input.onStart();
    },
    onMove: (position) => {
      point = position;
      updateTarget(position);
      if (frame === null && view) {
        lastFrameTime = null;
        frame = view.requestAnimationFrame(scrollAtEdge);
      }
    },
    onEnd: () => {
      if (started && target !== null && target !== input.sourceKey)
        input.onDrop(input.sourceKey, target);
    },
  });
}
