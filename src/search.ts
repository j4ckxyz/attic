import type { AtticDatabase } from "./db";
import type { PostRow, SearchFilters } from "./types";

export type SearchServiceOptions = SearchFilters & {
  limit?: number;
  offset?: number;
};

export class SearchService {
  constructor(private readonly db: AtticDatabase) {}

  search(query: string, options: SearchServiceOptions = {}): PostRow[] {
    const trimmed = query.trim();
    if (!trimmed) {
      return [];
    }

    return this.db.searchPosts(trimmed, {
      authorHandle: options.authorHandle,
      from: options.from,
      to: options.to,
      limit: options.limit,
      offset: options.offset,
    });
  }
}

export function formatSearchResults(results: PostRow[]): string {
  if (results.length === 0) {
    return "No matching posts found.";
  }

  return results
    .map((post, idx) => {
      const text = post.text.replaceAll("\n", " ").trim();
      const short = text.length > 180 ? `${text.slice(0, 177)}...` : text;
      return `${idx + 1}. [${post.timestamp}] @${post.authorHandle} ${short}\n   ${post.uri}`;
    })
    .join("\n");
}
