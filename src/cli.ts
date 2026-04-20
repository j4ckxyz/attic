#!/usr/bin/env bun

import { getConfig } from "./config";
import { AtticDatabase } from "./db";
import { SearchService, formatSearchResults } from "./search";
import { startServer } from "./server";
import { runSyncWorkerCli } from "./sync-worker";

type Command = "sync" | "serve" | "search" | "worker" | "help";

type ParsedArgs = {
  command: Command;
  full: boolean;
  query?: string;
  author?: string;
  from?: string;
  to?: string;
  limit?: number;
  host?: string;
  port?: number;
  noOpen: boolean;
  syncInterval?: number;
};

function parseArgs(argv: string[]): ParsedArgs {
  const args = [...argv];
  const first = args.shift();

  const command: Command =
    first === "sync" ||
    first === "serve" ||
    first === "search" ||
    first === "worker" ||
    first === "help"
      ? first
      : "help";

  const parsed: ParsedArgs = {
    command,
    full: false,
    noOpen: false,
  };

  while (args.length > 0) {
    const token = args.shift();
    if (!token) {
      break;
    }

    if (token === "--full") {
      parsed.full = true;
      continue;
    }

    if (token === "--no-open") {
      parsed.noOpen = true;
      continue;
    }

    if (token === "--author") {
      parsed.author = args.shift();
      continue;
    }

    if (token === "--from") {
      parsed.from = args.shift();
      continue;
    }

    if (token === "--to") {
      parsed.to = args.shift();
      continue;
    }

    if (token === "--limit") {
      const value = Number(args.shift() ?? "0");
      if (Number.isFinite(value) && value > 0) {
        parsed.limit = value;
      }
      continue;
    }

    if (token === "--host") {
      parsed.host = args.shift();
      continue;
    }

    if (token === "--port") {
      const value = Number(args.shift() ?? "0");
      if (Number.isFinite(value) && value > 0) {
        parsed.port = value;
      }
      continue;
    }

    if (token === "--sync-interval") {
      const value = Number(args.shift() ?? "0");
      if (Number.isFinite(value) && value > 0) {
        parsed.syncInterval = value;
      }
      continue;
    }

    if (parsed.command === "search" && !parsed.query) {
      parsed.query = token;
    }
  }

  return parsed;
}

function printUsage(): void {
  console.log(`Attic - personal Bluesky archive and search

Usage:
  attic sync
  attic sync --full
  attic serve
  attic serve --sync-interval 30
  attic worker
  attic search "query"

Options:
  --author <handle>     Search filter
  --from <ISO>          Search from timestamp
  --to <ISO>            Search to timestamp
  --limit <n>           Search result limit
  --host <host>         Serve host (default 0.0.0.0)
  --port <port>         Serve port (default 8787)
  --no-open             Do not auto-open browser
  --sync-interval <min> Auto-sync interval in minutes (serve only, default 15)
`);
}

function openDatabase(): AtticDatabase {
  const config = getConfig();
  const db = new AtticDatabase(config.dbPath);
  db.init();
  return db;
}

async function runSyncCommand(parsed: ParsedArgs): Promise<void> {
  const db = openDatabase();

  try {
    const mode = parsed.full ? "full" : "incremental";
    console.log(`Starting ${mode} sync...`);

    const { runSync } = await import("./sync");
    const stats = await runSync(db, {
      full: parsed.full,
      onProgress: (message) => console.log(message),
    });

    console.log("Sync complete.");
    console.log(`- Timeline posts saved: ${stats.timelinePostsSaved}`);
    console.log(`- Followed threads flagged: ${stats.followedThreadsFound}`);
  } finally {
    db.close();
  }
}

async function runServeCommand(parsed: ParsedArgs): Promise<void> {
  const db = openDatabase();
  const config = getConfig();

  const server = startServer(db, {
    host: parsed.host,
    port: parsed.port,
    pageSize: config.pageSize,
    openBrowser: !parsed.noOpen,
    syncInterval: parsed.syncInterval,
  });

  const url = `http://${server.host}:${server.port}`;
  console.log(`Attic UI running at ${url}`);
  if (parsed.syncInterval) {
    console.log(`Auto-sync every ${parsed.syncInterval} minutes`);
  }

  await waitForShutdown();
  server.stop();
  db.close();
}

function waitForShutdown(): Promise<void> {
  return new Promise((resolve) => {
    const done = () => resolve();
    process.once("SIGINT", done);
    process.once("SIGTERM", done);
  });
}

async function runSearchCommand(parsed: ParsedArgs): Promise<void> {
  if (!parsed.query) {
    throw new Error(
      'Search query is required. Example: attic search "bun sqlite"',
    );
  }

  const db = openDatabase();

  try {
    const search = new SearchService(db);
    const results = search.search(parsed.query, {
      authorHandle: parsed.author,
      from: parsed.from,
      to: parsed.to,
      limit: parsed.limit ?? 20,
    });

    console.log(formatSearchResults(results));
  } finally {
    db.close();
  }
}

export async function runCli(argv = Bun.argv.slice(2)): Promise<void> {
  const parsed = parseArgs(argv);

  if (parsed.command === "help") {
    printUsage();
    return;
  }

  if (parsed.command === "sync") {
    await runSyncCommand(parsed);
    return;
  }

  if (parsed.command === "worker") {
    await runSyncWorkerCli(parsed.syncInterval ?? 15);
    return;
  }

  if (parsed.command === "serve") {
    await runServeCommand(parsed);
    return;
  }

  await runSearchCommand(parsed);
}

if (import.meta.main) {
  runCli().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${message}`);
    process.exit(1);
  });
}
