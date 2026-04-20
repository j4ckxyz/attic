import { Hono } from "hono";
import type { AtticDatabase } from "./db";
import { SearchService } from "./search";
import type { PostRow } from "./types";
import { getSyncStatus, runSingleSync, startSyncWorker } from "./sync-worker";
import { AvatarCacher } from "./avatars";

const uiScript = await Bun.file(new URL("./web/app.js", import.meta.url)).text();

const avatarCacher = new AvatarCacher();

export type ServerOptions = {
  host?: string;
  port?: number;
  pageSize?: number;
  openBrowser?: boolean;
  syncInterval?: number;
};

function rewriteAvatarUrls(items: PostRow[]): PostRow[] {
  return items.map((item) => {
    if (!item.avatarUrl) {
      return item;
    }

    const filename = item.avatarUrl.split("/").pop();
    if (filename && filename.startsWith("did:")) {
      return { ...item, avatarUrl: item.avatarUrl };
    }

    return { ...item, avatarUrl: item.avatarUrl };
  });
}

export function createApp(db: AtticDatabase, pageSize = 50): Hono {
  const app = new Hono();
  const search = new SearchService(db);

  app.get("/", (c) => c.html(renderShell()));

  app.get("/app.js", (c) => {
    c.header("content-type", "application/javascript; charset=utf-8");
    return c.body(uiScript);
  });

  app.get("/avatars/:filename", (c) => {
    const filename = c.req.param("filename");
    const data = avatarCacher.serveAvatar(filename);
    if (!data) {
      return c.notFound();
    }

    c.header("content-type", avatarCacher.getContentType(filename));
    c.header("cache-control", "public, max-age=86400");
    return c.body(data);
  });

  app.get("/api/feed", (c) => {
    const page = Number(c.req.query("page") ?? "1");
    const items = rewriteAvatarUrls(db.listFeed(Math.max(page, 1), pageSize));
    return c.json({ items, page, pageSize });
  });

  app.get("/api/bookmarks", (c) => {
    const page = Number(c.req.query("page") ?? "1");
    const items = rewriteAvatarUrls(
      db.listBookmarks(Math.max(page, 1), pageSize),
    );
    return c.json({ items, page, pageSize });
  });

  app.post("/api/bookmarks/toggle", async (c) => {
    const body = (await c.req.json()) as { uri?: string };
    if (!body.uri) {
      return c.json({ error: "uri is required" }, 400);
    }

    const bookmarked = db.toggleBookmark(body.uri);
    return c.json({ bookmarked, uri: body.uri });
  });

  app.get("/api/threads", (c) => {
    const page = Number(c.req.query("page") ?? "1");
    const summaries = db.listThreadSummaries(Math.max(page, 1), pageSize);
    const items = summaries.map((summary) => {
      const rootPost = db.getPostByUri(summary.threadRootUri);
      return {
        ...summary,
        rootPost: rootPost ? rewriteAvatarUrls([rootPost])[0] : null,
      };
    });

    return c.json({ items, page, pageSize });
  });

  app.get("/api/thread", (c) => {
    const rootUri = c.req.query("rootUri");
    if (!rootUri) {
      return c.json({ error: "rootUri is required" }, 400);
    }

    const posts = rewriteAvatarUrls(db.getThreadPosts(rootUri));
    const tree = buildThreadTree(posts);
    return c.json({ rootUri, posts, tree });
  });

  app.get("/api/search", (c) => {
    const query = c.req.query("q") ?? "";
    const authorHandle = c.req.query("author");
    const from = c.req.query("from");
    const to = c.req.query("to");
    const page = Number(c.req.query("page") ?? "1");

    const items = rewriteAvatarUrls(
      search.search(query, {
        authorHandle: authorHandle || undefined,
        from: from || undefined,
        to: to || undefined,
        limit: pageSize,
        offset: (Math.max(page, 1) - 1) * pageSize,
      }),
    );

    return c.json({
      items,
      page,
      pageSize,
      query,
      filters: {
        authorHandle: authorHandle || null,
        from: from || null,
        to: to || null,
      },
    });
  });

  app.get("/api/health", (c) => c.json({ ok: true }));

  app.get("/api/sync/status", (c) => {
    return c.json(getSyncStatus());
  });

  app.post("/api/sync/trigger", async (c) => {
    const body = (await c.req.json()) as { full?: boolean } | undefined;
    const stats = await runSingleSync(db, { full: body?.full });
    if (!stats) {
      return c.json({ error: "Sync already in progress" }, 409);
    }

    return c.json({ status: "success", stats });
  });

  return app;
}

export function startServer(
  db: AtticDatabase,
  options: ServerOptions = {},
): { host: string; port: number; stop: () => void } {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 8787;
  const pageSize = options.pageSize ?? 50;
  const app = createApp(db, pageSize);

  const server = Bun.serve({
    hostname: host,
    port,
    fetch: app.fetch,
  });

  // Start sync worker if interval specified
  if (options.syncInterval) {
    startSyncWorker(db, {
      intervalMinutes: options.syncInterval,
    });
  }

  if (options.openBrowser ?? true) {
    const url = `http://${host}:${port}`;
    try {
      Bun.spawn(["open", url], {
        stdout: "ignore",
        stderr: "ignore",
      });
    } catch {
      // ignore launch failures
    }
  }

  return {
    host,
    port,
    stop: () => server.stop(),
  };
}

type ThreadTreeNode = {
  post: PostRow;
  children: ThreadTreeNode[];
};

function buildThreadTree(posts: PostRow[]): ThreadTreeNode[] {
  const byUri = new Map<string, ThreadTreeNode>();
  const roots: ThreadTreeNode[] = [];

  for (const post of posts) {
    byUri.set(post.uri, { post, children: [] });
  }

  for (const node of byUri.values()) {
    const parentUri = node.post.replyParentUri;
    if (!parentUri) {
      roots.push(node);
      continue;
    }

    const parent = byUri.get(parentUri);
    if (!parent) {
      roots.push(node);
      continue;
    }

    parent.children.push(node);
  }

  return roots;
}

function renderShell(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Attic</title>
    <style>
      :root {
        color-scheme: light;
        --space-1: 4px;
        --space-2: 8px;
        --space-3: 12px;
        --space-4: 16px;
        --space-5: 24px;
        --space-6: 32px;

        --radius-sm: 8px;
        --radius-md: 12px;
        --radius-lg: 14px;

        --dur-fast: 160ms;
        --dur-med: 220ms;
        --ease-standard: cubic-bezier(0.22, 1, 0.36, 1);

        --bg: #f4f0e8;
        --bg-grad-a: #efe4d2;
        --bg-grad-b: #f7e8d8;
        --surface: #fffdf8;
        --surface-solid: #ffffff;
        --surface-muted: #fffaf2;
        --surface-soft: #f0ebe2;

        --text: #1f1d1a;
        --text-muted: #6f675d;
        --line: #e2d8c9;

        --accent: #9f5f2d;
        --accent-strong: #6f3e1e;
        --accent-soft: #fff2e6;

        --header-start: #3f2a19;
        --header-mid: #6c4120;
        --header-end: #8a5628;
        --header-text: #fff1e2;
        --header-subtitle: #fff1e2;

        --sync-ok: #4a7c59;
        --sync-running: #c49a3c;
        --sync-error: #b33a3a;
      }

      @media (prefers-color-scheme: dark) {
        :root {
          color-scheme: dark;
          --bg: #18130f;
          --bg-grad-a: #2a1d14;
          --bg-grad-b: #1d1611;
          --surface: #211a15;
          --surface-solid: #261f1a;
          --surface-muted: #2a221b;
          --surface-soft: #362c24;

          --text: #efe4d7;
          --text-muted: #c5b39f;
          --line: #4c3d31;

          --accent: #d59253;
          --accent-strong: #cc8645;
          --accent-soft: #3a2a1c;

          --header-start: #4c301c;
          --header-mid: #694022;
          --header-end: #7f4f26;
          --header-text: #fff0de;
          --header-subtitle: #ffe8cf;

          --sync-ok: #6fb57f;
          --sync-running: #e8c44a;
          --sync-error: #e06060;
        }
      }

      * { box-sizing: border-box; }

      body {
        margin: 0;
        font-size: 16px;
        background:
          radial-gradient(circle at 10% 10%, var(--bg-grad-a) 0%, transparent 45%),
          radial-gradient(circle at 90% 20%, var(--bg-grad-b) 0%, transparent 40%),
          var(--bg);
        color: var(--text);
        font-family: "Iowan Old Style", "Palatino Linotype", Palatino, serif;
      }

      .shell { width: min(980px, 100%); margin: 0 auto; padding: var(--space-4); }

      .header {
        background: linear-gradient(
          110deg,
          var(--header-start),
          var(--header-mid) 70%,
          var(--header-end)
        );
        color: var(--header-text);
        border-radius: var(--radius-lg);
        padding: var(--space-4);
        box-shadow: 0 8px 28px rgba(58, 36, 18, 0.25);
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: var(--space-4);
      }

      .header-main { flex: 1; }
      .title { margin: 0; font-size: clamp(1.25rem, 2.5vw, 1.8rem); letter-spacing: 0.02em; }
      .subtitle { margin: var(--space-1) 0 0; color: var(--header-subtitle); font-size: 0.95rem; }

      .sync-status {
        text-align: right;
        flex-shrink: 0;
      }

      .sync-badge {
        display: inline-block;
        padding: var(--space-1) var(--space-2);
        border-radius: 999px;
        font-size: 0.78rem;
        font-weight: 600;
        letter-spacing: 0.02em;
        background: rgba(255, 255, 255, 0.12);
        color: var(--header-text);
        border: 1px solid rgba(255, 255, 255, 0.15);
      }

      .sync-badge.sync-ok {
        background: color-mix(in oklab, var(--sync-ok) 20%, transparent);
        border-color: color-mix(in oklab, var(--sync-ok) 40%, transparent);
        color: var(--header-text);
      }

      .sync-badge.sync-running {
        background: color-mix(in oklab, var(--sync-running) 20%, transparent);
        border-color: color-mix(in oklab, var(--sync-running) 40%, transparent);
        color: var(--header-text);
      }

      .sync-badge.sync-error {
        background: color-mix(in oklab, var(--sync-error) 20%, transparent);
        border-color: color-mix(in oklab, var(--sync-error) 40%, transparent);
        color: var(--header-text);
      }

      .sync-detail {
        font-size: 0.72rem;
        color: var(--header-subtitle);
        margin-top: var(--space-1);
        opacity: 0.8;
      }

      .tabs { display: flex; gap: var(--space-2); flex-wrap: wrap; margin: var(--space-4) 0; }

      .panel {
        background: color-mix(in oklab, var(--surface), transparent 4%);
        border: 1px solid var(--line);
        border-radius: var(--radius-lg);
        padding: var(--space-4);
        min-height: 300px;
      }

      .tab {
        border: 1px solid var(--line);
        border-radius: 999px;
        background: var(--surface);
        color: var(--text);
        padding: var(--space-2) var(--space-3);
        cursor: pointer;
        font: inherit;
      }

      .tab,
      .bookmark,
      .btn {
        min-width: 44px;
        min-height: 44px;
        transition:
          background-color var(--dur-fast) var(--ease-standard),
          border-color var(--dur-fast) var(--ease-standard),
          color var(--dur-fast) var(--ease-standard),
          transform var(--dur-fast) var(--ease-standard),
          box-shadow var(--dur-fast) var(--ease-standard);
      }

      .tab.active {
        border-color: var(--accent);
        background: var(--accent-soft);
        color: color-mix(in oklab, var(--accent-strong), black 14%);
      }

      .tab:hover,
      .bookmark:hover,
      .btn:hover {
        transform: translateY(-1px);
      }

      .feed-header {
        padding: var(--space-2) 0 var(--space-3);
        border-bottom: 1px solid var(--line);
        margin-bottom: var(--space-3);
      }

      .post {
        border: 1px solid var(--line);
        border-radius: var(--radius-md);
        background: var(--surface-solid);
        padding: var(--space-3);
        margin-bottom: var(--space-3);
        overflow-wrap: anywhere;
      }

      .post-header { display: flex; align-items: center; gap: var(--space-2); }

      .avatar {
        width: 32px;
        height: 32px;
        border-radius: 999px;
        border: 1px solid var(--line);
        object-fit: cover;
        background: var(--surface-soft);
      }

      .meta { font-size: 0.875rem; color: var(--text-muted); }
      .text {
        margin: var(--space-2) 0;
        white-space: pre-wrap;
        line-height: 1.45;
        max-width: 72ch;
      }

      .bookmark {
        margin-left: auto;
        border: 1px solid var(--line);
        border-radius: var(--radius-sm);
        background: var(--surface-solid);
        cursor: pointer;
        padding: 0 var(--space-3);
      }

      .bookmark.active {
        border-color: var(--accent);
        background: color-mix(in oklab, var(--accent-soft), var(--surface) 30%);
      }

      .controls {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
        gap: var(--space-3);
        margin-bottom: var(--space-3);
      }

      .controls label {
        display: block;
        font-size: 0.84rem;
        color: var(--text-muted);
        margin-bottom: var(--space-1);
      }

      .controls input {
        width: 100%;
        border: 1px solid var(--line);
        border-radius: var(--radius-sm);
        padding: 0 var(--space-2);
        min-height: 44px;
        font: inherit;
        color: var(--text);
        background: var(--surface-solid);
      }

      .row { display: flex; gap: var(--space-2); align-items: center; flex-wrap: wrap; }

      .btn {
        border: 1px solid var(--line);
        border-radius: var(--radius-sm);
        padding: 0 var(--space-3);
        background: var(--surface-solid);
        cursor: pointer;
        font: inherit;
      }

      .btn.primary {
        background: var(--accent-strong);
        color: var(--header-text);
        border-color: var(--accent-strong);
      }

      .btn:disabled,
      .tab:disabled,
      .bookmark:disabled {
        opacity: 0.55;
        cursor: not-allowed;
        transform: none;
      }

      .thread-card {
        border: 1px solid var(--line);
        border-radius: var(--radius-md);
        background: var(--surface-solid);
        margin-bottom: var(--space-3);
        overflow: hidden;
      }

      .thread-head {
        padding: var(--space-3);
        display: flex;
        gap: var(--space-3);
        justify-content: space-between;
        align-items: center;
        background: var(--surface-muted);
      }

      .thread-body { padding: var(--space-3); border-top: 1px solid var(--line); }
      .muted { color: var(--text-muted); }

      .sr-only {
        position: absolute;
        width: 1px;
        height: 1px;
        padding: 0;
        margin: -1px;
        overflow: hidden;
        clip: rect(0, 0, 0, 0);
        white-space: nowrap;
        border: 0;
      }

      .tab:focus-visible,
      .bookmark:focus-visible,
      .btn:focus-visible,
      .controls input:focus-visible {
        outline: 2px solid var(--accent);
        outline-offset: 2px;
        box-shadow: 0 0 0 3px color-mix(in oklab, var(--accent-soft), transparent 30%);
      }

      .loading {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        padding: var(--space-6);
        gap: var(--space-3);
      }

      .loading-spinner {
        width: 32px;
        height: 32px;
        border: 3px solid var(--line);
        border-top-color: var(--accent);
        border-radius: 50%;
        animation: spin 0.8s linear infinite;
      }

      @keyframes spin {
        to { transform: rotate(360deg); }
      }

      .empty-state {
        text-align: center;
        padding: var(--space-6) var(--space-4);
      }

      .empty-title {
        margin: 0 0 var(--space-2);
        font-size: 1.1rem;
        font-weight: 600;
        color: var(--text);
      }

      .empty-desc {
        margin: 0 0 var(--space-4);
        color: var(--text-muted);
        line-height: 1.5;
      }

      .empty-action {
        display: flex;
        justify-content: center;
      }

      @media (prefers-reduced-motion: reduce) {
        *, *::before, *::after {
          animation-duration: 0.01ms !important;
          animation-iteration-count: 1 !important;
          transition-duration: 0.01ms !important;
          scroll-behavior: auto !important;
        }
      }

      @media (max-width: 700px) {
        .shell { padding: var(--space-3); }
        .panel { padding: var(--space-3); }
        .header { flex-direction: column; }
        .sync-status { text-align: left; }
      }
    </style>
  </head>
  <body>
    <main class="shell">
      <header class="header">
        <div class="header-main">
          <h1 class="title">Attic</h1>
          <p class="subtitle">Your personal Bluesky archive and search desk</p>
        </div>
        <div class="sync-status">
          <span class="sync-badge sync-idle" id="sync-badge">Loading...</span>
          <div class="sync-detail" id="sync-status">Checking sync status...</div>
        </div>
      </header>

      <nav class="tabs" id="tabs" aria-label="Attic sections"></nav>
      <section class="panel" id="panel" role="tabpanel" aria-live="polite"></section>
      <p id="ui-status" class="sr-only" aria-live="polite"></p>
    </main>

    <script src="/app.js"></script>
  </body>
</html>`;
}
