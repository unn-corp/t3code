import {
  defaultInstanceIdForDriver,
  type ProviderDriverKind,
  type ProviderInstanceId,
} from "@t3tools/contracts";

/**
 * Which provider's conversations `/resume` lists and resumes.
 *
 * Deliberately derived from the composer's selection alone. The thread-oriented
 * `activeProviderDriver` resolves through the thread's *bound* session, so once a
 * resume bound one, the next `/resume` listed that driver instead of the selected
 * one: a thread would offer 16 Claude conversations and then 4 Codex ones moments
 * later. Sessions are stored per driver and per account, so listing and resuming
 * must agree with what the user has selected, or the picker offers sessions that
 * cannot be resumed.
 */
export function resolveResumeSessionSource(input: {
  readonly selectedProvider: ProviderDriverKind;
  /** Instance backing the selection, when one resolved from provider statuses. */
  readonly selectedProviderInstanceId: ProviderInstanceId | null;
}): {
  readonly driver: ProviderDriverKind;
  readonly providerInstanceId: ProviderInstanceId;
} {
  return {
    driver: input.selectedProvider,
    // Not every selectable provider has a `providerInstances` entry (codex has
    // none on this machine), and the canonical default is the driver kind itself.
    providerInstanceId:
      input.selectedProviderInstanceId ?? defaultInstanceIdForDriver(input.selectedProvider),
  };
}
