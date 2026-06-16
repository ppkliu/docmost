# Docmost 啟動 / 停止使用說明（start.sh / stop.sh）

用 `start.sh`、`stop.sh` 兩支腳本一鍵啟停 Docmost,支援 **dev**(原始碼熱重載)與 **prod**(預建映像)兩種模式。啟動完成後會在 CLI 直接印出前台網址、port、各服務狀態,失敗時列出相關 log。

---

## 前置需求

| 項目 | 說明 |
|---|---|
| Docker Engine | 20.10+ |
| **Docker Compose v2** | dev / prod 的 compose 檔含 `name:` 欄位,**必須**用 `docker compose`(v2);舊的 `docker-compose` 1.x 會失敗。腳本會自動偵測並警告。 |
| env 檔 | prod 用 `.env`、dev 用 `.env.dev`(已存在於本目錄) |

> 安裝 v2:`sudo apt-get install -y docker-compose-plugin`,再用 `docker compose version` 確認。

---

## 啟動 `./start.sh`

```bash
./start.sh prod          # 用 .env + docker-compose.prod.yml(預建映像)
./start.sh dev           # 用 .env.dev + docker-compose.dev.yml(原始碼熱重載)
./start.sh prod logs     # 啟動後接著跟著看 app log(第二參數 logs,可選)
```

行為:
1. 自動選 `docker compose`(v2)/ `docker-compose`(v1),v1 跑 dev/prod 會先警告。
2. **prod**:若 `DOCMOST_IMAGE`(預設 `agentwiki-docmost:latest`)不存在,先自動 `docker build`。
3. `up -d` 啟動整組(app / db / valkey)。
4. **dev**:自動跑一次 `migration:latest`(idempotent;由 `.env.dev` 的 `DEV_AUTO_MIGRATE=true` 控制)。因為 dev 是 `NODE_ENV=development`,Docmost 開機不會自動建表,少了這步 DB 沒有任何表會報 `relation "workspaces" does not exist`。prod 會自動 migrate,不需此步。
5. 等前台 port 就緒(prod 60s、dev 120s)。
5. 印出配置與狀態(見下節)。

> **dev 開哪個網址?** dev 模式互動 UI 在 **Vite `5173`**;`3011`(後端 server)在 dev 只提供 API、不吐頁面。所以 dev 要開 `http://127.0.0.1:5173` 才看得到登入 / 建立工作區(setup)流程。腳本在 dev 模式會以 5173 當「前台」回報並等待。

### 啟動後 CLI 顯示的內容

- **前台網址**:`http://127.0.0.1:<port>` 與區網 `http://<本機IP>:<port>`(prod = 3010;dev = Vite 5173)
- **服務狀態**:`docker compose ps`,再逐容器列健康狀態(`OK` / `X`,含重啟次數)
- **錯誤訊息**:某容器非 running 或重啟過多 → 直接印該容器最後 30 行 log;前台逾時未就緒 → 印 app 服務最後 40 行 log + 常見原因提示

成功範例:
```
==> 服務狀態
  OK mydocmost-prod: running (restarts=0)
  OK docmost-prod-db-1: running (restarts=0)
  OK docmost-prod-valkey-1: running (restarts=0)

================ Docmost 已啟動 [prod] ================
 前台網址:
   http://127.0.0.1:3010
   http://10.0.0.4:3010   (區網)
 容器內 app port: 3000
=======================================================
```

---

## 停止 `./stop.sh`

```bash
./stop.sh prod           # 停 prod(docker compose down)
./stop.sh dev            # 停 dev
./stop.sh prod clean     # 停 prod 並清掉該模式的 valkey 快取(不動 db 資料)
./stop.sh prod purge     # 停 prod 並移除 volumes(down -v)
```

- `clean`:刪 `./data/<mode>/valkey/*`,用於 valkey 快取損毀重啟(db 資料保留)。
- `purge`:`down -v`,連 volume 一起移除(資料會清,請小心)。
- 結束會檢查是否仍有殘留容器。

---

## Port 對照（取自 env 檔,括號為預設值）

| 服務 | prod(`.env`) | dev(`.env.dev`) |
|---|---|---|
| 前台 app | **3010**(`APP_HOST_PORT`) | **3011**(`DEV_APP_HOST_PORT`) |
| Vite client(僅 dev) | — | **5173**(`DEV_CLIENT_HOST_PORT`) |
| PostgreSQL | **15434**(`POSTGRES_HOST_PORT`) | 25433(`DEV_POSTGRES_HOST_PORT`) |
| Valkey/Redis | (26378,`REDIS_HOST_PORT`) | 26379(`DEV_REDIS_HOST_PORT`) |

容器內 app 一律監聽 `3000`,對外映射成上表的前台 port。

---

## 注意事項

0. **dev 與 prod 資料庫互相獨立**:各自連到自己 compose 專案的 `db` 容器、各自的資料夾(prod `./data/db`、dev `./data/dev/db`)。所以在 prod/base 建好的帳號**不會**出現在 dev;首次啟動 dev 時 DB 是空的,會走全新的「建立第一個工作區/管理員」setup(請開 dev 的 **5173**)。
1. **不要同時跑多種模式**:base `docker-compose.yml`、prod、dev 是不同 compose 專案,但若 host port(尤其 PostgreSQL)重疊會衝突。切換前先停掉前一組:
   ```bash
   ./stop.sh prod        # 或 ./stop.sh dev / docker-compose down
   ./start.sh dev
   ```
2. **dev 首次較久**:會編譯 client/server,前台要等久一點(腳本給 120s)。
3. **app 一直連不上 valkey/db**:多半是啟動順序或 valkey 快取壞掉,先 `./stop.sh <mode> clean` 再 `./start.sh <mode>`。
4. **看完整 log**:`docker compose --env-file <env> -f <compose> logs -f <app 服務>`(prod 服務名 `docmost`、dev 為 `docmost-dev`),或直接 `./start.sh <mode> logs`。
