import { useEffect, useRef, useState } from "react";
import { Button } from "../ui/button";
import { openPairingCamera, readPairingQr } from "../../android/pairingQr";

export function PairingQrScanner({
  onScan,
  onClose,
}: {
  readonly onScan: (url: string) => void;
  readonly onClose: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const close = () => {
      controller.abort();
      clearTimeout(timer);
    };
    const hidden = () => {
      if (document.hidden) {
        close();
        onClose();
      }
    };
    document.addEventListener("visibilitychange", hidden);
    const start = async () => {
      try {
        // Software decoding also works on Android WebViews without BarcodeDetector.
        const [{ default: decode }, stream] = await Promise.all([
          import("jsqr"),
          openPairingCamera(controller.signal),
        ]);
        const video = videoRef.current;
        if (controller.signal.aborted || !video) return;
        video.srcObject = stream;
        await video.play();
        const canvas = document.createElement("canvas");
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context) throw new Error("Could not start the QR scanner.");
        const scan = () => {
          if (controller.signal.aborted) return;
          if (video.readyState >= 2 && video.videoWidth > 0) {
            canvas.width = Math.min(video.videoWidth, 640);
            canvas.height = Math.round((video.videoHeight / video.videoWidth) * canvas.width);
            context.drawImage(video, 0, 0, canvas.width, canvas.height);
            const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
            const qr = decode(pixels.data, pixels.width, pixels.height);
            if (qr) {
              try {
                const url = readPairingQr(qr.data);
                close();
                onScan(url);
                return;
              } catch (cause) {
                setError(cause instanceof Error ? cause.message : "Invalid pairing QR code.");
              }
            }
          }
          timer = setTimeout(scan, 200);
        };
        scan();
      } catch (cause) {
        if (controller.signal.aborted) return;
        close();
        setError(
          cause instanceof DOMException && cause.name === "NotAllowedError"
            ? "Allow camera access in Android Settings for Arcwright Code, then try again. You can also paste the pairing link."
            : "Could not open the camera. Try again or paste the pairing link.",
        );
      }
    };
    void start();
    return () => {
      close();
      document.removeEventListener("visibilitychange", hidden);
      const video = videoRef.current;
      if (video) video.srcObject = null;
    };
  }, [onScan, onClose]);

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Point the camera at your host’s pairing QR code.
      </p>
      <video
        ref={videoRef}
        muted
        playsInline
        aria-label="Pairing QR camera"
        className="w-full rounded-md"
      />
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <Button variant="outline" onClick={onClose}>
        Cancel scanning
      </Button>
    </div>
  );
}
