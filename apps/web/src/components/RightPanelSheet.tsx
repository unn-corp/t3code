import { type ReactNode } from "react";

import { useResizableWidth } from "~/hooks/useResizableWidth";

import { useSyncExternalStore } from "react";
const subscribeViewport = (listener: () => void) => {
  window.addEventListener("resize", listener);
  return () => window.removeEventListener("resize", listener);
};
const getViewportWidth = () => window.innerWidth;
const useViewportWidth = () =>
  useSyncExternalStore(subscribeViewport, getViewportWidth, () => 1024);
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
        className={
          props.maximized
            ? "w-screen max-w-none"
            : "min-w-80 max-[760px]:min-w-0 wco:mt-[env(titlebar-area-height)] wco:h-[calc(100%-env(titlebar-area-height))] wco:max-h-[calc(100%-env(titlebar-area-height))]"
        }
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
