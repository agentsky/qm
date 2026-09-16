import {
  createSandboxResources,
  type SandboxResource,
  type SandboxDefault,
  type SandboxResourceRollout,
} from "../src/sandbox/sandbox-resources.ts";
import { createMemoryAdvisoryLock } from "../src/persistence/advisory-lock.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createSandboxMigrationRunner } from "../src/sandbox/sandbox-migration-runner.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import type { SandboxRoute } from "../src/sandbox/sandbox-routing.ts";
import type { Sandbox, SandboxHandle, ExecResult } from "../src/sandbox/sandbox.ts";

function hostBackend(name: string, homeDir: string): Sandbox & { tornDown: number } {
  mkdirSync(homeDir, { recursive: true });
  const rootDir = join(homeDir, "workspace");
  mkdirSync(rootDir, { recursive: true });
  const resolve = (rel: string) => join(rootDir, rel);
  const s = {
    tornDown: 0,
    profile: { backend: name, writablePersistence: "resident_disk" as const, processSessions: false },
    async provision(): Promise<SandboxHandle> {
      return { id: `${name}-box`, rootDir, homeDir };
    },
    async run(_h: SandboxHandle, command: string): Promise<ExecResult> {
      const r = spawnSync("sh", ["-c", command], {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        env: { PATH: process.env.PATH ?? "" },
      });
      return {
        stdout: r.stdout ?? "",
        stderr: r.stderr ?? "",
        code: r.status ?? (r.signal ? 137 : -1),
        timedOut: false,
      };
    },
    async readFileBytes(_h: SandboxHandle, rel: string): Promise<Uint8Array | null> {
      const p = resolve(rel);
      return existsSync(p) ? readFileSync(p) : null;
    },
    async writeFileBytes(_h: SandboxHandle, rel: string, data: Uint8Array): Promise<void> {
      const p = resolve(rel);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, data);
    },
    async teardown(): Promise<void> {
      s.tornDown++;
    },
    async readFile() {
      return null;
    },
    async writeFile() {},
    async listDir() {
      return [];
    },
    async removeDir() {},
  };
  return s as unknown as Sandbox & { tornDown: number };
}

function build(root: string) {
  const e2b = hostBackend("e2b", join(root, "e2b-home"));
  const modal = hostBackend("modal", join(root, "modal-home"));
  const routes = createMemoryMap<SandboxRoute>();
  return { e2b, modal, routes };
}

test("migrateScope copies $HOME, flips the route only after a verified copy, and parks both boxes", async () => {
  const root = mkdtempSync(join(tmpdir(), "mig-runner-"));
  try {
    const { e2b, modal, routes } = build(root);
    writeFileSync(join(root, "e2b-home", "notes.txt"), "hello\n");
    const runner = createSandboxMigrationRunner({ backends: { e2b, modal }, routes, defaultBackend: "e2b" });
    const res = await runner.migrateScope("personal:alice", "modal", "canary");
    assert.equal(res.from, "e2b");
    assert.equal(res.to, "modal");
    assert.match(res.sha, /^[0-9a-f]{64}$/);
    assert.equal(readFileSync(join(root, "modal-home", "notes.txt"), "utf8"), "hello\n");
    const route = await routes.get("personal:alice");
    assert.equal(route?.backend, "modal");
    assert.equal(route?.migrationSha, res.sha);
    assert.equal(route?.reason, "canary");
    assert.equal(e2b.tornDown, 1);
    assert.equal(modal.tornDown, 1);
    const back = await runner.migrateScope("personal:alice", "e2b");
    assert.equal(back.from, "modal");
    assert.equal((await routes.get("personal:alice"))?.backend, "e2b");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("snapshot strategy exports once, adopts into the target's snapshot store, and flips only after a hydrated home verifies", async () => {
  const root = mkdtempSync(join(tmpdir(), "mig-snap-"));
  try {
    const { e2b: src, routes } = build(root);
    const notes = join(root, "e2b-home", "notes.txt");
    writeFileSync(notes, "hello snapshot\n");
    utimesSync(notes, new Date(0), new Date(0));
    const blobs = new Map<string, Buffer>();
    const adopted: string[] = [];
    (src as unknown as { stageOut: Sandbox["stageOut"]; importFiles: unknown; stageIn: unknown }).stageOut = async (
      h,
      rel,
    ) => {
      const bytes = await src.readFileBytes(h, rel);
      if (!bytes) throw new Error("no tar");
      const id = `blob-${blobs.size + 1}`;
      blobs.set(id, Buffer.from(bytes));
      return id;
    };
    (src as unknown as { stageIn: unknown }).stageIn = async () => {};
    (src as unknown as { importFiles: unknown }).importFiles = async () => {};

    const dstHome = join(root, "modal-home");
    const dst = hostBackend("modal", dstHome);
    let hydratePending: Buffer | null = null;
    (dst as unknown as { adoptHomeSnapshot: Sandbox["adoptHomeSnapshot"] }).adoptHomeSnapshot = async (
      scope,
      blobId,
    ) => {
      adopted.push(`${scope}:${blobId}`);
      hydratePending = blobs.get(blobId) ?? null;
      if (!hydratePending) throw new Error("unknown blob");
    };
    const origProvision = dst.provision.bind(dst);
    dst.provision = async (layers, opts) => {
      const h = await origProvision(layers, opts);
      if (hydratePending) {
        const tarFile = join(dstHome, ".hydrate.tgz");
        writeFileSync(tarFile, hydratePending);
        hydratePending = null;
        spawnSync("sh", ["-c", `cd ${dstHome} && tar xzf .hydrate.tgz && rm -f .hydrate.tgz`], { encoding: "utf8" });
      }
      return h;
    };

    const runner = createSandboxMigrationRunner({ backends: { e2b: src, modal: dst }, routes, defaultBackend: "e2b" });
    const res = await runner.migrateScope("personal:alice", "modal", "snapshot cutover", {
      force: true,
      strategy: "snapshot",
    });
    assert.equal(res.to, "modal");
    assert.match(res.sha, /^[0-9a-f]{64}$/);
    assert.ok(res.destFiles >= 1);
    assert.equal(adopted.length, 1);
    assert.equal(res.resynced, false);
    assert.equal(readFileSync(join(dstHome, "notes.txt"), "utf8"), "hello snapshot\n");
    assert.equal((await routes.get("personal:alice"))?.backend, "modal");
    assert.equal(existsSync(join(root, "e2b-home", "notes.txt")), true, "source untouched");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("snapshot strategy resumes from an already-exported blob without repacking the source", async () => {
  const root = mkdtempSync(join(tmpdir(), "mig-snap-resume-"));
  try {
    const { e2b: src, routes } = build(root);
    let packs = 0;
    const origRun = src.run.bind(src);
    src.run = async (h, command, opts) => {
      if (command.includes("tar czf")) packs++;
      return origRun(h, command, opts);
    };
    (src as unknown as { stageOut: unknown }).stageOut = async () => {
      throw new Error("stageOut must not run on resume");
    };
    (src as unknown as { stageIn: unknown }).stageIn = async () => {};
    (src as unknown as { importFiles: unknown }).importFiles = async () => {};

    const dstHome = join(root, "modal-home");
    const dst = hostBackend("modal", dstHome);
    const adopted: string[] = [];
    (dst as unknown as { adoptHomeSnapshot: Sandbox["adoptHomeSnapshot"] }).adoptHomeSnapshot = async (
      scope,
      blobId,
    ) => {
      adopted.push(blobId);
      writeFileSync(join(dstHome, "restored.txt"), "from resumed blob\n");
    };

    const runner = createSandboxMigrationRunner({ backends: { e2b: src, modal: dst }, routes, defaultBackend: "e2b" });
    const res = await runner.migrateScope("personal:alice", "modal", "resume", {
      force: true,
      strategy: "snapshot",
      resumeBlobId: "ab".repeat(16),
    });
    assert.equal(packs, 0, "no source pack on resume");
    assert.deepEqual(adopted, ["ab".repeat(16)]);
    assert.equal(res.sha, "resumed");
    assert.equal(res.resynced, false, "resume never resyncs from the live source");
    assert.equal((await routes.get("personal:alice"))?.backend, "modal");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("snapshot strategy refuses when the target cannot adopt snapshots", async () => {
  const root = mkdtempSync(join(tmpdir(), "mig-snap-refuse-"));
  try {
    const { e2b: src, modal: dst, routes } = build(root);
    (src as unknown as { stageOut: unknown }).stageOut = async () => "blob-x";
    (src as unknown as { stageIn: unknown }).stageIn = async () => {};
    (src as unknown as { importFiles: unknown }).importFiles = async () => {};
    const runner = createSandboxMigrationRunner({
      backends: { e2b: src, modal: dst },
      routes,
      defaultBackend: "e2b",
    });
    await assert.rejects(
      runner.migrateScope("personal:alice", "modal", undefined, { force: true, strategy: "snapshot" }),
      /adopting home snapshots/,
    );
    assert.equal(await routes.get("personal:alice"), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("migrateScope refuses: same backend, pinned scope, live work, unconstructed target", async () => {
  const root = mkdtempSync(join(tmpdir(), "mig-refuse-"));
  try {
    const { e2b, modal, routes } = build(root);
    const busy = new Set<string>();
    const runner = createSandboxMigrationRunner({
      backends: { e2b, modal },
      routes,
      defaultBackend: "e2b",
      hasLiveWork: async (scopeId) => busy.has(scopeId),
    });
    await assert.rejects(runner.migrateScope("personal:a", "e2b"), /already on e2b/);
    await assert.rejects(runner.migrateScope("personal:a", "local"), /not constructed/);
    await routes.put("personal:pinned", { backend: "e2b", pinned: true, reason: "big box" });
    await assert.rejects(runner.migrateScope("personal:pinned", "modal"), /pinned/);
    busy.add("personal:busy");
    await assert.rejects(runner.migrateScope("personal:busy", "modal"), /live background work/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("migrateScope refuses a target that carries fewer capabilities, unless forced", async () => {
  const root = mkdtempSync(join(tmpdir(), "mig-caps-"));
  try {
    const { e2b, modal, routes } = build(root);
    writeFileSync(join(root, "e2b-home", "notes.txt"), "hello\n");
    const awsWithBackup: Sandbox = {
      ...e2b,
      async exportFiles() {
        return [];
      },
    };
    const runner = createSandboxMigrationRunner({
      backends: { e2b: awsWithBackup, modal },
      routes,
      defaultBackend: "e2b",
    });

    await assert.rejects(runner.migrateScope("personal:alice", "modal"), /home export/);
    assert.equal(await routes.get("personal:alice"), null, "a refused migration must not flip the route");

    const forced = await runner.migrateScope("personal:alice", "modal", "canary", { force: true });
    assert.deepEqual(forced.capabilitiesLost, ["home export (publish, resident-auth capture)"]);
    const route = await routes.get("personal:alice");
    assert.equal(route?.backend, "modal");
    assert.deepEqual(route?.capabilitiesLost, ["home export (publish, resident-auth capture)"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a resync after the settle window keeps the durable record of what was lost", async () => {
  const root = mkdtempSync(join(tmpdir(), "mig-resync-"));
  try {
    const { e2b, modal, routes } = build(root);
    writeFileSync(join(root, "e2b-home", "notes.txt"), "hello\n");
    const awsWithBackup: Sandbox = {
      ...e2b,
      async exportFiles() {
        return [];
      },
      async run(h, command, o) {
        if (command.includes("-newermt")) return { stdout: "notes.txt\n", stderr: "", code: 0, timedOut: false };
        return e2b.run(h, command, o);
      },
    };
    const runner = createSandboxMigrationRunner({
      backends: { e2b: awsWithBackup, modal },
      routes,
      defaultBackend: "e2b",
    });
    const res = await runner.migrateScope("personal:alice", "modal", "canary", { force: true });
    assert.equal(res.resynced, true, "the test must actually exercise the resync write");
    assert.deepEqual((await routes.get("personal:alice"))?.capabilitiesLost, [
      "home export (publish, resident-auth capture)",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("migrateScope refuses a target that enforces less egress", async () => {
  const root = mkdtempSync(join(tmpdir(), "mig-egress-"));
  try {
    const { e2b, modal, routes } = build(root);
    writeFileSync(join(root, "e2b-home", "notes.txt"), "hello\n");
    const confined: Sandbox = { ...e2b, profile: { ...e2b.profile, egressEnforcement: "domain" } };
    const open: Sandbox = { ...modal, profile: { ...modal.profile, egressEnforcement: "none" } };
    const runner = createSandboxMigrationRunner({
      backends: { e2b: confined, modal: open },
      routes,
      defaultBackend: "e2b",
    });
    await assert.rejects(runner.migrateScope("personal:alice", "modal"), /egress enforcement/);
    await routes.put("personal:bob", { backend: "modal" });
    writeFileSync(join(root, "modal-home", "notes.txt"), "hello\n");
    const res = await runner.migrateScope("personal:bob", "e2b");
    assert.deepEqual(res.capabilitiesLost, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("migrateScope reports no loss when the substrates carry the same capabilities", async () => {
  const root = mkdtempSync(join(tmpdir(), "mig-caps-equal-"));
  try {
    const { e2b, modal, routes } = build(root);
    writeFileSync(join(root, "e2b-home", "notes.txt"), "hello\n");
    const runner = createSandboxMigrationRunner({ backends: { e2b, modal }, routes, defaultBackend: "e2b" });
    const res = await runner.migrateScope("personal:alice", "modal");
    assert.deepEqual(res.capabilitiesLost, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a failed copy leaves the route untouched", async () => {
  const root = mkdtempSync(join(tmpdir(), "mig-fail-"));
  try {
    const { e2b, modal, routes } = build(root);
    writeFileSync(join(root, "e2b-home", "notes.txt"), "hello\n");
    const corrupt: Sandbox = {
      ...modal,
      async writeFileBytes(h, rel, data) {
        const bad = Buffer.from(data);
        bad[0] = bad[0]! ^ 0xff;
        return modal.writeFileBytes(h, rel, bad);
      },
    };
    const runner = createSandboxMigrationRunner({ backends: { e2b, modal: corrupt }, routes, defaultBackend: "e2b" });
    await assert.rejects(runner.migrateScope("personal:alice", "modal"), /sha-mismatch|verify\/extract failed/);
    assert.equal(await routes.get("personal:alice"), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("activation cannot pass a running migration before its final route and teardown", async () => {
  const root = mkdtempSync(join(tmpdir(), "mig-activation-"));
  try {
    const { e2b, modal, routes } = build(root);
    writeFileSync(join(root, "e2b-home", "notes.txt"), "preserve me\n");
    const lock = createMemoryAdvisoryLock();
    const rollout = createMemoryMap<SandboxResourceRollout>();
    const options = {
      enabled: false,
      rollout,
      records: createMemoryMap<SandboxResource>(),
      defaults: createMemoryMap<SandboxDefault>(),
      routes,
      backends: { e2b, modal },
      defaultBackend: "e2b" as const,
      lock,
      canUseScope: async () => true,
    };
    const reader = createSandboxResources(options);
    const activating = createSandboxResources({ ...options, enabled: true });
    const parked = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    e2b.teardown = async () => {
      parked.resolve();
      await release.promise;
    };
    const runner = createSandboxMigrationRunner({
      backends: { e2b, modal },
      routes,
      defaultBackend: "e2b",
      advisoryLock: lock,
      withLegacyMutation: (scope, action) => reader.withLegacyMutation(scope, action),
    });
    const migration = runner.migrateScope("personal:alice", "modal");
    await parked.promise;
    const activation = activating.initialize();
    assert.equal(await rollout.get("explicit-defaults"), null);
    release.resolve();
    await Promise.all([migration, activation]);
    assert.equal((await activating.resolve("personal:alice"))?.backend, "modal");
    assert.equal(readFileSync(join(root, "modal-home", "notes.txt"), "utf8"), "preserve me\n");
    await assert.rejects(runner.migrateScope("personal:alice", "e2b"), /retired/);
    assert.equal((await routes.get("personal:alice"))?.backend, "modal");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("migration reads the scope default as its source before installing an explicit route", async () => {
  const root = mkdtempSync(join(tmpdir(), "mig-scope-default-"));
  try {
    const { e2b, modal, routes } = build(root);
    writeFileSync(join(root, "e2b-home", "notes.txt"), "scope default data\n");
    const runner = createSandboxMigrationRunner({
      backends: { e2b, modal },
      routes,
      defaultBackend: "modal",
      scopeDefaults: { personal: "e2b" },
    });
    const result = await runner.migrateScope("personal:alice", "modal", "scope policy migration");
    assert.equal(result.from, "e2b");
    assert.equal(readFileSync(join(root, "modal-home", "notes.txt"), "utf8"), "scope default data\n");
    assert.equal((await routes.get("personal:alice"))?.backend, "modal");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
