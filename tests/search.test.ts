import { describe, expect, test } from "bun:test";
import { AtticDatabase } from "../src/db";
import { SearchService, formatSearchResults } from "../src/search";

describe("search", () => {
  test("returns matching posts from FTS index with filters", () => {
    const db = new AtticDatabase(":memory:");
    db.init();

    db.upsertPosts([
      {
        uri: "at://did:plc:alice/app.bsky.feed.post/1",
        cid: "cid-1",
        authorDid: "did:plc:alice",
        authorHandle: "alice.bsky.social",
        authorDisplayName: "Alice",
        text: "Bun makes CLI tooling fast",
        timestamp: "2026-01-01T10:00:00.000Z",
        raw: { text: "Bun makes CLI tooling fast" },
      },
      {
        uri: "at://did:plc:bob/app.bsky.feed.post/2",
        cid: "cid-2",
        authorDid: "did:plc:bob",
        authorHandle: "bob.bsky.social",
        authorDisplayName: "Bob",
        text: "SQLite works great for local archive search",
        timestamp: "2026-01-02T10:00:00.000Z",
        raw: { text: "SQLite works great for local archive search" },
      },
      {
        uri: "at://did:plc:alice/app.bsky.feed.post/3",
        cid: "cid-3",
        authorDid: "did:plc:alice",
        authorHandle: "alice.bsky.social",
        authorDisplayName: "Alice",
        text: "Archive design ideas",
        timestamp: "2026-01-03T10:00:00.000Z",
        raw: { text: "Archive design ideas" },
      },
    ]);

    const search = new SearchService(db);
    const results = search.search("archive", {
      authorHandle: "alice.bsky.social",
      from: "2026-01-03T00:00:00.000Z",
      to: "2026-01-04T00:00:00.000Z",
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.uri).toBe("at://did:plc:alice/app.bsky.feed.post/3");

    const output = formatSearchResults(results);
    expect(output).toContain("@alice.bsky.social");
    expect(output).toContain("Archive design ideas");

    db.close();
  });
});
