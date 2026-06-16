#!/usr/bin/env bash
# 將 production 環境(app + db + valkey 三個 image + 部署檔)自動打包成單一 .tar.gz,
# 方便搬到另一台機器離線部署。輸出在 ./dist/(已被 .gitignore 忽略)。
#
# 用法:
#   ./pack-prod.sh                 # 用 package.json 版本號打包
#   ./pack-prod.sh 1.2.0           # 指定版本標籤
#   SKIP_BUILD=1 ./pack-prod.sh    # 跳過 docker build(直接用既有 image)
set -euo pipefail
cd "$(dirname "$0")"

bold(){ printf '\033[1m%s\033[0m\n' "$*"; }
grn(){ printf '\033[32m%s\033[0m\n' "$*"; }

command -v docker >/dev/null || { echo "需要 docker"; exit 1; }

VERSION="${1:-$(node -p "require('./package.json').version" 2>/dev/null || echo latest)}"
APP_IMAGE="${DOCMOST_IMAGE:-agentwiki-docmost:${VERSION}}"
OUT_DIR="dist"
BUNDLE="docmost-prod-${VERSION}"
STAGE="${OUT_DIR}/${BUNDLE}"
TARBALL="${OUT_DIR}/${BUNDLE}.tar.gz"

bold "==> [1/6] build prod image: ${APP_IMAGE}"
if [ "${SKIP_BUILD:-0}" = "1" ]; then
  echo "  SKIP_BUILD=1,沿用既有 image"
  docker image inspect "$APP_IMAGE" >/dev/null 2>&1 || { echo "找不到 $APP_IMAGE,請先 build"; exit 1; }
else
  docker build -t "$APP_IMAGE" .
fi
# 額外打 latest 標籤,讓 compose 的 DOCMOST_IMAGE 預設值(:latest)也對得上
docker tag "$APP_IMAGE" agentwiki-docmost:latest

bold "==> [2/6] 從 compose.prod 解析相依 image"
DEP_IMAGES=$(grep -E '^[[:space:]]*image:' docker-compose.prod.yml \
  | sed -E 's/.*image:[[:space:]]*//' | tr -d '"' | grep -v '\${')
echo "$DEP_IMAGES" | sed 's/^/    /'
for img in $DEP_IMAGES; do
  docker image inspect "$img" >/dev/null 2>&1 || { echo "  pull $img"; docker pull "$img"; }
done

bold "==> [3/6] 準備部署檔(stage: ${STAGE})"
rm -rf "$STAGE"; mkdir -p "$STAGE"
cp docker-compose.prod.yml "$STAGE/"
cp .env.example            "$STAGE/.env.example"
cp start.sh stop.sh        "$STAGE/" 2>/dev/null || true
cp START_STOP.md           "$STAGE/" 2>/dev/null || true
# 記錄這次打包的 app image 標籤,部署端據此設定 DOCMOST_IMAGE
echo "DOCMOST_IMAGE=${APP_IMAGE}" > "$STAGE/image.env"

bold "==> [4/6] 匯出 image -> images.tar(app + ${DEP_IMAGES//$'\n'/ })"
# shellcheck disable=SC2086
docker save "$APP_IMAGE" agentwiki-docmost:latest $DEP_IMAGES -o "$STAGE/images.tar"

bold "==> [5/6] 產生部署端腳本與說明"
cat > "$STAGE/load.sh" <<'LOAD'
#!/usr/bin/env bash
# 部署端:載入 image 並備妥 .env。執行後依畫面提示啟動。
set -euo pipefail
cd "$(dirname "$0")"
echo "==> docker load images.tar"
docker load -i images.tar
[ -f .env ] || { cp .env.example .env; echo "==> 已建立 .env(請填密碼/網域等)"; }
# 把本次打包的 app image 標籤寫進 .env(若尚未設定)
grep -q '^DOCMOST_IMAGE=' .env || cat image.env >> .env
echo
echo "下一步:"
echo "  1) 編輯 .env(POSTGRES_PASSWORD / APP_SECRET / APP_URL ...)"
echo "  2) 啟動:  ./start.sh prod          (或下面的 compose 指令)"
echo "     docker compose --env-file .env -f docker-compose.prod.yml up -d"
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

bold "==> [6/6] 打包 -> ${TARBALL}"
tar -czf "$TARBALL" -C "$OUT_DIR" "$BUNDLE"
rm -rf "$STAGE"        # 只留最終 tar.gz

SIZE=$(du -h "$TARBALL" | cut -f1)
grn "完成:${TARBALL} (${SIZE})"
echo "搬到目標機後:tar -xzf ${BUNDLE}.tar.gz && cd ${BUNDLE} && ./load.sh && ./start.sh prod"
