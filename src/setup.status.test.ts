import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PatchResult } from './config-patcher.js';
import { createSetupServer, type SetupServer, type SetupServerDeps } from './setup.js';

const API_KEY = 'TEST_API_KEY_DO_NOT_EXPOSE';
const API_SECRET = 'TEST_API_SECRET_DO_NOT_EXPOSE';
const REQUEST_TOKEN = 'TEST_OAUTH_REQUEST_TOKEN_DO_NOT_EXPOSE';
const REQUEST_TOKEN_SECRET = 'TEST_OAUTH_TOKEN_SECRET_DO_NOT_EXPOSE';
const ACCESS_TOKEN = 'TEST_OAUTH_ACCESS_TOKEN_DO_NOT_EXPOSE';
const ACCESS_TOKEN_SECRET = 'TEST_ACCESS_TOKEN_SECRET_DO_NOT_EXPOSE';

const SECRET_VALUES = [
  API_KEY,
  API_SECRET,
  REQUEST_TOKEN,
  REQUEST_TOKEN_SECRET,
  ACCESS_TOKEN,
  ACCESS_TOKEN_SECRET,
];

const configResults: PatchResult[] = [
  { label: 'Claude Desktop', patched: true },
  { label: 'Cursor', patched: false, reason: 'Already configured' },
];

function assertSerializedResponseHidesSecrets(body: string) {
  for (const secret of SECRET_VALUES) {
    expect(body).not.toContain(secret);
  }
}

describe('GET /status', () => {
  const servers: SetupServer[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map(server => server.close()));
  });

  function deps(overrides: Partial<SetupServerDeps> = {}): SetupServerDeps {
    return {
      getRequestToken: vi.fn().mockResolvedValue({
        token: REQUEST_TOKEN,
        tokenSecret: REQUEST_TOKEN_SECRET,
      }),
      getAccessToken: vi.fn().mockResolvedValue({
        token: ACCESS_TOKEN,
        tokenSecret: ACCESS_TOKEN_SECRET,
        userNsid: '123456789@N00',
        username: 'testuser',
      }),
      saveCredentials: vi.fn(),
      patchMcpConfigs: vi.fn().mockReturnValue(configResults),
      ...overrides,
    };
  }

  async function listen(overrides: Partial<SetupServerDeps> = {}) {
    const server = createSetupServer(deps(overrides));
    servers.push(server);
    const port = await server.listen();
    return { port };
  }

  async function startAuth(port: number) {
    const response = await fetch(`http://127.0.0.1:${port}/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: API_KEY, apiSecret: API_SECRET }),
    });
    expect(response.ok).toBe(true);
  }

  async function statusText(port: number) {
    const response = await fetch(`http://127.0.0.1:${port}/status`);
    expect(response.status).toBe(200);
    return response.text();
  }

  it('returns only the idle phase before credentials are submitted', async () => {
    const { port } = await listen();
    const body = await statusText(port);

    expect(JSON.parse(body)).toEqual({ phase: 'idle' });
    assertSerializedResponseHidesSecrets(body);
  });

  it('does not return the API secret, request token, or request token secret while waiting for authorization', async () => {
    const { port } = await listen();
    await startAuth(port);
    const body = await statusText(port);
    const status = JSON.parse(body) as Record<string, unknown>;

    expect(status).toEqual({ phase: 'awaiting_auth' });
    expect(status).not.toHaveProperty('apiSecret');
    expect(status).not.toHaveProperty('apiKey');
    expect(status).not.toHaveProperty('requestToken');
    expect(status).not.toHaveProperty('requestTokenSecret');
    expect(status).not.toHaveProperty('oauth_token');
    expect(status).not.toHaveProperty('oauth_token_secret');
    assertSerializedResponseHidesSecrets(body);
  });

  it('returns username and config results after authorization without any stored tokens', async () => {
    const saveCredentials = vi.fn();
    const { port } = await listen({ saveCredentials });
    await startAuth(port);

    const callback = await fetch(
      `http://127.0.0.1:${port}/callback?oauth_verifier=TEST_VERIFIER`
    );
    expect(callback.status).toBe(200);

    const body = await statusText(port);
    const status = JSON.parse(body) as {
      phase: string;
      username: string;
      configResults: PatchResult[];
    };

    expect(status).toEqual({
      phase: 'done',
      username: 'testuser',
      configResults,
    });
    expect(saveCredentials).toHaveBeenCalledOnce();
    assertSerializedResponseHidesSecrets(body);
  });

  it('keeps a safe error message for the setup page when authorization fails', async () => {
    const { port } = await listen({
      getAccessToken: vi.fn().mockRejectedValue(new Error(
        `Access token failed: 401 oauth_token=${ACCESS_TOKEN}&oauth_token_secret=${ACCESS_TOKEN_SECRET} ${API_SECRET} ${REQUEST_TOKEN} ${REQUEST_TOKEN_SECRET}`
      )),
    });
    await startAuth(port);

    const callback = await fetch(
      `http://127.0.0.1:${port}/callback?oauth_verifier=TEST_VERIFIER`
    );
    expect(callback.status).toBe(500);

    const body = await statusText(port);
    const status = JSON.parse(body) as { phase: string; message: string };

    expect(status.phase).toBe('error');
    expect(status.message).toContain('Access token failed: 401');
    expect(status.message).not.toContain(API_SECRET);
    expect(Object.keys(status).sort()).toEqual(['message', 'phase']);
    assertSerializedResponseHidesSecrets(body);
  });

  it('does not echo access token material when saving credentials fails', async () => {
    const { port } = await listen({
      saveCredentials: vi.fn().mockImplementation(() => {
        throw new Error(`Could not write ${ACCESS_TOKEN} ${ACCESS_TOKEN_SECRET} ${API_SECRET}`);
      }),
    });
    await startAuth(port);
    await fetch(`http://127.0.0.1:${port}/callback?oauth_verifier=TEST_VERIFIER`);

    const body = await statusText(port);
    const status = JSON.parse(body) as { phase: string; message: string };

    expect(status.phase).toBe('error');
    expect(status.message).toContain('Could not write');
    assertSerializedResponseHidesSecrets(body);
  });
});
