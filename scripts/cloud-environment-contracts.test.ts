// @effect-diagnostics nodeBuiltinImport:off - Exercise the Python bootstrap against real T3 schemas with isolated homes.
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";
import { expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { CodexSettings, ServerSettings } from "../packages/contracts/src/settings.ts";
import { DEFAULT_MODEL, DEFAULT_TEXT_GENERATION_MODEL } from "../packages/contracts/src/model.ts";
import { ProviderInstanceId } from "../packages/contracts/src/providerInstance.ts";

const decodeFixtures = Schema.decodeUnknownSync(
  Schema.Array(Schema.Struct({ owner: ProviderInstanceId, settings: ServerSettings })),
);
const decodeCodexSettings = Schema.decodeUnknownSync(CodexSettings);
const codexInstanceId = ProviderInstanceId.make("codex");

it("fresh owner selections decode into T3 settings using the current model defaults", () => {
  const output = NodeChildProcess.execFileSync(
    "python3",
    [
      "-B",
      "-c",
      `
import contextlib, importlib.util, io, json
spec = importlib.util.spec_from_file_location("cloud_tests", "scripts/cloud-environment.test.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
fixtures = []
for owner, extra in (("codex", []), ("codex_meckle", []), ("codex_work", []), ("codex_work", ["codex"])):
    fixture = module.CloudEnvironmentTests()
    fixture.setUp()
    try:
        accounts = fixture.account_manifest()
        for account in accounts["codexAccounts"]:
            account["enabled"] = True
        with contextlib.redirect_stdout(io.StringIO()):
            module.cloud.initialize(fixture.home, fixture.installer, "1.2.3", 14567, accounts=accounts, owner_account=owner, include_accounts=extra)
        fixtures.append({"owner": owner, "settings": module.cloud.read_json(fixture.home / "userdata" / "settings.json")})
    finally:
        fixture.tearDown()
print(json.dumps(fixtures))
`,
    ],
    {
      cwd: NodeURL.fileURLToPath(new URL("..", import.meta.url)),
      encoding: "utf8",
      timeout: 15_000,
    },
  );
  const fixtures = decodeFixtures(JSON.parse(output));

  expect(fixtures).toHaveLength(4);
  for (const { owner, settings } of fixtures) {
    expect(settings.defaultModelSelection).toEqual({ instanceId: owner, model: DEFAULT_MODEL });
    expect(settings.textGenerationModelSelection).toEqual({
      instanceId: owner,
      model: DEFAULT_TEXT_GENERATION_MODEL,
    });
    expect(settings.providerInstances[owner]?.enabled).toBe(true);
    expect(settings.providers.codex.enabled).toBe(
      settings.providerInstances[codexInstanceId] !== undefined,
    );
    expect(settings.providers.claudeAgent.enabled).toBe(true);
    for (const instance of Object.values(settings.providerInstances)) {
      const config = decodeCodexSettings(instance.config);
      expect(config.setupMode).toBe("managed");
      expect(config.homePath).toMatch(/\/providers\/codex\/shared$/);
      expect(config.shadowHomePath).toBe("");
    }
  }
});
