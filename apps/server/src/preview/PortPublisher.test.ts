import { expect, it } from "@effect/vitest";

import {
  FIRST_PUBLISH_SERVE_PORT,
  LAST_PUBLISH_SERVE_PORT,
  nextServePort,
} from "./PortPublisher.ts";

it("allocates the lowest free serve port", () => {
  expect(nextServePort(new Set())).toBe(FIRST_PUBLISH_SERVE_PORT);
  expect(nextServePort(new Set([FIRST_PUBLISH_SERVE_PORT]))).toBe(FIRST_PUBLISH_SERVE_PORT + 1);
});

it("never hands back a port something else is already serving on", () => {
  // 443 is the tailnet default and carries the environment itself; 8443 is
  // pairing. Publishing over either would take down the way in.
  const everything = new Set<number>();
  for (let port = FIRST_PUBLISH_SERVE_PORT; port <= LAST_PUBLISH_SERVE_PORT; port += 1) {
    const allocated = nextServePort(everything);
    if (allocated === null) break;
    expect(allocated).not.toBe(443);
    expect(allocated).not.toBe(8443);
    everything.add(allocated);
  }
  expect(everything.size).toBeGreaterThan(0);
});

it("reports exhaustion rather than allocating outside its range", () => {
  const taken = new Set<number>();
  for (let port = FIRST_PUBLISH_SERVE_PORT; port <= LAST_PUBLISH_SERVE_PORT; port += 1) {
    taken.add(port);
  }
  expect(nextServePort(taken)).toBeNull();
});
