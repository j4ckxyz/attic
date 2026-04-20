import { describe, expect, test } from "bun:test";
import { createAuthenticatedAgent } from "../src/auth";
import { getConfig } from "../src/config";
import { AtticDatabase } from "../src/db";
import { SyncService, createSyncClient, type SyncClient } from "../src/sync";

function record(uri: string, text: string, createdAt: string) {
  return {
    uri,
    cid: `cid-${uri.split("/").at(-1)}`,
    value: {
      $type: "app.bsky.feed.post",
      text,
      createdAt,
    },
  };
}

describe("sync", () => {
  test("paginates repo records and tracks incremental cursor", async () => {
    const db = new AtticDatabase(":memory:");
    db.init();

    let repoCall = 0;
    const client: SyncClient = {
      async getFollows() {
        return {
          follows: [
            {
              did: "did:plc:bob",
              handle: "bob.bsky.social",
              displayName: "Bob",
              avatar: "https://example.com/bob.jpg",
            },
          ],
        };
      },
      async listRecords(repo, cursor) {
        expect(repo).toBe("did:plc:bob");

        repoCall += 1;
        if (cursor === undefined) {
          return {
            records: [
              record(
                "at://did:plc:bob/app.bsky.feed.post/new",
                "new post",
                "2026-01-05T00:00:00.000Z",
              ),
              record(
                "at://did:plc:bob/app.bsky.feed.post/old",
                "old post",
                "2026-01-01T00:00:00.000Z",
              ),
            ],
            cursor: "cursor-1",
          };
        }

        if (cursor === "cursor-1") {
          return {
            records: [
              record(
                "at://did:plc:bob/app.bsky.feed.post/newer",
                "newer post",
                "2026-01-06T00:00:00.000Z",
              ),
              record(
                "at://did:plc:bob/app.bsky.feed.post/already-synced",
                "already synced",
                "2026-01-05T00:00:00.000Z",
              ),
            ],
          };
        }

        throw new Error(`Unexpected cursor in mock listRecords: ${cursor}`);
      },
      async getTimeline() {
        return {
          feed: [
            {
              post: {
                uri: "at://did:plc:bob/app.bsky.feed.post/timeline-post",
                cid: "cid-timeline-post",
                author: {
                  did: "did:plc:bob",
                  handle: "bob.bsky.social",
                  displayName: "Bob",
                  avatar: "https://example.com/bob.jpg",
                },
                record: {
                  text: "timeline post",
                  createdAt: "2026-01-07T00:00:00.000Z",
                },
                indexedAt: "2026-01-07T00:00:00.000Z",
              },
            },
          ],
        };
      },
    };

    const service = new SyncService(db, client, "did:plc:viewer");

    const first = await service.sync();
    expect(first.repoPostsSaved).toBe(4);
    expect(first.timelinePostsSaved).toBe(1);
    expect(db.getCursor("repo:did:plc:bob")).toBe("2026-01-06T00:00:00.000Z");
    expect(db.getCursor("timeline")).toBe("2026-01-07T00:00:00.000Z");

    const second = await service.sync();
    expect(second.repoPostsSaved).toBe(0);
    expect(second.timelinePostsSaved).toBe(0);
    expect(db.getCursor("repo:did:plc:bob")).toBe("2026-01-06T00:00:00.000Z");

    db.close();
  });

  test(
    "runs real API sync smoke test with credentials",
    async () => {
      const db = new AtticDatabase(":memory:");
      db.init();

      const { agent, session } = await createAuthenticatedAgent(getConfig());
      const sync = new SyncService(db, createSyncClient(agent), session.did);
      const stats = await sync.sync({
        maxAccounts: 3,
        maxPagesPerRepo: 1,
        maxTimelinePages: 1,
      });

      expect(stats.followsCount).toBeGreaterThanOrEqual(0);
      expect(stats.repoPostsSaved).toBeGreaterThanOrEqual(0);
      expect(stats.timelinePostsSaved).toBeGreaterThanOrEqual(0);

      db.close();
    },
    { timeout: 60_000 },
  );
});
