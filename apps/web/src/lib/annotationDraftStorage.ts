import type { StateStorage } from "zustand/middleware";
import { toastManager } from "~/components/ui/toast";
import { createMemoryStorage } from "./storage";

/** Screenshots live in IndexedDB rather than competing with chat drafts for localStorage quota. */
export function createAnnotationDraftStorage(): StateStorage {
  const fallback = createMemoryStorage();
  let warned = false;
  const warn = () => {
    if (warned) return;
    warned = true;
    toastManager.add({
      type: "warning",
      title: "Annotation could not be saved to this device",
      description: "Keep the app open. Your annotation is still available in this session.",
    });
  };
  let database: Promise<IDBDatabase> | null = null;
  const open = () => {
    database ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("t3code-annotation-drafts", 1);
      request.addEventListener("upgradeneeded", () => request.result.createObjectStore("drafts"), {
        once: true,
      });
      request.addEventListener("success", () => resolve(request.result), { once: true });
      request.addEventListener("error", () => reject(request.error), { once: true });
      request.addEventListener(
        "blocked",
        () => reject(new Error("Annotation storage is blocked")),
        { once: true },
      );
    });
    return database;
  };
  const transact = async (
    mode: IDBTransactionMode,
    name: string,
    value?: string,
  ): Promise<string | null> => {
    const db = await open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction("drafts", mode);
      const store = transaction.objectStore("drafts");
      const request =
        mode === "readonly"
          ? store.get(name)
          : value === undefined
            ? store.delete(name)
            : store.put(value, name);
      transaction.addEventListener(
        "complete",
        () => resolve(typeof request.result === "string" ? request.result : null),
        { once: true },
      );
      transaction.addEventListener("error", () => reject(transaction.error), { once: true });
      transaction.addEventListener("abort", () => reject(transaction.error), { once: true });
    });
  };
  if (typeof indexedDB === "undefined") return fallback;
  return {
    getItem: async (name) => {
      try {
        return await transact("readonly", name);
      } catch {
        return fallback.getItem(name);
      }
    },
    setItem: async (name, value) => {
      fallback.setItem(name, value);
      try {
        await transact("readwrite", name, value);
      } catch {
        warn();
      }
    },
    removeItem: async (name) => {
      fallback.removeItem(name);
      try {
        await transact("readwrite", name);
      } catch {
        warn();
      }
    },
  };
}
