import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { reorderProjects, type UiState } from "../uiStateStore";
import { startSidebarRepositoryDrag } from "./Sidebar.repositoryDrag";
import type { SidebarPointerSensor } from "./Sidebar.pointer";

class TestDocument extends EventTarget {
  hidden = false;
  getSelection = () => ({ removeAllRanges() {} });
}

let document: TestDocument;
let window: EventTarget;
let sensor: SidebarPointerSensor | null;
const members = { a: ["laptop:/a", "deck:/a"], b: ["laptop:/b"], c: ["deck:/c"] };
type Group = keyof typeof members;

function pointer(type: string, values: Partial<PointerEvent> = {}) {
  return Object.assign(new Event(type, { cancelable: true }), {
    pointerId: 1,
    pointerType: "mouse",
    isPrimary: true,
    button: 0,
    buttons: 1,
    clientX: 10,
    clientY: 10,
    ...values,
  }) as PointerEvent;
}

function gesture(
  pointerType = "mouse",
  values: Partial<PointerEvent> = {},
  scrollElement?: HTMLElement,
) {
  let state: UiState = {
    projectExpandedById: {},
    projectOrder: Object.values(members).flat(),
    threadOrder: [],
    sidebarProjectScopeKey: null,
    threadLastVisitedAtById: {},
    threadChangedFilesExpandedById: {},
    defaultAdvertisedEndpointKey: null,
    pullRequestMergeMethod: "merge",
  };
  const onFinish = vi.fn();
  // Regions represent a source header, a destination's conversation body,
  // another header, and the area outside the sidebar.
  sensor = startSidebarRepositoryDrag(pointer("pointerdown", { pointerType, ...values }), {
    sourceKey: "a",
    targetAt: ({ y }) => {
      const contentY = y + (scrollElement?.scrollTop ?? 0);
      return contentY < 30 ? "a" : contentY < 100 ? "b" : contentY < 200 ? "c" : null;
    },
    scrollElement,
    onStart: vi.fn(),
    onTarget: vi.fn(),
    onFinish,
    onDrop: (source, target) => {
      state = reorderProjects(
        state,
        state.projectOrder,
        members[source as Group],
        members[target as Group],
      );
    },
  });
  return { order: () => state.projectOrder, onFinish };
}

beforeEach(() => {
  document = new TestDocument();
  window = new EventTarget();
  sensor = null;
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", window);
});
afterEach(() => {
  sensor?.cancel();
  vi.unstubAllGlobals();
});

describe("repository group gestures", () => {
  function scrollFixture() {
    let id = 0;
    let scrollTop = 0;
    const frames = new Map<number, FrameRequestCallback>();
    const element = {
      ownerDocument: {
        defaultView: {
          requestAnimationFrame: (callback: FrameRequestCallback) => {
            frames.set(++id, callback);
            return id;
          },
          cancelAnimationFrame: (frame: number) => frames.delete(frame),
        },
      },
      getBoundingClientRect: () => ({ left: 0, right: 100, top: 0, bottom: 100, height: 100 }),
      get scrollTop() {
        return scrollTop;
      },
      set scrollTop(value: number) {
        scrollTop = Math.max(0, Math.min(200, value));
      },
    } as unknown as HTMLElement;
    return {
      element,
      frames,
      step: (time: number) => {
        const callbacks = [...frames.values()];
        frames.clear();
        for (const callback of callbacks) callback(time);
      },
    };
  }

  it("scrolls a stationary edge gesture to the new destination and stops after release", () => {
    const scroll = scrollFixture();
    const drag = gesture("touch", {}, scroll.element);
    document.dispatchEvent(pointer("pointermove", { pointerType: "touch", clientY: 80 }));
    scroll.step(16);
    scroll.step(32);
    expect(scroll.element.scrollTop).toBe(24);
    document.dispatchEvent(pointer("pointerup", { clientY: 80, buttons: 0 }));
    expect(drag.order()).toEqual(["laptop:/b", "deck:/c", "laptop:/a", "deck:/a"]);
    expect(scroll.frames.size).toBe(0);
  });

  it("does not keep repainting at the scroll limit and cancels a queued scroll", () => {
    const scroll = scrollFixture();
    scroll.element.scrollTop = 200;
    gesture("mouse", {}, scroll.element);
    document.dispatchEvent(pointer("pointermove", { clientY: 80 }));
    scroll.step(16);
    expect(scroll.frames.size).toBe(0);
    document.dispatchEvent(pointer("pointermove", { clientY: 20 }));
    expect(scroll.frames.size).toBe(1);
    sensor?.cancel();
    expect(scroll.frames.size).toBe(0);
    scroll.step(32);
    expect(scroll.element.scrollTop).toBe(200);
  });

  it.each(["mouse", "touch", "pen"])(
    "moves all physical members together with %s",
    (pointerType) => {
      const drag = gesture(pointerType);
      document.dispatchEvent(pointer("pointermove", { pointerType, clientY: 80 }));
      document.dispatchEvent(pointer("pointerup", { pointerType, clientY: 80, buttons: 0 }));
      expect(drag.order()).toEqual(["laptop:/b", "laptop:/a", "deck:/a", "deck:/c"]);
      expect(drag.onFinish).toHaveBeenCalledOnce();
      const click = new Event("click");
      const propagation = vi.spyOn(click, "stopPropagation");
      document.dispatchEvent(click);
      expect(propagation).toHaveBeenCalledOnce();
    },
  );

  it("uses the release position when the last move did not reach its destination", () => {
    const drag = gesture();
    document.dispatchEvent(pointer("pointermove", { clientY: 80 }));
    document.dispatchEvent(pointer("pointerup", { clientY: 150, buttons: 0 }));
    expect(drag.order()).toEqual(["laptop:/b", "deck:/c", "laptop:/a", "deck:/a"]);
  });

  it.each([10, 250])("does not save a stale hover when released at y=%s", (clientY) => {
    const drag = gesture();
    document.dispatchEvent(pointer("pointermove", { clientY: 80 }));
    document.dispatchEvent(pointer("pointerup", { clientY, buttons: 0 }));
    expect(drag.order()).toEqual(Object.values(members).flat());
  });

  const interruptions = {
    escape: () => document.dispatchEvent(Object.assign(new Event("keydown"), { code: "Escape" })),
    resize: () => window.dispatchEvent(new Event("resize")),
    pointercancel: () => document.dispatchEvent(pointer("pointercancel")),
    unmount: () => sensor?.cancel(),
  };
  it.each(Object.entries(interruptions))(
    "keeps the saved order on %s, including a late release",
    (_name, interrupt) => {
      const drag = gesture();
      document.dispatchEvent(pointer("pointermove", { clientY: 80 }));
      interrupt();
      document.dispatchEvent(pointer("pointerup", { clientY: 150, buttons: 0 }));
      expect(drag.order()).toEqual(Object.values(members).flat());
      expect(drag.onFinish).toHaveBeenCalledOnce();
    },
  );

  it("leaves ordinary clicks unsuppressed and does not reorder", () => {
    const drag = gesture();
    document.dispatchEvent(pointer("pointermove", { clientY: 16 }));
    document.dispatchEvent(pointer("pointerup", { clientY: 80, buttons: 0 }));
    expect(drag.order()).toEqual(Object.values(members).flat());
    const click = new Event("click");
    const propagation = vi.spyOn(click, "stopPropagation");
    document.dispatchEvent(click);
    expect(propagation).not.toHaveBeenCalled();
  });

  it.each([{ button: 2 }, { isPrimary: false }])("ignores an ineligible pointer %j", (values) => {
    const drag = gesture("mouse", values);
    expect(sensor).toBeNull();
    document.dispatchEvent(pointer("pointermove", { clientY: 80 }));
    document.dispatchEvent(pointer("pointerup", { clientY: 80, buttons: 0 }));
    expect(drag.order()).toEqual(Object.values(members).flat());
  });
});
