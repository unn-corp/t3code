import type { ResizableWidthHandlers } from "~/hooks/useResizableWidth";
import { cn } from "~/lib/utils";

interface Props {
  handlers: ResizableWidthHandlers;
  className?: string;
}

/**
 * Hit target for resizing a right-anchored panel via its left edge.
 *
 * - Sits on top of the panel's border with a 4px overlap on each side so the
 *   user can grab a few pixels off the edge without aiming.
 * - Visual indicator is a 1px line that lights up on hover/active to mirror
 *   VS Code / Cursor.
 * - touch-action:none is load-bearing: without it the browser treats a finger
 *   drag as a pan and cancels the pointer sequence, so the handle worked with a
 *   mouse and did nothing on a touchscreen. The coarse-pointer before: block
 *   widens the grab zone to a finger without thickening the 1px line.
 */
export function RightPanelResizeHandle({ handlers, className }: Props) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      className={cn(
        "group absolute inset-y-0 -left-1 z-20 w-2 cursor-col-resize touch-none select-none",
        "pointer-coarse:before:-translate-x-1/2 pointer-coarse:before:absolute pointer-coarse:before:inset-y-0 pointer-coarse:before:left-1/2 pointer-coarse:before:w-11",
        className,
      )}
      {...handlers}
    >
      <span
        aria-hidden
        className="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-transparent transition-colors duration-150 group-hover:bg-border group-active:bg-primary/60"
      />
    </div>
  );
}
