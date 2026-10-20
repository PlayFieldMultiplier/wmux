import fs from 'node:fs';
import path from 'node:path';
import { agentRow, agentLauncherStem } from '../../shared/agentIdentity';

const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
/** A private launcher keeps the gateway bearer out of IPC, shell history and process arguments. */
export function createTerminalLaunch(directory: string, agent: string, id: string, url: string, token: string): { command: string; close: () => void } {
  const row = agentRow(agent);
  if (!row?.connectorLaunch || !/^con-[0-9a-f]{8}$/.test(id) || !/^http:\/\/127\.0\.0\.1:\d+\/mcp$/.test(url)
    || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('Invalid terminal launch');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const dir = fs.mkdtempSync(path.join(directory, 'session-')); fs.chmodSync(dir, 0o700);
  const close = () => { fs.rmSync(dir, { force: true, recursive: true }); };
  try {
    const launcher = agentLauncherStem(row);
    const key = `wmux-${id}`;
    const variable = `WMUX_CONNECTOR_${id.slice(4).toUpperCase()}_TOKEN`;
    let command: string;
    if (row.connectorLaunch === 'mcp-json') {
      const file = path.join(dir, 'mcp.json');
      fs.writeFileSync(file, JSON.stringify({ mcpServers: { [key]: { type: 'http', url, headers: { Authorization: `Bearer \${${variable}}` } } } }), { mode: 0o600, flag: 'wx' });
      command = `${quote(launcher)} --mcp-config ${quote(file)}`;
    } else {
      command = `${quote(launcher)} -c ${quote(`mcp_servers.${key}={url=${JSON.stringify(url)},bearer_token_env_var=${JSON.stringify(variable)}}`)}`;
    }
    const file = path.join(dir, 'launch');
    // Consume the launcher before starting the agent. Never echo or expand secrets into arguments.
    fs.writeFileSync(file, `#!/bin/sh\nrm -- ${quote(file)} || exit 1\nexport ${variable}=${quote(token)}\nexec ${command}\n`, { mode: 0o700, flag: 'wx' });
    return { command: quote(file), close };
  } catch (error) { close(); throw error; }
}
