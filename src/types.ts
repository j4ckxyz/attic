export type AuthorRecord = {
  did: string;
  handle: string;
  displayName?: string | null;
  avatarUrl?: string | null;
};

export type PostRecordInput = {
  uri: string;
  cid: string;
  authorDid: string;
  authorHandle: string;
  authorDisplayName?: string | null;
  authorAvatar?: string | null;
  text: string;
  timestamp: string;
  replyParentUri?: string | null;
  replyRootUri?: string | null;
  raw: unknown;
};

export type PostRow = {
  uri: string;
  cid: string;
  authorDid: string;
  authorHandle: string;
  displayName: string | null;
  avatarUrl: string | null;
  text: string;
  timestamp: string;
  replyParentUri: string | null;
  replyRootUri: string | null;
  threadRootUri: string;
  bookmarked: boolean;
};

export type SearchFilters = {
  authorHandle?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
};

export type ThreadSummary = {
  threadRootUri: string;
  participantCount: number;
  lastPostAt: string;
};
