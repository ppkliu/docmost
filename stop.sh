#!/usr/bin/env bash
# 一鍵停止 Docmost(prod 或 dev),可選清掉 valkey 快取。
#
# 用法:
#   ./stop.sh prod          # 停 prod(.env + docker-compose.prod.yml)
#   ./stop.sh dev           # 停 dev (.env.dev + docker-compose.dev.yml)
#   ./stop.sh prod clean    # 停 prod 並清掉該模式的 valkey 快取(不動 db 資料)
#   ./stop.sh prod purge    # 停 prod 並一併移除 volumes(down -v,連匿名 volume)
set -euo pipefail
cd "$(dirname "$0")"

MODE="${1:-prod}"
OPT="${2:-}"

red(){ printf '\033[31m%s\033[0m\n' "$*"; }
grn(){ printf '\033[32m%s\033[0m\n' "$*"; }
ylw(){ printf '\033[33m%s\033[0m\n' "$*"; }
bold(){ printf '\033[1m%s\033[0m\n' "$*"; }

# ---- compose CLI ----
if docker compose version >/dev/null 2>&1; then
  DC="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  DC="docker-compose"
else
  red "找不到 docker compose / docker-compose。"; exit 1
fi

# ---- 模式 -> 檔案 / valkey 快取路徑 ----
case "$MODE" in
  prod) ENV_FILE=".env";     COMPOSE_FILE="docker-compose.prod.yml"; VALKEY_DIR="./data/prod/valkey" ;;
  dev)  ENV_FILE=".env.dev"; COMPOSE_FILE="docker-compose.dev.yml";  VALKEY_DIR="./data/dev/valkey" ;;
  *)    red "用法: ./stop.sh [prod|dev] [clean|purge]"; exit 1 ;;
esac

[ -f "$ENV_FILE" ]     || { red "缺少 $ENV_FILE"; exit 1; }
[ -f "$COMPOSE_FILE" ] || { red "缺少 $COMPOSE_FILE"; exit 1; }

DCX=($DC --env-file "$ENV_FILE" -f "$COMPOSE_FILE")

# ---- 停止 ----
if [ "$OPT" = "purge" ]; then
  bold "==> 停止並移除 volumes [$MODE]  (down -v)"
  "${DCX[@]}" down -v
else
  bold "==> 停止 Docmost [$MODE]  (down)"
  "${DCX[@]}" down
fi
grn "  已停止。"

# ---- 可選:清 valkey 快取 ----
if [ "$OPT" = "clean" ]; then
  if [ -d "$VALKEY_DIR" ]; then
    bold "==> 清除 valkey 快取:$VALKEY_DIR/*(不動 db 資料)"
    rm -rf "${VALKEY_DIR:?}/"* 2>/dev/null || sudo rm -rf "${VALKEY_DIR:?}/"*
    grn "  valkey 快取已清。"
  else
    ylw "  找不到 $VALKEY_DIR,略過清快取。"
  fi
fi

# ---- 殘留檢查 ----
left="$("${DCX[@]}" ps -q 2>/dev/null || true)"
if [ -n "$left" ]; then
  ylw "==> 仍有容器在運作:"
  "${DCX[@]}" ps || true
else
  grn "==> 此模式已無運作中的容器。"
fi
