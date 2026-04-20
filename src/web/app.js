const views = [
  { id: "feed", label: "Feed" },
  { id: "threads", label: "Threads" },
  { id: "bookmarks", label: "Bookmarks" },
  { id: "search", label: "Search" },
];

const state = {
  view: "feed",
  page: 1,
  threadsPage: 1,
  bookmarksPage: 1,
  searchPage: 1,
  searchQuery: "",
  searchFilters: { author: "", from: "", to: "" },
};

const tabsEl = document.getElementById("tabs");
const panelEl = document.getElementById("panel");
const statusEl = document.getElementById("ui-status");
const syncStatusEl = document.getElementById("sync-status");
const syncBadgeEl = document.getElementById("sync-badge");

function avatar(url) {
  return (
    url ||
    "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='64' height='64'%3E%3Crect width='64' height='64' fill='%23efe8dd'/%3E%3C/svg%3E"
  );
}

function formatDate(iso) {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function formatRelativeTime(iso) {
  try {
    const date = new Date(iso);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return "just now";
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return date.toLocaleDateString();
  } catch {
    return iso;
  }
}

function escapeHtml(input) {
  return String(input)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function announce(message) {
  if (!statusEl) {
    return;
  }

  statusEl.textContent = "";
  requestAnimationFrame(() => {
    statusEl.textContent = message;
  });
}

function postHtml(post, depth = 0) {
  const margin = Math.min(depth * 16, 64);
  const safeText = escapeHtml(post.text || "");
  const handle = escapeHtml(post.authorHandle || "unknown");
  const stamp = escapeHtml(formatDate(post.timestamp));
  const uri = escapeHtml(post.uri || "");
  const isSaved = post.bookmarked ? "active" : "";
  const label = post.bookmarked ? "Saved" : "Save";
  const pressed = post.bookmarked ? "true" : "false";
  const bookmarkAria = post.bookmarked
    ? `Remove bookmark for post by @${handle}`
    : `Save bookmark for post by @${handle}`;

  return [
    `<article class="post" style="margin-left:${margin}px">`,
    `<header class="post-header">`,
    `<img class="avatar" src="${avatar(post.avatarUrl)}" alt="" width="32" height="32" loading="lazy" decoding="async" />`,
    `<div><strong>@${handle}</strong><div class="meta">${stamp}</div></div>`,
    `<button class="bookmark ${isSaved}" data-uri="${uri}" title="Toggle bookmark" aria-label="${escapeHtml(bookmarkAria)}" aria-pressed="${pressed}">${label}</button>`,
    `</header>`,
    `<p class="text">${safeText}</p>`,
    `</article>`,
  ].join("");
}

function loadingHtml(message = "Loading...") {
  return `<div class="loading"><div class="loading-spinner" aria-hidden="true"></div><p class="muted">${message}</p></div>`;
}

function emptyStateHtml(title, description, action) {
  return [
    `<div class="empty-state">`,
    `<h3 class="empty-title">${escapeHtml(title)}</h3>`,
    `<p class="empty-desc">${escapeHtml(description)}</p>`,
    action ? `<div class="empty-action">${action}</div>` : "",
    `</div>`,
  ].join("");
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) {
    throw new Error(await response.text());
  }

  return response.json();
}

function updateBookmarksInDom(uri, bookmarked) {
  panelEl
    .querySelectorAll(`button.bookmark[data-uri="${CSS.escape(uri)}"]`)
    .forEach((button) => {
      button.classList.toggle("active", bookmarked);
      button.textContent = bookmarked ? "Saved" : "Save";
      button.setAttribute("aria-pressed", bookmarked ? "true" : "false");
      const existing = button.getAttribute("aria-label") || "Toggle bookmark";
      if (
        existing.includes("Remove bookmark") ||
        existing.includes("Save bookmark")
      ) {
        button.setAttribute(
          "aria-label",
          existing.replace(
            /(Remove bookmark|Save bookmark)/,
            bookmarked ? "Remove bookmark" : "Save bookmark",
          ),
        );
      }
    });
}

async function toggleBookmark(uri) {
  const data = await fetchJson("/api/bookmarks/toggle", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ uri }),
  });

  updateBookmarksInDom(data.uri, data.bookmarked);
  announce(data.bookmarked ? "Post bookmarked." : "Bookmark removed.");

  if (state.view === "bookmarks") {
    await render();
  }
}

function bindBookmarkButtons() {
  panelEl.querySelectorAll("button.bookmark").forEach((button) => {
    button.addEventListener("click", () => {
      toggleBookmark(button.dataset.uri);
    });
  });
}

function bindTabButtons() {
  tabsEl.setAttribute("role", "tablist");

  tabsEl.innerHTML = views
    .map((view) => {
      const selected = state.view === view.id;
      return `<button class="tab ${selected ? "active" : ""}" data-view="${view.id}" role="tab" aria-selected="${selected ? "true" : "false"}" aria-controls="panel">${view.label}</button>`;
    })
    .join("");

  tabsEl.querySelectorAll("button.tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      state.view = tab.dataset.view;
      state.searchPage = 1;
      panelEl.setAttribute("aria-label", `${tab.textContent} view`);
      render();
    });
  });
}

async function renderFeed() {
  panelEl.innerHTML = loadingHtml("Loading your archive...");

  try {
    const data = await fetchJson(`/api/feed?page=${state.page}`);
    if (data.items.length === 0) {
      panelEl.innerHTML = emptyStateHtml(
        "Your archive is empty",
        "Run a sync to start collecting posts from accounts you follow.",
        '<button class="btn primary" id="trigger-sync">Sync now</button>',
      );
      panelEl.querySelector("#trigger-sync")?.addEventListener("click", () => {
        triggerSync();
      });
      return;
    }

    panelEl.innerHTML = [
      `<div class="feed-header"><span class="muted">${data.items.length} posts</span></div>`,
      data.items.map((post) => postHtml(post)).join(""),
      "<div class=\"row\">",
      `<button class="btn" id="feed-prev" ${state.page <= 1 ? "disabled" : ""}>Previous</button>`,
      '<button class="btn" id="feed-next">Next</button>',
      "</div>",
    ].join("");

    panelEl.querySelector("#feed-prev")?.addEventListener("click", () => {
      state.page = Math.max(1, state.page - 1);
      render();
    });
    panelEl.querySelector("#feed-next")?.addEventListener("click", () => {
      state.page += 1;
      render();
    });
  } catch (error) {
    panelEl.innerHTML = `<p class="muted">Failed to load feed: ${escapeHtml(String(error))}</p>`;
  }
}

async function renderBookmarks() {
  panelEl.innerHTML = loadingHtml("Loading bookmarks...");

  try {
    const data = await fetchJson(`/api/bookmarks?page=${state.bookmarksPage}`);
    if (data.items.length === 0) {
      panelEl.innerHTML = emptyStateHtml(
        "No bookmarks yet",
        "Tap Save on any post to add it here.",
      );
      return;
    }

    panelEl.innerHTML = [
      data.items.map((post) => postHtml(post)).join(""),
      "<div class=\"row\">",
      `<button class="btn" id="bm-prev" ${state.bookmarksPage <= 1 ? "disabled" : ""}>Previous</button>`,
      '<button class="btn" id="bm-next">Next</button>',
      "</div>",
    ].join("");

    panelEl.querySelector("#bm-prev")?.addEventListener("click", () => {
      state.bookmarksPage = Math.max(1, state.bookmarksPage - 1);
      render();
    });
    panelEl.querySelector("#bm-next")?.addEventListener("click", () => {
      state.bookmarksPage += 1;
      render();
    });
  } catch (error) {
    panelEl.innerHTML = `<p class="muted">Failed to load bookmarks: ${escapeHtml(String(error))}</p>`;
  }
}

function flattenThread(nodes, depth = 0, out = []) {
  for (const node of nodes) {
    out.push({ post: node.post, depth });
    flattenThread(node.children || [], depth + 1, out);
  }

  return out;
}

async function renderThreads() {
  panelEl.innerHTML = loadingHtml("Loading threads...");

  try {
    const data = await fetchJson(`/api/threads?page=${state.threadsPage}`);
    if (data.items.length === 0) {
      panelEl.innerHTML = emptyStateHtml(
        "No followed threads yet",
        "Threads with 3+ followed participants will appear here after syncing.",
      );
      return;
    }

    const cards = data.items
      .map((item) => {
        const preview = item.rootPost
          ? postHtml(item.rootPost)
          : '<p class="muted">Root post not in archive.</p>';
        const rootUri = escapeHtml(item.threadRootUri);
        const chainId = `thread-chain-${encodeURIComponent(item.threadRootUri).replaceAll("%", "-")}`;

        return [
          `<section class="thread-card" data-root="${rootUri}">`,
          '<header class="thread-head">',
          `<div><strong>${item.participantCount} participants</strong><div class="meta">Last activity: ${escapeHtml(formatRelativeTime(item.lastPostAt))}</div></div>`,
          `<button class="btn" data-action="expand" aria-expanded="false" aria-controls="${chainId}">Expand</button>`,
          "</header>",
          `<div class="thread-body">${preview}<div id="${chainId}" data-chain hidden></div></div>`,
          "</section>",
        ].join("");
      })
      .join("");

    panelEl.innerHTML =
      cards +
      [
        "<div class=\"row\">",
        `<button class="btn" id="th-prev" ${state.threadsPage <= 1 ? "disabled" : ""}>Previous</button>`,
        '<button class="btn" id="th-next">Next</button>',
        "</div>",
      ].join("");

    panelEl
      .querySelectorAll("button[data-action='expand']")
      .forEach((button) => {
        button.addEventListener("click", async () => {
          const card = button.closest(".thread-card");
          const rootUri = card.dataset.root;
          const chainEl = card.querySelector("[data-chain]");

          if (!chainEl.hidden) {
            chainEl.hidden = true;
            button.textContent = "Expand";
            button.setAttribute("aria-expanded", "false");
            return;
          }

          const thread = await fetchJson(
            `/api/thread?rootUri=${encodeURIComponent(rootUri)}`,
          );
          const flattened = flattenThread(thread.tree || []);
          chainEl.innerHTML = flattened
            .map(({ post, depth }) => postHtml(post, depth))
            .join("");
          chainEl.hidden = false;
          button.textContent = "Collapse";
          button.setAttribute("aria-expanded", "true");
          bindBookmarkButtons();
        });
      });

    panelEl.querySelector("#th-prev")?.addEventListener("click", () => {
      state.threadsPage = Math.max(1, state.threadsPage - 1);
      render();
    });
    panelEl.querySelector("#th-next")?.addEventListener("click", () => {
      state.threadsPage += 1;
      render();
    });
  } catch (error) {
    panelEl.innerHTML = `<p class="muted">Failed to load threads: ${escapeHtml(String(error))}</p>`;
  }
}

function buildSearchControls() {
  return [
    '<form id="search-form">',
    '<div class="controls">',
    '<div><label for="q">Query</label><input id="q" name="q" required placeholder="Search text" /></div>',
    '<div><label for="author">Author handle</label><input id="author" name="author" placeholder="alice.bsky.social" /></div>',
    '<div><label for="from">From</label><input id="from" name="from" type="date" /></div>',
    '<div><label for="to">To</label><input id="to" name="to" type="date" /></div>',
    "</div>",
    '<button class="btn primary" type="submit">Search archive</button>',
    "</form>",
    '<div id="search-results" style="margin-top:12px"></div>',
  ].join("");
}

function serializeSearchFilters(formData) {
  const q = String(formData.get("q") || "").trim();
  const author = String(formData.get("author") || "").trim();
  const fromDate = String(formData.get("from") || "").trim();
  const toDate = String(formData.get("to") || "").trim();

  const params = new URLSearchParams({ q, page: String(state.searchPage) });
  if (author) {
    params.set("author", author);
  }
  if (fromDate) {
    params.set("from", `${fromDate}T00:00:00.000Z`);
  }
  if (toDate) {
    params.set("to", `${toDate}T23:59:59.999Z`);
  }

  return params;
}

async function executeSearch(form, resultsEl) {
  resultsEl.innerHTML = loadingHtml("Searching...");

  const params = serializeSearchFilters(new FormData(form));
  const data = await fetchJson(`/api/search?${params.toString()}`);

  if (data.items.length === 0) {
    resultsEl.innerHTML = emptyStateHtml(
      "No matches found",
      "Try different keywords or adjust your filters.",
    );
    return;
  }

  resultsEl.innerHTML = [
    `<div class="feed-header"><span class="muted">${data.items.length} results for "${escapeHtml(data.query)}"</span></div>`,
    data.items.map((post) => postHtml(post)).join(""),
    '<div class="row">',
    `<button class="btn" id="search-prev" ${state.searchPage <= 1 ? "disabled" : ""}>Previous</button>`,
    '<button class="btn" id="search-next">Next</button>',
    "</div>",
  ].join("");

  resultsEl.querySelector("#search-prev")?.addEventListener("click", async () => {
    state.searchPage = Math.max(1, state.searchPage - 1);
    await executeSearch(form, resultsEl);
    bindBookmarkButtons();
  });
  resultsEl.querySelector("#search-next")?.addEventListener("click", async () => {
    state.searchPage += 1;
    await executeSearch(form, resultsEl);
    bindBookmarkButtons();
  });
}

async function renderSearch() {
  panelEl.innerHTML = buildSearchControls();

  const form = panelEl.querySelector("#search-form");
  const resultsEl = panelEl.querySelector("#search-results");

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    state.searchPage = 1;
    await executeSearch(form, resultsEl);
    bindBookmarkButtons();
  });
}

async function updateSyncStatus() {
  if (!syncStatusEl || !syncBadgeEl) {
    return;
  }

  try {
    const data = await fetchJson("/api/sync/status");

    if (data.inProgress) {
      syncBadgeEl.className = "sync-badge sync-running";
      syncBadgeEl.textContent = "Syncing...";
      syncStatusEl.textContent = "Sync in progress";
    } else if (data.status === "error") {
      syncBadgeEl.className = "sync-badge sync-error";
      syncBadgeEl.textContent = "Error";
      syncStatusEl.textContent = `Last sync failed: ${data.lastError || "unknown error"}`;
    } else if (data.lastSyncStats) {
      syncBadgeEl.className = "sync-badge sync-ok";
      const stats = data.lastSyncStats;
      syncBadgeEl.textContent = `${stats.followsCount} followed`;
      syncStatusEl.textContent = `Last sync: ${stats.repoPostsSaved} repo posts, ${stats.timelinePostsSaved} timeline posts, ${stats.followedThreadsFound} threads`;
    } else {
      syncBadgeEl.className = "sync-badge sync-idle";
      syncBadgeEl.textContent = "Never synced";
      syncStatusEl.textContent = "Run a sync to get started";
    }
  } catch {
    // Sync status endpoint may not exist on older servers
  }
}

async function triggerSync(full = false) {
  if (!syncBadgeEl) {
    return;
  }

  syncBadgeEl.className = "sync-badge sync-running";
  syncBadgeEl.textContent = "Syncing...";
  announce("Sync started.");

  try {
    const data = await fetchJson("/api/sync/trigger", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ full }),
    });

    if (data.status === "success") {
      syncBadgeEl.className = "sync-badge sync-ok";
      syncBadgeEl.textContent = `${data.stats.followsCount} followed`;
      announce(`Sync complete: ${data.stats.repoPostsSaved} repo posts, ${data.stats.timelinePostsSaved} timeline posts`);
    }
  } catch (error) {
    syncBadgeEl.className = "sync-badge sync-error";
    syncBadgeEl.textContent = "Error";
    announce(`Sync failed: ${String(error)}`);
  }

  // Refresh current view after sync
  setTimeout(() => render(), 500);
}

async function render() {
  bindTabButtons();

  if (state.view === "feed") {
    await renderFeed();
  } else if (state.view === "threads") {
    await renderThreads();
  } else if (state.view === "bookmarks") {
    await renderBookmarks();
  } else {
    await renderSearch();
  }

  bindBookmarkButtons();
  await updateSyncStatus();
}

// Initial render
render().catch((error) => {
  panelEl.innerHTML = `<p class="muted">Failed to load this view. ${escapeHtml(String(error))}</p>`;
  announce("Failed to load view.");
});

// Poll sync status every 30 seconds
setInterval(updateSyncStatus, 30000);
