#!/usr/bin/env bash
# GPT-AM-SEC-001/002 统一 drift guard：核对四端口 host publish 是否均仅绑 127.0.0.1。
# 只读；退出码 0=全部收敛，1=存在暴露。部署前后各跑一次。
set -euo pipefail

fail=0
for container in tdai-memory-core tdai-memory-hub tdai-proxy; do
  if ! docker inspect "$container" >/dev/null 2>&1; then
    echo "MISSING  $container (not running?)"
    fail=1
    continue
  fi
  bindings=$(docker inspect "$container" --format '{{json .HostConfig.PortBindings}}' \
    | jq -r 'to_entries[] | .key as $k | .value[]? | "\($k) \(.HostIp // "0.0.0.0"):\(.HostPort)"')
  if [[ -z "$bindings" ]]; then
    echo "OK       $container (no host ports published)"
    continue
  fi
  while read -r line; do
    port="${line%% *}"
    host="${line#* }"
    ip="${host%%:*}"
    if [[ "$ip" == "127.0.0.1" ]]; then
      echo "OK       $container $port → $host"
    else
      echo "EXPOSED  $container $port → $host (expected 127.0.0.1)"
      fail=1
    fi
  done <<< "$bindings"
done

# 启动脚本 drift 检查（防止未打补丁的副本重新全接口发布）
DEPLOY_DIR="${1:-/Volumes/ORICO/Projects/TencentDB-Agent-Memory/deploy/global-images}"
for script in start-memory-core.sh start-memory-hub.sh start-proxy.sh; do
  path="$DEPLOY_DIR/$script"
  [[ -f "$path" ]] || continue
  if rg -q 'HOST_BIND:-127\.0\.0\.1' "$path"; then
    echo "OK       $path defaults to loopback"
  else
    echo "DRIFT    $path missing loopback default (would re-expose on next start)"
    fail=1
  fi
done

if [[ $fail -eq 0 ]]; then
  echo "GUARD PASS: all host publishes are loopback-only and scripts are patched"
else
  echo "GUARD FAIL: exposure or drift detected — see lines above"
fi
exit $fail
