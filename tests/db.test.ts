import { describe, expect, test } from "bun:test";
import { AtticDatabase } from "../src/db";
import type { PostRecordInput } from "../src/types";

function createPost(overrides: Partial<PostRecordInput> = {}): PostRecordInput {
  return {
    uri: "at://did:plc:alice/app.bsky.feed.post/1",
    cid: "cid-1",
    authorDid: "did:plc:alice",
    authorHandle: "alice.bsky.social",
    authorDisplayName: "Alice",
    authorAvatar: "https://example.com/alice.jpg",
    text: "hello attic",
    timestamp: "2025-01-01T00:00:00.000Z",
    replyParentUri: null,
    replyRootUri: null,
    raw: { text: "hello attic" },
    ...overrides,
  };
}

describe("db", () => {
  test("inserts posts and deduplicates on URI", () => {
    const db = new AtticDatabase(":memory:");
    db.init();

    db.upsertPost(createPost());
    db.upsertPost(
      createPost({
        cid: "cid-2",
        text: "hello attic updated",
      }),
    );

    const feed = db.listFeed(1, 20);
    expect(feed).toHaveLength(1);
    expect(feed[0]?.cid).toBe("cid-2");
    expect(feed[0]?.text).toBe("hello attic updated");
    expect(feed[0]?.authorHandle).toBe("alice.bsky.social");

    db.close();
  });

  test("toggles bookmarks and lists bookmarked posts", () => {
    const db = new AtticDatabase(":memory:");
    db.init();

    db.upsertPost(createPost());

    const firstToggle = db.toggleBookmark("at://did:plc:alice/app.bsky.feed.post/1");
    expect(firstToggle).toBe(true);
    const bookmarks = db.listBookmarks(1, 20);
    expect(bookmarks).toHaveLength(1);
    expect(bookmarks[0]?.bookmarked).toBe(true);

    const secondToggle = db.toggleBookmark(
      "at://did:plc:alice/app.bsky.feed.post/1",
    );
    expect(secondToggle).toBe(false);
    expect(db.listBookmarks(1, 20)).toHaveLength(0);

    db.close();
  });

  test("detects followed threads with at least 3 participants", () => {
    const db = new AtticDatabase(":memory:");
    db.init();

    const root = "at://did:plc:alice/app.bsky.feed.post/thread-root";
    db.upsertPosts([
      createPost({
        uri: root,
        cid: "cid-root",
        authorDid: "did:plc:alice",
        authorHandle: "alice.bsky.social",
        text: "thread start",
        timestamp: "2025-01-01T00:00:00.000Z",
      }),
      createPost({
        uri: "at://did:plc:bob/app.bsky.feed.post/thread-1",
        cid: "cid-bob",
        authorDid: "did:plc:bob",
        authorHandle: "bob.bsky.social",
        authorDisplayName: "Bob",
        replyParentUri: root,
        replyRootUri: root,
        text: "reply from bob",
        timestamp: "2025-01-01T01:00:00.000Z",
      }),
      createPost({
        uri: "at://did:plc:carol/app.bsky.feed.post/thread-2",
        cid: "cid-carol",
        authorDid: "did:plc:carol",
        authorHandle: "carol.bsky.social",
        authorDisplayName: "Carol",
        replyParentUri: "at://did:plc:bob/app.bsky.feed.post/thread-1",
        replyRootUri: root,
        text: "reply from carol",
        timestamp: "2025-01-01T02:00:00.000Z",
      }),
      createPost({
        uri: "at://did:plc:dave/app.bsky.feed.post/other-thread",
        cid: "cid-dave",
        authorDid: "did:plc:dave",
        authorHandle: "dave.bsky.social",
        authorDisplayName: "Dave",
        text: "independent post",
        timestamp: "2025-01-01T03:00:00.000Z",
      }),
    ]);

    db.refreshFollowedThreads([
      "did:plc:alice",
      "did:plc:bob",
      "did:plc:carol",
      "did:plc:dave",
    ]);

    const threads = db.listThreadSummaries(1, 20);
    expect(threads).toHaveLength(1);
    expect(threads[0]?.threadRootUri).toBe(root);
    expect(threads[0]?.participantCount).toBe(3);

    const threadPosts = db.getThreadPosts(root);
    expect(threadPosts).toHaveLength(3);

    db.close();
  });
});
