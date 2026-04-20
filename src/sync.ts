import { AtpAgent } from "@atproto/api";
import { createAuthenticatedAgent } from "./auth";
import { getConfig } from "./config";
import type { AtticDatabase } from "./db";
import { withRetry } from "./retry";
import type { PostRecordInput } from "./types";

type FollowProfile = {
  did: string;
  handle: string;
  displayName?: string;
  avatar?: string;
};

type RepoRecord = {
  uri: string;
  cid: string;
  value: Record<string, unknown>;
};

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

type FollowsPage = {
  follows: FollowProfile[];
  cursor?: string;
};

type RepoRecordsPage = {
  records: RepoRecord[];
  cursor?: string;
};

type TimelinePage = {
  feed: TimelineFeedItem[];
  cursor?: string;
};

export type SyncClient = {
  getFollows(actor: string, cursor?: string): Promise<FollowsPage>;
  listRecords(repo: string, cursor?: string): Promise<RepoRecordsPage>;
  getTimeline(cursor?: string): Promise<TimelinePage>;
};

export type SyncOptions = {
  full?: boolean;
  maxAccounts?: number;
  maxPagesPerRepo?: number;
  maxTimelinePages?: number;
  onProgress?: (message: string) => void;
};

export type SyncStats = {
  followsCount: number;
  repoPostsSaved: number;
  timelinePostsSaved: number;
  followedThreadsFound: number;
};

export function createSyncClient(agent: AtpAgent): SyncClient {
  const pdsByDid = new Map<string, string>();
  const agentByPds = new Map<string, AtpAgent>();

  const getAgentForPds = (pdsUrl: string): AtpAgent => {
    const existing = agentByPds.get(pdsUrl);
    if (existing) {
      return existing;
    }

    const created = new AtpAgent({ service: pdsUrl });
    agentByPds.set(pdsUrl, created);
    return created;
  };

  const resolvePdsForDid = async (did: string): Promise<string> => {
    const cached = pdsByDid.get(did);
    if (cached) {
      return cached;
    }

    const endpoint = getDidDocumentUrl(did);
    const response = await withRetry(() => fetch(endpoint));
    if (!response.ok) {
      throw new Error(`Failed to resolve DID document for ${did}`);
    }

    const data = (await response.json()) as {
      service?: Array<{
        id?: string;
        type?: string;
        serviceEndpoint?: string;
      }>;
    };

    const service = data.service?.find(
      (entry) =>
        entry.id === "#atproto_pds" &&
        entry.type === "AtprotoPersonalDataServer" &&
        typeof entry.serviceEndpoint === "string",
    );

    const pdsUrl = service?.serviceEndpoint;
    if (!pdsUrl) {
      throw new Error(`No PDS endpoint in DID document for ${did}`);
    }

    pdsByDid.set(did, pdsUrl);
    return pdsUrl;
  };

  return {
    async getFollows(actor: string, cursor?: string): Promise<FollowsPage> {
      const response = await withRetry(() =>
        agent.getFollows({ actor, cursor, limit: 100 }),
      );

      return {
        follows: response.data.follows.map((f) => ({
          did: f.did,
          handle: f.handle,
          displayName: f.displayName,
          avatar: f.avatar,
        })),
        cursor: response.data.cursor,
      };
    },

    async listRecords(repo: string, cursor?: string): Promise<RepoRecordsPage> {
      const pdsUrl = await resolvePdsForDid(repo);
      const pdsAgent = getAgentForPds(pdsUrl);

      const response = await withRetry(() =>
        pdsAgent.com.atproto.repo.listRecords({
          repo,
          collection: "app.bsky.feed.post",
          cursor,
          limit: 100,
        }),
      );

      return {
        records: response.data.records.map((r) => ({
          uri: r.uri,
          cid: r.cid,
          value: (r.value as Record<string, unknown>) ?? {},
        })),
        cursor: response.data.cursor,
      };
    },

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
    private readonly viewerDid: string,
    private readonly log?: (message: string) => void,
  ) {}

  async sync(options: SyncOptions = {}): Promise<SyncStats> {
    const full = options.full ?? false;
    const followed = await this.fetchAllFollows();

    for (const follow of followed) {
      this.db.upsertAuthor({
        did: follow.did,
        handle: follow.handle,
        displayName: follow.displayName,
        avatarUrl: follow.avatar,
      });
    }

    const followedSlice =
      options.maxAccounts !== undefined
        ? followed.slice(0, options.maxAccounts)
        : followed;

    let repoPostsSaved = 0;
    for (const account of followedSlice) {
      try {
        const saved = await this.syncRepo(account, full, options.maxPagesPerRepo);
        repoPostsSaved += saved;
        this.log?.(`synced ${saved} posts from ${account.handle}`);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "unknown sync error";
        this.log?.(`skipped ${account.handle}: ${message}`);
      }
    }

    const followedDidSet = new Set(followed.map((f) => f.did));
    const timelinePostsSaved = await this.syncTimeline(
      followedDidSet,
      full,
      options.maxTimelinePages,
    );

    this.db.refreshFollowedThreads(Array.from(followedDidSet));
    const followedThreadsFound = this.db.listThreadSummaries(1, 1_000_000).length;

    return {
      followsCount: followed.length,
      repoPostsSaved,
      timelinePostsSaved,
      followedThreadsFound,
    };
  }

  private async fetchAllFollows(): Promise<FollowProfile[]> {
    const follows: FollowProfile[] = [];
    let cursor: string | undefined;

    do {
      const page = await this.client.getFollows(this.viewerDid, cursor);
      follows.push(...page.follows);
      cursor = page.cursor;
    } while (cursor);

    return follows;
  }

  private async syncRepo(
    account: FollowProfile,
    full: boolean,
    maxPagesPerRepo?: number,
  ): Promise<number> {
    const cursorKey = `repo:${account.did}`;
    const since = full ? null : this.db.getCursor(cursorKey);

    let apiCursor: string | undefined;
    let pages = 0;
    let inserted = 0;
    let newestTimestamp = since;
    let done = false;

    while (!done) {
      const page = await this.client.listRecords(account.did, apiCursor);
      pages += 1;

      const pageRecords: PostRecordInput[] = [];

      for (const record of page.records) {
        const post = mapRepoRecord(record, account);
        if (!post) {
          continue;
        }

        if (!full && since && post.timestamp <= since) {
          done = true;
          break;
        }

        if (!newestTimestamp || post.timestamp > newestTimestamp) {
          newestTimestamp = post.timestamp;
        }

        pageRecords.push(post);
      }

      if (pageRecords.length > 0) {
        inserted += pageRecords.length;
        this.db.upsertPosts(pageRecords);
      }

      if (!page.cursor || done) {
        break;
      }

      if (maxPagesPerRepo !== undefined && pages >= maxPagesPerRepo) {
        break;
      }

      apiCursor = page.cursor;
    }

    if (newestTimestamp) {
      this.db.setCursor(cursorKey, newestTimestamp);
    }

    return inserted;
  }

  private async syncTimeline(
    followedDidSet: Set<string>,
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

        if (!followedDidSet.has(entry.post.author.did)) {
          continue;
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
    session.did,
    options.onProgress,
  );

  return service.sync(options);
}

function mapRepoRecord(record: RepoRecord, author: FollowProfile): PostRecordInput | null {
  const value = record.value;
  const createdAt = getString(value, "createdAt");
  const text = getString(value, "text") ?? "";

  if (!createdAt) {
    return null;
  }

  const reply = getObject(value, "reply");
  const parent = getObject(reply, "parent");
  const root = getObject(reply, "root");

  return {
    uri: record.uri,
    cid: record.cid,
    authorDid: author.did,
    authorHandle: author.handle || extractHandleFromAtUri(record.uri) || author.did,
    authorDisplayName: author.displayName,
    authorAvatar: author.avatar,
    text,
    timestamp: createdAt,
    replyParentUri: getString(parent, "uri") ?? null,
    replyRootUri: getString(root, "uri") ?? null,
    raw: value,
  };
}

function mapTimelinePost(entry: TimelineFeedItem): PostRecordInput | null {
  const record = entry.post.record;
  const createdAt =
    getString(record, "createdAt") ?? getTimelineTimestamp(entry) ?? entry.post.indexedAt;
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

function extractHandleFromAtUri(uri: string): string | undefined {
  const match = /^at:\/\/([^/]+)\//.exec(uri);
  return match ? match[1] : undefined;
}

function getDidDocumentUrl(did: string): string {
  if (did.startsWith("did:plc:")) {
    return `https://plc.directory/${did}`;
  }

  if (did.startsWith("did:web:")) {
    const webPart = did.slice("did:web:".length);
    const segments = webPart.split(":");
    const host = segments[0];
    const path = segments.slice(1).join("/");

    if (!host) {
      throw new Error(`Invalid did:web value: ${did}`);
    }

    if (!path) {
      return `https://${host}/.well-known/did.json`;
    }

    return `https://${host}/${path}/did.json`;
  }

  throw new Error(`Unsupported DID method for ${did}`);
}
