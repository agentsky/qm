import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../lib/envctx.ts";
import { killTree, spawnDetached } from "../lib/proc.ts";
import { bestEffortValue, sleep } from "../lib/util.ts";
import { EXIT } from "../lib/types.ts";

function ciDirName(): string {
  return process.env.CI_INSTANCE_DIR ?? ".ci-instance";
}

function envNum(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function readPid(dir: string, name: string): number | undefined {
  const pid = Number(bestEffortValue(() => readFileSync(join(dir, `${name}.pid`), "utf8").trim()));
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

function tail(path: string, lines: number): string {
  return (bestEffortValue(() => readFileSync(path, "utf8")) ?? "").trimEnd().split("\n").slice(-lines).join("\n");
}

async function waitForLog(path: string, pattern: RegExp, timeoutSec: number): Promise<boolean> {
  const deadline = Date.now() + timeoutSec * 1000;
  for (;;) {
    if (pattern.test(bestEffortValue(() => readFileSync(path, "utf8")) ?? "")) return true;
    if (Date.now() >= deadline) return false;
    await sleep(250);
  }
}

function missingPrereq(root: string): string | null {
  if (!(process.env.SLACK_BOT_TOKEN ?? "").startsWith("xoxb-")) return "SLACK_BOT_TOKEN (xoxb-…) required";
  if (process.env.SLACK_EVENTS_MODE === "http") {
    if (!process.env.SLACK_SIGNING_SECRET) return "SLACK_SIGNING_SECRET required in http events mode";
  } else if (!(process.env.SLACK_APP_TOKEN ?? "").startsWith("xapp-")) {
    return "SLACK_APP_TOKEN (xapp-…) required";
  }
  if (!process.env.ANTHROPIC_API_KEY && !process.env.OPENAI_API_KEY && !process.env.OPENROUTER_API_KEY) {
    return "a model provider key required (ANTHROPIC_API_KEY, OPENAI_API_KEY, or OPENROUTER_API_KEY — live turns are the point of this instance)";
  }
  if (!process.env.CORE_SIGNING_SECRET) return "CORE_SIGNING_SECRET required";
  if (!existsSync(join(root, "node_modules"))) return "core deps missing — run 'npm ci' first";
  return null;
}

export async function ciUp(): Promise<number> {
  const root = repoRoot();
  const problem = missingPrereq(root);
  if (problem) {
    console.error(`dev ci: ${problem}`);
    return EXIT.missingPrereq;
  }

  const dir = join(root, ciDirName());
  mkdirSync(dir, { recursive: true });
  const coreLog = join(dir, "core.log");
  writeFileSync(coreLog, "");
  const port = envNum("CI_INSTANCE_PORT", 8181);
  const readyTimeout = envNum("CI_INSTANCE_READY_TIMEOUT", 60);

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  env.HARNESS = process.env.HARNESS ?? "pi";
  env.ORG_ID = "acme";
  env.SESSION_STORE = "memory";
  env.PORT = String(port);
  if (process.env.SLACK_EVENTS_MODE === "http" && !process.env.SLACK_EVENTS_PORT) {
    env.SLACK_EVENTS_PORT = String(port + 1);
  }

  const pid = spawnDetached({
    cwd: root,
    logFile: coreLog,
    argv: ["node", "--env-file-if-exists=.env", "src/index.ts"],
    env,
  });
  writeFileSync(join(dir, "core.pid"), String(pid));

  const gates: Array<[RegExp, string]> = [
    [new RegExp(`listening on :${port}`), `core failed to start on :${port}`],
    [/connected as @/, "slack surface failed to connect (bad/uninstalled CI app token?)"],
  ];
  for (const [pattern, failure] of gates) {
    if (await waitForLog(coreLog, pattern, readyTimeout)) continue;
    console.error(`--- core.log (tail) ---\n${tail(coreLog, 30)}`);
    await ciDown();
    console.error(`dev ci: ${failure}`);
    return EXIT.childFailed;
  }

  const handle = readFileSync(coreLog, "utf8").match(/connected as @(\S+)/)?.[1] ?? "agent";
  console.log(`ci instance up — core :${port}, slack @${handle}`);
  if (process.env.GITHUB_ENV) {
    appendFileSync(process.env.GITHUB_ENV, `CORE_API_URL=http://localhost:${port}\nAGENT_HANDLE=${handle}\n`);
  }
  return EXIT.ok;
}

export async function ciDown(): Promise<number> {
  const root = bestEffortValue(() => repoRoot());
  const dir = root === undefined ? undefined : join(root, ciDirName());
  if (dir === undefined || !existsSync(dir)) {
    console.log("nothing to tear down.");
    return EXIT.ok;
  }
  await killTree(readPid(dir, "core"));
  rmSync(join(dir, "core.pid"), { force: true });
  console.log(`ci instance down (logs kept in ${ciDirName()}/)`);
  return EXIT.ok;
}
