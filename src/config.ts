export type AppConfig = {
  handle: string;
  appPassword: string;
  pdsUrl: string;
  dbPath: string;
  pageSize: number;
};

function getRequiredEnv(name: string): string {
  const value = Bun.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

export function getConfig(): AppConfig {
  return {
    handle: getRequiredEnv("BLUESKY_HANDLE"),
    appPassword: getRequiredEnv("BLUESKY_APP_PASSWORD"),
    pdsUrl: getRequiredEnv("BLUESKY_PDS_URL"),
    dbPath: Bun.env.ATTIC_DB_PATH ?? "data/attic.db",
    pageSize: Number(Bun.env.ATTIC_PAGE_SIZE ?? "50"),
  };
}
