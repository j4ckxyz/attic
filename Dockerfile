FROM oven/bun:1-alpine AS base
WORKDIR /app

# Install dependencies
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Copy source code
COPY . .

# Create data directory for SQLite
RUN mkdir -p /app/data

ENV NODE_ENV=production
ENV ATTIC_DB_PATH=/app/data/attic.db
ENV PORT=8787
ENV HOST=0.0.0.0

EXPOSE 8787

# Default: run web server with built-in sync worker
CMD ["bun", "run", "src/cli.ts", "serve", "--no-open", "--sync-interval", "15"]
