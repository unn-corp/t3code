import { expect, it, vi } from "vite-plus/test";
import { ThreadId } from "@t3tools/contracts";
import type { DraftId } from "../../composerDraftStore";
vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({ state: { location: { href: "/" }, matches: [] } }),
}));
vi.mock("./TeamDiscussion", () => ({ TeamDiscussionButton: () => null }));
vi.mock("../../state/teamProjects", () => ({
  teamProjects: {},
  sharedProjectSourceScope: () => "scope",
}));
vi.mock("../../state/query", () => ({ useEnvironmentQuery: () => ({ data: null }) }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => {} }));
vi.mock("../../hooks/useHandleNewThread", () => ({ useNewThreadHandler: () => {} }));
vi.mock("../../composerDraftStore", () => ({ useComposerDraftStore: {} }));
vi.mock("../chat/MessagesTimeline", () => ({ MessagesTimeline: () => null }));
vi.mock("../ui/sidebar", () => ({ SidebarInset: () => null }));
vi.mock("../ui/button", () => ({ Button: () => null }));
import { continueSharedConversation } from "./SharedChatView";
function deferred<A>() {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
it.each(["account", "link", "root", "environment", "destination"])(
  "leaves no quoted prompt after %s changes during awaited navigation",
  async (change) => {
    const entered = deferred<void>();
    const navigation = deferred<{ draftId: DraftId; threadId: ThreadId }>();
    let sourceCurrent = true;
    let destinationCurrent = true;
    const prompts: string[] = [];
    const action = continueSharedConversation({
      isCurrent: async () => sourceCurrent,
      createDraft: () => {
        entered.resolve();
        return navigation.promise;
      },
      isDestinationCurrent: () => destinationCurrent,
      writeQuote: () => prompts.push("Old-account quote"),
    });
    await entered.promise;
    if (change === "destination") destinationCurrent = false;
    else sourceCurrent = false;
    navigation.resolve({ draftId: "draft" as DraftId, threadId: ThreadId.make("local") });
    await action;
    expect(prompts).toEqual([]);
  },
);
it("quotes only after a current Local destination receipt and never creates from a stale source", async () => {
  const navigation = deferred<{ draftId: DraftId; threadId: ThreadId }>();
  const entered = deferred<void>();
  const prompts: string[] = [];
  const action = continueSharedConversation({
    isCurrent: async () => true,
    createDraft: () => {
      entered.resolve();
      return navigation.promise;
    },
    isDestinationCurrent: () => true,
    writeQuote: () => prompts.push("Attributed quote"),
  });
  await entered.promise;
  expect(prompts).toEqual([]);
  navigation.resolve({ draftId: "draft" as DraftId, threadId: ThreadId.make("local") });
  await action;
  expect(prompts).toEqual(["Attributed quote"]);
  let creations = 0;
  await continueSharedConversation({
    isCurrent: async () => false,
    createDraft: async () => {
      creations++;
      return null;
    },
    isDestinationCurrent: () => true,
    writeQuote: () => prompts.push("Stale"),
  });
  expect(creations).toBe(0);
  expect(prompts).toHaveLength(1);
});
