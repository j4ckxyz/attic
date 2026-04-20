# Attic

Attic is a personal Bluesky archive and search tool built with Bun, SQLite, and Hono.

## Setup

1. Install dependencies:

```bash
bun install
```

2. Copy env file and fill values:

```bash
cp .env.example .env
```

Required environment variables:

- `BLUESKY_HANDLE`
- `BLUESKY_APP_PASSWORD`
- `BLUESKY_PDS_URL`

Optional:

- `ATTIC_DB_PATH` (default `data/attic.db`)
- `ATTIC_PAGE_SIZE` (default `50`)

## Commands

Run commands through Bun:

```bash
bun run src/cli.ts sync
bun run src/cli.ts sync --full
bun run src/cli.ts serve
bun run src/cli.ts search "archive query"
```

Or via npm-style script:

```bash
bun run attic sync
```

### CLI summary

- `attic sync` - incremental sync
- `attic sync --full` - full re-fetch
- `attic serve` - local web UI (opens browser)
- `attic search "<query>"` - quick stdout search

Search supports optional filters:

```bash
bun run src/cli.ts search "archive" --author alice.bsky.social --from 2026-01-01T00:00:00.000Z --to 2026-01-31T23:59:59.999Z
```

## Features

- Auth via `com.atproto.server.createSession`
- Archive posts from followed accounts using `com.atproto.repo.listRecords`
- Also ingest timeline posts from followed users
- Incremental sync via cursors (`sync_state`)
- Thread detection for followed participant chains (`followed_threads`)
- Local bookmarks
- Full-text search (SQLite FTS5)
- Local UI with Feed, Threads, Bookmarks, Search

## Tests

Run full suite:

```bash
bun test
```

Includes:

- Auth integration tests (real credentials from `.env`)
- DB tests (insert, dedupe, thread detection)
- Sync tests (pagination/cursor + real API smoke test)
- Search tests (FTS queries and filtering)
