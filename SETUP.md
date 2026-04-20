# Attic Setup

## Quick Start with Docker

### 1. Clone and configure

```bash
git clone https://github.com/j4ckxyz/attic.git
cd attic
cp .env.example .env
```

Edit `.env` with your Bluesky credentials:

```env
BLUESKY_HANDLE=your.handle.bsky.social
BLUESKY_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx
BLUESKY_PDS_URL=https://bsky.social
```

### 2. Run with Docker Compose

```bash
docker compose up -d
```

Attic will be available at `http://localhost:8787`

### 3. Initial sync

```bash
docker compose exec attic bun run src/cli.ts sync
```

### 4. View logs

```bash
docker compose logs -f attic
```

### 5. Stop

```bash
docker compose down
```

Data persists in the `attic-data` Docker volume.

---

## Manual Setup (no Docker)

### Requirements

- Bun 1.x (`curl -fsSL https://bun.com/install | bash`)

### Install

```bash
bun install
cp .env.example .env
# Edit .env with your credentials
```

### Commands

```bash
# Sync your Bluesky archive
bun run src/cli.ts sync

# Full re-sync
bun run src/cli.ts sync --full

# Start web UI
bun run src/cli.ts serve

# Search from CLI
bun run src/cli.ts search "your query"
```

---

## Docker Commands Reference

```bash
# Build image
docker build -t attic .

# Run container
docker run -d \
  --name attic \
  -p 8787:8787 \
  -v attic-data:/app/data \
  --env-file .env \
  attic

# Sync data
docker exec attic bun run src/cli.ts sync

# Search from CLI
docker exec attic bun run src/cli.ts search "query"

# View logs
docker logs -f attic

# Stop
docker stop attic
```

---

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `BLUESKY_HANDLE` | Yes | - | Your Bluesky handle |
| `BLUESKY_APP_PASSWORD` | Yes | - | App-specific password |
| `BLUESKY_PDS_URL` | Yes | - | PDS endpoint |
| `ATTIC_DB_PATH` | No | `/app/data/attic.db` | SQLite database path |
| `ATTIC_PAGE_SIZE` | No | `50` | Posts per page |
| `PORT` | No | `8787` | Server port |
| `HOST` | No | `0.0.0.0` | Server host |

---

## Data Persistence

SQLite database is stored in `/app/data/attic.db` inside the container.

**Docker Compose**: Data persists automatically via the `attic-data` volume.

**Docker run**: Use `-v attic-data:/app/data` to persist data.

**Manual**: Data stored in `./data/attic.db` by default.
