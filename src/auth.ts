import { createHmac, randomBytes } from 'crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

export interface Credentials {
  api_key: string;
  api_secret: string;
  oauth_token: string;
  oauth_token_secret: string;
  user_nsid: string;
  username: string;
}

const CONFIG_DIR = join(homedir(), '.config', 'flickr-mcp');
const CONFIG_FILE = join(CONFIG_DIR, 'credentials.json');

export function hasCredentials(): boolean {
  return existsSync(CONFIG_FILE);
}

export function loadCredentials(): Credentials {
  if (!hasCredentials()) {
    throw new Error('No credentials found. Run: flickr-mcp setup');
  }
  return JSON.parse(readFileSync(CONFIG_FILE, 'utf-8')) as Credentials;
}

export function saveCredentials(creds: Credentials): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(creds, null, 2), { mode: 0o600 });
}

// RFC 3986 percent encoding as required by OAuth 1.0a
function pct(s: string): string {
  return encodeURIComponent(s)
    .replace(/!/g, '%21')
    .replace(/\*/g, '%2A')
    .replace(/'/g, '%27')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29');
}

export interface OAuthOptions {
  consumerKey: string;
  consumerSecret: string;
  tokenKey?: string;
  tokenSecret?: string;
}

/**
 * Build an OAuth 1.0a Authorization header.
 * requestParams must include ALL non-oauth params that will be sent
 * (query string for GET, body for POST) so they are included in the signature.
 */
export function buildAuthHeader(
  method: string,
  url: string,
  requestParams: Record<string, string>,
  opts: OAuthOptions
): string {
  const oauthParams: Record<string, string> = {
    oauth_consumer_key: opts.consumerKey,
    oauth_nonce: randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_version: '1.0',
    ...(opts.tokenKey ? { oauth_token: opts.tokenKey } : {}),
  };

  // Signature base string includes ALL params
  const allParams = { ...requestParams, ...oauthParams };
  const paramStr = Object.keys(allParams)
    .sort()
    .map(k => `${pct(k)}=${pct(allParams[k])}`)
    .join('&');

  const baseString = [method.toUpperCase(), pct(url), pct(paramStr)].join('&');
  const signingKey = `${pct(opts.consumerSecret)}&${pct(opts.tokenSecret ?? '')}`;
  const signature = createHmac('sha1', signingKey).update(baseString).digest('base64');

  // Authorization header carries only oauth params + signature
  const headerParams = { ...oauthParams, oauth_signature: signature };
  const headerValue = Object.entries(headerParams)
    .map(([k, v]) => `${k}="${pct(v)}"`)
    .join(', ');

  return `OAuth realm="", ${headerValue}`;
}

export async function getRequestToken(
  apiKey: string,
  apiSecret: string,
  callbackUrl: string = 'oob'
): Promise<{ token: string; tokenSecret: string }> {
  const url = 'https://www.flickr.com/services/oauth/request_token';
  const reqParams = { oauth_callback: callbackUrl };
  const header = buildAuthHeader('POST', url, reqParams, {
    consumerKey: apiKey,
    consumerSecret: apiSecret,
  });

  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: header },
    body: new URLSearchParams(reqParams),
  });

  if (!res.ok) {
    throw new Error(`Request token failed: ${res.status} ${await res.text()}`);
  }

  const parsed = Object.fromEntries(new URLSearchParams(await res.text()));
  if (parsed.oauth_callback_confirmed !== 'true') {
    throw new Error('OAuth callback confirmation failed');
  }
  return { token: parsed.oauth_token, tokenSecret: parsed.oauth_token_secret };
}

export async function getAccessToken(
  apiKey: string,
  apiSecret: string,
  requestToken: string,
  requestTokenSecret: string,
  verifier: string
): Promise<{ token: string; tokenSecret: string; userNsid: string; username: string }> {
  const url = 'https://www.flickr.com/services/oauth/access_token';
  const reqParams = { oauth_verifier: verifier };
  const header = buildAuthHeader('POST', url, reqParams, {
    consumerKey: apiKey,
    consumerSecret: apiSecret,
    tokenKey: requestToken,
    tokenSecret: requestTokenSecret,
  });

  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: header },
    body: new URLSearchParams(reqParams),
  });

  if (!res.ok) {
    throw new Error(`Access token failed: ${res.status} ${await res.text()}`);
  }

  const parsed = Object.fromEntries(new URLSearchParams(await res.text()));
  return {
    token: parsed.oauth_token,
    tokenSecret: parsed.oauth_token_secret,
    userNsid: parsed.user_nsid,
    username: parsed.username,
  };
}
