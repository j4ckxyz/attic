export type RetryOptions = {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
};

function getErrorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }

  const e = error as {
    status?: number;
    response?: { status?: number };
    cause?: { status?: number };
  };

  return e.status ?? e.response?.status ?? e.cause?.status;
}

function isRetryable(error: unknown): boolean {
  const status = getErrorStatus(error);
  if (status === undefined) {
    return true;
  }

  return status === 429 || status >= 500;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const maxRetries = options.maxRetries ?? 5;
  const baseDelayMs = options.baseDelayMs ?? 500;
  const maxDelayMs = options.maxDelayMs ?? 30_000;

  let attempt = 0;

  while (true) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= maxRetries || !isRetryable(error)) {
        throw error;
      }

      const jitter = Math.floor(Math.random() * 200);
      const delay = Math.min(baseDelayMs * 2 ** attempt + jitter, maxDelayMs);
      await sleep(delay);
      attempt += 1;
    }
  }
}
