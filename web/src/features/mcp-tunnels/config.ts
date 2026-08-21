import type { McpTunnel } from './api';

export function tunnelClientYaml(tunnel: McpTunnel, localMcpUrl: string) {
  const baseUrl = new URL(tunnel.mcp_url, window.location.origin).origin;
  return [
    'config_version: 1',
    'control_plane:',
    `  base_url: ${baseUrl}`,
    '  url_path: /connector',
    `  tunnel_id: ${tunnel.id}`,
    '  api_key: env:OMA_TUNNEL_TOKEN',
    'mcp:',
    '  server_urls:',
    '    - channel: main',
    `      url: ${localMcpUrl}`,
  ].join('\n');
}

export function visibleTunnelRefreshInterval() {
  return document.visibilityState === 'visible' ? 10_000 : false;
}
