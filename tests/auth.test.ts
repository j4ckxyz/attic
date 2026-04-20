import { describe, expect, test } from "bun:test";
import { createAuthenticatedAgent, createSession } from "../src/auth";
import { getConfig } from "../src/config";

describe("auth", () => {
  test(
    "creates a session via com.atproto.server.createSession",
    async () => {
      const config = getConfig();
      const session = await createSession(config);

      expect(session.did.startsWith("did:")).toBe(true);
      expect(session.handle.length).toBeGreaterThan(0);
      expect(session.accessJwt.length).toBeGreaterThan(20);
      expect(session.refreshJwt.length).toBeGreaterThan(20);
      expect(session.active).toBe(true);
    },
    { timeout: 30_000 },
  );

  test(
    "creates an authenticated agent that can call getSession",
    async () => {
      const config = getConfig();
      const { agent, session } = await createAuthenticatedAgent(config);
      const response = await agent.com.atproto.server.getSession();

      expect(response.success).toBe(true);
      expect(response.data.did).toBe(session.did);
      expect(response.data.handle).toBe(session.handle);
    },
    { timeout: 30_000 },
  );
});
