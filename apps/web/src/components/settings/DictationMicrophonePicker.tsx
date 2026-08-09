import { RefreshCwIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { toastManager } from "../ui/toast";

const SYSTEM_DEFAULT_MICROPHONE = "__t3_system_default_microphone__";

function availableMediaDevices(): MediaDevices | null {
  if (typeof navigator === "undefined") return null;
  return navigator.mediaDevices ?? null;
}

async function enumerateMicrophones(mediaDevices: MediaDevices): Promise<MediaDeviceInfo[]> {
  const devices = await mediaDevices.enumerateDevices();
  const seenDeviceIds = new Set<string>();
  return devices.filter((device) => {
    if (device.kind !== "audioinput" || device.deviceId.length === 0) return false;
    if (seenDeviceIds.has(device.deviceId)) return false;
    seenDeviceIds.add(device.deviceId);
    return true;
  });
}

function microphoneLabel(device: MediaDeviceInfo, index: number): string {
  return device.label.trim() || `Microphone ${index + 1}`;
}

export function DictationMicrophonePicker({
  value,
  onValueChange,
}: {
  value: string;
  onValueChange: (value: string) => void;
}) {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [isDetecting, setIsDetecting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const mediaDevices = availableMediaDevices();

  const refreshDeviceList = useCallback(async () => {
    const available = availableMediaDevices();
    if (!available?.enumerateDevices) {
      setDevices([]);
      setErrorMessage("Microphone selection is unavailable on this device.");
      return;
    }
    try {
      setDevices(await enumerateMicrophones(available));
      setErrorMessage(null);
    } catch (error: unknown) {
      setErrorMessage(error instanceof Error ? error.message : "Could not list microphones.");
    }
  }, []);

  useEffect(() => {
    void refreshDeviceList();
    const available = availableMediaDevices();
    if (!available) return;
    const handleDeviceChange = () => void refreshDeviceList();
    available.addEventListener("devicechange", handleDeviceChange);
    return () => available.removeEventListener("devicechange", handleDeviceChange);
  }, [refreshDeviceList]);

  const detectMicrophones = useCallback(async () => {
    const available = availableMediaDevices();
    if (!available?.getUserMedia) {
      setErrorMessage("Microphone selection is unavailable on this device.");
      return;
    }

    setIsDetecting(true);
    setErrorMessage(null);
    let stream: MediaStream | null = null;
    try {
      stream = await available.getUserMedia({ audio: true });
      setDevices(await enumerateMicrophones(available));
    } catch (error: unknown) {
      const description =
        error instanceof DOMException && error.name === "NotAllowedError"
          ? "Allow microphone access, then try detecting microphones again."
          : error instanceof Error
            ? error.message
            : "Could not detect microphones.";
      setErrorMessage(description);
      toastManager.add({
        type: "error",
        title: "Could not detect microphones",
        description,
      });
    } finally {
      for (const track of stream?.getTracks() ?? []) track.stop();
      setIsDetecting(false);
    }
  }, []);

  const selectedLabel = useMemo(() => {
    if (value.length === 0) return "System default";
    const selectedIndex = devices.findIndex((device) => device.deviceId === value);
    const selectedDevice = devices[selectedIndex];
    return selectedDevice
      ? microphoneLabel(selectedDevice, selectedIndex)
      : "Selected microphone (unavailable)";
  }, [devices, value]);
  const selectedDeviceIsUnavailable =
    value.length > 0 && !devices.some((device) => device.deviceId === value);

  return (
    <div className="flex w-full min-w-0 flex-col gap-1.5 sm:w-80">
      <div className="flex min-w-0 items-center gap-2">
        <Select
          value={value.length > 0 ? value : SYSTEM_DEFAULT_MICROPHONE}
          onValueChange={(next) => {
            if (typeof next !== "string") return;
            onValueChange(next === SYSTEM_DEFAULT_MICROPHONE ? "" : next);
          }}
        >
          <SelectTrigger
            className="min-w-0 flex-1"
            aria-label="Dictation microphone"
            disabled={!mediaDevices?.enumerateDevices}
          >
            <SelectValue>{selectedLabel}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            <SelectItem hideIndicator value={SYSTEM_DEFAULT_MICROPHONE}>
              System default
            </SelectItem>
            {selectedDeviceIsUnavailable ? (
              <SelectItem disabled hideIndicator value={value}>
                Selected microphone (unavailable)
              </SelectItem>
            ) : null}
            {devices.map((device, index) => (
              <SelectItem hideIndicator key={device.deviceId} value={device.deviceId}>
                {microphoneLabel(device, index)}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        <Button
          type="button"
          size="xs"
          variant="outline"
          className="shrink-0 gap-1.5"
          disabled={isDetecting || !mediaDevices?.getUserMedia}
          onClick={() => void detectMicrophones()}
        >
          <RefreshCwIcon className={isDetecting ? "size-3.5 animate-spin" : "size-3.5"} />
          Detect
        </Button>
      </div>
      {errorMessage ? (
        <p className="text-xs text-destructive" role="status">
          {errorMessage}
        </p>
      ) : null}
    </div>
  );
}
