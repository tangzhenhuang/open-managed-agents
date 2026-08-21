import { afterEach, describe, expect, mock, test } from 'bun:test';
import { archiveMcpTunnel, createMcpTunnel, listMcpTunnels, revealMcpTunnelToken, rotateMcpTunnelToken } from './api';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('MCP tunnels Console API', () => {
  test('uses organization and workspace paths with cookie credentials', async () => {
    const requests = recordRequests();
    await listMcpTunnels('org/a', 'wrk spc', true);

    expect(requests[0].url).toBe(
      '/api/console/organizations/org%2Fa/workspaces/wrk%20spc/mcp_tunnels?include_archived=true',
    );
    expect(requests[0].init.credentials).toBe('include');
    expect(requests[0].init.headers.get('accept')).toBe('application/json');
  });

  test('sends CSRF on every mutation without tunnel beta headers', async () => {
    const requests = recordRequests();
    await createMcpTunnel('org_test', 'default', 'Local tools', 'csrf_test');
    await revealMcpTunnelToken('org_test', 'default', 'tnl_test', 'csrf_test');
    await rotateMcpTunnelToken('org_test', 'default', 'tnl_test', 'csrf_test');
    await archiveMcpTunnel('org_test', 'default', 'tnl_test', 'csrf_test');

    expect(requests.map((request) => request.init.method)).toEqual(['POST', 'POST', 'POST', 'POST']);
    for (const request of requests) {
      expect(request.init.credentials).toBe('include');
      expect(request.init.headers.get('x-csrf-token')).toBe('csrf_test');
      expect(request.init.headers.has('anthropic-beta')).toBe(false);
    }
    expect(requests[0].body).toEqual({ display_name: 'Local tools' });
    expect(requests[1].url).toEndWith('/tnl_test/reveal_token');
    expect(requests[2].url).toEndWith('/tnl_test/rotate_token');
    expect(requests[3].url).toEndWith('/tnl_test/archive');
  });
});

type RecordedRequest = {
  url: string;
  init: RequestInit & { headers: Headers };
  body?: Record<string, unknown>;
};

function recordRequests() {
  const requests: RecordedRequest[] = [];
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const headers = new Headers(init?.headers);
    requests.push({
      url,
      init: { ...init, headers },
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined,
    });
    return new Response(JSON.stringify(url.includes('reveal_token') || url.includes('rotate_token') ? token : tunnel), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  return requests;
}

const tunnel = {
  id: 'tnl_test',
  type: 'tunnel',
  display_name: 'Local tools',
  domain: 'example.test',
  created_at: '2026-08-21T00:00:00Z',
  archived_at: null,
  mcp_url: 'https://oma.example/v1/mcp/tnl_test',
  connection: { state: 'disconnected', instance_count: 0, channels: [] },
};

const token = { id: 'tnltok_test', type: 'tunnel_token', tunnel_token: 'secret-token' };
