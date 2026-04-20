import { describe, expect, test } from "bun:test";
import { createAuthenticatedAgent } from "../src/auth";
import { getConfig } from "../src/config";
import { AtticDatabase } from "../src/db";
import { SyncService, createSyncClient, type SyncClient } from "../src/sync";

function timelineEntry(
  uri: string,
  text: string,
  createdAt: string,
  authorDid = "did:plc:bob",
  authorHandle = "bob.bsky.social",
) {
  return {
    post: {
      uri,
      cid: `cid-${uri.split("/").at(-1)}`,
      author: {
        did: authorDid,
        handle: authorHandle,
        displayName: "Bob",
        avatar: "https://example.com/bob.jpg",
      },
      record: {
        text,
        createdAt,
      },
      indexedAt: createdAt,
    },
  };
}

describe("sync", () => {
  test("paginates timeline and tracks incremental cursor", async () => {
    const db = new AtticDatabase(":memory:");
    db.init();

    let timelineCall = 0;
    const client: SyncClient = {
      async getTimeline(cursor) {
        timelineCall += 1;

        if (timelineCall === 1) {
          expect(cursor).toBeUndefined();
          return {
            feed: [
              timelineEntry(
                "at://did:plc:bob/app.bsky.feed.post/new",
                "new post",
                "2026-01-05T00:00:00.000Z",
              ),
              timelineEntry(
                "at://did:plc:bob/app.bsky.feed.post/old",
                "old post",
                "2026-01-01T00:00:00.000Z",
              ),
            ],
            cursor: "cursor-1",
          };
        }

        if (timelineCall === 2) {
          expect(cursor).toBe("cursor-1");
          return {
            feed: [
              timelineEntry(
                "at://did:plc:bob/app.bsky.feed.post/newer",
                "newer post",
                "2026-01-06T00:00:00.000Z",
              ),
              timelineEntry(
                "at://did:plc:bob/app.bsky.feed.post/already-synced",
                "already synced",
                "2026-01-05T00:00:00.000Z",
              ),
            ],
          };
        }

        return { feed: [] };
      },
    };

    const service = new SyncService(db, client);

    const first = await service.sync();
    expect(first.timelinePostsSaved).toBe(4);
    expect(db.getCursor("timeline")).toBe("2026-01-06T00:00:00.000Z");

    const second = await service.sync();
    expect(second.timelinePostsSaved).toBe(0);
    expect(db.getCursor("timeline")).toBe("2026-01-06T00:00:00.000Z");

    db.close();
  });

  test(
    "runs real API sync smoke test with credentials",
    async () => {
      const db = new AtticDatabase(":memory:");
      db.init();

      const { agent } = await createAuthenticatedAgent(getConfig());
      const service = new SyncService(db, createSyncClient(agent));
      const stats = await service.sync({
        maxTimelinePages: 2,
      });

      expect(stats.timelinePostsSaved).toBeGreaterThanOrEqual(0);
      expect(stats.followedThreadsFound).toBeGreaterThanOrEqual(0);

      db.close();
    },
    { timeout: 60_000 },
  );
});
