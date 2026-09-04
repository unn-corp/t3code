import { type ReactNode } from "react";

import { useResizableWidth } from "~/hooks/useResizableWidth";
import { cn } from "~/lib/utils";

import { RIGHT_PANEL_SHEET_CLASS_NAME } from "../rightPanelLayout";
import { useViewportWidth } from "./preview/PreviewPanelShell";
import { RightPanelResizeHandle } from "./preview/RightPanelResizeHandle";
import { Sheet, SheetPopup } from "./ui/sheet";

const RIGHT_PANEL_SHEET_WIDTH_STORAGE_KEY = "t3code:right-panel-sheet-width";
const RIGHT_PANEL_SHEET_MIN_WIDTH = 280;
const RIGHT_PANEL_SHEET_DEFAULT_WIDTH = 420;
/**
 * A phone can give the panel nearly the whole screen and still leave a strip of
 * chat visible to show what it is covering. Maximizing removes even that.
 */
const RIGHT_PANEL_SHEET_MAX_WIDTH_FRACTION = 0.96;

export function RightPanelSheet(props: {
  animationDurationMs: number;
  children: ReactNode;
  open: boolean;
  maximized: boolean;
  onClose: () => void;
}) {
  const viewportWidth = useViewportWidth();
  const { width, handlers } = useResizableWidth({
    storageKey: RIGHT_PANEL_SHEET_WIDTH_STORAGE_KEY,
    defaultWidth: RIGHT_PANEL_SHEET_DEFAULT_WIDTH,
    minWidth: RIGHT_PANEL_SHEET_MIN_WIDTH,
    maxWidth: Math.floor(viewportWidth * RIGHT_PANEL_SHEET_MAX_WIDTH_FRACTION),
    edge: "left",
  });

  return (
    <Sheet
      open={props.open}
      onOpenChange={(open) => {
        if (!open) {
          props.onClose();
        }
      }}
    >
      <SheetPopup
        transitionDurationMs={props.animationDurationMs}
        side="right"
        showCloseButton={false}
        keepMounted
        className={cn(
          props.maximized
            ? // Full-bleed. A slide-over capped at 24rem leaves most of a phone
              // screen unused, and the panel's own chrome needs that room more
              // than a peek at the chat behind it does.
              "w-screen max-w-none border-s-0"
            : RIGHT_PANEL_SHEET_CLASS_NAME,
        )}
        // Inline width beats the class so a drag survives re-render, and
        // maxWidth has to come with it or the class ceiling clamps the drag.
        style={props.maximized ? undefined : { width: `${width}px`, maxWidth: "100vw" }}
      >
        {props.maximized ? null : <RightPanelResizeHandle handlers={handlers} />}
        {props.children}
      </SheetPopup>
    </Sheet>
  );
}
