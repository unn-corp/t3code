// @effect-diagnostics nodeBuiltinImport:off globalDate:off - these tests parse workflow files and run their shell steps for real.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { assert, describe, it } from "@effect/vitest";
import { ARTIFACT_DIRS } from "./fork-release-assets.ts";
import { RECOVERY_HELPER_ASSETS } from "./fork-release-helper.ts";
import { PACKAGE_VALIDATION, requiredSuiteRuns } from "./fork-release-suites.ts";

const REPO = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
// `yaml` is a dependency of packages/shared, which scripts already depends on.
const YAML = NodeModule.createRequire(NodePath.join(REPO, "packages/shared/package.json"))(
  "yaml",
) as {
  parse: (text: string) => unknown;
};

interface Step {
  readonly name?: string;
  readonly id?: string;
  readonly if?: string;
  readonly uses?: string;
  readonly run?: string;
  readonly "working-directory"?: string;
  readonly env?: Record<string, string>;
  readonly with?: Record<string, unknown>;
}
interface Job {
  readonly name?: string;
  readonly needs?: string | string[];
  readonly if?: string;
  readonly uses?: string;
  readonly "runs-on"?: string;
  readonly permissions?: Record<string, string>;
  readonly secrets?: Record<string, string>;
  readonly with?: Record<string, unknown>;
  readonly strategy?: { matrix?: { include?: Array<Record<string, string>> } };
  readonly steps?: Step[];
}
interface Workflow {
  readonly on: Record<string, unknown>;
  readonly concurrency: {
    group: string;
    queue?: string;
    "cancel-in-progress": boolean;
  };
  readonly permissions: Record<string, string>;
  readonly jobs: Record<string, Job>;
}

const load = (name: string): Workflow =>
  YAML.parse(
    NodeFS.readFileSync(NodePath.join(REPO, ".github/workflows", name), "utf8"),
  ) as Workflow;
const text = (name: string) =>
  NodeFS.readFileSync(NodePath.join(REPO, ".github/workflows", name), "utf8");
const release = load("fork-release.yml");
const withdraw = load("fork-release-withdraw.yml");
const desktop = load("release-desktop.yml");
const needsOf = (job: Job): string[] =>
  job.needs === undefined ? [] : Array.isArray(job.needs) ? job.needs : [job.needs];
const jobText = (job: Job) => JSON.stringify(job);
const stepNamed = (job: Job, name: string): Step => {
  const step = job.steps?.find((entry) => entry.name === name);
  if (!step) throw new Error(`No step ${name}`);
  return step;
};

describe("fork-release.yml structure", () => {
  it("resolves every Vite+ version file from a checkout present before setup", () => {
    for (const [name, job] of Object.entries(release.jobs)) {
      const roots: string[] = [];
      for (const step of job.steps ?? []) {
        if (step.uses?.startsWith("actions/checkout")) roots.push(String(step.with?.path ?? "."));
        if (!step.uses?.startsWith("voidzero-dev/setup-vp")) continue;
        const file = String(step.with?.["node-version-file"] ?? "");
        const root = roots.find((entry) => entry === "." || file.startsWith(`${entry}/`));
        assert.isDefined(root, `${name}: ${file} has no checkout before setup`);
        const relative = root === "." ? file : file.slice(root!.length + 1);
        assert.isTrue(
          NodeFS.existsSync(NodePath.join(REPO, relative)),
          `${name}: ${file} is absent from its checkout`,
        );
      }
    }
  });

  it("runs nightly daily at 07:23 UTC and stable Sundays at 08:23 UTC", () => {
    const schedule = (release.on.schedule as Array<{ cron: string }>).map((entry) => entry.cron);
    assert.deepStrictEqual(schedule, ["23 7 * * *", "23 8 * * 0"]);
  });

  it("serializes releases without cancelling a publisher, and keeps queued runs", () => {
    assert.deepStrictEqual(release.concurrency, {
      group: "fork-release",
      "cancel-in-progress": false,
      queue: "max",
    });
    assert.notEqual(withdraw.concurrency.group, release.concurrency.group);
  });

  it("forms an acyclic graph rooted at the plan, and every other job refuses to run on a skipped plan", () => {
    const names = Object.keys(release.jobs);
    for (const [name, job] of Object.entries(release.jobs)) {
      for (const need of needsOf(job))
        assert.include(names, need, `${name} needs unknown job ${need}`);
    }
    const reaches = (from: string, target: string, seen = new Set<string>()): boolean => {
      if (from === target) return true;
      if (seen.has(from)) return false;
      seen.add(from);
      return needsOf(release.jobs[from]!).some((need) => reaches(need, target, seen));
    };
    for (const name of names.filter((entry) => entry !== "plan")) {
      assert.isTrue(reaches(name, "plan"), `${name} does not depend on plan`);
      assert.include(
        release.jobs[name]!.if ?? "",
        "needs.plan.outputs.skip == 'false'",
        `${name} ignores a skipped plan`,
      );
      assert.isFalse(reaches("plan", name), `${name} forms a cycle`);
    }
  });

  it("publishes only after the manifest, which only follows validation and assembly", () => {
    assert.deepStrictEqual(needsOf(release.jobs.publish!).toSorted(), ["manifest", "plan"]);
    assert.isTrue(needsOf(release.jobs.manifest!).includes("validate"));
    assert.isTrue(needsOf(release.jobs.validate!).includes("assemble"));
    for (const build of [
      "desktop_linux_x64",
      "desktop_win_x64",
      "android",
      "android_recovery_extras",
      "recovery_helper",
    ]) {
      assert.isTrue(
        needsOf(release.jobs.assemble!).includes(build),
        `assemble must wait for ${build}`,
      );
    }
    assert.include(release.jobs.publish!.if ?? "", "needs.plan.outputs.publish == 'true'");
  });

  it("limits write access to Android code reservation and publication", () => {
    assert.deepStrictEqual(release.permissions, { contents: "read" });
    const writers = Object.entries(release.jobs)
      .filter(([, job]) => Object.values(job.permissions ?? {}).includes("write"))
      .map(([name]) => name)
      .toSorted();
    assert.deepStrictEqual(writers, ["publish", "reserve_android_codes"]);
    for (const job of [...Object.values(release.jobs), ...Object.values(withdraw.jobs)]) {
      assert.notProperty(job.permissions ?? {}, "id-token");
    }
  });

  it("confines secrets to the jobs that need them", () => {
    const secretsIn = (job: Job) =>
      [...jobText(job).matchAll(/secrets\.([A-Z0-9_]+)/g)].map((match) => match[1]!);
    const allowed: Record<string, RegExp> = {
      android: /^FORK_ANDROID_/,
      android_recovery_extras: /^FORK_ANDROID_/,
      desktop_win_x64: /^AZURE_/,
    };
    for (const [name, job] of Object.entries(release.jobs)) {
      for (const secret of secretsIn(job)) {
        assert.isTrue(allowed[name]?.test(secret) ?? false, `${name} reads secret ${secret}`);
      }
    }
    assert.isAbove(secretsIn(release.jobs.android!).length, 0);
    assert.isTrue(
      secretsIn(release.jobs.android!).every((secret) => secret.startsWith("FORK_ANDROID_")),
    );
  });

  it("pins every third-party action to a full commit SHA and uses only GitHub-hosted runners", () => {
    for (const file of ["fork-release.yml", "fork-release-withdraw.yml"]) {
      for (const match of text(file).matchAll(/uses: ([^\s]+)/g)) {
        const target = match[1]!;
        if (target.startsWith("./")) continue;
        assert.match(target, /@[0-9a-f]{40}$/, `${file}: ${target} is not pinned`);
      }
      assert.notMatch(text(file), /blacksmith|self-hosted/);
    }
    const runners = Object.values(release.jobs).flatMap((job) => [
      job["runs-on"],
      ...(Array.isArray(job.strategy?.matrix?.include)
        ? job.strategy!.matrix!.include!.map((entry) => entry.runner)
        : []),
    ]);
    for (const runner of runners.filter(
      (entry): entry is string => typeof entry === "string" && !entry.includes("${{"),
    )) {
      assert.match(runner, /^(ubuntu-24\.04|windows-2025)$/);
    }
  });

  it("builds no production targets and never reaches npm, relay, web hosting, AUR, or announcements", () => {
    // Comments may name the targets this workflow stays away from; only executable content counts.
    assert.notMatch(
      JSON.stringify(release.jobs),
      /npm publish|vercel|alchemy|publish-aur|announce|discord|deploy/i,
    );
    const publishes = Object.entries(release.jobs).filter(([, job]) =>
      jobText(job).includes("softprops/action-gh-release"),
    );
    assert.deepStrictEqual(publishes, []);
  });
});

const hasBash = NodeChildProcess.spawnSync("bash", ["-c", "true"]).status === 0;

describe("fork-release.yml gating", () => {
  const intent = stepNamed(release.jobs.plan!, "Resolve channel and intent");
  const bash = (env: Record<string, string>) => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-intent-"));
    try {
      const output = NodePath.join(dir, "out");
      NodeFS.writeFileSync(output, "");
      const result = NodeChildProcess.spawnSync("bash", ["-c", intent.run!], {
        encoding: "utf8",
        env: {
          PATH: process.env.PATH ?? "",
          INPUT_COMMIT: "",
          INPUT_CHANNEL: "",
          INPUT_PUBLISH: "",
          INPUT_COMMISSION: "",
          SCHEDULE: "",
          ...env,
          GITHUB_OUTPUT: output,
        },
      });
      const outputs = Object.fromEntries(
        NodeFS.readFileSync(output, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => line.split("=") as [string, string]),
      );
      return { status: result.status, outputs, stderr: result.stderr };
    } finally {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  };

  it.skipIf(!hasBash)(
    "maps the two cron entries to channels and publishes only when enabled",
    () => {
      const nightly = bash({
        EVENT: "schedule",
        SCHEDULE: "23 7 * * *",
        ENABLED: "true",
      });
      assert.deepStrictEqual(
        [nightly.status, nightly.outputs.channel, nightly.outputs.publish],
        [0, "nightly", "true"],
      );
      const stable = bash({
        EVENT: "schedule",
        SCHEDULE: "23 8 * * 0",
        ENABLED: "true",
      });
      assert.deepStrictEqual([stable.outputs.channel, stable.outputs.publish], ["stable", "true"]);
      assert.equal(
        bash({ EVENT: "schedule", SCHEDULE: "23 7 * * *", ENABLED: "" }).outputs.publish,
        "false",
      );
    },
  );

  it.skipIf(!hasBash)("never publishes a manual run unless asked and enabled", () => {
    const base = { EVENT: "workflow_dispatch", INPUT_CHANNEL: "nightly" };
    assert.equal(
      bash({ ...base, INPUT_PUBLISH: "false", ENABLED: "true" }).outputs.publish,
      "false",
    );
    assert.equal(bash({ ...base, INPUT_PUBLISH: "true", ENABLED: "" }).outputs.publish, "false");
    assert.equal(
      bash({ ...base, INPUT_PUBLISH: "true", ENABLED: "false" }).outputs.publish,
      "false",
    );
    assert.equal(bash({ ...base, INPUT_PUBLISH: "true", ENABLED: "true" }).outputs.publish, "true");
    assert.equal(
      bash({
        ...base,
        INPUT_PUBLISH: "true",
        INPUT_COMMISSION: "false",
        ENABLED: "false",
      }).outputs.publish,
      "false",
    );
  });

  it.skipIf(!hasBash)(
    "allows explicit manual nightly commissioning without enabling schedules",
    () => {
      const base = {
        EVENT: "workflow_dispatch",
        INPUT_CHANNEL: "nightly",
        INPUT_PUBLISH: "true",
        INPUT_COMMISSION: "true",
        ENABLED: "false",
      };
      const manual = bash(base);
      assert.equal(manual.status, 0);
      assert.equal(manual.outputs.publish, "true");
      assert.equal(bash({ ...base, INPUT_PUBLISH: "false" }).status, 1);
      assert.equal(bash({ ...base, INPUT_CHANNEL: "stable" }).status, 1);
      assert.equal(bash({ ...base, ENABLED: "true" }).status, 1);
      assert.equal(bash({ ...base, EVENT: "schedule", SCHEDULE: "23 7 * * *" }).status, 1);
      assert.equal(bash({ ...base, EVENT: "push" }).status, 1);
    },
  );

  it.skipIf(!hasBash)("rejects a commit input on a stable run", () => {
    const result = bash({
      EVENT: "workflow_dispatch",
      INPUT_CHANNEL: "stable",
      INPUT_COMMIT: "a".repeat(40),
      INPUT_PUBLISH: "false",
      ENABLED: "true",
    });
    assert.equal(result.status, 1);
    assert.include(result.stderr, "takes no commit input");
  });

  it("skips scheduled runs until commissioned and never runs off main or off this repository", () => {
    const condition = release.jobs.plan!.if ?? "";
    assert.include(condition, "github.repository == 'unn-corp/t3code'");
    assert.include(condition, "github.ref == 'refs/heads/main'");
    assert.match(
      condition,
      /github\.event_name != 'schedule' \|\| vars\.FORK_RELEASES_ENABLED == 'true'/,
    );
    assert.include(withdraw.jobs.withdrawal!.if ?? "", "github.ref == 'refs/heads/main'");
  });

  it("builds from the pinned commit and verifies the checkout is exactly that commit", () => {
    for (const name of ["build_bundle", "android", "recovery_helper"]) {
      const job = release.jobs[name]!;
      const confirm = job.steps!.filter((step) => step.name?.startsWith("Confirm"));
      assert.isAbove(confirm.length, 0, `${name} never confirms its checkout`);
      for (const step of confirm)
        assert.match(step.env!.EXPECTED!, /needs\.plan\.outputs\.(predecessor_)?commit/);
    }
    for (const name of ["desktop_linux_x64", "desktop_win_x64"]) {
      assert.equal(release.jobs[name]!.with!.ref, "${{ needs.plan.outputs.commit }}");
    }
  });

  it("passes only the explicit dispatch commissioning input into nightly planning", () => {
    const plan = stepNamed(release.jobs.plan!, "Plan");
    assert.equal(plan.env!.COMMISSION, "${{ inputs.commission }}");
    assert.include(plan.run!, "--commission");
    const intent = stepNamed(release.jobs.plan!, "Resolve channel and intent");
    assert.include(intent.run!, "Commissioning requires an explicit manual nightly publish");
    assert.include(intent.run!, '"$ENABLED" != "true"');
  });
});

describe("reusable desktop workflow contract", () => {
  const callee = (
    desktop.on as {
      workflow_call: {
        inputs: Record<string, { required?: boolean; default?: unknown }>;
        secrets: Record<string, unknown>;
      };
    }
  ).workflow_call;

  it("keeps failed Windows smoke archives out of release assembly", () => {
    const job = Object.values(desktop.jobs).find((entry) =>
      entry.steps?.some((step) => step.name === "Smoke-test CLI archive"),
    )!;
    assert.equal(stepNamed(job, "Smoke-test CLI archive").id, "cli_smoke");
    const diagnostic = stepNamed(job, "Upload failed Windows CLI for diagnosis");
    assert.include(diagnostic.if!, "failure()");
    assert.include(diagnostic.if!, "steps.cli_smoke.outcome == 'failure'");
    assert.include(diagnostic.if!, "github.repository == 'unn-corp/t3code'");
    assert.equal(diagnostic.with!.name, "diagnostic-cli-win-${{ inputs.arch }}");
    assert.equal(diagnostic.with!["retention-days"], 1);
    assert.notInclude(Object.values(ARTIFACT_DIRS), "diagnostic-cli-win-x64");
    const normal = stepNamed(job, "Upload CLI archive");
    assert.notInclude(normal.if!, "failure()");
    assert.notInclude(normal.if!, "always()");
  });

  it("receives every required input and nothing the callee does not declare", () => {
    for (const name of ["desktop_linux_x64", "desktop_win_x64"]) {
      const given = Object.keys(release.jobs[name]!.with ?? {});
      for (const key of given)
        assert.property(callee.inputs, key, `${name} passes unknown input ${key}`);
      for (const [input, spec] of Object.entries(callee.inputs)) {
        if (spec.required === true)
          assert.include(given, input, `${name} omits required input ${input}`);
      }
    }
  });

  it("needs no relay or Clerk configuration and records no tracing", () => {
    for (const input of [
      "clerk_publishable_key",
      "clerk_jwt_template",
      "clerk_cli_oauth_client_id",
      "relay_url",
    ]) {
      assert.notEqual(callee.inputs[input]!.required, true, `${input} must be optional`);
      assert.equal(callee.inputs[input]!.default, "");
    }
    for (const name of ["desktop_linux_x64", "desktop_win_x64"]) {
      assert.equal(release.jobs[name]!.with!.relay_client_tracing, false);
      assert.notProperty(release.jobs[name]!.with!, "clerk_publishable_key");
    }
  });

  it("passes only declared secrets, and only the optional Windows signing set", () => {
    assert.isUndefined(release.jobs.desktop_linux_x64!.secrets);
    for (const secret of Object.keys(release.jobs.desktop_win_x64!.secrets!)) {
      assert.property(callee.secrets, secret);
      assert.match(secret, /^AZURE_/);
    }
  });

  it("builds Linux with AppImage and Windows with NSIS, each with its server archive", () => {
    const linux = release.jobs.desktop_linux_x64!.with!;
    const windows = release.jobs.desktop_win_x64!.with!;
    assert.deepStrictEqual(
      [linux.platform, linux.target, linux.arch, linux.cli_archive],
      ["linux", "AppImage", "x64", true],
    );
    assert.deepStrictEqual(
      [windows.platform, windows.target, windows.arch, windows.cli_archive],
      ["win", "nsis", "x64", true],
    );
    // The Windows job waits for the Linux job by name to embed its archive as the WSL runtime.
    assert.isTrue(release.jobs.desktop_linux_x64!.name!.endsWith("Linux x64"));
    assert.equal(linux.label, "Linux x64");
  });
});

describe("artifact and CLI agreement", () => {
  // Names the called workflow uploads, evaluated for the platform and arch each caller passes.
  const calleeUploads = (): string[] => {
    const names: string[] = [];
    for (const key of ["desktop_linux_x64", "desktop_win_x64"]) {
      const inputs = release.jobs[key]!.with as Record<string, string>;
      for (const step of desktop.jobs.build!.steps!) {
        const name = step.with?.name;
        if (step.uses?.startsWith("actions/upload-artifact") && typeof name === "string") {
          const rendered = name
            .replaceAll("${{ inputs.platform }}", inputs.platform!)
            .replaceAll("${{ inputs.arch }}", inputs.arch!);
          const condition = step.if ?? "";
          if (condition.includes("inputs.platform == 'win'") && inputs.platform !== "win") continue;
          if (
            condition.includes("inputs.cli_archive") &&
            inputs.cli_archive !== (true as unknown as string)
          )
            continue;
          names.push(rendered);
        }
      }
    }
    return names;
  };
  const ownUploads = (): string[] => {
    const names: string[] = [];
    for (const job of Object.values(release.jobs)) {
      const platforms = Array.isArray(job.strategy?.matrix?.include)
        ? job.strategy!.matrix!.include!.map((entry) => entry.platform)
        : [];
      for (const step of job.steps ?? []) {
        const name = step.with?.name;
        if (!step.uses?.startsWith("actions/upload-artifact") || typeof name !== "string") continue;
        if (name.includes("${{ matrix.platform }}"))
          names.push(
            ...platforms.map((platform) => name.replace("${{ matrix.platform }}", platform!)),
          );
        else names.push(name);
      }
    }
    return names;
  };

  it("uploads every directory the assembler reads, under the names it downloads", () => {
    const uploaded = new Set([...calleeUploads(), ...ownUploads()]);
    for (const dir of Object.values(ARTIFACT_DIRS))
      assert.isTrue(uploaded.has(dir), `no job uploads ${dir}`);
    const assemble = release.jobs.assemble!.steps!;
    assert.isTrue(
      assemble.some((step) => step.with?.pattern === "android-recovery-extra-*"),
      "assemble downloads all additional recovery APKs",
    );
    assert.isTrue(
      assemble.some((step) => step.with?.name === "android-code-allocation"),
      "assemble verifies exact codes against the uploaded durable reservation",
    );
    for (const step of assemble.filter((entry) =>
      entry.uses?.startsWith("actions/download-artifact"),
    )) {
      const name = step.with?.name as string | undefined;
      if (name)
        assert.isTrue(
          uploaded.has(name) || name === "fork-release-plan",
          `assemble downloads ${name}, which nothing uploads`,
        );
      const into = step.with?.path as string | undefined;
      if (name && into?.startsWith("inputs/")) assert.equal(into, `inputs/${name}`);
    }
  });

  it("builds a recovery helper for exactly the platforms the coordinator-wired builder defines", () => {
    const platforms = release.jobs
      .recovery_helper!.strategy!.matrix!.include!.map((entry) => entry.platform)
      .toSorted();
    assert.deepStrictEqual(platforms, ["linux-x64", "windows-x64"]);
    assert.deepStrictEqual(
      [...new Set(RECOVERY_HELPER_ASSETS.map((asset) => asset.platform))].toSorted(),
      platforms,
    );
    // Each helper is built from the candidate's own source checkout, never the tooling checkout.
    const build = stepNamed(release.jobs.recovery_helper!, "Build recovery helper");
    assert.include(build.run!, "--workdir");
    assert.include(build.env!.WORKDIR!, "/source");
  });

  it("builds extra recovery APKs with current tooling against the exact pinned source checkout", () => {
    const job = release.jobs.android_recovery_extras!;
    const build = stepNamed(job, "Build recovery APK with current tooling");
    assert.equal(build["working-directory"], "tooling");
    assert.equal(stepNamed(job, "Setup Vite+").with?.["node-version-file"], "tooling/package.json");
    assert.equal(
      stepNamed(job, "Install current release tooling and builder")["working-directory"],
      "tooling",
    );
    assert.include(
      stepNamed(job, "Install current release tooling and builder").run!,
      "--filter=@t3tools/scripts...",
    );
    assert.equal(
      stepNamed(job, "Install pinned source dependencies")["working-directory"],
      "source",
    );
    assert.include(build.run!, 'git -C "$GITHUB_WORKSPACE/source" rev-parse HEAD');
    assert.include(build.run!, '--source-dir "$GITHUB_WORKSPACE/source"');
    assert.include(build.run!, '--normal-version-code "$NORMAL_CODE"');
    assert.include(build.run!, '--version-code "$RECOVERY_CODE"');
  });

  it("validates the three targets with the package validation defined in code, not in configuration", () => {
    const targets = release.jobs
      .validate!.strategy!.matrix!.include!.map((entry) => entry.target)
      .toSorted();
    assert.deepStrictEqual(targets, ["android", "linux-x64", "windows-x64"]);
    assert.isTrue(
      NodeFS.existsSync(NodePath.join(REPO, ".github/scripts/fork-release-receipts.sh")),
    );
    assert.isTrue(NodeFS.existsSync(NodePath.join(REPO, PACKAGE_VALIDATION.run[1])));
    assert.isFalse(
      NodeFS.existsSync(NodePath.join(REPO, ".github/scripts/fork-release-config.json")),
      "a replaceable JSON commission must not come back",
    );
  });

  it("runs every required safety suite on every target it covers, from the pinned source, and feeds the manifest", () => {
    const matrix = release.jobs
      .suites!.strategy!.matrix!.include!.map((entry) => `${entry.suite}:${entry.target}`)
      .toSorted();
    assert.deepStrictEqual(
      matrix,
      requiredSuiteRuns()
        .map((run) => `${run.suite}:${run.target}`)
        .toSorted(),
    );
    const suites = release.jobs.suites!;
    assert.deepStrictEqual(needsOf(suites).toSorted(), ["assemble", "plan"]);
    assert.equal(
      stepNamed(suites, "Checkout pinned source").with!.ref,
      "${{ needs.plan.outputs.commit }}",
    );
    assert.include(stepNamed(suites, "Run suite").run!, "--source ../source");
    assert.equal(stepNamed(suites, "Upload suite receipt").if, "always()");
    for (const need of ["validate", "suites", "assemble"]) {
      assert.include(needsOf(release.jobs.manifest!), need);
    }
    assert.equal(
      stepNamed(release.jobs.manifest!, "Download receipts").with!.pattern,
      "*receipts-*",
    );
  });

  const optionsOf = (file: string): Set<string> =>
    new Set(
      [
        ...NodeFS.readFileSync(NodePath.join(REPO, file), "utf8").matchAll(
          /^\s+"?([a-z][a-z-]*)"?: \{ type: "(?:string|boolean)"/gm,
        ),
      ].map((match) => match[1]!),
    );

  it("calls fork-release.ts and build-android-pwa.ts only with subcommands and flags they define", () => {
    const cli = optionsOf("scripts/fork-release.ts");
    const android = optionsOf("scripts/build-android-pwa.ts");
    const usage = /Usage: fork-release\.ts <([^>]+)>/
      .exec(NodeFS.readFileSync(NodePath.join(REPO, "scripts/fork-release.ts"), "utf8"))![1]!
      .split("|");
    const everyRun = [...Object.values(release.jobs), ...Object.values(withdraw.jobs)]
      .flatMap((job) => job.steps ?? [])
      .map((step) => step.run ?? "")
      .filter(Boolean);
    let commands = 0;
    for (const run of everyRun) {
      const flat = run.replaceAll("\\\n", " ").replaceAll(/\s+/g, " ");
      for (const match of flat.matchAll(
        /scripts\/fork-release\.ts ([a-z-]+)((?: --[a-z-]+(?: (?:"[^"]*"|\S+))?)*)/g,
      )) {
        commands += 1;
        assert.include(usage, match[1], `unknown subcommand ${match[1]}`);
        for (const flag of match[2]!.matchAll(/--([a-z-]+)/g))
          assert.isTrue(
            cli.has(flag[1]!) || flag[1] === "dry-run",
            `fork-release.ts has no --${flag[1]}`,
          );
      }
      for (const match of flat.matchAll(
        /scripts\/build-android-pwa\.ts((?: --[a-z-]+(?: (?:"[^"]*"|\S+))?)*)/g,
      )) {
        commands += 1;
        for (const flag of match[1]!.matchAll(/--([a-z-]+)/g))
          assert.isTrue(android.has(flag[1]!), `build-android-pwa.ts has no --${flag[1]}`);
      }
    }
    assert.isAbove(commands, 12);
  });

  it("passes the Android helper exactly the code pair, source, and signer the verifier expects", () => {
    const steps = release.jobs.android!.steps!;
    const flat = (name: string) =>
      stepNamed(release.jobs.android!, name).run!.replaceAll("\\\n", " ").replaceAll(/\s+/g, " ");
    assert.include(
      flat("Build normal APK"),
      '--version-code "$NORMAL_CODE" --source-commit "$COMMIT"',
    );
    assert.include(flat("Verify normal APK"), '--code "$NORMAL_CODE" --commit "$COMMIT"');
    // The recovery build takes the normal code and derives its own, one higher.
    assert.include(
      flat("Build recovery APK from the predecessor"),
      '--normal-version-code "$NORMAL_CODE"',
    );
    assert.include(
      flat("Build recovery APK from the predecessor"),
      '--version-name "$PREDECESSOR_VERSION"',
    );
    assert.include(
      flat("Verify recovery APK"),
      '--code "$RECOVERY_CODE" --commit "$PREDECESSOR_COMMIT"',
    );
    assert.isTrue(
      steps.some((step) => step.name === "Remove signing material" && step.if === "always()"),
    );
  });
});

describe("withdrawal workflow", () => {
  it("writes only through the withdrawal job and requires a reason to withdraw", () => {
    assert.deepStrictEqual(Object.keys(withdraw.jobs), ["withdrawal"]);
    assert.equal(withdraw.permissions.contents, "read");
    assert.equal(withdraw.jobs.withdrawal!.permissions!.contents, "write");
    assert.include(
      stepNamed(withdraw.jobs.withdrawal!, "Withdraw").run!,
      "A withdrawal needs a reason",
    );
  });

  it("offers both the withdrawal and its reverse", () => {
    const action = (
      withdraw.on.workflow_dispatch as {
        inputs: { action: { options: string[] } };
      }
    ).inputs.action;
    assert.deepStrictEqual(action.options, ["withdraw", "restore"]);
  });
});
