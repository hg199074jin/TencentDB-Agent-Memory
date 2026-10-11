#!/usr/bin/env bash
# GPT-AM-R3 严格部署门禁：Memory 栈四端口必须且只能绑 127.0.0.1，容器必须运行，
# 启动脚本必须实际发布 loopback（解析 -p 参数，不靠注释/grep 字样）。
#
# 退出码：0 = PASS（可放行部署）；1 = FAIL（列出全部违例）；2 = 用法/环境错误。
# 设计原则：缺端口、多端口、IPv6 通配、容器停止、脚本缺失、假覆盖、注释命中，一律 FAIL。
set -uo pipefail

DEPLOY_DIR="${1:-/Volumes/ORICO/Projects/TencentDB-Agent-Memory/deploy/global-images}"

# ── 期望矩阵（唯一事实源；新增暴露端口必须显式批准后改这里）──────────────────
EXPECTED_CORE=(tdai-memory-core 8420)
EXPECTED_HUB=(tdai-memory-hub 8125 8424)
EXPECTED_PROXY=(tdai-proxy 8096)
ALL_CONTAINERS=(tdai-memory-core tdai-memory-hub tdai-proxy)
# 允许的额外发布端口（默认空；确有外部依赖须在此显式列出并注明批准单号）
APPROVED_EXTRA_PORTS="${APPROVED_EXTRA_PORTS:-}"

violations=()

note() { printf '%s\n' "$*"; }
bad() { violations+=("$1"); note "FAIL  $1"; }
ok() { note "OK    $1"; }

# ── 0. docker 可用性 ────────────────────────────────────────────────────────
if ! command -v docker >/dev/null 2>&1; then
  note "FAIL  docker CLI not found"
  exit 2
fi
if ! docker info >/dev/null 2>&1; then
  note "FAIL  docker daemon not reachable"
  exit 2
fi

container_port_list() {
  docker inspect "$1" --format '{{json .HostConfig.PortBindings}}' 2>/dev/null
}

container_state() {
  docker inspect "$1" --format '{{.State.Status}} {{.State.Health.Status}}' 2>/dev/null
}

# ── 1. 容器存在、运行中 ──────────────────────────────────────────────────────
for c in "${ALL_CONTAINERS[@]}"; do
  if ! docker inspect "$c" >/dev/null 2>&1; then
    bad "container $c does not exist"
    continue
  fi
  read -r status health <<<"$(container_state "$c")"
  if [[ "$status" != "running" ]]; then
    bad "container $c is not running (status=$status)"
  elif [[ -n "${health:-}" && "$health" != "healthy" && "$health" != "none" ]]; then
    bad "container $c is running but health=$health"
  else
    ok "container $c running${health:+ (health=$health)}"
  fi
done

# ── 2. 端口绑定：精确匹配期望（缺一个/多一个/非 loopback/IPv6 都 FAIL）─────────
check_expected() {
  local container="$1"; shift
  local expected=("$@")
  local json
  json="$(container_port_list "$container")"
  if [[ -z "$json" ]]; then
    bad "$container has no host port bindings (expected: ${expected[*]})"
    return
  fi
  # 提取 "container_port host_ip:host_port" 行
  local actual
  actual="$(printf '%s' "$json" | jq -r 'to_entries[] | (.key | split("/")[0]) as $k | .value[]? | "\($k) \(.HostIp // "0.0.0.0") \(.HostPort)"')"
  if [[ -z "$actual" ]]; then
    bad "$container has no host port bindings (expected: ${expected[*]})"
    return
  fi
  local -A seen=()
  while read -r cport hip hport; do
    [[ -z "${cport:-}" ]] && continue
    seen["$cport"]=1
    if [[ "$hip" != "127.0.0.1" ]]; then
      bad "$container publishes $cport on $hip:$hport (must be 127.0.0.1)"
    else
      ok "$container $cport → 127.0.0.1:$hport"
    fi
  done <<<"$actual"
  # 期望端口必须逐个出现
  for want in "${expected[@]}"; do
    if [[ -z "${seen[$want]:-}" ]]; then
      bad "$container is missing required published port $want"
    fi
  done
  # 额外端口：仅当显式批准
  for have in "${!seen[@]}"; do
    local allowed=0
    for want in "${expected[@]}"; do [[ "$have" == "$want" ]] && allowed=1; done
    if [[ $allowed -eq 0 ]]; then
      if [[ ",$APPROVED_EXTRA_PORTS," == *",$have,"* ]]; then
        ok "$container extra port $have is explicitly approved"
      else
        bad "$container publishes unapproved extra port $have"
      fi
    fi
  done
}

check_expected "${EXPECTED_CORE[0]}" "${EXPECTED_CORE[@]:1}"
check_expected "${EXPECTED_HUB[0]}" "${EXPECTED_HUB[@]:1}"
check_expected "${EXPECTED_PROXY[0]}" "${EXPECTED_PROXY[@]:1}"

# ── 3. 启动脚本：解析实际 -p 参数（忽略注释行），必须全部 loopback ─────────────
#    同时识别两种形态：裸 `${PORT}:8420`（旧版，FAIL）与 `${BIND:-127.0.0.1}:${PORT}:8420`。
check_script() {
  local path="$1"
  if [[ ! -f "$path" ]]; then
    bad "start script missing: $path (cannot verify future deploys)"
    return
  fi
  # 去注释后取 docker 发布参数：-p 的值必须含端口分隔冒号（排除 mkdir -p "$DIR" 等误命中）
  local publishes
  publishes="$(sed 's/#.*//' "$path" | grep -oE '\-p[= ]+"[^"]*:[^"]*"' | sed -E 's/-p[= ]+"//; s/"$//')"
  if [[ -z "$publishes" ]]; then
    bad "$path has no -p publish lines (unexpected layout)"
    return
  fi
  local line
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    # 形如 [bind:]container_port:host_port 或 [bind:]host:container
    if [[ "$line" == *":127.0.0.1:"* ]] || [[ "$line" == 127.0.0.1:* ]]; then
      ok "$(basename "$path") -p \"$line\" (loopback)"
    elif [[ "$line" =~ ^\$\{[A-Z_]+:-127\.0\.0\.1\} ]]; then
      ok "$(basename "$path") -p \"$line\" (loopback default)"
    else
      bad "$(basename "$path") -p \"$line\" is not loopback-bound"
    fi
  done <<<"$publishes"
  # 覆盖变量若被错误设置（非 loopback 且非空）也 FAIL
  local overrides
  overrides="$(sed 's/#.*//' "$path" | grep -oE '\$\{[A-Z_]+_HOST_BIND[^}]*\}' | sort -u)"
  if [[ -n "$overrides" ]]; then
    while IFS= read -r ov; do
      [[ -z "$ov" ]] && continue
      if [[ "$ov" != *':-127.0.0.1}'* ]]; then
        bad "$(basename "$path") override $ov does not default to 127.0.0.1"
      fi
    done <<<"$overrides"
  fi
  # 环境变量实际覆盖检查（部署机上的显式设置）
  local var
  for var in MEMORY_CORE_HOST_BIND MEMORY_HUB_HOST_BIND MEMORY_PROXY_HOST_BIND; do
    local val="${!var:-}"
    if [[ -n "$val" && "$val" != "127.0.0.1" ]]; then
      bad "environment $var=$val would expose LAN on next start"
    fi
  done
}

check_script "$DEPLOY_DIR/start-memory-core.sh" 8420
check_script "$DEPLOY_DIR/start-memory-hub.sh" 8125 8424
check_script "$DEPLOY_DIR/start-proxy.sh" 8096

# ── 4. 汇总 ─────────────────────────────────────────────────────────────────
if [[ ${#violations[@]} -eq 0 ]]; then
  note "GUARD PASS: 4 ports loopback-only, containers healthy, scripts publish loopback"
  exit 0
fi
note "GUARD FAIL: ${#violations[@]} violation(s) — see FAIL lines above"
exit 1
