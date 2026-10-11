#!/usr/bin/env bash
# GPT-AM-R3 安全上线准备 E2E 一键复现（隔离环境，不触生产）。
# 顺序：隔离强 Bearer Core → 合成用户/team/agent → M4 越权探测 →
#       Proxy Bearer RED（未打补丁源码）→ GREEN（当前源码）→ 负向场景 → 清理。
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
E2E_DIR="$REPO/ops/e2e"
CONTAINER=am-r3-core
NET=am-r3-net
VOLUME=am-r3-core-data
PORT=18420
BEARER=r3-test-service-bearer
PROXY_SRC="$REPO/MemoryProxy/src"
CORE_IMAGE="agentmemory/memory-core@sha256:338847edc6464ed20a5f2a936ca2efa7fc71e188410836ebe9a711c1bc53fe84"
WORK="$(mktemp -d /tmp/am-r3-e2e.XXXXXX)"

cleanup() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  docker rm -f am-r3-proxy-red am-r3-proxy-green-bearer am-r3-proxy-green-wrong-bearer am-r3-proxy-green-no-userkey >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  docker volume rm "$VOLUME" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

# ── 1. 隔离强 Bearer Core ──────────────────────────────────────────────────
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
docker network create "$NET" >/dev/null 2>&1 || true
cat > "$WORK/gateway.yaml" <<YAML
deployMode: standalone
stateBackend: local
server:
  port: 8420
  host: 0.0.0.0
data:
  baseDir: /data/tdai-memory
llm:
  baseUrl: "https://open.bigmodel.cn/api/paas/v4"
  apiKey: "e2e-dummy"
  model: "glm-5.3-flash"
  maxTokens: 32000
  timeoutMs: 300000
memory:
  promptMode: chat
  capture: { enabled: true }
  extraction: { enabled: true, enableDedup: true, maxMemoriesPerSession: 20 }
YAML
docker run -d --name "$CONTAINER" --network "$NET" --network-alias am-r3-core \
  -p "127.0.0.1:${PORT}:8420" -v "${VOLUME}:/data/tdai-memory" \
  -v "$WORK/gateway.yaml:/data/config/tdai-gateway.yaml:ro" \
  -e TDAI_GATEWAY_PORT=8420 -e TDAI_GATEWAY_HOST=0.0.0.0 \
  -e "TDAI_GATEWAY_API_KEY=${BEARER}" -e TDAI_DATA_DIR=/data/tdai-memory \
  -e STORE_MODE=sqlite -e TDAI_GATEWAY_CONFIG=/data/config/tdai-gateway.yaml \
  "$CORE_IMAGE" >/dev/null
sleep 6

api() { curl -s -m 10 -X POST "http://127.0.0.1:${PORT}$1" -H "Authorization: Bearer ${BEARER}" -H 'x-tdai-service-id: default' -H 'Content-Type: application/json' "${@:2}"; }

echo "── 强 Bearer 生效验证（无/错 Bearer 必须 401）──"
code_no=$(curl -s -m 5 -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:${PORT}/v3/core/read" -H "Authorization: Bearer wrong" -H 'x-tdai-service-id: default' -H 'Content-Type: application/json' -d '{}')
echo "wrong bearer → $code_no (expect 401)"

echo "── 2. 合成用户/team/agent ──"
INIT=$(api /v3/internal/meta/user/init-admin -d '{"username":"r3-synthetic"}')
USER_KEY=$(printf '%s' "$INIT" | sed -n 's/.*"user_key":"\([^"]*\)".*/\1/p')
USER_ID=$(printf '%s' "$INIT" | sed -n 's/.*"user_id":"\([^"]*\)".*/\1/p')
[[ -n "$USER_KEY" && -n "$USER_ID" ]] || { echo "init-admin failed: $INIT" >&2; exit 1; }
TEAM=$(api /v3/meta/team/create -H "x-tdai-user-key: ${USER_KEY}" -d "{\"name\":\"r3-syn-team\",\"owner_user_id\":\"${USER_ID}\"}" | sed -n 's/.*"team_id":"\([^"]*\)".*/\1/p')
AGENT=$(api /v3/meta/agent/create -H "x-tdai-user-key: ${USER_KEY}" -d "{\"team_id\":\"${TEAM}\",\"owner_user_id\":\"${USER_ID}\",\"name\":\"r3-syn-agent\"}" | sed -n 's/.*"agent_id":"\([^"]*\)".*/\1/p')
[[ -n "$TEAM" && -n "$AGENT" ]] || { echo "team/agent creation failed" >&2; exit 1; }
echo "synthetic user=${USER_KEY:0:10}… team=$TEAM agent=$AGENT"

echo "── 3. M4 越权探测（预期：五种全部 allowed=true = 敞口 RED）──"
AM_R3_USER_A="$USER_KEY" node "$E2E_DIR/scoped-identity-probe.mjs" | tail -3

echo "── 4. Proxy Bearer RED（未打补丁源码）──"
git -C "$REPO" stash list >/dev/null 2>&1 || true
RED_SRC="$WORK/unpatched-src"
mkdir -p "$RED_SRC"
cp -R "$PROXY_SRC/." "$RED_SRC/"
# 用 HEAD（未打补丁）的 auth.ts 覆盖，构造 RED 版本；types/config 的补丁对
# verifyUserKey 无头文件影响（serviceBearer 缺省即空），行为等价于旧版。
git -C "$REPO" show "HEAD:MemoryProxy/src/auth.ts" > "$RED_SRC/auth.ts"
grep -q 'serviceBearer' "$RED_SRC/auth.ts" && { echo "RED src construction failed" >&2; exit 1; } || true
AM_R3_USER_KEY="$USER_KEY" node "$E2E_DIR/proxy-bearer-e2e.mjs" "$RED_SRC" red | rg '"httpStatus"|"authRejected"|"upstreamReached"'

echo "── 5. GREEN（当前分支源码）──"
AM_R3_USER_KEY="$USER_KEY" node "$E2E_DIR/proxy-bearer-e2e.mjs" "$PROXY_SRC" green-bearer | rg '"httpStatus"|"authRejected"|"upstreamReached"'

echo "── 6. 负向（错误服务 Bearer / 缺失 user key / 错误 user key）──"
AM_R3_USER_KEY="$USER_KEY" node "$E2E_DIR/proxy-bearer-e2e.mjs" "$PROXY_SRC" green-wrong-bearer | rg '"httpStatus"|"authRejected"'
AM_R3_USER_KEY="$USER_KEY" node "$E2E_DIR/proxy-bearer-e2e.mjs" "$PROXY_SRC" green-no-userkey | rg '"httpStatus"|"authRejected"'
AM_R3_USER_KEY="sk-mem-0000000000000000000000000000000000000000" node "$E2E_DIR/proxy-bearer-e2e.mjs" "$PROXY_SRC" green-bearer | rg '"httpStatus"|"authRejected"'

echo "── 完成（隔离环境已清理）──"
