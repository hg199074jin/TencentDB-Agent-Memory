#!/usr/bin/env bash
# 切换 proxy 上游模型（带记忆功能）
#
# 用法：
#   ./switch-model.sh            # 交互式选择模型
#   ./switch-model.sh minimax    # 直接切到 minimax
#   ./switch-model.sh glm        # 直接切到 glm
#
# 切换后：proxy 会重启并指向新模型。
# 注意：你还需要在 CC-switch 里切到对应的"XXX+记忆"供应商，
#       并确认 ANTHROPIC_AUTH_TOKEN 是你的 sk-mem- user_key（不是模型 API key）。

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"

# ── 可选模型列表 ──────────────────────────────────────────────
# 想加新模型，就在这里加一行。格式：名称|anthropic端点|模型ID|API Key
# API Key 填该模型的 sk-xxx（走 proxy 转发时用）
declare -A MODELS
MODELS=(
  ["minimax"]="https://api.minimaxi.com/anthropic/v1|MiniMax-M3|在此填MiniMax的APIKey"
  ["glm"]="https://open.bigmodel.cn/api/anthropic/v1|glm-5.2|在此填GLM的APIKey"
  ["mimo"]="https://token-plan-cn.xiaomimimo.com/anthropic/v1|mimo-v2.5-pro|在此填MiMo的APIKey"
)

echo "═══════════════════════════════════════════════════════════"
echo "  TencentDB-Agent-Memory · 切换记忆系统的上游模型"
echo "═══════════════════════════════════════════════════════════"
echo ""

# ── 选择模型 ──────────────────────────────────────────────────
CHOICE="${1:-}"
if [[ -z "$CHOICE" ]]; then
  echo "可选模型："
  for key in "${!MODELS[@]}"; do
    IFS='|' read -r url model _ <<< "${MODELS[$key]}"
    printf "  %-12s %s (%s)\n" "$key" "$model" "$url"
  done
  echo ""
  read -rp "请输入要切换到的模型（如 minimax）: " CHOICE
fi

if [[ -z "${MODELS[$CHOICE]:-}" ]]; then
  echo "[error] 未知模型: $CHOICE"
  echo "可用模型: ${!MODELS[*]}"
  exit 1
fi

IFS='|' read -r UPSTREAM_URL UPSTREAM_MODEL UPSTREAM_KEY <<< "${MODELS[$CHOICE]}"

# 检查 API Key 是否还是占位符
if [[ "$UPSTREAM_KEY" == 在此填* ]]; then
  echo "[error] 模型 $CHOICE 的 API Key 还没填。"
  echo "       请编辑本脚本（switch-model.sh），在 MODELS 数组里填入真实的 API Key。"
  exit 1
fi

echo "即将切换到："
echo "  模型:   $UPSTREAM_MODEL"
echo "  端点:   $UPSTREAM_URL"
echo ""
read -rp "确认切换？(y/N) " CONFIRM
[[ "$CONFIRM" =~ ^[Yy]$ ]] || { echo "已取消。"; exit 0; }

# ── 修改 .env ────────────────────────────────────────────────
ENV_FILE="$SCRIPT_DIR/.env"
info "更新 .env 里的 proxy 上游配置..."

# 用 sed 替换 PROXY_UPSTREAM_* 三行
sed -i.bak \
  -e "s|^PROXY_UPSTREAM_URL=.*|PROXY_UPSTREAM_URL=$UPSTREAM_URL|" \
  -e "s|^PROXY_UPSTREAM_API_KEY=.*|PROXY_UPSTREAM_API_KEY=$UPSTREAM_KEY|" \
  -e "s|^PROXY_UPSTREAM_MODEL=.*|PROXY_UPSTREAM_MODEL=$UPSTREAM_MODEL|" \
  "$ENV_FILE"

ok ".env 已更新"

# ── 重启 proxy ───────────────────────────────────────────────
info "重启 proxy（全栈模式）..."
cd "$SCRIPT_DIR"
PROXY_FULL_STACK=1 ./start-proxy.sh

echo ""
echo "═══════════════════════════════════════════════════════════"
ok "切换完成！proxy 现在转发到 $UPSTREAM_MODEL"
echo ""
echo "  ⚠️  还需要做一步："
echo "     在 CC-switch 里切到「${CHOICE}+记忆」供应商"
echo "     （如果还没有这个供应商，让我帮你建）"
echo ""
echo "  验证：启动 claude，问'我是谁'，应该还记得你是胡刚。"
echo "═══════════════════════════════════════════════════════════"
