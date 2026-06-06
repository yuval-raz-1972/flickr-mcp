import { createInterface } from 'readline/promises';
import { getRequestToken, getAccessToken, saveCredentials, hasCredentials } from './auth.js';

async function prompt(rl: ReturnType<typeof createInterface>, question: string): Promise<string> {
  const answer = await rl.question(question);
  return answer.trim();
}

export async function runSetup(force = false): Promise<void> {
  if (hasCredentials() && !force) {
    console.error('Credentials already exist. Run with --force to re-authenticate.');
    process.exit(0);
  }

  const rl = createInterface({ input: process.stdin, output: process.stderr });

  console.error('\n=== Flickr MCP Setup ===\n');
  console.error('You need a Flickr API key to continue.');
  console.error('Register a free app at: https://www.flickr.com/services/apps/create/noncommercial/');
  console.error('(Takes about 2 minutes — fill in any app name/description, select "personal use")\n');

  const apiKey = await prompt(rl, 'Paste your API key:    ');
  const apiSecret = await prompt(rl, 'Paste your API secret: ');

  if (!apiKey || !apiSecret) {
    console.error('API key and secret are required.');
    rl.close();
    process.exit(1);
  }

  console.error('\nRequesting OAuth token from Flickr...');
  let requestToken: string;
  let requestTokenSecret: string;

  try {
    const rt = await getRequestToken(apiKey, apiSecret);
    requestToken = rt.token;
    requestTokenSecret = rt.tokenSecret;
  } catch (e) {
    console.error(`Failed: ${e instanceof Error ? e.message : e}`);
    console.error('Double-check your API key and secret and try again.');
    rl.close();
    process.exit(1);
  }

  const authUrl = `https://www.flickr.com/services/oauth/authorize?oauth_token=${requestToken}&perms=write`;

  console.error('\nOpen this URL in your browser to authorize access to your Flickr account:');
  console.error(`\n  ${authUrl}\n`);

  // Try to open the browser automatically
  try {
    const { default: open } = await import('open');
    await open(authUrl);
    console.error('(Browser opened automatically)');
  } catch {
    console.error('(Open the URL manually — could not launch browser)');
  }

  console.error('\nFlickr will show you a 9-digit verification code after you authorize.');
  const verifier = await prompt(rl, 'Paste the verification code: ');

  if (!verifier) {
    console.error('Verification code is required.');
    rl.close();
    process.exit(1);
  }

  console.error('\nExchanging for access token...');
  let accessToken: { token: string; tokenSecret: string; userNsid: string; username: string };

  try {
    accessToken = await getAccessToken(apiKey, apiSecret, requestToken, requestTokenSecret, verifier);
  } catch (e) {
    console.error(`Failed: ${e instanceof Error ? e.message : e}`);
    rl.close();
    process.exit(1);
  }

  saveCredentials({
    api_key: apiKey,
    api_secret: apiSecret,
    oauth_token: accessToken.token,
    oauth_token_secret: accessToken.tokenSecret,
    user_nsid: accessToken.userNsid,
    username: accessToken.username,
  });

  rl.close();

  console.error(`\n✓ Authenticated as @${accessToken.username} (${accessToken.userNsid})`);
  console.error('✓ Credentials saved to ~/.config/flickr-mcp/credentials.json');
  console.error('\nSetup complete. Add this server to your MCP client config and start tagging!\n');
}
