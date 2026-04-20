import { AtticDatabase } from "./db";
import { runSync, type SyncStats } from "./sync";
import { getConfig } from "./config";

type SyncState = "idle" | "running" | "error";

type SyncLogEntry = {
  timestamp: string;
  status: "success" | "error";
  message: string;
  stats?: SyncStats;
  durationMs: number;
};

let currentStatus: SyncState = "idle";
let lastSyncStats: SyncStats | null = null;
let lastError: string | null = null;
let syncLog: SyncLogEntry[] = [];
let syncInProgress = false;

const MAX_LOG_ENTRIES = 50;

export function getSyncStatus(): {
  status: SyncState;
  lastSyncStats: SyncStats | null;
  lastError: string | null;
  syncLog: SyncLogEntry[];
  inProgress: boolean;
} {
  return {
    status: currentStatus,
    lastSyncStats,
    lastError,
    syncLog,
    inProgress: syncInProgress,
  };
}

export async function runSingleSync(
  db: AtticDatabase,
  options: { full?: boolean } = {},
): Promise<SyncStats | null> {
  if (syncInProgress) {
    return null;
  }

  syncInProgress = true;
  currentStatus = "running";
  const startTime = Date.now();

  try {
    const stats = await runSync(db, {
      full: options.full,
      onProgress: (message) => console.log(`[sync] ${message}`),
    });

    const durationMs = Date.now() - startTime;
    const entry: SyncLogEntry = {
      timestamp: new Date().toISOString(),
      status: "success",
      message: `Synced ${stats.repoPostsSaved} repo posts, ${stats.timelinePostsSaved} timeline posts`,
      stats,
      durationMs,
    };

    syncLog.unshift(entry);
    if (syncLog.length > MAX_LOG_ENTRIES) {
      syncLog = syncLog.slice(0, MAX_LOG_ENTRIES);
    }

    currentStatus = "idle";
    lastSyncStats = stats;
    lastError = null;

    console.log(
      `[sync] Complete in ${durationMs}ms: ${stats.followsCount} follows, ${stats.repoPostsSaved} repo posts, ${stats.timelinePostsSaved} timeline posts, ${stats.followedThreadsFound} threads`,
    );

    return stats;
  } catch (error) {
    const durationMs = Date.now() - startTime;
    const message = error instanceof Error ? error.message : String(error);

    const entry: SyncLogEntry = {
      timestamp: new Date().toISOString(),
      status: "error",
      message,
      durationMs,
    };

    syncLog.unshift(entry);
    if (syncLog.length > MAX_LOG_ENTRIES) {
      syncLog = syncLog.slice(0, MAX_LOG_ENTRIES);
    }

    currentStatus = "error";
    lastError = message;
    syncInProgress = false;

    console.error(`[sync] Failed after ${durationMs}ms: ${message}`);
    return null;
  } finally {
    syncInProgress = false;
  }
}

export function startSyncWorker(
  db: AtticDatabase,
  options: {
    intervalMinutes?: number;
    onSyncComplete?: (stats: SyncStats) => void;
  } = {},
): { stop: () => void } {
  const intervalMinutes = options.intervalMinutes ?? 15;
  const intervalMs = intervalMinutes * 60 * 1000;

  console.log(`[sync-worker] Starting with ${intervalMinutes}-minute interval`);

  // Run initial sync immediately
  runSingleSync(db).then((stats) => {
    if (stats && options.onSyncComplete) {
      options.onSyncComplete(stats);
    }
  });

  // Schedule recurring syncs
  const timer = setInterval(async () => {
    const stats = await runSingleSync(db);
    if (stats && options.onSyncComplete) {
      options.onSyncComplete(stats);
    }
  }, intervalMs);

  return {
    stop: () => {
      clearInterval(timer);
      console.log("[sync-worker] Stopped");
    },
  };
}

export async function runSyncWorkerCli(
  intervalMinutes: number = 15,
): Promise<void> {
  const config = getConfig();
  const db = new AtticDatabase(config.dbPath);
  db.init();

  console.log(`Attic sync worker started — interval: ${intervalMinutes} minutes`);
  console.log(`Database: ${config.dbPath}`);

  const worker = startSyncWorker(db, {
    intervalMinutes,
  });

  // Handle graceful shutdown
  const shutdown = () => {
    console.log("\n[sync-worker] Shutting down...");
    worker.stop();
    db.close();
    process.exit(0);
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  // Keep process alive
  await new Promise(() => {});
}
