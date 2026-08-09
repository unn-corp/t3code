export interface DictationMicrophoneRequestResult {
  readonly stream: MediaStream;
  readonly usedSystemDefaultFallback: boolean;
}

function selectedMicrophoneIsUnavailable(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    (error.name === "OverconstrainedError" || error.name === "NotFoundError")
  );
}

export async function requestDictationMicrophone(
  mediaDevices: Pick<MediaDevices, "getUserMedia">,
  selectedDeviceId: string,
): Promise<DictationMicrophoneRequestResult> {
  if (selectedDeviceId.length === 0) {
    return {
      stream: await mediaDevices.getUserMedia({ audio: true }),
      usedSystemDefaultFallback: false,
    };
  }

  try {
    return {
      stream: await mediaDevices.getUserMedia({
        audio: { deviceId: { exact: selectedDeviceId } },
      }),
      usedSystemDefaultFallback: false,
    };
  } catch (error: unknown) {
    if (!selectedMicrophoneIsUnavailable(error)) throw error;
    return {
      stream: await mediaDevices.getUserMedia({ audio: true }),
      usedSystemDefaultFallback: true,
    };
  }
}
