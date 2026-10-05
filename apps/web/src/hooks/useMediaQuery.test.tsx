import { act, useLayoutEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { useIsMobile, useMediaQuery } from "./useMediaQuery";

type Listener = (event: MediaQueryListEvent) => void;

let viewportWidth = 900;
let renderer: ReactTestRenderer;
let mobileValue = false;
let smallValue = false;
let matchMediaMock: ReturnType<typeof vi.fn>;
let queryLists: Array<{
  media: string;
  listeners: Set<Listener>;
  lastMatches: boolean;
}>;

function matchesQuery(query: string): boolean {
  const minWidth = query.match(/\(min-width:\s*([\d.]+)px\)/)?.[1];
  const maxWidth = query.match(/\(max-width:\s*([\d.]+)px\)/)?.[1];
  const lessThanWidth = query.match(/\(width\s*<\s*([\d.]+)px\)/)?.[1];
  return (
    (minWidth === undefined || viewportWidth >= Number(minWidth)) &&
    (maxWidth === undefined || viewportWidth <= Number(maxWidth)) &&
    (lessThanWidth === undefined || viewportWidth < Number(lessThanWidth))
  );
}

function makeMediaQueryList(query: string) {
  const listeners = new Set<Listener>();
  const list = {
    media: query,
    lastMatches: matchesQuery(query),
    get matches() {
      return matchesQuery(query);
    },
    addEventListener: vi.fn((type: string, listener: Listener) => {
      if (type === "change") listeners.add(listener);
    }),
    removeEventListener: vi.fn((type: string, listener: Listener) => {
      if (type === "change") listeners.delete(listener);
    }),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    onchange: null,
    dispatchEvent: vi.fn(() => true),
    listeners,
  };
  queryLists.push(list);
  return list as unknown as MediaQueryList & { listeners: Set<Listener> };
}

function setViewportWidth(width: number) {
  viewportWidth = width;
  for (const list of queryLists) {
    const nextMatches = matchesQuery(list.media);
    if (nextMatches === list.lastMatches) continue;
    list.lastMatches = nextMatches;
    const event = { matches: nextMatches, media: list.media } as MediaQueryListEvent;
    for (const listener of list.listeners) listener(event);
  }
}

function Probe() {
  const isMobile = useIsMobile();
  const isSmall = useMediaQuery("max-sm");
  useLayoutEffect(() => {
    mobileValue = isMobile;
    smallValue = isSmall;
  }, [isMobile, isSmall]);
  return null;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  viewportWidth = 900;
  mobileValue = false;
  smallValue = false;
  queryLists = [];
  matchMediaMock = vi.fn((query: string) => makeMediaQueryList(query));
  vi.stubGlobal("window", { matchMedia: matchMediaMock });
  act(() => {
    renderer = create(<Probe />);
  });
});

afterEach(() => {
  act(() => renderer.unmount());
  vi.unstubAllGlobals();
});

it("updates mobile layout across fractional fold, unfolded, and cover widths without remounting", () => {
  expect(mobileValue).toBe(false);

  act(() => setViewportWidth(671.2));
  expect(mobileValue).toBe(true);

  act(() => setViewportWidth(672));
  expect(mobileValue).toBe(false);

  act(() => setViewportWidth(416));
  expect(mobileValue).toBe(true);
});

it("keeps the small-screen breakpoint continuous at a fractional CSS width", () => {
  act(() => setViewportWidth(639.2));
  expect(smallValue).toBe(true);

  act(() => setViewportWidth(640));
  expect(smallValue).toBe(false);
});
