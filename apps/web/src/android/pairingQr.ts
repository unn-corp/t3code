import { readHostedPairingRequest } from "@t3tools/shared/remote";
import { getPairingTokenFromUrl } from "../pairingUrl";

/** Accept pairing links only; arbitrary QR content must never become a connection host. */
export function readPairingQr(payload: string): string {
  let url = new URL(payload.trim());
  if (url.protocol === "t3code:") {
    url = new URL(url.searchParams.get("pairingUrl") ?? "");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Scan a pairing QR code from Arcwright Code Connections.");
  }
  if (!readHostedPairingRequest(url) && !getPairingTokenFromUrl(url)) {
    throw new Error("This QR code has no pairing code. Create a fresh pairing link on the host.");
  }
  return url.toString();
}

export async function openPairingCamera(signal: AbortSignal): Promise<MediaStream> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode: { ideal: "environment" }, width: { ideal: 640 } },
  });
  const stop = () => stream.getTracks().forEach((track) => track.stop());
  if (signal.aborted) {
    stop();
    throw new DOMException("Scanner closed", "AbortError");
  }
  signal.addEventListener("abort", stop, { once: true });
  return stream;
}
