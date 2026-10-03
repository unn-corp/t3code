import {
  TeamCommand,
  TeamCommandResult,
  TeamSnapshot,
  TeamSpaceSchema,
  TeamDirectory,
  TeamRosterResult,
  type TeamRosterCommand,
} from "@t3tools/contracts/teamSpaces";
import { TeamMemberDirectory } from "@t3tools/contracts/teamProjects";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";

const decodeError = Schema.decodeUnknownSync(Schema.Struct({ error: Schema.String }));

interface TeamIdentitySession {
  readonly id: string;
  readonly user: { readonly id: string };
  readonly getToken: () => Promise<string | null>;
}
/** Capture the session resource: Clerk's global token getter can switch identity while awaiting readiness. */
export function createTeamSessionTokenGetter(input: {
  readonly userId: string | null | undefined;
  readonly sessionId: string | null | undefined;
  readonly session: TeamIdentitySession | null | undefined;
  readonly currentSession: () => TeamIdentitySession | null | undefined;
}) {
  const session = input.session;
  const requireCurrent = () => {
    const current = input.currentSession();
    if (
      !session ||
      session.id !== input.sessionId ||
      session.user.id !== input.userId ||
      current?.id !== session.id ||
      current.user.id !== input.userId
    )
      throw new Error("Your Teams sign-in changed. Reload team access before continuing.");
  };
  return async () => {
    requireCurrent();
    const token = await session!.getToken();
    requireCurrent();
    return token;
  };
}

/** Clerk tokens are sent only to the configured control service, never to personal environment controls. */
export function createTeamClient(baseUrl: string, getToken: () => Promise<string | null>) {
  const request = async <A>(
    path: string,
    schema: Schema.Codec<A, unknown>,
    body?: unknown,
    signal?: AbortSignal,
  ) => {
    signal?.throwIfAborted();
    const token = await getToken();
    signal?.throwIfAborted();
    if (!token) throw new Error("Sign in to access team projects.");
    const response = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        let request = HttpClientRequest.make(body === undefined ? "GET" : "POST")(
          new URL(path, baseUrl),
          { headers: { authorization: `Bearer ${token}` } },
        );
        if (body !== undefined) request = request.pipe(HttpClientRequest.bodyJsonUnsafe(body));
        const result = yield* client.execute(request);
        return {
          status: result.status,
          ok: result.status >= 200 && result.status < 300,
          body: yield* result.json,
        };
      }).pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(FetchHttpClient.RequestInit, { cache: "no-store" }),
      ),
      { signal },
    );
    if (!response.ok) {
      const error = decodeError(response.body);
      const message: Record<string, string> = {
        last_owner_required: "The project must retain its creator.",
        last_team_owner_required: "The team must retain an owner.",
        team_invitation_invalid:
          "This team invitation is invalid, expired, or issued for another verified email.",
        team_membership_required: "Accept a team invitation before creating or opening projects.",
        invitation_invalid:
          "This invitation is invalid, expired, or issued for a different verified email.",
        project_creation_denied: "This account cannot create team projects.",
        project_name_invalid: "Enter a project name between 1 and 120 characters.",
        sign_in_required: "Sign in again to access team projects.",
      };
      throw new Error(
        message[error.error] ??
          (response.status === 403
            ? "Project access denied. Sign in again or ask the owner for access."
            : "Team request failed."),
      );
    }
    return Schema.decodeUnknownSync(schema)(response.body);
  };
  return {
    teamDirectory: (signal?: AbortSignal) =>
      request("/api/team/team-directory", TeamDirectory, undefined, signal),
    teamCommand: (command: TeamRosterCommand, signal?: AbortSignal) =>
      request("/api/team/team-command", TeamRosterResult, command, signal),
    memberDirectory: (spaceId: string, signal?: AbortSignal) =>
      request(
        `/api/team/projects/${encodeURIComponent(spaceId)}/member-directory`,
        TeamMemberDirectory,
        undefined,
        signal,
      ),
    list: (signal?: AbortSignal) =>
      request(
        "/api/team/spaces",
        Schema.Struct({ spaces: Schema.Array(TeamSpaceSchema) }),
        undefined,
        signal,
      ),
    snapshot: (spaceId: string, after = 0, signal?: AbortSignal) =>
      request(
        `/api/team/snapshot?spaceId=${encodeURIComponent(spaceId)}&after=${after}`,
        TeamSnapshot,
        undefined,
        signal,
      ),
    command: (command: TeamCommand, signal?: AbortSignal) =>
      request("/api/team/command", TeamCommandResult, command, signal),
    ticket: (spaceId: string, signal?: AbortSignal) =>
      request("/api/team/ticket", Schema.Struct({ ticket: Schema.String }), { spaceId }, signal),
    websocketUrl: (ticket: string) => {
      const url = new URL("/api/team/ws", baseUrl);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      url.searchParams.set("ticket", ticket);
      return url.href;
    },
  };
}
