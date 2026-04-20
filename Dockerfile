FROM oven/bun:1 AS base
WORKDIR /app

# Install dependencies
FROM base AS install
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Copy source code
COPY . .

# Build stage (optional - Bun runs TS directly)
FROM base AS build
COPY --from=install /app /app
RUN bun build src/cli.ts --outdir ./dist --target node

# Runtime stage
FROM base AS runtime
COPY --from=install /app/node_modules ./node_modules
COPY --from=install /app/src ./src
COPY --from=install /app/package.json ./

# Create data directory for SQLite
RUN mkdir -p /app/data

ENV NODE_ENV=production
ENV ATTIC_DB_PATH=/app/data/attic.db
ENV PORT=8787
ENV HOST=0.0.0.0

EXPOSE 8787

CMD ["bun", "run", "src/cli.ts", "serve", "--no-open"]
