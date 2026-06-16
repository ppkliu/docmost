#!/usr/bin/env bash
# 掃描目錄裡的封存檔(.tar.gz / .tgz / .tar),選一個 → 確認 → 載入到 docker。
# 自動辨識兩種型態:
#   1) 部署 bundle(本專案 pack-prod.sh 產出,內含 <dir>/images.tar + load.sh/update.sh)
#      → 解開後執行其 load.sh(完整包),或載入 image 並提示 update.sh(更新包)。
#   2) 直接的 docker image 封存(docker save 產出,頂層有 manifest.json)
#      → 直接 docker load。
#
# 用法:
#   ./load-select.sh            # 掃描目前目錄
#   ./load-select.sh /path/dir  # 掃描指定目錄
#   ./load-select.sh -y         # 跳過確認(自動 yes);可搭配目錄: ./load-select.sh -y /path
set -euo pipefail

bold(){ printf '\033[1m%s\033[0m\n' "$*"; }
grn(){ printf '\033[32m%s\033[0m\n' "$*"; }
ylw(){ printf '\033[33m%s\033[0m\n' "$*"; }
red(){ printf '\033[31m%s\033[0m\n' "$*"; }

command -v docker >/dev/null || { red "需要 docker"; exit 1; }

ASSUME_YES=0
[ "${1:-}" = "-y" ] && { ASSUME_YES=1; shift; }
DIR="${1:-.}"
[ -d "$DIR" ] || { red "目錄不存在:$DIR"; exit 1; }

# ---- 1) 掃描封存檔(第一層,依修改時間新到舊)----
mapfile -t FILES < <(find "$DIR" -maxdepth 1 -type f \
  \( -name '*.tar.gz' -o -name '*.tgz' -o -name '*.tar' \) -printf '%T@\t%p\n' \
  | sort -rn | cut -f2-)
[ "${#FILES[@]}" -gt 0 ] || { red "在 $DIR 找不到 .tar.gz / .tgz / .tar"; exit 1; }

bold "在 $DIR 找到 ${#FILES[@]} 個封存檔:"
i=1
for f in "${FILES[@]}"; do
  sz=$(du -h "$f" 2>/dev/null | cut -f1)
  printf "  %2d) %-45s %6s\n" "$i" "$(basename "$f")" "$sz"
  i=$((i+1))
done

# ---- 2) 使用者選擇 ----
printf "請選擇編號 [1-%d](q 取消):" "${#FILES[@]}"
read -r sel
[ "$sel" = "q" ] && { echo "已取消"; exit 0; }
[[ "$sel" =~ ^[0-9]+$ ]] && [ "$sel" -ge 1 ] && [ "$sel" -le "${#FILES[@]}" ] \
  || { red "無效選擇:$sel"; exit 1; }
TARGET="${FILES[$((sel-1))]}"

# ---- 3) 判斷型態 + 組出「將執行的動作」描述 ----
listing=$(tar -tzf "$TARGET" 2>/dev/null || tar -tf "$TARGET" 2>/dev/null || true)
[ -n "$listing" ] || { red "無法讀取封存內容(檔案損毀?)"; exit 1; }
extract(){ tar -xzf "$1" -C "$2" 2>/dev/null || tar -xf "$1" -C "$2"; }

TYPE=""; SUB=""; bdir=""; DESC=""
if grep -qE '^\.?/?manifest\.json$' <<<"$listing"; then
  TYPE="image"; DESC="直接 docker load 此 docker image 封存"
elif grep -qE '/images\.tar$' <<<"$listing"; then
  TYPE="bundle"
  top=$(head -1 <<<"$listing" | cut -d/ -f1)
  bdir="$(dirname "$TARGET")/$top"
  if   grep -qE "^$top/load\.sh$"   <<<"$listing"; then SUB="full"
  elif grep -qE "^$top/update\.sh$" <<<"$listing"; then SUB="update"
  else SUB="plain"; fi
  case "$SUB" in
    full)   DESC="解開到 $bdir(會先刪除既有同名資料夾)→ 執行 load.sh(docker load + 備妥 .env)";;
    update) DESC="解開到 $bdir(會先刪除既有同名資料夾)→ docker load 新 app image;之後需 ./update.sh <部署目錄>";;
    plain)  DESC="解開到 $bdir(會先刪除既有同名資料夾)→ docker load images.tar";;
  esac
else
  TYPE="unknown"; DESC="型態無法辨識,將嘗試直接 docker load"
fi

# ---- 4) 確認機制 ----
echo
bold "即將執行:"
echo "  檔案:$(basename "$TARGET")"
echo "  路徑:$TARGET"
echo "  動作:$DESC"
if [ "$ASSUME_YES" = "1" ]; then
  ylw "(-y 已指定,跳過確認)"
else
  printf "確認執行?[y/N]:"
  read -r ans
  case "$ans" in
    y|Y|yes|YES) ;;
    *) echo "已取消"; exit 0;;
  esac
fi

# ---- 5) 執行 ----
case "$TYPE" in
  image|unknown)
    docker load -i "$TARGET" ;;
  bundle)
    bold "==> 解開 bundle:$bdir"
    rm -rf "$bdir"; extract "$TARGET" "$(dirname "$TARGET")"
    [ -f "$bdir/images.tar" ] || { red "解開後找不到 $bdir/images.tar"; exit 1; }
    case "$SUB" in
      full)
        bold "==> 執行 load.sh"
        ( cd "$bdir" && ./load.sh )
        grn "下一步:cd $bdir && 編輯 .env 後 ./start.sh prod" ;;
      update)
        bold "==> docker load 新 app image"
        docker load -i "$bdir/images.tar"
        grn "下一步(指定既有部署目錄):cd $bdir && ./update.sh <既有部署目錄>" ;;
      plain)
        docker load -i "$bdir/images.tar" ;;
    esac ;;
esac

echo
grn "==> 目前相關 docker images:"
docker images | grep -E 'REPOSITORY|docmost|pgvector|valkey' || docker images | head
