import { createServer, IncomingMessage, ServerResponse } from 'http';
import { getRequestToken, getAccessToken, saveCredentials, hasCredentials } from './auth.js';
import { patchMcpConfigs, PatchResult } from './config-patcher.js';

type SetupState =
  | { phase: 'idle' }
  | { phase: 'awaiting_auth'; apiKey: string; apiSecret: string; requestToken: string; requestTokenSecret: string }
  | { phase: 'done'; username: string; configResults: PatchResult[] }
  | { phase: 'error'; message: string };

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => (body += chunk));
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, data: unknown) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(body);
}

const CALLBACK_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Authorized · Flickr MCP</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f0f0f0;min-height:100vh;display:flex;align-items:center;justify-content:center}
.card{background:#fff;border-radius:16px;padding:48px 40px;text-align:center;max-width:400px;width:100%;box-shadow:0 4px 24px rgba(0,0,0,.10)}
.icon{font-size:52px;margin-bottom:20px}
h2{font-size:20px;font-weight:700;color:#111;margin-bottom:8px}
p{color:#666;font-size:14px;line-height:1.5}
</style>
</head>
<body>
<div class="card">
  <div class="icon">✅</div>
  <h2>Authorization complete</h2>
  <p>You can close this tab and return to the setup page.</p>
</div>
</body>
</html>`;

const SETUP_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Flickr MCP · Setup</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f0f0f0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
.card{background:#fff;border-radius:16px;box-shadow:0 4px 24px rgba(0,0,0,.10);max-width:520px;width:100%;padding:48px 40px}
h1{font-size:22px;font-weight:700;color:#111;margin-bottom:4px}
.subtitle{color:#777;font-size:14px;margin-bottom:32px}

/* Step indicator */
.steps{display:flex;align-items:center;margin-bottom:36px}
.dot{width:28px;height:28px;border-radius:50%;background:#e5e5e5;color:#aaa;font-size:12px;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:background .2s,color .2s}
.dot.active{background:#ff0084;color:#fff}
.dot.done{background:#16a34a;color:#fff}
.line{flex:1;height:2px;background:#e5e5e5;transition:background .2s}
.line.done{background:#16a34a}

/* Form */
label{display:block;font-size:13px;font-weight:600;color:#333;margin-bottom:6px;margin-top:18px}
input{width:100%;padding:10px 14px;border:1.5px solid #ddd;border-radius:8px;font-size:14px;font-family:'SFMono-Regular',Consolas,monospace;color:#111;outline:none;transition:border-color .15s;background:#fafafa}
input:focus{border-color:#ff0084;background:#fff}
.hint{background:#fff5fb;border:1px solid #ffd6ea;border-radius:8px;padding:13px 15px;margin:20px 0 4px;font-size:13px;color:#555;line-height:1.6}
.hint a{color:#ff0084;font-weight:600;text-decoration:none}
.hint a:hover{text-decoration:underline}
button{display:block;width:100%;padding:13px;background:#ff0084;color:#fff;border:none;border-radius:8px;font-size:15px;font-weight:700;cursor:pointer;margin-top:22px;transition:background .15s,transform .1s;letter-spacing:.01em}
button:hover:not(:disabled){background:#d4006d}
button:active:not(:disabled){transform:scale(.98)}
button:disabled{background:#ccc;cursor:not-allowed}
.err{background:#fff0f0;border:1px solid #fca5a5;border-radius:8px;padding:11px 14px;margin-top:14px;font-size:13px;color:#b91c1c;display:none}

/* Step panels */
.panel{display:none}
.panel.on{display:block}

/* Waiting */
.waiting{text-align:center;padding:20px 0}
.waiting .icon{font-size:52px;margin-bottom:18px;display:block;animation:pulse 1.6s ease-in-out infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}
.waiting h2{font-size:18px;font-weight:700;color:#111;margin-bottom:10px}
.waiting p{color:#666;font-size:14px;line-height:1.6}

/* Success */
.done-header{text-align:center;padding-bottom:24px}
.done-header .icon{font-size:52px;display:block;margin-bottom:16px}
.done-header h2{font-size:20px;font-weight:700;color:#111;margin-bottom:6px}
.done-header .un{color:#ff0084}
.done-header p{color:#666;font-size:14px}
.config-list{border-top:1px solid #f0f0f0;margin:0 0 24px}
.ci{display:flex;align-items:flex-start;gap:12px;padding:12px 0;border-bottom:1px solid #f0f0f0;font-size:14px}
.ci .badge{font-size:18px;flex-shrink:0;margin-top:1px}
.ci .label{font-weight:600;color:#222}
.ci .sub{font-size:12px;color:#888;margin-top:2px}
.next{background:#f8f8f8;border-radius:8px;padding:14px 16px;font-size:13px;color:#555;line-height:1.6}
.next strong{color:#111}
</style>
</head>
<body>
<div class="card">
  <h1>Flickr MCP Setup</h1>
  <p class="subtitle">Connect your Flickr account to Claude and other AI assistants</p>

  <div class="steps">
    <div class="dot active" id="d1">1</div>
    <div class="line" id="l1"></div>
    <div class="dot" id="d2">2</div>
    <div class="line" id="l2"></div>
    <div class="dot" id="d3">✓</div>
  </div>

  <!-- Step 1: credentials -->
  <div class="panel on" id="p1">
    <div class="hint">
      You need a Flickr API key. Registering one requires a <strong>Flickr Pro account</strong>.<br>
      <a href="https://www.flickr.com/services/apps/create/noncommercial/" target="_blank">Create a Flickr app →</a>
      &nbsp;(~2 minutes — any name works, choose "personal use")
    </div>
    <label for="apiKey">API Key</label>
    <input type="text" id="apiKey" placeholder="Paste your API key" autocomplete="off" spellcheck="false">
    <label for="apiSecret">API Secret</label>
    <input type="text" id="apiSecret" placeholder="Paste your API secret" autocomplete="off" spellcheck="false">
    <div class="err" id="err1"></div>
    <button id="btn1" onclick="startAuth()">Connect to Flickr →</button>
  </div>

  <!-- Step 2: waiting for Flickr callback -->
  <div class="panel" id="p2">
    <div class="waiting">
      <span class="icon">🔐</span>
      <h2>Authorize in Flickr</h2>
      <p>A Flickr authorization page opened in your browser.<br>
         Sign in and click <strong>OK, I'll authorize it</strong>.</p>
      <p style="margin-top:14px;font-size:12px;color:#bbb">This page updates automatically when done.</p>
    </div>
  </div>

  <!-- Step 3: success -->
  <div class="panel" id="p3">
    <div class="done-header">
      <span class="icon">🎉</span>
      <h2>All set, <span class="un" id="dun"></span>!</h2>
      <p>Your Flickr account is connected.</p>
    </div>
    <div class="config-list" id="cl"></div>
    <div class="next"><strong>What's next:</strong> Restart Claude (or your AI assistant) and ask it to list your Flickr photos.</div>
  </div>
</div>

<script>
var poll = null;

function step(n) {
  [1,2,3].forEach(function(i) {
    document.getElementById('p'+i).className = 'panel' + (i===n?' on':'');
    var d = document.getElementById('d'+i);
    d.className = 'dot' + (i<n?' done':i===n?' active':'');
  });
  if (document.getElementById('l1'))
    document.getElementById('l1').className = 'line' + (n>1?' done':'');
  if (document.getElementById('l2'))
    document.getElementById('l2').className = 'line' + (n>2?' done':'');
}

async function startAuth() {
  var key = document.getElementById('apiKey').value.trim();
  var sec = document.getElementById('apiSecret').value.trim();
  var err = document.getElementById('err1');
  var btn = document.getElementById('btn1');
  err.style.display = 'none';
  if (!key || !sec) { showErr(err,'Both fields are required.'); return; }
  btn.disabled = true;
  btn.textContent = 'Connecting…';
  try {
    var r = await fetch('/start', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({apiKey:key, apiSecret:sec})
    });
    var d = await r.json();
    if (!r.ok) { showErr(err, d.error||'Connection failed — check your API key and secret.'); btn.disabled=false; btn.textContent='Connect to Flickr →'; return; }
    step(2);
    window.open(d.authUrl, '_blank');
    poll = setInterval(checkStatus, 1500);
  } catch(e) {
    showErr(err,'Could not reach setup server. Try refreshing.');
    btn.disabled=false; btn.textContent='Connect to Flickr →';
  }
}

async function checkStatus() {
  try {
    var r = await fetch('/status');
    var d = await r.json();
    if (d.phase==='done') {
      clearInterval(poll);
      step(3);
      document.getElementById('dun').textContent = '@'+d.username;
      var html = (d.configResults||[]).map(function(cr) {
        var badge = cr.patched ? '✅' : (cr.reason==='Already configured' ? '☑️' : '⚠️');
        var sub = cr.patched ? 'Added to config' : (cr.reason||'Skipped');
        return '<div class="ci"><span class="badge">'+badge+'</span><div><div class="label">'+cr.label+'</div><div class="sub">'+sub+'</div></div></div>';
      }).join('');
      document.getElementById('cl').innerHTML = html;
    } else if (d.phase==='error') {
      clearInterval(poll);
      step(1);
      showErr(document.getElementById('err1'), d.message||'Authorization failed. Please try again.');
    }
  } catch(e) {}
}

function showErr(el, msg) { el.textContent=msg; el.style.display='block'; }
</script>
</body>
</html>`;

export async function runSetup(force = false): Promise<void> {
  if (hasCredentials() && !force) {
    console.error('Credentials already exist. Run with --force to re-authenticate.');
    process.exit(0);
  }

  let state: SetupState = { phase: 'idle' };
  let serverPort = 0;

  return new Promise<void>(resolve => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      handleRequest(req, res).catch(e => {
        console.error('Setup server error:', e);
        if (!res.headersSent) { res.writeHead(500); res.end(); }
      });
    });

    async function handleRequest(req: IncomingMessage, res: ServerResponse) {
      const url = new URL(req.url!, `http://127.0.0.1`);

      if (url.pathname === '/' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(SETUP_HTML);
        return;
      }

      if (url.pathname === '/start' && req.method === 'POST') {
        const body = await readBody(req);
        let apiKey: string, apiSecret: string;
        try {
          ({ apiKey, apiSecret } = JSON.parse(body));
        } catch {
          return sendJson(res, 400, { error: 'Invalid request body.' });
        }
        if (!apiKey || !apiSecret) {
          return sendJson(res, 400, { error: 'API key and secret are required.' });
        }
        try {
          const callbackUrl = `http://127.0.0.1:${serverPort}/callback`;
          const { token, tokenSecret } = await getRequestToken(apiKey, apiSecret, callbackUrl);
          state = { phase: 'awaiting_auth', apiKey, apiSecret, requestToken: token, requestTokenSecret: tokenSecret };
          const authUrl = `https://www.flickr.com/services/oauth/authorize?oauth_token=${token}&perms=write`;
          return sendJson(res, 200, { authUrl });
        } catch (e) {
          return sendJson(res, 500, { error: e instanceof Error ? e.message : 'Failed to get request token. Check your API key and secret.' });
        }
      }

      if (url.pathname === '/callback' && req.method === 'GET') {
        const oauthVerifier = url.searchParams.get('oauth_verifier');
        if (!oauthVerifier || state.phase !== 'awaiting_auth') {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end('Invalid callback — please restart setup.');
          return;
        }
        try {
          const { apiKey, apiSecret, requestToken, requestTokenSecret } = state;
          const access = await getAccessToken(apiKey, apiSecret, requestToken, requestTokenSecret, oauthVerifier);
          saveCredentials({
            api_key: apiKey,
            api_secret: apiSecret,
            oauth_token: access.token,
            oauth_token_secret: access.tokenSecret,
            user_nsid: access.userNsid,
            username: access.username,
          });
          const configResults = patchMcpConfigs();
          state = { phase: 'done', username: access.username, configResults };
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(CALLBACK_HTML);
          setTimeout(() => server.close(() => resolve()), 8000);
        } catch (e) {
          state = { phase: 'error', message: e instanceof Error ? e.message : 'Authorization failed.' };
          res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<html><body style="font-family:sans-serif;padding:40px"><h2>Authorization failed</h2><p>Return to the setup page and try again.</p></body></html>');
        }
        return;
      }

      if (url.pathname === '/status' && req.method === 'GET') {
        return sendJson(res, 200, state);
      }

      res.writeHead(404);
      res.end();
    }

    server.listen(0, '127.0.0.1', () => {
      serverPort = (server.address() as { port: number }).port;
      const setupUrl = `http://127.0.0.1:${serverPort}`;
      console.error('\n=== Flickr MCP Setup ===\n');
      console.error(`Opening: ${setupUrl}`);
      console.error('(If your browser does not open, visit the URL above)\n');
      import('open').then(({ default: open }) => open(setupUrl)).catch(() => {});
    });
  });
}
