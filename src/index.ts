#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { hasCredentials, loadCredentials } from './auth.js';
import { FlickrClient } from './flickr-client.js';
import { TOOLS, handleTool } from './tools.js';

async function startServer(): Promise<void> {
  if (!hasCredentials()) {
    console.error('No Flickr credentials found.');
    console.error('Run:  npx flickr-mcp setup');
    process.exit(1);
  }

  const credentials = loadCredentials();
  const client = new FlickrClient(credentials);

  const server = new Server(
    { name: 'flickr-mcp', version: '0.1.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async request => {
    const { name, arguments: args } = request.params;
    return handleTool(name, (args ?? {}) as Record<string, unknown>, client);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`flickr-mcp running (authenticated as @${credentials.username})`);
}

async function main(): Promise<void> {
  const cmd = process.argv[2];

  if (cmd === 'setup') {
    const { runSetup } = await import('./setup.js');
    await runSetup(process.argv.includes('--force'));
    return;
  }

  await startServer();
}

main().catch(e => {
  console.error('Fatal:', e instanceof Error ? e.message : e);
  process.exit(1);
});
