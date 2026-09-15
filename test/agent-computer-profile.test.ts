import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createLocalWorkspaceStore } from "../src/workspace/workspace-store.ts";
import { createSmolmachinesSandbox } from "../src/sandbox/smolmachines-sandbox.ts";
import { effectiveEgressEnforcement, type AgentComputerProfile } from "../src/sandbox/sandbox.ts";
import { installFakeSmolmachines, FAKE_SMOLMACHINES_TOKEN } from "./support/fake-smolmachines.ts";

function smolSandbox(extraTools: string[]) {
  const fake = installFakeSmolmachines();
  after(() => fake.cleanup());
  return createSmolmachinesSandbox(createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "smol-profile-"))), {
    token: FAKE_SMOLMACHINES_TOKEN,
    fetchImpl: fake.fetchImpl,
    extraTools,
  });
}

test("the smolmachines sandbox declares the Agent Computer contract (persistent per-scope computer)", () => {
  const { spec, ...contract } = smolSandbox([]).profile;
  assert.deepEqual(contract, {
    backend: "smolmachines",
    writablePersistence: "resident_disk",
    processSessions: true,
    egressEnforcement: "none",
  });
  assert.ok(spec?.homeDir);
  assert.ok(spec?.workdir?.startsWith(spec.homeDir));
  assert.ok(spec?.notInstalled?.includes("gh"));
});

test("a layer re-describing a hardcoded tool never advertises the binary twice (first occurrence wins)", () => {
  const sb = smolSandbox(["git (deployment Git CLI)"]);
  const gitLines = (sb.profile.spec?.tools ?? []).filter((line) => line.split(/\s+/)[0] === "git");
  assert.deepEqual(gitLines, ["git"], "one advertise line per binary; the hardcoded entry wins");
});

test("a layer that advertises a tool removes it from notInstalled (no install/not-installed contradiction)", () => {
  const sb = smolSandbox(["gcloud (deployment Google Cloud CLI)"]);
  const { spec } = sb.profile;
  assert.ok(spec?.tools?.includes("gcloud (deployment Google Cloud CLI)"), "advertise line joins the tools list");
  assert.ok(!spec?.notInstalled?.includes("gcloud"), "advertised tool is dropped from notInstalled");
  assert.ok(spec?.notInstalled?.includes("kubectl"));
});

test("egress enforcement is effective only when core can mint a reachable proxy token", () => {
  const profile: AgentComputerProfile = {
    backend: "smolmachines",
    writablePersistence: "resident_disk",
    processSessions: true,
    egressEnforcement: "domain",
  };
  assert.equal(
    effectiveEgressEnforcement(profile, { signingSecret: "secret" }),
    "none",
    "no reachable core URL means no per-turn token",
  );
  assert.equal(
    effectiveEgressEnforcement(profile, { apiBaseUrl: "https://core.internal" }),
    "none",
    "no signer means no per-turn token",
  );
  assert.equal(
    effectiveEgressEnforcement(profile, { signingSecret: "secret", apiBaseUrl: "https://core.internal" }),
    "domain",
  );
});
