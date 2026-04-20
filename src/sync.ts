import { AtpAgent } from "@atproto/api";
import { createAuthenticatedAgent } from "./auth";
import { getConfig } from "./config";
import type { AtticDatabase } from "./db";
import { withRetry } from "./retry";
import type { PostRecordInput } from "./types";

type TimelineAuthor = {
  did: string;
  handle: string;
  displayName?: string;
  avatar?: string;
};

type TimelinePost = {
  uri: string;
  cid: string;
  author: TimelineAuthor;
  record: Record<string, unknown>;
  indexedAt: string;
};

type TimelineFeedItem = {
  post: TimelinePost;
  reply?: {
    parent?: { uri: string };
    root?: { uri: string };
  };
};

type TimelinePage = {
  feed: TimelineFeedItem[];
  cursor?: string;
};

export type SyncClient = {
  getTimeline(cursor?: string): Promise<TimelinePage>;
};

export type SyncOptions = {
  full?: boolean;
  maxTimelinePages?: number;
  onProgress?: (message: string) => void;
};

export type SyncStats = {
  timelinePostsSaved: number;
  followedThreadsFound: number;
};

export function createSyncClient(agent: AtpAgent): SyncClient {
  return {
    async getTimeline(cursor?: string): Promise<TimelinePage> {
      const response = await withRetry(() =>
        agent.getTimeline({ cursor, limit: 100 }),
      );

      return {
        feed: response.data.feed.map((entry) => ({
          post: {
            uri: entry.post.uri,
            cid: entry.post.cid,
            author: {
              did: entry.post.author.did,
              handle: entry.post.author.handle,
              displayName: entry.post.author.displayName,
              avatar: entry.post.author.avatar,
            },
            record: (entry.post.record as Record<string, unknown>) ?? {},
            indexedAt: entry.post.indexedAt,
          },
          reply:
            entry.reply && "parent" in entry.reply && "root" in entry.reply
              ? {
                  parent:
                    entry.reply.parent && "uri" in entry.reply.parent
                      ? { uri: String(entry.reply.parent.uri) }
                      : undefined,
                  root:
                    entry.reply.root && "uri" in entry.reply.root
                      ? { uri: String(entry.reply.root.uri) }
                      : undefined,
                }
              : undefined,
        })),
        cursor: response.data.cursor,
      };
    },
  };
}

export class SyncService {
  constructor(
    private readonly db: AtticDatabase,
    private readonly client: SyncClient,
    private readonly log?: (message: string) => void,
  ) {}

  async sync(options: SyncOptions = {}): Promise<SyncStats> {
    const full = options.full ?? false;
    const timelinePostsSaved = await this.syncTimeline(
      full,
      options.maxTimelinePages,
    );

    const followedThreadsFound = this.db.listThreadSummaries(1, 1_000_000).length;

    return {
      timelinePostsSaved,
      followedThreadsFound,
    };
  }

  private async syncTimeline(
    full: boolean,
    maxTimelinePages?: number,
  ): Promise<number> {
    const cursorKey = "timeline";
    const since = full ? null : this.db.getCursor(cursorKey);

    let apiCursor: string | undefined;
    let pages = 0;
    let inserted = 0;
    let newestTimestamp = since;
    let done = false;

    while (!done) {
      const page = await this.client.getTimeline(apiCursor);
      pages += 1;

      const pageRecords: PostRecordInput[] = [];

      for (const entry of page.feed) {
        const timestamp = getTimelineTimestamp(entry);
        if (!newestTimestamp || timestamp > newestTimestamp) {
          newestTimestamp = timestamp;
        }

        if (!full && since && timestamp <= since) {
          done = true;
          break;
        }

        const post = mapTimelinePost(entry);
        if (post) {
          pageRecords.push(post);
        }
      }

      if (pageRecords.length > 0) {
        inserted += pageRecords.length;
        this.db.upsertPosts(pageRecords);
      }

      if (!page.cursor || done) {
        break;
      }

      if (maxTimelinePages !== undefined && pages >= maxTimelinePages) {
        break;
      }

      apiCursor = page.cursor;
    }

    if (newestTimestamp) {
      this.db.setCursor(cursorKey, newestTimestamp);
    }

    return inserted;
  }
}

export async function runSync(
  db: AtticDatabase,
  options: SyncOptions = {},
): Promise<SyncStats> {
  const config = getConfig();
  const { agent, session } = await createAuthenticatedAgent(config);
  const service = new SyncService(
    db,
    createSyncClient(agent),
    options.onProgress,
  );

  return service.sync(options);
}

function mapTimelinePost(entry: TimelineFeedItem): PostRecordInput | null {
  const record = entry.post.record;
  const createdAt =
    getString(record, "createdAt") ??
    getTimelineTimestamp(entry) ??
    entry.post.indexedAt;
  const text = getString(record, "text") ?? "";

  if (!createdAt) {
    return null;
  }

  const replyFromRecord = getObject(record, "reply");
  const parentFromRecord = getObject(replyFromRecord, "parent");
  const rootFromRecord = getObject(replyFromRecord, "root");

  const replyParentUri =
    getString(parentFromRecord, "uri") ?? entry.reply?.parent?.uri ?? null;
  const replyRootUri =
    getString(rootFromRecord, "uri") ?? entry.reply?.root?.uri ?? null;

  return {
    uri: entry.post.uri,
    cid: entry.post.cid,
    authorDid: entry.post.author.did,
    authorHandle: entry.post.author.handle,
    authorDisplayName: entry.post.author.displayName,
    authorAvatar: entry.post.author.avatar,
    text,
    timestamp: createdAt,
    replyParentUri,
    replyRootUri,
    raw: entry,
  };
}

function getTimelineTimestamp(entry: TimelineFeedItem): string {
  const createdAt = getString(entry.post.record, "createdAt");
  return createdAt ?? entry.post.indexedAt;
}

function getObject(
  obj: Record<string, unknown> | undefined,
  key: string,
): Record<string, unknown> | undefined {
  if (!obj) {
    return undefined;
  }

  const value = obj[key];
  if (!value || typeof value !== "object") {
    return undefined;
  }

  return value as Record<string, unknown>;
}

function getString(
  obj: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  if (!obj) {
    return undefined;
  }

  const value = obj[key];
  return typeof value === "string" ? value : undefined;
}
