"use client";

import type { PreviewViewportSetting } from "@t3tools/contracts";
import { PREVIEW_VIEWPORT_PRESETS } from "@t3tools/shared/previewViewport";
import { MonitorSmartphone } from "lucide-react";

import { Button } from "~/components/ui/button";
import {
  Menu,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "~/components/ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

const FILL_VALUE = "fill";

/**
 * Device emulation for a viewer that has no local webview.
 *
 * The desktop exposes this through its device toolbar, which is drawn around
 * its own webview and so never reaches a phone. The underlying resize already
 * travels to whichever host is rendering, so this is the control that was
 * missing rather than the capability.
 */
export function PreviewDeviceMenu(props: {
  readonly viewport: PreviewViewportSetting;
  readonly disabled: boolean;
  readonly onChange: (viewport: PreviewViewportSetting) => void;
}) {
  const selected = props.viewport._tag === "preset" ? props.viewport.presetId : FILL_VALUE;
  const label =
    props.viewport._tag === "fill"
      ? "Fit to panel"
      : (PREVIEW_VIEWPORT_PRESETS.find((preset) => preset.id === selected)?.label ??
        `${props.viewport.width} × ${props.viewport.height}`);

  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <Button
                  size="xs"
                  variant="ghost"
                  className="shrink-0"
                  disabled={props.disabled}
                  aria-label={`Device size: ${label}`}
                >
                  <MonitorSmartphone />
                </Button>
              }
            />
          }
        />
        <TooltipPopup side="bottom">{label}</TooltipPopup>
      </Tooltip>
      <MenuPopup
        align="end"
        side="bottom"
        sideOffset={6}
        className="max-h-96 min-w-56 overflow-auto"
      >
        <MenuRadioGroup
          value={selected}
          onValueChange={(value) => {
            if (value === FILL_VALUE) {
              props.onChange({ _tag: "fill" });
              return;
            }
            const preset = PREVIEW_VIEWPORT_PRESETS.find((candidate) => candidate.id === value);
            if (!preset) return;
            props.onChange({
              _tag: "preset",
              presetId: preset.id,
              width: preset.width,
              height: preset.height,
            });
          }}
        >
          <MenuRadioItem value={FILL_VALUE}>Fit to panel</MenuRadioItem>
          <MenuSeparator />
          {PREVIEW_VIEWPORT_PRESETS.map((preset) => (
            <MenuRadioItem key={preset.id} value={preset.id}>
              <span className="flex w-full items-center justify-between gap-3">
                <span>{preset.label}</span>
                <span className="text-muted-foreground text-xs tabular-nums">{preset.detail}</span>
              </span>
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
}
