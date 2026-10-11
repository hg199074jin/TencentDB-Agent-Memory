#!/usr/bin/env bash
# GPT-AM-SEC-001 可复用补丁：将 start-memory-core.sh 的 host publish 固定为 127.0.0.1。
# 幂等；保留 MEMORY_CORE_HOST_BIND 覆盖变量；不动容器内监听（仍 0.0.0.0，网桥别名访问不受影响）。
# 用法：bash bind-core-loopback.sh /path/to/deploy/global-images
set -euo pipefail

DEPLOY_DIR="${1:-/Volumes/ORICO/Projects/TencentDB-Agent-Memory/deploy/global-images}"
SCRIPT="$DEPLOY_DIR/start-memory-core.sh"

[[ -f "$SCRIPT" ]] || { echo "not found: $SCRIPT" >&2; exit 1; }

if grep -q 'MEMORY_CORE_HOST_BIND' "$SCRIPT"; then
  echo "already patched: $SCRIPT"
  exit 0
fi

cp "$SCRIPT" "$SCRIPT.pre-sec001.bak"
python3 - "$SCRIPT" <<'PY'
import sys
path = sys.argv[1]
s = open(path).read()
old = '-p "${MEMORY_CORE_PORT}:8420" \\'
new = '-p "${MEMORY_CORE_HOST_BIND:-127.0.0.1}:${MEMORY_CORE_PORT}:8420" \\'
assert old in s, "expected -p line not found (upstream layout changed?)"
open(path, "w").write(s.replace(old, new, 1))
PY

echo "patched: $SCRIPT (backup: $SCRIPT.pre-sec001.bak)"
echo "容器替换命令模式（保持镜像/卷/网络/env 不变，仅改 host bind）："
echo '  docker run -d --name tdai-memory-core --network tdai-memory-stack --network-alias memory-core \'
echo '    -p 127.0.0.1:8420:8420 -v tdai-memory-core-data:/data/tdai-memory \'
echo '    -v "<gateway.yaml>:/data/config/tdai-gateway.yaml:ro" --env-file <0600 env file> <image-digest>'
