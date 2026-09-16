import { existsSync, openSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { writePidFile } from "./lease.ts";
import { run } from "./proc.ts";
import { ensureDockerDaemon } from "./postgres.ts";
import { bestEffortValue, sleep } from "./util.ts";

export interface SandboxResolution {
  backend: "local" | "smolmachines" | "e2b" | "agent37";
  env: Record<string, string>;
  detail: string;
  publicApiUrl: string | null;
  warnings: string[];
}

function worktreeSupportsLocalSandbox(worktree: string): boolean {
  return existsSync(join(worktree, "src/sandbox/local-sandbox.ts"));
}

async function localImagePresent(image: string): Promise<boolean> {
  return (await run("docker", ["image", "inspect", image], { timeoutMs: 30_000 })).code === 0;
}

const SANDBOX_CHOICES = ["local", "smolmachines", "e2b", "agent37"] as const;

export async function resolveSandbox(opts: {
  worktree: string;
  requested: "local" | "smolmachines" | "e2b" | "agent37" | "auto";
  corePort: number;
  lock: string;
  baseEnv: Record<string, string>;
  log: (msg: string) => void;
}): Promise<SandboxResolution> {
  const warnings: string[] = [];
  const backend = opts.requested === "auto" ? "local" : opts.requested;
  if (!SANDBOX_CHOICES.includes(backend)) {
    throw new Error(`--sandbox ${String(backend)} is not one of ${SANDBOX_CHOICES.join(", ")}, or auto`);
  }
  if (backend === "local" && !worktreeSupportsLocalSandbox(opts.worktree)) {
    throw new Error(
      "this worktree's code has no local sandbox backend (src/sandbox/local-sandbox.ts missing) -- use --sandbox e2b",
    );
  }

  if (backend === "local") {
    if (!(await ensureDockerDaemon(opts.log))) {
      throw new Error("SANDBOX_BACKEND=local requires a running Docker daemon (is Docker Desktop running?)");
    }
    const image = opts.baseEnv.LOCAL_SANDBOX_IMAGE || "qm-sandbox-local:latest";
    if (!(await localImagePresent(image))) {
      warnings.push(
        `local sandbox image ${image} not built -- execute turns will fail until you run: npm run sandbox:local:build`,
      );
    }
    const publicApiUrl = opts.baseEnv.PUBLIC_API_URL || `http://host.docker.internal:${opts.corePort}`;
    return {
      backend: "local",
      env: {
        SANDBOX_BACKEND: "local",
        LOCAL_SANDBOX_IMAGE: image,
        PUBLIC_API_URL: publicApiUrl,
      },
      detail: `local Docker (${image})`,
      publicApiUrl,
      warnings,
    };
  }

  if (backend === "e2b") {
    const e2bKey = opts.baseEnv.E2B_API_KEY;
    if (!e2bKey) throw new Error("--sandbox e2b requires E2B_API_KEY in the environment");
    let e2bApiUrl = opts.baseEnv.PUBLIC_API_URL || null;
    if (!e2bApiUrl) {
      e2bApiUrl = await startQuickTunnel(opts.corePort, opts.lock, opts.log);
      if (!e2bApiUrl)
        warnings.push(
          "cloudflared tunnel didn't come up -- agent self-API (crons/sends) won't be reachable from the sandbox",
        );
    }
    const e2bEnv: Record<string, string> = {
      SANDBOX_BACKEND: "e2b",
      E2B_API_KEY: e2bKey,
      E2B_NAME_PREFIX: opts.baseEnv.E2B_NAME_PREFIX || "qmdev",
    };
    if (opts.baseEnv.E2B_TEMPLATE_ID) e2bEnv.E2B_TEMPLATE_ID = opts.baseEnv.E2B_TEMPLATE_ID;
    if (e2bApiUrl) e2bEnv.PUBLIC_API_URL = e2bApiUrl;
    return { backend: "e2b", env: e2bEnv, detail: "e2b (api.e2b.dev)", publicApiUrl: e2bApiUrl, warnings };
  }

  if (backend === "smolmachines") {
    const smolToken = opts.baseEnv.SMOLMACHINES_TOKEN;
    if (!smolToken)
      throw new Error(
        "--sandbox smolmachines requires SMOLMACHINES_TOKEN in the environment (create an API key in the smolmachines console)",
      );
    let smolApiUrl = opts.baseEnv.PUBLIC_API_URL || null;
    if (!smolApiUrl) {
      smolApiUrl = await startQuickTunnel(opts.corePort, opts.lock, opts.log);
      if (!smolApiUrl)
        warnings.push(
          "cloudflared tunnel didn't come up -- agent self-API (crons/sends) won't be reachable from the sandbox",
        );
    }
    const smolEnv: Record<string, string> = {
      SANDBOX_BACKEND: "smolmachines",
      SMOLMACHINES_TOKEN: smolToken,
      SMOLMACHINES_NAME_PREFIX: opts.baseEnv.SMOLMACHINES_NAME_PREFIX || "qmdev",
    };
    if (opts.baseEnv.SMOLMACHINES_IMAGE) smolEnv.SMOLMACHINES_IMAGE = opts.baseEnv.SMOLMACHINES_IMAGE;
    if (opts.baseEnv.SMOLMACHINES_EGRESS_PROXY_URL)
      smolEnv.SMOLMACHINES_EGRESS_PROXY_URL = opts.baseEnv.SMOLMACHINES_EGRESS_PROXY_URL;
    else
      warnings.push(
        "SMOLMACHINES_EGRESS_PROXY_URL unset -- smolmachines sandbox runs with NO egress enforcement; set it to QA the forced-proxy path",
      );
    if (smolApiUrl) smolEnv.PUBLIC_API_URL = smolApiUrl;
    return {
      backend: "smolmachines",
      env: smolEnv,
      detail: "smolmachines (api.smolmachines.com)",
      publicApiUrl: smolApiUrl,
      warnings,
    };
  }

  const apiKey = opts.baseEnv.AGENT37_API_KEY;
  if (!apiKey)
    throw new Error(
      "--sandbox agent37 requires AGENT37_API_KEY in the environment (mint one at https://agent37.com/dashboard/cloud/api-keys)",
    );
  let apiUrl = opts.baseEnv.PUBLIC_API_URL || null;
  if (!apiUrl) {
    apiUrl = await startQuickTunnel(opts.corePort, opts.lock, opts.log);
    if (!apiUrl)
      warnings.push(
        "cloudflared tunnel didn't come up -- agent self-API (crons/sends) won't be reachable from the sandbox",
      );
  }
  const env: Record<string, string> = {
    SANDBOX_BACKEND: "agent37",
    AGENT37_API_KEY: apiKey,
    AGENT37_NAME_PREFIX: opts.baseEnv.AGENT37_NAME_PREFIX || "qmdev",
  };
  if (opts.baseEnv.AGENT37_API_BASE_URL) env.AGENT37_API_BASE_URL = opts.baseEnv.AGENT37_API_BASE_URL;
  if (opts.baseEnv.AGENT37_TEMPLATE) env.AGENT37_TEMPLATE = opts.baseEnv.AGENT37_TEMPLATE;
  if (opts.baseEnv.AGENT37_EGRESS_PROXY_URL) env.AGENT37_EGRESS_PROXY_URL = opts.baseEnv.AGENT37_EGRESS_PROXY_URL;
  else
    warnings.push(
      "AGENT37_EGRESS_PROXY_URL unset -- agent37 sandbox runs with NO egress enforcement; set it to QA the forced-proxy path",
    );
  if (apiUrl) env.PUBLIC_API_URL = apiUrl;
  return { backend: "agent37", env, detail: "Agent37 (api.agent37.com)", publicApiUrl: apiUrl, warnings };
}

async function startQuickTunnel(corePort: number, lock: string, log: (msg: string) => void): Promise<string | null> {
  if ((await run("cloudflared", ["--version"], { timeoutMs: 15_000 })).code !== 0) return null;
  const logPath = join(lock, "tunnel.log");
  const fd = openSync(logPath, "a");
  const child = spawn("cloudflared", ["tunnel", "--url", `http://localhost:${corePort}`, "--no-autoupdate"], {
    detached: true,
    stdio: ["ignore", fd, fd],
  });
  child.unref();
  if (!child.pid) return null;
  writePidFile(lock, "tunnel.pid", child.pid);
  for (let i = 0; i < 20; i++) {
    const url = bestEffortValue(
      () => readFileSync(logPath, "utf8").match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)?.[0] ?? "",
    );
    if (url) {
      log(`agent self-API tunnel: ${url} -> :${corePort} (lets the sandbox reach this core for crons/sends)`);
      return url;
    }
    await sleep(1000);
  }
  return null;
}

export async function destroyLocalDevSandboxes(log: (msg: string) => void): Promise<void> {
  const list = await run(
    "docker",
    [
      "ps",
      "-aq",
      "--filter",
      "label=qm.sandbox=1",
      "--filter",
      "label=agent_env=dev",
      "--filter",
      "status=exited",
      "--filter",
      "status=created",
    ],
    { timeoutMs: 30_000 },
  );
  const ids = (list.stdout ?? "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!ids.length) return;
  log(`sandbox: removing ${ids.length} parked local dev sandbox container(s) (volumes kept; running boxes untouched)`);
  await run("docker", ["rm", "-f", ...ids], { timeoutMs: 60_000 });
}
