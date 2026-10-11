// M3 隔离 E2E：强 Bearer Core + Proxy verifyUserKey Bearer 兼容。
// 通过挂载源码到生产代理镜像运行（镜像含 node22+tsx+依赖），不构建新镜像；
// 挂载的 src 目录决定被测代码版本（RED=未打补丁，GREEN=打补丁后）。
import { spawnSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SRC = process.argv[2]; // 被挂载的 proxy src 目录
const MODE = process.argv[3] ?? "red"; // red | green-bearer | green-wrong-bearer | green-no-userkey
const TAG = `am-r3-proxy-${MODE}`;
const CORE = "am-r3-core";
const NET = "am-r3-net";
const SERVICE_BEARER = "r3-test-service-bearer";
const USER_KEY = process.env.AM_R3_USER_KEY ?? "";
const UPSTREAM_PORT = 18422;
const PROXY_PORT = 18096;

function sh(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} → ${r.status}: ${(r.stderr ?? "").slice(0, 200)}`);
  return r.stdout.trim();
}

// ── mock 上游（代理转发目标，返回可识别标记）────────────────────────────────
const upstream = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      id: "chatcmpl-am-r3-e2e", object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content: "AM-R3-E2E-UPSTREAM-OK" }, finish_reason: "stop" }],
    }));
  });
});
await new Promise((r) => upstream.listen(UPSTREAM_PORT, "127.0.0.1", r));

// ── proxy 配置（按模式切换 auth 相关）──────────────────────────────────────
const cfgDir = mkdtempSync(join(tmpdir(), "am-r3-cfg-"));
const tdaiKey = MODE === "red" ? "" : MODE === "green-wrong-bearer" ? "wrong-service-bearer" : SERVICE_BEARER;
writeFileSync(join(cfgDir, "config.yaml"), [
  "server:", `  host: 0.0.0.0`, `  port: 8096`, "  forwardTimeoutMs: 60000",
  "upstream:", `  url: "http://host.docker.internal:${UPSTREAM_PORT}"`, '  apiKey: "mock-upstream-key"',
  "log:", '  file: ""', "  level: info", "  backend: console",
  "tdai:", "  enabled: false", `  endpoint: "http://${CORE}:8420"`, `  apiKey: "${tdaiKey}"`, '  serviceId: "default"',
  "skill:", `  endpoint: "http://${CORE}:8420"`, `  serviceToken: "${tdaiKey}"`,
  "auth:", "  enabled: true", `  url: "http://${CORE}:8420"`, "  timeoutMs: 5000",
  "sessionInit:", "  enabled: false",
  "costGuard:", "  enabled: false",
  "injection:", "  enabled: false",
  "redis:", "  enabled: false",
  "",
].join("\n"));

// ── 启动 proxy（挂载被测源码）──────────────────────────────────────────────
sh("docker", ["rm", "-f", TAG]);
sh("docker", [
  "run", "-d", "--name", TAG, "--network", NET, "--network-alias", "proxy",
  "--add-host", "host.docker.internal:host-gateway",
  "-p", `127.0.0.1:${PROXY_PORT}:8096`,
  "-v", `${SRC}:/app/src:ro`,
  "-v", `${join(cfgDir, "config.yaml")}:/data/config.yaml:ro`,
  "agentmemory/memory-proxy@sha256:82df81d8af89d26ab2c1029dca3037f0e4bf3e55e50b16969d357c5b74385a97",
]);
await new Promise((r) => setTimeout(r, 6000));

// ── 发请求（带隔离合成 user key）───────────────────────────────────────────
const headers = { "Content-Type": "application/json" };
if (MODE !== "green-no-userkey") headers.Authorization = `Bearer ${USER_KEY}`;
const request = await fetch(`http://127.0.0.1:${PROXY_PORT}/opencode/default/v1/chat/completions`, {
  method: "POST",
  headers,
  body: JSON.stringify({ model: "test-model", stream: false, messages: [{ role: "user", content: "am-r3 bearer probe" }], max_tokens: 8 }),
});
const text = await request.text();
const logs = sh("docker", ["logs", "--tail", "40", TAG]);

console.log(JSON.stringify({
  mode: MODE,
  httpStatus: request.status,
  bodyHead: text.slice(0, 200),
  authRejected: /auth|rejected|unauthorized|401/i.test(text) || logs.includes("auth.verify.httpError"),
  upstreamReached: text.includes("AM-R3-E2E-UPSTREAM-OK"),
  logsTail: logs.split("\n").filter((l) => /auth|reject|error/i.test(l)).slice(-4),
}, null, 1));

sh("docker", ["rm", "-f", TAG]);
upstream.close();
process.exit(0);
