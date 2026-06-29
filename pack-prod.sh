#!/usr/bin/env bash
# 將 production 環境打包成單一 .tar.gz,搬到另一台機器離線部署 / 更新。
# 輸出在 ./dist/(已被 .gitignore 忽略)。
#
# 兩種包:
#   完整包(預設):app + db + valkey 三個 image + 部署檔，首次部署用。
#   更新包(APP_ONLY=1):只含 app image，正式環境「只更新代碼」用,小很多。
#
# 用法:
#   ./pack-prod.sh                 # 完整包,用 package.json 版本號
#   ./pack-prod.sh 1.2.0           # 指定版本標籤
#   APP_ONLY=1 ./pack-prod.sh      # 只打包 app image(更新代碼用)
#   SKIP_BUILD=1 ./pack-prod.sh    # 跳過 docker build(沿用既有 image)
set -euo pipefail
cd "$(dirname "$0")"

bold(){ printf '\033[1m%s\033[0m\n' "$*"; }
grn(){ printf '\033[32m%s\033[0m\n' "$*"; }

command -v docker >/dev/null || { echo "需要 docker"; exit 1; }

VERSION="${1:-$(node -p "require('./package.json').version" 2>/dev/null || echo latest)}"
APP_IMAGE="${DOCMOST_IMAGE:-agentwiki-docmost:${VERSION}}"
APP_ONLY="${APP_ONLY:-0}"
OUT_DIR="dist"
if [ "$APP_ONLY" = "1" ]; then BUNDLE="docmost-prod-update-${VERSION}"; else BUNDLE="docmost-prod-${VERSION}"; fi
STAGE="${OUT_DIR}/${BUNDLE}"
TARBALL="${OUT_DIR}/${BUNDLE}.tar.gz"

bold "==> [1/6] build prod image: ${APP_IMAGE}  (APP_ONLY=${APP_ONLY})"
if [ "${SKIP_BUILD:-0}" = "1" ]; then
  echo "  SKIP_BUILD=1,沿用既有 image"
  docker image inspect "$APP_IMAGE" >/dev/null 2>&1 || { echo "找不到 $APP_IMAGE,請先 build"; exit 1; }
else
  docker build -t "$APP_IMAGE" .
fi
# 額外打 latest 標籤,讓 compose 的 DOCMOST_IMAGE 預設值(:latest)也對得上
docker tag "$APP_IMAGE" agentwiki-docmost:latest

bold "==> [2/6] 解析相依 image(完整包才會打包 db/valkey)"
DEP_IMAGES=$(grep -E '^[[:space:]]*image:' docker-compose.prod.yml \
  | sed -E 's/.*image:[[:space:]]*//' | tr -d '"' | grep -v '\${')
SAVE_IMAGES="$APP_IMAGE agentwiki-docmost:latest"
if [ "$APP_ONLY" = "1" ]; then
  echo "    APP_ONLY:只含 app,跳過 db/valkey"
else
  echo "$DEP_IMAGES" | sed 's/^/    /'
  for img in $DEP_IMAGES; do
    docker image inspect "$img" >/dev/null 2>&1 || { echo "  pull $img"; docker pull "$img"; }
  done
  SAVE_IMAGES="$SAVE_IMAGES $DEP_IMAGES"
fi

bold "==> [3/6] 準備部署檔(stage: ${STAGE})"
rm -rf "$STAGE"; mkdir -p "$STAGE"
cp docker-compose.prod.yml "$STAGE/"
echo "DOCMOST_IMAGE=${APP_IMAGE}" > "$STAGE/image.env"   # 本次 app image 標籤
if [ "$APP_ONLY" != "1" ]; then
  cp .env.example "$STAGE/.env.example"
  cp start.sh stop.sh "$STAGE/" 2>/dev/null || true
  cp START_STOP.md    "$STAGE/" 2>/dev/null || true
fi

bold "==> [4/6] 匯出 image -> images.tar"
# shellcheck disable=SC2086
docker save $SAVE_IMAGES -o "$STAGE/images.tar"

bold "==> [5/6] 產生部署端腳本與說明"
if [ "$APP_ONLY" = "1" ]; then
  # ---- 更新包:只換 app image,db/valkey 不動 ----
  cat > "$STAGE/update.sh" <<'UPD'
#!/usr/bin/env bash
# 部署端:只更新 app 代碼(換 app image),db/valkey 與資料保留。
# 用法: ./update.sh <既有部署目錄>   (該目錄需含原本部署的 .env)
set -euo pipefail
cd "$(dirname "$0")"
DEPLOY_DIR="${1:?用法: ./update.sh <既有部署目錄,含 .env>}"
[ -f "$DEPLOY_DIR/.env" ] || { echo "在 $DEPLOY_DIR 找不到 .env"; exit 1; }

echo "==> docker load 新 app image"
docker load -i images.tar

NEWTAG=$(grep '^DOCMOST_IMAGE=' image.env | cut -d= -f2-)
echo "==> 更新 $DEPLOY_DIR/.env 的 DOCMOST_IMAGE -> $NEWTAG"
if grep -q '^DOCMOST_IMAGE=' "$DEPLOY_DIR/.env"; then
  sed -i "s|^DOCMOST_IMAGE=.*|DOCMOST_IMAGE=${NEWTAG}|" "$DEPLOY_DIR/.env"
else
  echo "DOCMOST_IMAGE=${NEWTAG}" >> "$DEPLOY_DIR/.env"
fi
cp docker-compose.prod.yml "$DEPLOY_DIR/"   # compose 若有更新一起換

echo "==> 重建 app 容器(db/valkey 保留;prod 會自動跑新 migration)"
( cd "$DEPLOY_DIR" && docker compose --env-file .env -f docker-compose.prod.yml up -d )
echo "==> done. log: cd $DEPLOY_DIR && docker compose --env-file .env -f docker-compose.prod.yml logs -f docmost"
UPD
  chmod +x "$STAGE/update.sh"

  cat > "$STAGE/UPDATE.md" <<EOF
# Docmost Production 更新包(${BUNDLE})

只更新 app 代碼,**不動** db / valkey 與資料。本包只含 app image(${APP_IMAGE})。

## 步驟(目標機,需先有用完整包做過的部署目錄)
\`\`\`bash
tar -xzf ${BUNDLE}.tar.gz && cd ${BUNDLE}
./update.sh /path/to/your/deploy-dir     # 既有部署目錄(含 .env)
\`\`\`

update.sh 會:載入新 app image → 更新部署目錄 .env 的 DOCMOST_IMAGE → 換上新 compose →
\`docker compose up -d\`(只重建 app 容器)。prod 是 production 模式,會**自動跑新的 DB migration**。

## 回滾
保留上一版的更新包,重跑 \`./update.sh <部署目錄>\` 即可換回舊 image。
注意:若新版含破壞性 migration,回滾 image 不會回滾 schema,請另行備份 DB(\`pg_dump\`)。
EOF

else
  # ---- 完整包:首次部署 ----
  cat > "$STAGE/load.sh" <<'LOAD'
#!/usr/bin/env bash
# 部署端:載入 image 並備妥 .env。執行後依畫面提示啟動。
set -euo pipefail
cd "$(dirname "$0")"
echo "==> docker load images.tar"
docker load -i images.tar
[ -f .env ] || { cp .env.example .env; echo "==> 已建立 .env(請填密碼/網域等)"; }
NEWTAG=$(grep '^DOCMOST_IMAGE=' image.env | cut -d= -f2-)
if grep -q '^DOCMOST_IMAGE=' .env; then
  sed -i "s|^DOCMOST_IMAGE=.*|DOCMOST_IMAGE=${NEWTAG}|" .env
else
  echo "DOCMOST_IMAGE=${NEWTAG}" >> .env
fi
echo
echo "下一步:"
echo "  1) 編輯 .env(POSTGRES_PASSWORD / APP_SECRET / APP_URL ...)"
echo "  2) 啟動:  ./start.sh prod"
echo "     或:    docker compose --env-file .env -f docker-compose.prod.yml up -d"
LOAD
  chmod +x "$STAGE/load.sh"

  cat > "$STAGE/DEPLOY.md" <<EOF
# Docmost Production 部署包(${BUNDLE})

離線部署 Docmost 正式環境。本包已含 app / db / valkey 三個 image,目標機器**不需連網、不需原始碼**。

## 內容
| 檔案 | 說明 |
|---|---|
| images.tar | app(${APP_IMAGE})+ pgvector(pg18)+ valkey 三個 image |
| docker-compose.prod.yml | 正式環境 compose |
| .env.example | 環境變數範本 |
| image.env | 本次 app image 標籤(DOCMOST_IMAGE) |
| start.sh / stop.sh | 啟停腳本 |
| load.sh | 一鍵載入 image + 備妥 .env |
| START_STOP.md | 啟停腳本使用說明 |

## 前置需求
- Docker Engine 20.10+,**Docker Compose v2**(\`docker compose version\` 可用)

## 步驟
\`\`\`bash
tar -xzf ${BUNDLE}.tar.gz && cd ${BUNDLE}
./load.sh                       # docker load + 產生 .env
nano .env                       # 填 POSTGRES_PASSWORD / APP_SECRET / APP_URL ...
./start.sh prod                 # 啟動;完成後印出前台網址
\`\`\`

啟動後:prod 會自動跑 DB migration,開 \`http://<本機>:\${APP_HOST_PORT:-3010}\` 進入 setup。

## 驗證
\`\`\`bash
docker compose --env-file .env -f docker-compose.prod.yml ps
docker compose --env-file .env -f docker-compose.prod.yml logs -f docmost
\`\`\`
EOF
fi

bold "==> [6/6] 打包 -> ${TARBALL}"
tar -czf "$TARBALL" -C "$OUT_DIR" "$BUNDLE"
rm -rf "$STAGE"        # 只留最終 tar.gz

SIZE=$(du -h "$TARBALL" | cut -f1)
grn "完成:${TARBALL} (${SIZE})"
if [ "$APP_ONLY" = "1" ]; then
  echo "目標機:tar -xzf ${BUNDLE}.tar.gz && cd ${BUNDLE} && ./update.sh <既有部署目錄>"
else
  echo "目標機:tar -xzf ${BUNDLE}.tar.gz && cd ${BUNDLE} && ./load.sh && ./start.sh prod"
fi
