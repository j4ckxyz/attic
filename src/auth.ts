import { AtpAgent, type AtpSessionData } from "@atproto/api";
import { getConfig, type AppConfig } from "./config";
import { withRetry } from "./retry";

type CreateSessionResponse = {
  accessJwt: string;
  refreshJwt: string;
  handle: string;
  did: string;
  email?: string;
  emailConfirmed?: boolean;
  emailAuthFactor?: boolean;
  active?: boolean;
  status?: string;
};

function getCreateSessionUrl(pdsUrl: string): string {
  return new URL("/xrpc/com.atproto.server.createSession", pdsUrl).toString();
}

function toAtpSessionData(payload: CreateSessionResponse): AtpSessionData {
  return {
    accessJwt: payload.accessJwt,
    refreshJwt: payload.refreshJwt,
    handle: payload.handle,
    did: payload.did,
    email: payload.email,
    emailConfirmed: payload.emailConfirmed,
    emailAuthFactor: payload.emailAuthFactor,
    active: payload.active ?? true,
    status: payload.status,
  };
}

export async function createSession(
  config: AppConfig = getConfig(),
): Promise<AtpSessionData> {
  const endpoint = getCreateSessionUrl(config.pdsUrl);

  return withRetry(async () => {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        identifier: config.handle,
        password: config.appPassword,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      const error = new Error(
        `createSession failed (${response.status}): ${body}`,
      ) as Error & { status?: number };
      error.status = response.status;
      throw error;
    }

    const data = (await response.json()) as CreateSessionResponse;
    return toAtpSessionData(data);
  });
}

export async function createAuthenticatedAgent(
  config: AppConfig = getConfig(),
): Promise<{ agent: AtpAgent; session: AtpSessionData }> {
  const session = await createSession(config);
  const agent = new AtpAgent({ service: config.pdsUrl });
  await agent.resumeSession(session);

  return { agent, session };
}
