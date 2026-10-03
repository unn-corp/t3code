import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProjectId, ThreadId, MessageId } from "@t3tools/contracts";
import type {
  LocalTeamProjectState,
  TeamThreadSource,
  TeamSharedThreadSummary,
  TeamSharedThreadSnapshot,
} from "@t3tools/contracts/teamProjects";
import {
  createSharedProjectVisibilitySelector,
  sharedProjectBoundaryKey,
  sharedProjectSourceScope,
  reduceSharedProject,
  reduceSharedThread,
} from "./teamProjects.ts";
import { requireTeamExecution } from "./teamExecution.ts";

const environmentId = EnvironmentId.make("one");
const projectId = ProjectId.make("project");
const threadId = ThreadId.make("thread");
const source: TeamThreadSource = {
  displayProjectRef: { projectId },
  readSource: { kind: "shared", sourceId: "scoped-peer", threadId },
  executionRef: null,
  discussionRef: { linkId: "link", threadId },
  assetSource: "unavailable",
  fileSource: "unavailable",
  contentFormat: "plain-text",
  access: { execute: false, publish: false, discuss: true, markRead: true },
};
const thread: TeamSharedThreadSummary = {
  id: threadId,
  source,
  title: "Peer",
  display: { provider: "codex", model: "local" },
  createdBy: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  archivedAt: null,
};
const linkState = (
  overrides: Partial<LocalTeamProjectState["link"]> = {},
  owned: string[] = [],
): LocalTeamProjectState => ({
  link: {
    id: "link",
    projectId,
    sharedProjectId: "cloud",
    serviceUrl: "https://teams.example",
    subject: "owner",
    generation: "one",
    role: "owner",
    status: "synced",
    publicationPolicy: "explicit-threads",
    repositorySync: "available",
    ...overrides,
  },
  publications: owned.map((id) => ({
    publicationId: id,
    threadId: ThreadId.make(`local-${id}`),
    sharedThreadId: ThreadId.make(id),
    status: "synced",
    revision: 1,
  })),
});

describe("shared read identities", () => {
  it("caches empty and equivalent visibility, preferring real owned mappings across environments", () => {
    const select = createSharedProjectVisibilitySelector();
    expect(select([], null)).toBe(select([], null));
    const one = linkState({}, ["owned-one"]);
    const two = linkState({ projectId: ProjectId.make("second") }, ["owned-two"]);
    const entries = [
      { environmentId, state: one },
      { environmentId: EnvironmentId.make("two"), state: two },
    ];
    const first = select(entries, environmentId);
    expect(
      select(
        entries.map((entry) => ({ ...entry, state: { ...entry.state } })),
        environmentId,
      ),
    ).toBe(first);
    const visible = first.get(sharedProjectBoundaryKey(one.link));
    expect(visible?.preferred).toBe(JSON.stringify([environmentId, projectId]));
    expect([...visible!.ownedThreadIds].sort()).toEqual(["owned-one", "owned-two"]);
    expect(
      select(entries, EnvironmentId.make("two")).get(sharedProjectBoundaryKey(one.link))?.preferred,
    ).toBe(JSON.stringify(["two", "second"]));
  });
  it("separates cached read sources after account generation and link replacement", () => {
    const link = linkState().link;
    const keys = [
      link,
      { ...link, generation: "two" },
      { ...link, id: "replacement" },
      { ...link, serviceUrl: "https://other.example" },
      { ...link, subject: "other" },
    ].map(sharedProjectSourceScope);
    expect(new Set(keys).size).toBe(5);
    expect(sharedProjectSourceScope({ ...link })).toBe(keys[0]);
  });
  it("partitions service/project/member identity and removes revoked or account-changed links", () => {
    const select = createSharedProjectVisibilitySelector();
    const states = [
      linkState(),
      linkState({ serviceUrl: "https://other.example" }),
      linkState({ sharedProjectId: "other" }),
      linkState({ subject: "other" }),
      linkState({ status: "account-changed", sharedProjectId: "changed" }),
      linkState({ status: "access-revoked", sharedProjectId: "revoked" }),
    ];
    expect(
      select(
        states.map((state) => ({ environmentId, state })),
        environmentId,
      ).size,
    ).toBe(4);
  });
  it("preserves source array identity for synchronization and applies bounded shell changes", () => {
    const initial = reduceSharedProject([], { kind: "snapshot", sequence: 1, threads: [thread] });
    expect(reduceSharedProject(initial, { kind: "synchronized" })).toBe(initial);
    const changed = reduceSharedProject(initial, {
      kind: "thread-upserted",
      sequence: 2,
      thread: { ...thread, title: "Updated" },
    });
    expect(changed).toHaveLength(1);
    expect(changed[0]?.title).toBe("Updated");
    expect(reduceSharedProject(changed, { kind: "thread-removed", sequence: 3, threadId })).toEqual(
      [],
    );
  });
  it("merges live chunks once, ignores replay, and requests discussion refresh without copying bodies", () => {
    const message = {
      id: MessageId.make("message"),
      role: "assistant" as const,
      text: "A",
      streaming: true,
      author: null,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
    };
    const snapshot: TeamSharedThreadSnapshot = {
      snapshotSequence: 5,
      thread,
      memberStatus: null,
      messages: [message],
      discussions: [],
    };
    const state = { snapshot, refreshRevision: 0 };
    const item = {
      kind: "message" as const,
      sequence: 6,
      message: { ...message, text: "B" },
      append: true,
    };
    const next = reduceSharedThread(state, item);
    expect(next.snapshot?.messages[0]?.text).toBe("AB");
    expect(reduceSharedThread(next, item)).toBe(next);
    const discussion = reduceSharedThread(next, { kind: "discussion-changed", sequence: 7 });
    expect(discussion.snapshot).toBe(next.snapshot);
    expect(discussion.refreshRevision).toBe(1);
  });
  it("rejects peer/null/mismatched execution identities even when thread IDs coincide", () => {
    expect(() => requireTeamExecution(source, threadId)).toThrow("read-only");
    const local: TeamThreadSource = {
      ...source,
      readSource: { kind: "local", threadId },
      executionRef: { projectId, threadId },
      access: { ...source.access, execute: true },
    };
    expect(() => requireTeamExecution(local, threadId)).not.toThrow();
    expect(() => requireTeamExecution({ ...local, executionRef: null }, threadId)).toThrow();
    expect(() =>
      requireTeamExecution(
        { ...local, executionRef: { projectId: ProjectId.make("other"), threadId } },
        threadId,
      ),
    ).toThrow();
    expect(() => requireTeamExecution(local, "other")).toThrow();
  });
});
