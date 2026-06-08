# Deployment — build locally, ship to production Docker

This repo contains **modified source** (the EE→OSS features), so you **cannot** use the official
prebuilt `docmost/docmost:latest` image — you must build your **own** image from this code. Below
is the "build on a local/dev machine → copy the release to the production machine → start with
Docker" workflow. Official reference: <https://docmost.com/docs/> (it documents the prebuilt-image
path; we diverge by building from source).

The stack (see [`docker-compose.yml`](../docker-compose.yml)): **docmost** (app), **db**
(`pgvector/pgvector` — required for AI Answers), **valkey** (Redis-compatible, for queue + the
organize SSE relay). Database **migrations run automatically** on app startup, so deploying a new
build applies new migrations (e.g. `page_embeddings`, `organize_tasks`).

---

## 0. One-time: production `.env`
Copy [`.env.example`](../.env.example) → `.env` on the production host and set real values. The
essentials:

```dotenv
APPPORT=3010                                  # host port the app is published on
APP_URL=https://wiki.yourdomain.com           # the real public URL (used for links + statusUrl)
APP_SECRET=<openssl rand -hex 32>             # 32+ chars
POSTGRES_USER=docmost
POSTGRES_DB=docmost
POSTGRES_PORT=5432
POSTGRES_PASSWORD=<strong password>
# inside compose, hosts are the SERVICE NAMES, not localhost:
DATABASE_URL="postgresql://docmost:<password>@db:5432/docmost?schema=public"
REDIS_URL=redis://valkey:6379
FILE_UPLOAD_SIZE_LIMIT=50mb                   # blank now also defaults to 50mb
```
> Common gotcha: `DATABASE_URL`/`REDIS_URL` must use the compose service names **`db`** and
> **`valkey`** (not `localhost`/`127.0.0.1`) — the app runs in its own container.

AI features (optional) also need: `AI_DRIVER` (`openai|openai-compatible|gemini|ollama`),
`AI_COMPLETION_MODEL`, and for AI Answers `AI_EMBEDDING_MODEL` + `AI_EMBEDDING_DIMENSION`
(768/1024/1536/2000/3072) + the provider key (`OPENAI_API_KEY`, …).

---

## Approach A — transfer a built image (no build on prod) ← matches "build local, copy, run"

**On the local/dev machine:**
```bash
# 1. build the production image from source (multi-stage: client + server)
docker build -t agentwiki-docmost:1.0 .

# 2. (optional) verify it boots locally
#    docker compose up -d --build

# 3. export the image to a file
docker save agentwiki-docmost:1.0 | gzip > agentwiki-docmost-1.0.tar.gz

# 4. copy image + compose + env to the prod host
scp agentwiki-docmost-1.0.tar.gz docker-compose.prod.yml user@prod:/opt/docmost/
scp .env user@prod:/opt/docmost/.env        # or create .env directly on prod
```

**On the production machine** (`/opt/docmost`):
```bash
docker load < agentwiki-docmost-1.0.tar.gz   # loads agentwiki-docmost:1.0
docker compose -f docker-compose.prod.yml up -d
docker compose -f docker-compose.prod.yml logs -f docmost   # watch migrations run
```

`docker-compose.prod.yml` is the repo compose with the app service switched from `build:` to the
**prebuilt image** (so prod never compiles):
```yaml
services:
  docmost:
    image: agentwiki-docmost:1.0        # <- use the loaded image, no `build:`
    container_name: docmost
    depends_on: [db, valkey]
    env_file: [.env]
    ports: ["${APPPORT}:3000"]
    restart: unless-stopped
    volumes: ["./data/docmost:/app/data/storage"]
  db:
    image: pgvector/pgvector:0.8.2-pg18-trixie
    environment:
      POSTGRES_DB: ${POSTGRES_DB}
      POSTGRES_USER: ${POSTGRES_USER}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
    restart: unless-stopped
    volumes: ["./data/db:/var/lib/postgresql"]
  valkey:
    image: valkey/valkey:9.1-alpine3.23
    command: ["valkey-server","--appendonly","yes","--maxmemory-policy","noeviction"]
    restart: unless-stopped
    volumes: ["./data/valkey:/data"]
```

## Approach B — private registry (recommended for repeat deploys / CI)
```bash
# local
docker build -t registry.example.com/agentwiki/docmost:1.0 .
docker push registry.example.com/agentwiki/docmost:1.0
# prod (compose uses image: registry.example.com/agentwiki/docmost:1.0)
docker compose pull && docker compose up -d
```

## Approach C — copy source, build on prod (simplest, needs build resources on prod)
The repo compose already has `build: context: .`, so:
```bash
# copy the whole repo to prod, then:
docker compose up -d --build
```
Use only if the prod host has enough CPU/RAM to run `pnpm build` (the server build benefits from
`NODE_OPTIONS=--max-old-space-size=2048+`).

---

## After first start
1. Open `APP_URL` → the Docmost **setup page** → create the first workspace + admin account.
2. Put a reverse proxy (Caddy/Nginx/Traefik) in front for **HTTPS** and point it at `APPPORT`.
   Set `APP_URL` to the `https://` domain so links, the collab websocket, and organize `statusUrl`
   are correct.
3. Persistence lives in the bind-mounts: `./data/docmost` (uploaded files, when
   `STORAGE_DRIVER=local`), `./data/db` (Postgres), `./data/valkey`. Back these up.

## Updating to a new build
```bash
# local: rebuild + bump the tag
docker build -t agentwiki-docmost:1.1 . && docker save agentwiki-docmost:1.1 | gzip > out.tar.gz
# prod: load, point compose image: to :1.1, then
docker compose -f docker-compose.prod.yml up -d   # recreates the app; migrations auto-apply
```
Migrations are forward-only and run on boot; take a `./data/db` backup before upgrading.

## Notes / verification
- Confirm pgvector is active for AI Answers: the `db` image is `pgvector/pgvector` and the
  `page_embeddings` migration runs `CREATE EXTENSION IF NOT EXISTS vector`.
- Health: `docker compose logs docmost` should show migrations applied and the server listening on
  3000; `curl http://localhost:${APPPORT}` returns the app.
- `STORAGE_DRIVER=s3`/`azure` is recommended for multi-node or durable production storage instead
  of the local bind-mount.
