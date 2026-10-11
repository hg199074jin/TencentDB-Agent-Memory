// M2 RED→GREEN：严格 loopback guard 的 mock 测试（不碰真实 docker）。
// 通过在 PATH 前部注入假 docker 可执行文件，驱动 ops/loopback-guard.sh 的各分支。
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const GUARD = join(import.meta.dirname, "..", "loopback-guard.sh");

function makeFakeDocker(handler) {
  const dir = mkdtempSync(join(tmpdir(), "am-r3-docker-"));
  const bin = join(dir, "docker");
  writeFileSync(bin, `#!/usr/bin/env bash\n${handler}\n`);
  chmodSync(bin, 0o755);
  return dir;
}

function runGuard({ dockerHandler, env = {}, deployScripts } = {}) {
  const dirs = [];
  const fakeDocker = dockerHandler ? makeFakeDocker(dockerHandler) : null;
  if (fakeDocker) dirs.push(fakeDocker);
  const deployDir = mkdtempSync(join(tmpdir(), "am-r3-deploy-"));
  dirs.push(deployDir);
  for (const [name, content] of Object.entries(deployScripts ?? {})) {
    writeFileSync(join(deployDir, name), content);
  }
  const result = spawnSync("bash", [GUARD, deployDir], {
    env: {
      ...process.env,
      ...(fakeDocker ? { PATH: `${fakeDocker}:${process.env.PATH}` } : {}),
      ...env,
    },
    encoding: "utf8",
  });
  return { status: result.status, output: result.stdout + result.stderr, deployDir };
}

const LOOPBACK_BINDINGS = (extra = "") => JSON.stringify({
  "8420/tcp": [{ HostIp: "127.0.0.1", HostPort: "8420" }],
  "8125/tcp": [{ HostIp: "127.0.0.1", HostPort: "8125" }],
  "8424/tcp": [{ HostIp: "127.0.0.1", HostPort: "8424" }],
  "8096/tcp": [{ HostIp: "127.0.0.1", HostPort: "8096" }],
  ...(extra ? JSON.parse(extra) : {}),
});

const GOOD_SCRIPTS = {
  "start-memory-core.sh": '#!/usr/bin/env bash\n# comment mentioning -p "8420:8420" must be ignored\nmkdir -p "$CORE_CONFIG_DIR"\n-p "${MEMORY_CORE_HOST_BIND:-127.0.0.1}:${MEMORY_CORE_PORT}:8420"\n',
  "start-memory-hub.sh": '#!/usr/bin/env bash\n-p "${MEMORY_HUB_HOST_BIND:-127.0.0.1}:${PANEL_PORT}:8125"\n-p "${MEMORY_HUB_HOST_BIND:-127.0.0.1}:${KNOWLEDGE_PORT}:8424"\n',
  "start-proxy.sh": '#!/usr/bin/env bash\nmkdir -p "$CONFIG_DIR"\n-p "${MEMORY_PROXY_HOST_BIND:-127.0.0.1}:${PROXY_PORT}:8096"\n',
};

function dockerHandler({ bindings = LOOPBACK_BINDINGS(), states = {} } = {}) {
  return `
case "$1" in
  info) exit 0 ;;
  inspect)
    case "$2" in
      tdai-memory-core) [[ "$3" == "--format" && "$4" == *PortBindings* ]] && echo '${JSON.stringify({ "8420/tcp": [{ HostIp: "127.0.0.1", HostPort: "8420" }] })}' && exit 0
        [[ "$4" == *State.Status* ]] && echo "running healthy" && exit 0 ;;
      tdai-memory-hub) [[ "$3" == "--format" && "$4" == *PortBindings* ]] && echo '${JSON.stringify({ "8125/tcp": [{ HostIp: "127.0.0.1", HostPort: "8125" }], "8424/tcp": [{ HostIp: "127.0.0.1", HostPort: "8424" }] })}' && exit 0
        [[ "$4" == *State.Status* ]] && echo "running healthy" && exit 0 ;;
      tdai-proxy) [[ "$3" == "--format" && "$4" == *PortBindings* ]] && echo '${JSON.stringify({ "8096/tcp": [{ HostIp: "127.0.0.1", HostPort: "8096" }] })}' && exit 0
        [[ "$4" == *State.Status* ]] && echo "running healthy" && exit 0 ;;
    esac
    echo '{}' ; exit 0 ;;
esac
exit 0
`;
}

// G1: 全部正确 → PASS
{
  const r = runGuard({ dockerHandler: dockerHandler(), deployScripts: GOOD_SCRIPTS });
  assert.equal(r.status, 0, `expected PASS, got:\n${r.output}`);
  assert.ok(r.output.includes("GUARD PASS"));
  console.log("G1 exact match → PASS: PASS");
}

// G2: 缺端口（hub 只发 8125）→ FAIL
{
  const r = runGuard({
    dockerHandler: dockerHandler({
      bindings: JSON.stringify({
        "8420/tcp": [{ HostIp: "127.0.0.1", HostPort: "8420" }],
        "8125/tcp": [{ HostIp: "127.0.0.1", HostPort: "8125" }],
        "8096/tcp": [{ HostIp: "127.0.0.1", HostPort: "8096" }],
      }),
    }),
    deployScripts: GOOD_SCRIPTS,
  });
  // fake docker 的 hub 分支固定返回双端口，这里用自定义 handler 更直接：
  const custom = `
case "$1" in
  info) exit 0 ;;
  inspect)
    case "$2" in
      tdai-memory-core) [[ "$4" == *PortBindings* ]] && echo '{"8420/tcp":[{"HostIp":"127.0.0.1","HostPort":"8420"}]}' && exit 0; echo "running healthy" ;;
      tdai-memory-hub) [[ "$4" == *PortBindings* ]] && echo '{"8125/tcp":[{"HostIp":"127.0.0.1","HostPort":"8125"}]}' && exit 0; echo "running healthy" ;;
      tdai-proxy) [[ "$4" == *PortBindings* ]] && echo '{"8096/tcp":[{"HostIp":"127.0.0.1","HostPort":"8096"}]}' && exit 0; echo "running healthy" ;;
    esac ;;
esac
exit 0
`;
  const r2 = runGuard({ dockerHandler: custom, deployScripts: GOOD_SCRIPTS });
  assert.equal(r2.status, 1, `missing port must FAIL:\n${r2.output}`);
  assert.ok(r2.output.includes("missing required published port 8424"));
  console.log("G2 missing required port → FAIL: PASS");
}

// G3: 0.0.0.0 暴露 → FAIL
{
  const r = runGuard({
    dockerHandler: `
case "$1" in
  info) exit 0 ;;
  inspect)
    case "$2" in
      tdai-memory-core) [[ "$4" == *PortBindings* ]] && echo '{"8420/tcp":[{"HostIp":"0.0.0.0","HostPort":"8420"}]}' && exit 0; echo "running healthy" ;;
      tdai-memory-hub) [[ "$4" == *PortBindings* ]] && echo '{"8125/tcp":[{"HostIp":"0.0.0.0","HostPort":"8125"}],"8424/tcp":[{"HostIp":"0.0.0.0","HostPort":"8424"}]}' && exit 0; echo "running healthy" ;;
      tdai-proxy) [[ "$4" == *PortBindings* ]] && echo '{"8096/tcp":[{"HostIp":"0.0.0.0","HostPort":"8096"}]}' && exit 0; echo "running healthy" ;;
    esac ;;
esac
exit 0
`,
    deployScripts: GOOD_SCRIPTS,
  });
  assert.equal(r.status, 1);
  assert.ok(r.output.includes("must be 127.0.0.1"));
  console.log("G3 wildcard bind → FAIL: PASS");
}

// G4: IPv6 通配 → FAIL
{
  const r = runGuard({
    dockerHandler: `
case "$1" in
  info) exit 0 ;;
  inspect)
    case "$2" in
      tdai-memory-core) [[ "$4" == *PortBindings* ]] && echo '{"8420/tcp":[{"HostIp":"::","HostPort":"8420"}]}' && exit 0; echo "running healthy" ;;
      tdai-memory-hub) [[ "$4" == *PortBindings* ]] && echo '{"8125/tcp":[{"HostIp":"::","HostPort":"8125"}],"8424/tcp":[{"HostIp":"::","HostPort":"8424"}]}' && exit 0; echo "running healthy" ;;
      tdai-proxy) [[ "$4" == *PortBindings* ]] && echo '{"8096/tcp":[{"HostIp":"::","HostPort":"8096"}]}' && exit 0; echo "running healthy" ;;
    esac ;;
esac
exit 0
`,
    deployScripts: GOOD_SCRIPTS,
  });
  assert.equal(r.status, 1);
  assert.ok(r.output.includes("must be 127.0.0.1"));
  console.log("G4 IPv6 wildcard → FAIL: PASS");
}

// G5: 容器 stopped → FAIL
{
  const r = runGuard({
    dockerHandler: `
case "$1" in
  info) exit 0 ;;
  inspect)
    case "$2" in
      tdai-memory-core) [[ "$4" == *PortBindings* ]] && echo '{"8420/tcp":[{"HostIp":"127.0.0.1","HostPort":"8420"}]}' && exit 0; echo "exited 0" ;;
      tdai-memory-hub) [[ "$4" == *PortBindings* ]] && echo '{"8125/tcp":[{"HostIp":"127.0.0.1","HostPort":"8125"}],"8424/tcp":[{"HostIp":"127.0.0.1","HostPort":"8424"}]}' && exit 0; echo "running healthy" ;;
      tdai-proxy) [[ "$4" == *PortBindings* ]] && echo '{"8096/tcp":[{"HostIp":"127.0.0.1","HostPort":"8096"}]}' && exit 0; echo "running healthy" ;;
    esac ;;
esac
exit 0
`,
    deployScripts: GOOD_SCRIPTS,
  });
  assert.equal(r.status, 1);
  assert.ok(r.output.includes("not running"));
  console.log("G5 stopped container → FAIL: PASS");
}

// G6: 启动脚本缺失 → FAIL
{
  const r = runGuard({
    dockerHandler: dockerHandler(),
    deployScripts: {
      "start-memory-core.sh": GOOD_SCRIPTS["start-memory-core.sh"],
      "start-memory-hub.sh": GOOD_SCRIPTS["start-memory-hub.sh"],
      // proxy 脚本缺失
    },
  });
  assert.equal(r.status, 1);
  assert.ok(r.output.includes("start script missing"));
  console.log("G6 missing script → FAIL: PASS");
}

// G7: 旧版脚本（裸 0.0.0.0 发布）→ FAIL（注释假命中不豁免）
{
  const r = runGuard({
    dockerHandler: dockerHandler(),
    deployScripts: {
      ...GOOD_SCRIPTS,
      "start-proxy.sh": '#!/usr/bin/env bash\n# binds 127.0.0.1 by default via ${MEMORY_PROXY_HOST_BIND:-127.0.0.1} (comment)\n-p "${PROXY_PORT}:8096"\n',
    },
  });
  assert.equal(r.status, 1);
  assert.ok(r.output.includes("not loopback-bound"));
  console.log("G7 legacy wildcard script (comment decoy) → FAIL: PASS");
}

// G8: 错误的环境覆盖 → FAIL
{
  const r = runGuard({
    dockerHandler: dockerHandler(),
    deployScripts: GOOD_SCRIPTS,
    env: { MEMORY_HUB_HOST_BIND: "0.0.0.0" },
  });
  assert.equal(r.status, 1);
  assert.ok(r.output.includes("MEMORY_HUB_HOST_BIND=0.0.0.0"));
  console.log("G8 bad env override → FAIL: PASS");
}

// G9: 未批准额外端口 → FAIL
{
  const r = runGuard({
    dockerHandler: `
case "$1" in
  info) exit 0 ;;
  inspect)
    case "$2" in
      tdai-memory-core) [[ "$4" == *PortBindings* ]] && echo '{"8420/tcp":[{"HostIp":"127.0.0.1","HostPort":"8420"}]}' && exit 0; echo "running healthy" ;;
      tdai-memory-hub) [[ "$4" == *PortBindings* ]] && echo '{"8125/tcp":[{"HostIp":"127.0.0.1","HostPort":"8125"}],"8424/tcp":[{"HostIp":"127.0.0.1","HostPort":"8424"}],"9999/tcp":[{"HostIp":"127.0.0.1","HostPort":"9999"}]}' && exit 0; echo "running healthy" ;;
      tdai-proxy) [[ "$4" == *PortBindings* ]] && echo '{"8096/tcp":[{"HostIp":"127.0.0.1","HostPort":"8096"}]}' && exit 0; echo "running healthy" ;;
    esac ;;
esac
exit 0
`,
    deployScripts: GOOD_SCRIPTS,
  });
  assert.equal(r.status, 1);
  assert.ok(r.output.includes("unapproved extra port 9999"));
  console.log("G9 unapproved extra port → FAIL: PASS");
}

// G10: 批准的额外端口 → PASS
{
  const r = runGuard({
    dockerHandler: `
case "$1" in
  info) exit 0 ;;
  inspect)
    case "$2" in
      tdai-memory-core) [[ "$4" == *PortBindings* ]] && echo '{"8420/tcp":[{"HostIp":"127.0.0.1","HostPort":"8420"}]}' && exit 0; echo "running healthy" ;;
      tdai-memory-hub) [[ "$4" == *PortBindings* ]] && echo '{"8125/tcp":[{"HostIp":"127.0.0.1","HostPort":"8125"}],"8424/tcp":[{"HostIp":"127.0.0.1","HostPort":"8424"}],"9999/tcp":[{"HostIp":"127.0.0.1","HostPort":"9999"}]}' && exit 0; echo "running healthy" ;;
      tdai-proxy) [[ "$4" == *PortBindings* ]] && echo '{"8096/tcp":[{"HostIp":"127.0.0.1","HostPort":"8096"}]}' && exit 0; echo "running healthy" ;;
    esac ;;
esac
exit 0
`,
    deployScripts: GOOD_SCRIPTS,
    env: { APPROVED_EXTRA_PORTS: "9999" },
  });
  assert.equal(r.status, 0, `approved extra port must PASS:\n${r.output}`);
  console.log("G10 approved extra port → PASS: PASS");
}

// G11: 无端口发布的容器（旧版 guard 的误报源）→ FAIL
{
  const r = runGuard({
    dockerHandler: `
case "$1" in
  info) exit 0 ;;
  inspect)
    case "$2" in
      tdai-memory-core) [[ "$4" == *PortBindings* ]] && echo '{}' && exit 0; echo "running healthy" ;;
      tdai-memory-hub) [[ "$4" == *PortBindings* ]] && echo '{"8125/tcp":[{"HostIp":"127.0.0.1","HostPort":"8125"}],"8424/tcp":[{"HostIp":"127.0.0.1","HostPort":"8424"}]}' && exit 0; echo "running healthy" ;;
      tdai-proxy) [[ "$4" == *PortBindings* ]] && echo '{"8096/tcp":[{"HostIp":"127.0.0.1","HostPort":"8096"}]}' && exit 0; echo "running healthy" ;;
    esac ;;
esac
exit 0
`,
    deployScripts: GOOD_SCRIPTS,
  });
  assert.equal(r.status, 1);
  assert.ok(r.output.includes("no host port bindings"));
  console.log("G11 no published ports → FAIL (no false PASS): PASS");
}
