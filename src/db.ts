import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  AuthorRecord,
  PostRecordInput,
  PostRow,
  SearchFilters,
  ThreadSummary,
} from "./types";

type PostRowDb = {
  uri: string;
  cid: string;
  author_did: string;
  author_handle: string;
  display_name: string | null;
  avatar_url: string | null;
  text: string;
  timestamp: string;
  reply_parent_uri: string | null;
  reply_root_uri: string | null;
  thread_root_uri: string;
  bookmarked: number;
};

function toPostRow(row: PostRowDb): PostRow {
  return {
    uri: row.uri,
    cid: row.cid,
    authorDid: row.author_did,
    authorHandle: row.author_handle,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    text: row.text,
    timestamp: row.timestamp,
    replyParentUri: row.reply_parent_uri,
    replyRootUri: row.reply_root_uri,
    threadRootUri: row.thread_root_uri,
    bookmarked: row.bookmarked === 1,
  };
}

export class AtticDatabase {
  private readonly db: Database;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") {
      mkdirSync(dirname(dbPath), { recursive: true });
    }

    this.db = new Database(dbPath, { create: true });
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec("PRAGMA journal_mode = WAL;");
  }

  init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS authors (
        did TEXT PRIMARY KEY,
        handle TEXT NOT NULL,
        display_name TEXT,
        avatar_url TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS posts (
        uri TEXT PRIMARY KEY,
        cid TEXT NOT NULL,
        author_did TEXT NOT NULL,
        author_handle TEXT NOT NULL,
        text TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        reply_parent_uri TEXT,
        reply_root_uri TEXT,
        thread_root_uri TEXT NOT NULL,
        raw_json TEXT NOT NULL,
        inserted_at TEXT NOT NULL,
        FOREIGN KEY (author_did) REFERENCES authors(did)
      );

      CREATE INDEX IF NOT EXISTS idx_posts_timestamp ON posts(timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_posts_author_handle ON posts(author_handle);
      CREATE INDEX IF NOT EXISTS idx_posts_thread_root_uri ON posts(thread_root_uri);

      CREATE VIRTUAL TABLE IF NOT EXISTS posts_fts USING fts5(
        text,
        author_handle,
        timestamp,
        content='posts',
        content_rowid='rowid'
      );

      CREATE TRIGGER IF NOT EXISTS posts_ai AFTER INSERT ON posts BEGIN
        INSERT INTO posts_fts(rowid, text, author_handle, timestamp)
        VALUES (new.rowid, new.text, new.author_handle, new.timestamp);
      END;

      CREATE TRIGGER IF NOT EXISTS posts_ad AFTER DELETE ON posts BEGIN
        INSERT INTO posts_fts(posts_fts, rowid, text, author_handle, timestamp)
        VALUES('delete', old.rowid, old.text, old.author_handle, old.timestamp);
      END;

      CREATE TRIGGER IF NOT EXISTS posts_au AFTER UPDATE ON posts BEGIN
        INSERT INTO posts_fts(posts_fts, rowid, text, author_handle, timestamp)
        VALUES('delete', old.rowid, old.text, old.author_handle, old.timestamp);
        INSERT INTO posts_fts(rowid, text, author_handle, timestamp)
        VALUES (new.rowid, new.text, new.author_handle, new.timestamp);
      END;

      CREATE TABLE IF NOT EXISTS bookmarks (
        post_uri TEXT PRIMARY KEY,
        bookmarked_at TEXT NOT NULL,
        FOREIGN KEY (post_uri) REFERENCES posts(uri) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS sync_state (
        feed TEXT PRIMARY KEY,
        cursor TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS followed_threads (
        thread_root_uri TEXT PRIMARY KEY,
        participant_count INTEGER NOT NULL,
        last_post_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  upsertAuthor(author: AuthorRecord): void {
    const now = new Date().toISOString();
    this.db
      .query(
        `
        INSERT INTO authors (did, handle, display_name, avatar_url, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(did) DO UPDATE SET
          handle = excluded.handle,
          display_name = excluded.display_name,
          avatar_url = excluded.avatar_url,
          updated_at = excluded.updated_at
      `,
      )
      .run(
        author.did,
        author.handle,
        author.displayName ?? null,
        author.avatarUrl ?? null,
        now,
      );
  }

  upsertPosts(posts: PostRecordInput[]): void {
    const tx = this.db.transaction((records: PostRecordInput[]) => {
      for (const post of records) {
        this.upsertPost(post);
      }
    });

    tx(posts);
  }

  upsertPost(post: PostRecordInput): void {
    this.upsertAuthor({
      did: post.authorDid,
      handle: post.authorHandle,
      displayName: post.authorDisplayName,
      avatarUrl: post.authorAvatar,
    });

    this.db
      .query(
        `
        INSERT INTO posts (
          uri,
          cid,
          author_did,
          author_handle,
          text,
          timestamp,
          reply_parent_uri,
          reply_root_uri,
          thread_root_uri,
          raw_json,
          inserted_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(uri) DO UPDATE SET
          cid = excluded.cid,
          author_did = excluded.author_did,
          author_handle = excluded.author_handle,
          text = excluded.text,
          timestamp = excluded.timestamp,
          reply_parent_uri = excluded.reply_parent_uri,
          reply_root_uri = excluded.reply_root_uri,
          thread_root_uri = excluded.thread_root_uri,
          raw_json = excluded.raw_json
      `,
      )
      .run(
        post.uri,
        post.cid,
        post.authorDid,
        post.authorHandle,
        post.text,
        post.timestamp,
        post.replyParentUri ?? null,
        post.replyRootUri ?? null,
        post.replyRootUri ?? post.uri,
        JSON.stringify(post.raw),
        new Date().toISOString(),
      );
  }

  getPostByUri(uri: string): PostRow | null {
    const row = this.db
      .query(
        `
        SELECT
          p.uri,
          p.cid,
          p.author_did,
          p.author_handle,
          a.display_name,
          a.avatar_url,
          p.text,
          p.timestamp,
          p.reply_parent_uri,
          p.reply_root_uri,
          p.thread_root_uri,
          CASE WHEN b.post_uri IS NULL THEN 0 ELSE 1 END AS bookmarked
        FROM posts p
        LEFT JOIN authors a ON a.did = p.author_did
        LEFT JOIN bookmarks b ON b.post_uri = p.uri
        WHERE p.uri = ?
      `,
      )
      .get(uri) as PostRowDb | null;

    return row ? toPostRow(row) : null;
  }

  listFeed(page: number, pageSize: number): PostRow[] {
    const rows = this.db
      .query(
        `
        SELECT
          p.uri,
          p.cid,
          p.author_did,
          p.author_handle,
          a.display_name,
          a.avatar_url,
          p.text,
          p.timestamp,
          p.reply_parent_uri,
          p.reply_root_uri,
          p.thread_root_uri,
          CASE WHEN b.post_uri IS NULL THEN 0 ELSE 1 END AS bookmarked
        FROM posts p
        LEFT JOIN authors a ON a.did = p.author_did
        LEFT JOIN bookmarks b ON b.post_uri = p.uri
        ORDER BY p.timestamp DESC
        LIMIT ? OFFSET ?
      `,
      )
      .all(pageSize, (page - 1) * pageSize) as PostRowDb[];

    return rows.map(toPostRow);
  }

  listBookmarks(page: number, pageSize: number): PostRow[] {
    const rows = this.db
      .query(
        `
        SELECT
          p.uri,
          p.cid,
          p.author_did,
          p.author_handle,
          a.display_name,
          a.avatar_url,
          p.text,
          p.timestamp,
          p.reply_parent_uri,
          p.reply_root_uri,
          p.thread_root_uri,
          1 AS bookmarked
        FROM bookmarks bm
        JOIN posts p ON p.uri = bm.post_uri
        LEFT JOIN authors a ON a.did = p.author_did
        ORDER BY bm.bookmarked_at DESC
        LIMIT ? OFFSET ?
      `,
      )
      .all(pageSize, (page - 1) * pageSize) as PostRowDb[];

    return rows.map(toPostRow);
  }

  toggleBookmark(uri: string): boolean {
    const existing = this.db
      .query("SELECT 1 FROM bookmarks WHERE post_uri = ?")
      .get(uri) as { 1: number } | null;

    if (existing) {
      this.db.query("DELETE FROM bookmarks WHERE post_uri = ?").run(uri);
      return false;
    }

    this.db
      .query(
        "INSERT INTO bookmarks (post_uri, bookmarked_at) VALUES (?, ?)",
      )
      .run(uri, new Date().toISOString());
    return true;
  }

  getCursor(feed: string): string | null {
    const row = this.db
      .query("SELECT cursor FROM sync_state WHERE feed = ?")
      .get(feed) as { cursor: string | null } | null;

    return row?.cursor ?? null;
  }

  setCursor(feed: string, cursor: string | null): void {
    this.db
      .query(
        `
        INSERT INTO sync_state (feed, cursor, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(feed) DO UPDATE SET
          cursor = excluded.cursor,
          updated_at = excluded.updated_at
      `,
      )
      .run(feed, cursor, new Date().toISOString());
  }

  searchPosts(query: string, filters: SearchFilters = {}): PostRow[] {
    const conditions: string[] = ["posts_fts MATCH ?"];
    const params: Array<string | number> = [toFtsQuery(query)];

    if (filters.authorHandle) {
      conditions.push("p.author_handle = ?");
      params.push(filters.authorHandle);
    }

    if (filters.from) {
      conditions.push("p.timestamp >= ?");
      params.push(filters.from);
    }

    if (filters.to) {
      conditions.push("p.timestamp <= ?");
      params.push(filters.to);
    }

    const limit = filters.limit ?? 50;
    const offset = filters.offset ?? 0;
    params.push(limit, offset);

    const rows = this.db
      .query(
        `
        SELECT
          p.uri,
          p.cid,
          p.author_did,
          p.author_handle,
          a.display_name,
          a.avatar_url,
          p.text,
          p.timestamp,
          p.reply_parent_uri,
          p.reply_root_uri,
          p.thread_root_uri,
          CASE WHEN b.post_uri IS NULL THEN 0 ELSE 1 END AS bookmarked
        FROM posts_fts
        JOIN posts p ON p.rowid = posts_fts.rowid
        LEFT JOIN authors a ON a.did = p.author_did
        LEFT JOIN bookmarks b ON b.post_uri = p.uri
        WHERE ${conditions.join(" AND ")}
        ORDER BY p.timestamp DESC
        LIMIT ? OFFSET ?
      `,
      )
      .all(...params) as PostRowDb[];

    return rows.map(toPostRow);
  }

  refreshFollowedThreads(followedDids: string[]): void {
    const tx = this.db.transaction((dids: string[]) => {
      this.db.query("DELETE FROM followed_threads").run();

      if (dids.length === 0) {
        return;
      }

      const placeholders = dids.map(() => "?").join(", ");
      this.db
        .query(
          `
          INSERT INTO followed_threads (
            thread_root_uri,
            participant_count,
            last_post_at,
            updated_at
          )
          SELECT
            thread_root_uri,
            COUNT(DISTINCT author_did) AS participant_count,
            MAX(timestamp) AS last_post_at,
            ?
          FROM posts
          WHERE author_did IN (${placeholders})
          GROUP BY thread_root_uri
          HAVING COUNT(DISTINCT author_did) >= 3
        `,
        )
        .run(new Date().toISOString(), ...dids);
    });

    tx(followedDids);
  }

  listThreadSummaries(page: number, pageSize: number): ThreadSummary[] {
    return this.db
      .query(
        `
        SELECT
          thread_root_uri,
          participant_count,
          last_post_at
        FROM followed_threads
        ORDER BY last_post_at DESC
        LIMIT ? OFFSET ?
      `,
      )
      .all(pageSize, (page - 1) * pageSize)
      .map((row) => {
        const r = row as {
          thread_root_uri: string;
          participant_count: number;
          last_post_at: string;
        };

        return {
          threadRootUri: r.thread_root_uri,
          participantCount: r.participant_count,
          lastPostAt: r.last_post_at,
        };
      });
  }

  getThreadPosts(threadRootUri: string): PostRow[] {
    const rows = this.db
      .query(
        `
        SELECT
          p.uri,
          p.cid,
          p.author_did,
          p.author_handle,
          a.display_name,
          a.avatar_url,
          p.text,
          p.timestamp,
          p.reply_parent_uri,
          p.reply_root_uri,
          p.thread_root_uri,
          CASE WHEN b.post_uri IS NULL THEN 0 ELSE 1 END AS bookmarked
        FROM posts p
        LEFT JOIN authors a ON a.did = p.author_did
        LEFT JOIN bookmarks b ON b.post_uri = p.uri
        WHERE p.thread_root_uri = ?
        ORDER BY p.timestamp ASC
      `,
      )
      .all(threadRootUri) as PostRowDb[];

    return rows.map(toPostRow);
  }
}

function toFtsQuery(query: string): string {
  const tokens = query
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => `${escapeToken(token)}*`);

  if (tokens.length === 0) {
    return "*";
  }

  return tokens.join(" AND ");
}

function escapeToken(token: string): string {
  return token.replaceAll('"', "");
}
