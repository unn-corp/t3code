import {
  DesktopPreviewAnnotationSnapshotSchema,
  PreviewAnnotationPayloadSchema,
  ScopedThreadRef,
  type DesktopPreviewAnnotationSnapshot,
  type PreviewAnnotationPayload,
} from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import * as Schema from "effect/Schema";
import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import type { ComposerImageAttachment } from "./composerDraftStore";
import { randomUUID } from "./lib/utils";
import { createAnnotationDraftStorage } from "./lib/annotationDraftStorage";

const SessionBase = Schema.Struct({
  id: Schema.String,
  threadRef: ScopedThreadRef,
  tabId: Schema.String,
});
const SessionSchema = Schema.Union([
  Schema.Struct({ ...SessionBase.fields, status: Schema.Literal("capturing") }),
  Schema.Struct({ ...SessionBase.fields, status: Schema.Literal("error"), error: Schema.String }),
  Schema.Struct({
    ...SessionBase.fields,
    status: Schema.Literal("ready"),
    snapshot: DesktopPreviewAnnotationSnapshotSchema,
    annotation: PreviewAnnotationPayloadSchema,
  }),
]);
export type PreviewAnnotationEditorSession = typeof SessionSchema.Type;
const isSession = Schema.is(SessionSchema);
export type PreviewAnnotationSender = (
  annotation: PreviewAnnotationPayload,
  image: ComposerImageAttachment | null,
) => void;

interface EditorState {
  session: PreviewAnnotationEditorSession | null;
  hydrated: boolean;
  begin: (threadRef: ScopedThreadRef, tabId: string) => string | null;
  complete: (id: string, snapshot: DesktopPreviewAnnotationSnapshot) => void;
  fail: (id: string, error: string) => void;
  update: (
    id: string,
    update: (annotation: PreviewAnnotationPayload) => PreviewAnnotationPayload,
  ) => void;
  discard: (id: string, approved: boolean) => void;
  finish: (id: string) => void;
}

export function createPreviewAnnotationEditorStore(
  storage: StateStorage = createAnnotationDraftStorage(),
) {
  return create<EditorState>()(
    persist(
      (set, get) => ({
        session: null,
        hydrated: false,
        begin: (threadRef, tabId) => {
          if (!get().hydrated || get().session) return null;
          const id = randomUUID();
          set({ session: { id, threadRef, tabId, status: "capturing" } });
          return id;
        },
        complete: (id, snapshot) => {
          const session = get().session;
          if (!session || session.id !== id || session.status !== "capturing") return;
          set({
            session: {
              ...session,
              status: "ready",
              snapshot,
              annotation: {
                id,
                pageUrl: snapshot.pageUrl,
                pageTitle: snapshot.pageTitle,
                createdAt: snapshot.createdAt,
                screenshot: snapshot.screenshot,
                comment: "",
                elements: [],
                regions: [],
                strokes: [],
                styleChanges: [],
              },
            },
          });
        },
        fail: (id, error) => {
          const session = get().session;
          if (session?.id === id && session.status === "capturing")
            set({ session: { ...session, status: "error", error } });
        },
        update: (id, update) => {
          const session = get().session;
          if (session?.id === id && session.status === "ready")
            set({ session: { ...session, annotation: update(session.annotation) } });
        },
        discard: (id, approved) => {
          if (approved && get().session?.id === id) set({ session: null });
        },
        finish: (id) => {
          if (get().session?.id === id) set({ session: null });
        },
      }),
      {
        name: "t3code:preview-annotation-editor:v1",
        storage: createJSONStorage(() => storage),
        partialize: ({ session }) => ({ session }),
        merge: (persisted: unknown, current) => {
          if (
            typeof persisted !== "object" ||
            persisted === null ||
            !("session" in persisted) ||
            !isSession(persisted.session)
          )
            return current;
          const session = persisted.session;
          return {
            ...current,
            session:
              session.status === "capturing"
                ? {
                    ...session,
                    status: "error",
                    error:
                      "Capture was interrupted. Close this annotation and capture the page again.",
                  }
                : session,
          };
        },
        onRehydrateStorage: (initial) => (state) => {
          (state ?? initial).hydrated = true;
        },
      },
    ),
  );
}

export const usePreviewAnnotationEditorStore = createPreviewAnnotationEditorStore();

export const usePreviewAnnotationSenders = create<{
  senders: ReadonlyMap<string, PreviewAnnotationSender>;
}>(() => ({ senders: new Map() }));

export function registerPreviewAnnotationSender(
  threadRef: ScopedThreadRef,
  sender: PreviewAnnotationSender,
): () => void {
  const key = scopedThreadKey(threadRef);
  const store = usePreviewAnnotationSenders;
  store.setState((state) => ({ senders: new Map([...state.senders, [key, sender]]) }));
  return () => {
    if (store.getState().senders.get(key) !== sender) return;
    store.setState((state) => {
      const senders = new Map(state.senders);
      senders.delete(key);
      return { senders };
    });
  };
}
