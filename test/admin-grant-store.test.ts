import { test } from "node:test";
import assert from "node:assert/strict";
import { createAdminGrantStore, createMemoryAdminGrantPersistence, grantKey } from "../src/admin/admin-grant-store.ts";
import { createAdminService, parseAdminGrants } from "../src/admin/admin-service.ts";
import { scopeId } from "../src/types.ts";

test("grant store: add / list / revoke round-trip on (principal, scope, role)", async () => {
  const store = createAdminGrantStore();
  assert.deepEqual(await store.list(), []);
  await store.add({ principalId: "U1", scopeId: "org:default-org", role: "org_admin" });
  await store.add({ principalId: "U2", scopeId: "org:default-org", role: "org_admin" });
  assert.equal((await store.list()).length, 2);
  await store.add({ principalId: "U1", scopeId: "org:default-org", role: "org_admin", grantedBy: "x" });
  assert.equal((await store.list()).length, 2);
  await store.add({ principalId: "U2", scopeId: "org:other", role: "org_admin" });
  assert.equal((await store.list()).length, 3);
  await store.revoke("U1", "org:default-org", "org_admin");
  const list = await store.list();
  assert.equal(list.length, 2);
  assert.ok(!list.some((g) => g.principalId === "U1"));
});

test("grant store: seed applies only when empty and never undoes a revoke", async () => {
  const persist = createMemoryAdminGrantPersistence();
  const seed = [{ principalId: "A", scopeId: "org:default-org", role: "org_admin" as const }];
  const store = createAdminGrantStore(persist, { seed });
  assert.equal((await store.list()).length, 1);
  await store.revoke("A", "org:default-org", "org_admin");
  assert.equal((await store.list()).length, 0);

  await persist.put({ principalId: "B", scopeId: "org:default-org", role: "org_admin" });
  const store2 = createAdminGrantStore(persist, { seed });
  assert.deepEqual(
    (await store2.list()).map((g) => g.principalId),
    ["B"],
  );
});

test("grant store: an empty seed grants no admins (deliberate lock-out)", async () => {
  const store = createAdminGrantStore(createMemoryAdminGrantPersistence(), { seed: [] });
  assert.deepEqual(await store.list(), []);
});

test("grantKey is stable and collision-free across the triple", () => {
  assert.equal(grantKey("U1", "org:default-org", "org_admin"), grantKey("U1", "org:default-org", "org_admin"));
  assert.notEqual(grantKey("U1", "org:default-org", "org_admin"), grantKey("U1", "org:other", "org_admin"));
  assert.notEqual(grantKey("U1", "org:default-org", "org_admin"), grantKey("U2", "org:default-org", "org_admin"));
});

test("parseAdminGrants: unset keeps the seeded defaults (returns undefined)", () => {
  assert.equal(parseAdminGrants(undefined, "default-org"), undefined);
});

test("parseAdminGrants: parses org_admin grants and skips malformed / removed-role entries", () => {
  const grants = parseAdminGrants(
    "U1:org_admin, U2:team_admin:team-eng, bad, U3:notarole, U5:org_admin",
    "default-org",
  );
  assert.deepEqual(grants, [
    { principalId: "U1", scopeId: scopeId("org", "default-org"), role: "org_admin" },
    { principalId: "U5", scopeId: scopeId("org", "default-org"), role: "org_admin" },
  ]);
  assert.deepEqual(parseAdminGrants("", "default-org"), []);
});

test("ADMIN_GRANTS-seeded admins resolve and authorize org-wide; non-admins do not", async () => {
  const store = createAdminGrantStore(createMemoryAdminGrantPersistence(), {
    seed: parseAdminGrants("U1:org_admin", "default-org"),
  });
  const svc = createAdminService(store);
  const u1 = svc.resolveActor("U1@default-org");
  const u2 = svc.resolveActor("U2@default-org");
  assert.ok(u1 && u2);
  assert.equal(await svc.canAdminister(u1, scopeId("org", "default-org")), true);
  assert.equal(await svc.canAdminister(u1, scopeId("channel", "eng")), true);
  assert.equal(await svc.canAdminister(u2, scopeId("org", "default-org")), false);
  assert.equal(
    await svc.canAdminister(svc.resolveActor("admin-alice@default-org")!, scopeId("org", "default-org")),
    false,
  );
});
