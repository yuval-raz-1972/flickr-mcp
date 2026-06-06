import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';

export interface PatchResult {
  label: string;
  patched: boolean;
  reason?: string;
}

const MCP_ENTRY = { command: 'npx', args: ['flickr-mcp'] };

function patchConfig(filePath: string, label: string): PatchResult {
  let config: Record<string, unknown> = {};

  if (existsSync(filePath)) {
    try {
      config = JSON.parse(readFileSync(filePath, 'utf-8'));
    } catch {
      return { label, patched: false, reason: 'Could not parse existing config' };
    }
  }

  const servers = (config.mcpServers ?? {}) as Record<string, unknown>;
  if (servers.flickr) {
    return { label, patched: false, reason: 'Already configured' };
  }

  config.mcpServers = { ...servers, flickr: MCP_ENTRY };

  try {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify(config, null, 2));
    return { label, patched: true };
  } catch (e) {
    return { label, patched: false, reason: `Write failed: ${e instanceof Error ? e.message : e}` };
  }
}

export function patchMcpConfigs(): PatchResult[] {
  const home = homedir();
  const results: PatchResult[] = [];

  if (process.platform === 'darwin') {
    const configPath = join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
    if (existsSync('/Applications/Claude.app') || existsSync(configPath)) {
      results.push(patchConfig(configPath, 'Claude Desktop'));
    } else {
      results.push({ label: 'Claude Desktop', patched: false, reason: 'Not installed' });
    }
  } else if (process.platform === 'win32') {
    const appData = process.env.APPDATA ?? join(home, 'AppData', 'Roaming');
    results.push(patchConfig(join(appData, 'Claude', 'claude_desktop_config.json'), 'Claude Desktop'));
  } else {
    const configPath = join(home, '.config', 'Claude', 'claude_desktop_config.json');
    if (existsSync(configPath)) {
      results.push(patchConfig(configPath, 'Claude Desktop'));
    } else {
      results.push({ label: 'Claude Desktop', patched: false, reason: 'Not installed' });
    }
  }

  results.push(patchConfig(join(home, '.claude', 'settings.json'), 'Claude Code (global)'));

  return results;
}
