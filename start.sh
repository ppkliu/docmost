#!/usr/bin/env bash
# 一鍵啟動 Docmost(prod 或 dev),啟動後顯示前台網址/port、各服務狀態,有錯就列出 log。
#
# 用法:
#   ./start.sh prod      # 用 .env + docker-compose.prod.yml
#   ./start.sh dev       # 用 .env.dev + docker-compose.dev.yml
#   ./start.sh prod logs # 啟動後接著跟著看 app log(可選第二參數)
set -euo pipefail
cd "$(dirname "$0")"

MODE="${1:-prod}"
FOLLOW="${2:-}"

# ---- 顏色 ----
red(){ printf '\033[31m%s\033[0m\n' "$*"; }
grn(){ printf '\033[32m%s\033[0m\n' "$*"; }
ylw(){ printf '\033[33m%s\033[0m\n' "$*"; }
bold(){ printf '\033[1m%s\033[0m\n' "$*"; }

# ---- 選擇 compose CLI(優先 v2)----
if docker compose version >/dev/null 2>&1; then
  DC="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  DC="docker-compose"
else
  red "找不到 docker compose / docker-compose,請先安裝。"; exit 1
fi

# ---- 模式 -> 檔案 / 服務名 / port 變數 ----
case "$MODE" in
  prod)
    ENV_FILE=".env";     COMPOSE_FILE="docker-compose.prod.yml"; APP_SVC="docmost"
    APP_PORT_VAR="APP_HOST_PORT";     APP_PORT_DEF="3010" ;;
  dev)
    ENV_FILE=".env.dev"; COMPOSE_FILE="docker-compose.dev.yml";  APP_SVC="docmost-dev"
    APP_PORT_VAR="DEV_APP_HOST_PORT"; APP_PORT_DEF="3011" ;;
  *)
    red "用法: ./start.sh [prod|dev] [logs]"; exit 1 ;;
esac

[ -f "$ENV_FILE" ]     || { red "缺少 $ENV_FILE"; exit 1; }
[ -f "$COMPOSE_FILE" ] || { red "缺少 $COMPOSE_FILE"; exit 1; }

# ---- 從 env 檔安全取值(不 source,避免特殊字元出包)----
getenv(){ grep -E "^$1=" "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"'; }
val(){ local v; v="$(getenv "$1")"; echo "${v:-$2}"; }

APP_PORT="$(val "$APP_PORT_VAR" "$APP_PORT_DEF")"
CLIENT_PORT="$(val DEV_CLIENT_HOST_PORT 5173)"   # dev 才用
# dev 的互動前端是 Vite(CLIENT_PORT);後端 server(APP_PORT)在 dev 只提供 API。
if [ "$MODE" = "dev" ]; then FRONT_PORT="$CLIENT_PORT"; else FRONT_PORT="$APP_PORT"; fi

# ---- compose v1 不支援 name: 欄位,先提醒 ----
if [ "$DC" = "docker-compose" ] && grep -q '^name:' "$COMPOSE_FILE"; then
  ylw "警告:$COMPOSE_FILE 含 'name:',需要 docker compose v2;你目前是 v1(docker-compose),可能會失敗。"
  ylw "      建議安裝 docker compose v2,或改用 base docker-compose.yml。"
fi

DCX=($DC --env-file "$ENV_FILE" -f "$COMPOSE_FILE")

# ---- prod:確保 image 存在(順序:本地 → pull → 用 Dockerfile build)----
if [ "$MODE" = "prod" ]; then
  IMG="$(val DOCMOST_IMAGE agentwiki-docmost:latest)"
  if docker image inspect "$IMG" >/dev/null 2>&1; then
    : # 本地已有,直接用
  elif docker pull "$IMG" >/dev/null 2>&1; then
    grn "已 pull 映像 $IMG"
  elif [ -f Dockerfile ]; then
    ylw "本地/registry 都沒有 $IMG,改用 Dockerfile build(第一次較久)…"
    NPM_REGISTRY_VAL="$(val NPM_REGISTRY https://registry.npmmirror.com)"
    NODE_IMAGE_VAL="$(val NODE_IMAGE node:22-slim)"
    docker build \
      --build-arg "NODE_IMAGE=$NODE_IMAGE_VAL" \
      --build-arg "NPM_REGISTRY=$NPM_REGISTRY_VAL" \
      -t "$IMG" .
  else
    red "找不到映像 $IMG,且無法 pull、本地也沒有 Dockerfile 可 build。請任選一種:"
    echo "  A) 用官方映像:在 $ENV_FILE 設 DOCMOST_IMAGE=docmost/docmost:latest 後重跑(會自動 pull)"
    echo "  B) 用打包映像:在建置機 ./pack-prod.sh 產生 tar.gz → FTP → 本機 docker load 後重跑"
    echo "  C) 自行 build:把 Dockerfile + 完整原始碼放到此目錄再重跑"
    exit 1
  fi
fi

# ---- 啟動 ----
bold "==> 啟動 Docmost [$MODE]  ($DC -f $COMPOSE_FILE --env-file $ENV_FILE)"
"${DCX[@]}" up -d

# ---- dev:手動套用 migration ----
# prod(NODE_ENV=production)開機會自動 migrate;dev(development)不會,
# 否則 DB 沒有任何表,會出現 relation "workspaces" does not exist。此步為 idempotent。
if [ "$MODE" = "dev" ] && [ "$(val DEV_AUTO_MIGRATE true)" = "true" ]; then
  bold "==> dev:套用資料庫 migration(migration:latest,idempotent)"
  mig_ok=0
  for ((i=0; i<10; i++)); do
    if "${DCX[@]}" exec -T docmost-dev pnpm --filter ./apps/server run migration:latest; then
      mig_ok=1; break
    fi
    ylw "   migration 尚未成功(DB 可能還沒就緒),3s 後重試 [$((i+1))/10]…"; sleep 3
  done
  [ "$mig_ok" = 1 ] || red "   migration 失敗;請查 db 服務與 DATABASE_URL,或手動:
     ${DCX[*]} exec docmost-dev pnpm --filter ./apps/server run migration:latest"
fi

# ---- 等待前台 port 開啟 ----
port_open(){ (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null && { exec 3>&- 3<&-; return 0; }; return 1; }
TIMEOUT=$([ "$MODE" = "dev" ] && echo 120 || echo 60)   # dev 要編譯,等久一點
bold "==> 等待前台 (127.0.0.1:$FRONT_PORT) 就緒,最多 ${TIMEOUT}s…"
ready=0
for ((i=0; i<TIMEOUT; i+=3)); do
  if port_open "$FRONT_PORT"; then ready=1; break; fi
  sleep 3; printf '.'
done
echo

# ---- 服務狀態 ----
bold "==> 服務狀態"
"${DCX[@]}" ps || true

# ---- 逐容器健康檢查 + 有問題就印 log ----
err=0
ids="$("${DCX[@]}" ps -q 2>/dev/null || true)"
for id in $ids; do
  name=$(docker inspect -f '{{.Name}}' "$id" 2>/dev/null | sed 's#^/##')
  status=$(docker inspect -f '{{.State.Status}}' "$id" 2>/dev/null || echo unknown)
  restarts=$(docker inspect -f '{{.RestartCount}}' "$id" 2>/dev/null || echo 0)
  if [ "$status" = "running" ] && [ "${restarts:-0}" -le 2 ]; then
    grn "  OK $name: $status (restarts=$restarts)"
  else
    err=1
    red "  X $name: $status (restarts=$restarts) — 最後 30 行 log:"
    docker logs --tail=30 "$id" 2>&1 | sed 's/^/      /'
  fi
done

# ---- 結果輸出 ----
echo
IP=$(hostname -I 2>/dev/null | awk '{print $1}')
if [ "$ready" = "1" ]; then
  grn "================ Docmost 已啟動 [$MODE] ================"
  bold " 前台網址:"
  echo  "   http://127.0.0.1:${FRONT_PORT}"
  [ -n "$IP" ] && echo "   http://${IP}:${FRONT_PORT}   (區網)"
  if [ "$MODE" = "dev" ]; then
    echo "   (dev 互動 UI = Vite ${FRONT_PORT};後端 API 在 http://127.0.0.1:${APP_PORT},不提供頁面)"
  fi
  echo " 容器內 app port: 3000"
  grn "======================================================="
else
  red "================ 前台尚未就緒 [$MODE] ================="
  red " 127.0.0.1:${FRONT_PORT} 在 ${TIMEOUT}s 內未開啟。"
  red " app 服務($APP_SVC)最後 40 行 log:"
  "${DCX[@]}" logs --tail=40 "$APP_SVC" 2>&1 | sed 's/^/   /' || true
  echo
  ylw " 常見原因:Redis/DB 未就緒、migration 失敗、port 被占用。"
  ylw " 可重試:  ./start.sh $MODE        再次啟動(idempotent)"
  ylw " 看完整 log: ${DCX[*]} logs -f $APP_SVC"
fi

# ---- 可選:跟著看 app log ----
if [ "$FOLLOW" = "logs" ]; then
  echo; bold "==> 跟著 $APP_SVC log(Ctrl-C 離開,容器仍在背景執行)"
  exec "${DCX[@]}" logs -f "$APP_SVC"
fi

[ "$err" = "0" ] && [ "$ready" = "1" ]
