import { mkdirSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { join, extname } from "node:path";
import type { AtticDatabase } from "./db";
import { withRetry } from "./retry";

export type AvatarCacheOptions = {
  cacheDir?: string;
};

export class AvatarCacher {
  private readonly cacheDir: string;

  constructor(options: AvatarCacheOptions = {}) {
    this.cacheDir = options.cacheDir ?? "data/avatars";
    mkdirSync(this.cacheDir, { recursive: true });
  }

  async cacheAvatars(db: AtticDatabase): Promise<number> {
    const authors = db.getAuthorsNeedingAvatarCache();
    let cached = 0;

    for (const author of authors) {
      if (!author.avatarUrl) {
        continue;
      }

      const localPath = await this.downloadAvatar(author.did, author.avatarUrl);
      if (localPath) {
        db.markAvatarCached(author.did);
        cached += 1;
      }
    }

    return cached;
  }

  private async downloadAvatar(
    did: string,
    url: string,
  ): Promise<string | null> {
    const safeDid = did.replaceAll(/[^a-zA-Z0-9._-]/g, "_");
    const ext = this.guessExt(url) ?? ".jpg";
    const filename = `${safeDid}${ext}`;
    const filepath = join(this.cacheDir, filename);

    if (existsSync(filepath)) {
      return `/avatars/${filename}`;
    }

    try {
      const response = await withRetry(() => fetch(url), {
        maxRetries: 2,
        baseDelayMs: 200,
      });

      if (!response.ok) {
        return null;
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length === 0) {
        return null;
      }

      writeFileSync(filepath, buffer);
      return `/avatars/${filename}`;
    } catch {
      return null;
    }
  }

  private guessExt(url: string): string | null {
    const ext = extname(url.split("?")[0]).toLowerCase();
    if (ext === ".png" || ext === ".jpg" || ext === ".jpeg" || ext === ".webp" || ext === ".gif") {
      return ext === ".jpeg" ? ".jpg" : ext;
    }

    return ".jpg";
  }

  serveAvatar(filename: string): Uint8Array | null {
    const safe = filename.replaceAll(/[^a-zA-Z0-9._-]/g, "_");
    const filepath = join(this.cacheDir, safe);

    if (!existsSync(filepath)) {
      return null;
    }

    return readFileSync(filepath);
  }

  getContentType(filename: string): string {
    const ext = extname(filename).toLowerCase();
    switch (ext) {
      case ".png":
        return "image/png";
      case ".webp":
        return "image/webp";
      case ".gif":
        return "image/gif";
      default:
        return "image/jpeg";
    }
  }
}
