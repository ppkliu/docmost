# Production 環境打包流程（pack-prod.sh）

把 Docmost 正式環境**整包**(app + db + valkey 三個 image + 部署檔)自動打包成單一 `.tar.gz`,搬到另一台機器即可**離線部署**,目標機器不需連網、不需原始碼。

## 流程總覽

```
══════════════════ 建置機 (docmost/ 原始碼) ══════════════════
 改完代碼
   │
   ├─ 首次部署 / base 升版 ── ./pack-prod.sh
   │     → build app + pull db/valkey + save 3 image + 部署檔
   │     → dist/docmost-prod-<ver>.tar.gz                [完整包]
   │
   └─ 只更新代碼 ──────────── APP_ONLY=1 ./pack-prod.sh
         → 只 build + save app image
         → dist/docmost-prod-update-<ver>.tar.gz          [更新包]
                              │
                              │   scp / USB 搬運(離線)
                              ▼
═════════════ 目標機 (離線,Docker + Compose v2) ═════════════
 ./load-select.sh <dir>   掃描 .tar.gz → 選單 → 確認(y/N) → 辨識型態
   │
   ├─ 完整包 ─▶ 解開 → load.sh(docker load + 備 .env)
   │              → 編輯 .env → ./start.sh prod
   │
   ├─ 更新包 ─▶ 解開 → docker load app image
   │              → ./update.sh <部署目錄>(換 image + up -d,只重建 app)
   │
   └─ 裸 image 封存 ─▶ docker load
                              │
                              ▼   prod 自動跑 DB migration
                   http://<host>:3010      (./stop.sh prod 可停止)
```

| 腳本 | 在哪台 | 做什麼 |
|---|---|---|
| `pack-prod.sh` | 建置機 | 打包完整包 / 更新包(`APP_ONLY=1`) |
| `load-select.sh` | 目標機 | 掃描 / 選擇 / 確認 / 載入 tar.gz |
| `load.sh`(包內生成) | 目標機 | 完整包:docker load + 備 `.env` |
| `update.sh`(包內生成) | 目標機 | 更新包:換 app image + `up -d`(資料保留) |
| `start.sh` / `stop.sh` | 目標機 | 啟動(prod 自動 migrate)/ 停止 |

---

## 一、前置需求(建置機)

- Docker Engine（能 `docker build` / `docker pull` / `docker save`)
- 可連網(第一次需拉 `pgvector`、`valkey` base image)
- 在 `docmost/` 目錄執行

## 二、執行打包

```bash
cd docmost
./pack-prod.sh                 # 完整包,用 package.json 的版本號(目前 0.90.1)
# 其他用法
./pack-prod.sh 1.2.0           # 指定版本標籤
APP_ONLY=1 ./pack-prod.sh      # 只更新代碼:只打包 app image(更新包,小很多)
SKIP_BUILD=1 ./pack-prod.sh    # 跳過 build,直接用本機既有的 app image
DOCMOST_IMAGE=myrepo/docmost:rc1 ./pack-prod.sh   # 自訂 app image 名稱
```

流程(腳本會印 6 個步驟):
1. `docker build` 出 app image `agentwiki-docmost:<版本>`(並加 `:latest` 標籤)
2. 從 `docker-compose.prod.yml` 解析相依 image(`pgvector`、`valkey`),沒有就 `pull`
3. 準備部署檔(compose / `.env.example` / `start.sh` / `stop.sh` / `START_STOP.md`)
4. `docker save` 三個 image → `images.tar`
5. 產生部署端 `load.sh` 與 `DEPLOY.md`
6. 全部打包 → **`dist/docmost-prod-<版本>.tar.gz`**

> 輸出在 `dist/`(已被 `.gitignore` 忽略,不會進版控)。

## 三、產物內容

`dist/docmost-prod-<版本>.tar.gz` 解開後:

| 檔案 | 用途 |
|---|---|
| `images.tar` | app + pgvector(pg18)+ valkey 三個 image |
| `docker-compose.prod.yml` | 正式環境 compose |
| `.env.example` | 環境變數範本 |
| `image.env` | 本次 app image 標籤(`DOCMOST_IMAGE=...`) |
| `start.sh` / `stop.sh` | 啟停腳本 |
| `load.sh` | 部署端一鍵載入 image + 備妥 `.env` |
| `START_STOP.md` / `DEPLOY.md` | 使用 / 部署說明 |

## 四、搬運與部署(目標機)

把 `docmost-prod-<版本>.tar.gz` 複製到目標機後:

```bash
tar -xzf docmost-prod-<版本>.tar.gz && cd docmost-prod-<版本>
./load.sh                       # docker load images.tar + 建立 .env(從範本)
nano .env                       # 填 POSTGRES_PASSWORD / APP_SECRET / APP_URL ...
./start.sh prod                 # 啟動,完成後印出前台網址(預設 http://<本機>:3010)
```

- 目標機只需 **Docker + Docker Compose v2**,**不需**原始碼或連網。
- prod 會自動跑 DB migration,啟動後直接進 setup 建立第一個工作區/管理員。
- 詳細部署說明見包內 `DEPLOY.md`。

> **多個包要挑著載?** 用 `load-select.sh`(把它一起複製到目標機):掃描目錄裡的 `.tar.gz`、列選單、確認後自動辨識完整包/更新包/裸 image 並載入。
> ```bash
> ./load-select.sh /path/to/bundles     # 掃描 → 選擇 → 確認 → 載入
> ```

## 五、更新 production 代碼(只換 app,不動資料)

prod 跑的是**預建 image**(原始碼已 build 進 image,不是掛載),所以「更新代碼」= 重出 app image。db / valkey 很少變動,因此用 **更新包** 只送 app image 即可,小很多。

| 情境 | 建置機 | 目標機 | 送的東西 |
|---|---|---|---|
| 首次部署 | `./pack-prod.sh` | `./load.sh` → `./start.sh prod` | app + db + valkey |
| **只更新代碼** | `APP_ONLY=1 ./pack-prod.sh` | `./update.sh <部署目錄>` | **只有 app image** |
| 連 base image 也升版 | `./pack-prod.sh`(完整) | `./load.sh` → 重啟 | 全部 |

**更新流程:**
```bash
# 建置機(改完代碼後)
APP_ONLY=1 ./pack-prod.sh 0.90.2          # 產生 dist/docmost-prod-update-0.90.2.tar.gz

# 目標機(把更新包複製過去)
tar -xzf docmost-prod-update-0.90.2.tar.gz && cd docmost-prod-update-0.90.2
./update.sh /path/to/your/deploy-dir       # 既有部署目錄(含 .env / data)
```

`update.sh` 會:`docker load` 新 app image → 更新部署目錄 `.env` 的 `DOCMOST_IMAGE` → 換上新 compose → `docker compose up -d`(**只重建 app 容器**,db/valkey 與資料保留)。因為 prod 是 `NODE_ENV=production`,**新版的 DB migration 會在啟動時自動套用**。

**回滾**:保留上一版更新包,重跑 `./update.sh <部署目錄>` 即可換回舊 image。但若新版含破壞性 migration,回滾 image **不會**回滾 schema —— 更新前建議先 `pg_dump` 備份 DB。

## 六、注意事項

- **體積**:三個 image 解壓後約 1～2 GB,`.tar.gz` 視壓縮率而定;傳輸前確認目標機磁碟空間。
- **架構需一致**:image 與目標機 CPU 架構要相同(x86_64 打的包不能在 arm64 跑)。需跨架構請在對應架構的機器上打包,或用 `docker buildx`。
- **版本更新**:改了原始碼要重出新版 → `./pack-prod.sh <新版本>`,目標機重跑 `./load.sh` 載入新 image 後 `./start.sh prod`(prod 會自動 migrate 新 schema)。
- **`.env` 不入包**:只附 `.env.example`;真正的密碼/secret 在目標機填,不會被打包帶走。
- **`SKIP_BUILD=1`**:用於已在 CI/別處 build 好 image、只想重新打包的情境。
