import { expect, it } from "@effect/vitest";
import { admitsNewBlobs, TEAM_BLOB_LIMIT } from "./TeamRepository.ts";

it("admits a blob only while the repository stays within the cap, and still admits cleanup", () => {
  expect(TEAM_BLOB_LIMIT).toBe(50_000);
  expect(admitsNewBlobs(49_999, 1)).toBe(true);
  expect(admitsNewBlobs(50_000, 1)).toBe(false);
  expect(admitsNewBlobs(50_001, 1)).toBe(false);
  expect(admitsNewBlobs(50_001, 0)).toBe(true);
  expect(admitsNewBlobs(50_000, 0)).toBe(true);
});
