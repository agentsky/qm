import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { CORE_SECRET_SPECS } from "../src/deployment/secret-schema.ts";

test("every secret core can require has a key in the chart's secretEnv", () => {
  const values = readFileSync(new URL("../deploy/helm/values.yaml", import.meta.url), "utf8");
  const block = /^secretEnv:\n((?: {2}\S.*\n)+)/m.exec(values);
  assert.ok(block, "values.yaml declares a secretEnv map");
  const keys = new Set(block[1]!.split("\n").flatMap((line) => (line.trim() ? [line.trim().split(":")[0]!] : [])));
  for (const spec of CORE_SECRET_SPECS) assert.ok(keys.has(spec.name), `values.yaml secretEnv lists ${spec.name}`);
});
