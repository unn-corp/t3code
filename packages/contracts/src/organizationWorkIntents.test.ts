import { assert, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import {
  OrganizationWorkIntentListInput,
  OrganizationWorkIntentListResult,
} from "./organizationWorkIntents.ts";

const decodePage = Schema.decodeUnknownSync(OrganizationWorkIntentListResult);

it("bounds work intent pages and requires an Organization scope", () => {
  const decode = Schema.decodeUnknownSync(OrganizationWorkIntentListInput);
  assert.equal(decode({ organizationId: "org-a", afterIntentId: null, limit: 100 }).limit, 100);
  assert.throws(() => decode({ organizationId: "org-a", afterIntentId: null, limit: 101 }));
  assert.throws(() => decode({ organizationId: "org-a", afterIntentId: null, limit: 0 }));
  assert.throws(() => decode({ organizationId: "", afterIntentId: null, limit: 10 }));
  assert.throws(() =>
    decode({ organizationId: "org-a", afterIntentId: "x".repeat(161), limit: 10 }),
  );
  assert.deepEqual(
    decodePage({
      intents: [],
      nextCursor: null,
    }),
    { intents: [], nextCursor: null },
  );
});
