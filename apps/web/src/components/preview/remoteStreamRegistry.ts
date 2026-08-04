/**
 * Maps a runtime webview id to the server thread/tab it is streaming for.
 *
 * Frames arrive from the desktop bridge keyed by runtime tab id, but the server
 * addresses tabs by `(threadId, tabId)`. Without this the host would have to
 * re-derive the pairing per frame, which is the wrong place to spend work when
 * frames arrive continuously.
 */
export interface RemoteStreamTarget {
  readonly threadId: string;
  readonly tabId: string;
}

const targets = new Map<string, RemoteStreamTarget>();

export function registerRemoteStreamTab(runtimeTabId: string, target: RemoteStreamTarget): void {
  targets.set(runtimeTabId, target);
}

export function unregisterRemoteStreamTab(runtimeTabId: string): void {
  targets.delete(runtimeTabId);
}

export function readRemoteStreamTarget(runtimeTabId: string): RemoteStreamTarget | null {
  return targets.get(runtimeTabId) ?? null;
}

export function clearRemoteStreamTargets(): void {
  targets.clear();
}

/**
 * Frames carry no sequence of their own, so the host stamps one. A viewer uses
 * it to drop a frame that lost a race and arrived after a newer one.
 */
let sequence = 0;

export function nextRemoteFrameSequence(): number {
  // Wrap well below MAX_SAFE_INTEGER so a long-lived host never produces a
  // sequence a viewer cannot compare.
  sequence = (sequence + 1) % 1_000_000_000;
  return sequence;
}

export function resetRemoteFrameSequence(): void {
  sequence = 0;
}
