import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { type ReactNode } from 'react';
import { resetTestDom } from '../../test/setup';
import { AuthContext, type AuthContextValue } from '../../shared/auth/context';
import { I18nProvider, type Locale } from '../../shared/i18n';
import { defaultWorkspace } from '../../shared/workspaces/api';
import { WorkspaceContext, type WorkspaceContextValue } from '../../shared/workspaces/context';
import { McpTunnelsContent } from './McpTunnelsPage';
import { visibleTunnelRefreshInterval } from './config';
import type { McpTunnel } from './api';

const testingLibrary = await import('@testing-library/react');
const { cleanup, fireEvent, render, screen, waitFor, within } = testingLibrary;
const originalFetch = globalThis.fetch;

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

describe('MCP tunnels page', () => {
  test('renders empty and error states', async () => {
    resetTestDom('https://oma.duck.ai/workspaces/default/mcp-tunnels');
    mockTunnelApi([]);
    const view = renderPage();
    expect(await screen.findByText('No MCP tunnels yet')).toBeTruthy();
    view.unmount();

    globalThis.fetch = mock(async () => jsonResponse({ error: 'unavailable', message: 'Redis is unavailable' }, 503));
    renderPage();
    expect(await screen.findByText('Could not load MCP tunnels')).toBeTruthy();
    expect(screen.getByText('Redis is unavailable')).toBeTruthy();
  });

  test('creates and reveals without retaining the token in query data', async () => {
    resetTestDom('https://oma.duck.ai/workspaces/default/mcp-tunnels');
    const api = mockTunnelApi([]);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderPage(queryClient);

    await screen.findByText('No MCP tunnels yet');
    fireEvent.click(screen.getAllByRole('button', { name: 'Create tunnel' })[0]);
    const createDialog = screen.getByRole('dialog', { name: 'Create MCP tunnel' });
    fireEvent.change(within(createDialog).getByPlaceholderText('Local tools'), { target: { value: 'Private tools' } });
    fireEvent.click(within(createDialog).getByRole('button', { name: 'Create' }));

    const secretDialog = await screen.findByRole('dialog', { name: 'Tunnel ready' });
    expect(within(secretDialog).getByText('secret-created')).toBeTruthy();
    expect(secretDialog.textContent).toContain('url_path: /connector');
    expect(secretDialog.textContent).toContain('api_key: env:OMA_TUNNEL_TOKEN');
    expect(secretDialog.textContent).toContain('http://127.0.0.1:3000/mcp');
    expect(
      JSON.stringify(
        queryClient
          .getQueryCache()
          .getAll()
          .map((query) => query.state.data),
      ),
    ).not.toContain('secret-created');
    const createRequest = api.requests.find(
      (request) => request.method === 'POST' && request.url.endsWith('/mcp_tunnels'),
    );
    expect(createRequest?.headers.get('x-csrf-token')).toBe('csrf_test');

    fireEvent.click(within(secretDialog).getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.queryByText('secret-created')).toBeNull());
    expect(await screen.findByText('Private tools')).toBeTruthy();
  });

  test('rotates a token and archives through confirmation dialogs', async () => {
    resetTestDom('https://oma.duck.ai/workspaces/default/mcp-tunnels');
    const api = mockTunnelApi([activeTunnel]);
    renderPage();

    await screen.findByText('Private tools');
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Private tools' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rotate token' }));
    const rotateDialog = screen.getByRole('alertdialog', { name: 'Rotate tunnel token?' });
    fireEvent.click(within(rotateDialog).getByRole('button', { name: 'Rotate token' }));

    const tokenDialog = await screen.findByRole('dialog', { name: 'New tunnel token' });
    expect(within(tokenDialog).getByText('secret-rotated')).toBeTruthy();
    fireEvent.click(within(tokenDialog).getByRole('button', { name: 'Done' }));

    fireEvent.click(screen.getByRole('button', { name: 'Actions for Private tools' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Archive' }));
    const archiveDialog = screen.getByRole('alertdialog', { name: 'Archive MCP tunnel?' });
    fireEvent.click(within(archiveDialog).getByRole('button', { name: 'Archive' }));

    await waitFor(() => expect(screen.queryByText('Private tools')).toBeNull());
    expect(api.requests.some((request) => request.url.endsWith('/rotate_token'))).toBe(true);
    expect(api.requests.some((request) => request.url.endsWith('/archive'))).toBe(true);
  }, 10_000);

  test('polls only while the page is visible', () => {
    expect(visibleTunnelRefreshInterval()).toBe(10_000);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    expect(visibleTunnelRefreshInterval()).toBe(false);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  });

  test('filters by name or exact ID and can include archived tunnels', async () => {
    resetTestDom('https://oma.duck.ai/workspaces/default/mcp-tunnels');
    const archivedTunnel: McpTunnel = {
      ...activeTunnel,
      id: 'tnl_Zyxwvutsrqponmlkjihg3210',
      display_name: 'Archived tools',
      archived_at: '2026-08-21T03:00:00Z',
    };
    const api = mockTunnelApi([activeTunnel, archivedTunnel]);
    renderPage();

    await screen.findByText('Private tools');
    const search = screen.getByPlaceholderText('Search by name or exact ID');
    fireEvent.change(search, { target: { value: 'missing' } });
    expect(await screen.findByText('No matching MCP tunnels')).toBeTruthy();
    fireEvent.change(search, { target: { value: activeTunnel.id } });
    expect(await screen.findByText('Private tools')).toBeTruthy();

    fireEvent.change(search, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Status Active' }));
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'All' }));
    expect(await screen.findByText('Archived tools')).toBeTruthy();
    expect(api.requests.some((request) => request.url.includes('include_archived=true'))).toBe(true);
  });

  test('uses the console locale for tunnel management copy', async () => {
    resetTestDom('https://oma.duck.ai/workspaces/default/mcp-tunnels');
    mockTunnelApi([]);
    renderPage(undefined, 'default', 'zh-CN');

    expect(await screen.findByRole('heading', { name: 'MCP Tunnel' })).toBeTruthy();
    expect(screen.getByPlaceholderText('按名称或精确 ID 搜索')).toBeTruthy();
    expect(screen.getByRole('button', { name: '创建 Tunnel' })).toBeTruthy();
  });

  test('uses the route workspace before workspace context catches up', async () => {
    resetTestDom('https://oma.duck.ai/workspaces/wrkspc_route/mcp-tunnels');
    const api = mockTunnelApi([]);
    renderPage(undefined, 'wrkspc_route');
    await screen.findByText('No MCP tunnels yet');
    expect(api.requests[0].url).toContain('/workspaces/wrkspc_route/mcp_tunnels');
  });
});

type RecordedRequest = {
  url: string;
  method: string;
  headers: Headers;
  body?: Record<string, unknown>;
};

function mockTunnelApi(initialTunnels: McpTunnel[]) {
  let tunnels = [...initialTunnels];
  const requests: RecordedRequest[] = [];
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? 'GET';
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    requests.push({ url, method, headers, body });
    if (method === 'GET') {
      const includeArchived = url.includes('include_archived=true');
      return jsonResponse(tunnels.filter((tunnel) => includeArchived || !tunnel.archived_at));
    }
    if (url.endsWith('/mcp_tunnels')) {
      const created = { ...activeTunnel, display_name: String(body?.display_name || '') };
      tunnels = [...tunnels, created];
      return jsonResponse(created);
    }
    if (url.endsWith('/reveal_token')) {
      return jsonResponse({ id: 'tnltok_created', type: 'tunnel_token', tunnel_token: 'secret-created' });
    }
    if (url.endsWith('/rotate_token')) {
      return jsonResponse({ id: 'tnltok_rotated', type: 'tunnel_token', tunnel_token: 'secret-rotated' });
    }
    if (url.endsWith('/archive')) {
      tunnels = tunnels.map((tunnel) =>
        url.includes(tunnel.id) ? { ...tunnel, archived_at: '2026-08-21T03:00:00Z' } : tunnel,
      );
      return jsonResponse(tunnels.find((tunnel) => url.includes(tunnel.id)));
    }
    return jsonResponse({ error: 'not_found', message: 'Not found' }, 404);
  });
  return { requests };
}

function renderPage(
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  routeWorkspaceId = 'default',
  locale: Locale = 'en',
) {
  return render(
    <TunnelHarness queryClient={queryClient} locale={locale}>
      <McpTunnelsContent routeWorkspaceId={routeWorkspaceId} />
    </TunnelHarness>,
  );
}

function TunnelHarness({
  children,
  queryClient,
  locale,
}: {
  children: ReactNode;
  queryClient: QueryClient;
  locale: Locale;
}) {
  return (
    <I18nProvider initialLocale={locale}>
      <QueryClientProvider client={queryClient}>
        <AuthContext.Provider value={authValue}>
          <WorkspaceContext.Provider value={workspaceValue}>{children}</WorkspaceContext.Provider>
        </AuthContext.Provider>
      </QueryClientProvider>
    </I18nProvider>
  );
}

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}

const authValue: AuthContextValue = {
  account: { uuid: 'acct_test', email_address: 'test@example.com', display_name: 'test' },
  status: 'authenticated',
  csrfToken: 'csrf_test',
  refresh: async () => ({ account: { uuid: 'acct_test', email_address: 'test@example.com' } }),
  logout: async () => undefined,
};

const workspaceValue: WorkspaceContextValue = {
  orgUuid: 'org_test',
  workspaces: [defaultWorkspace],
  activeWorkspace: defaultWorkspace,
  activeWorkspaceId: defaultWorkspace.id,
  isLoading: false,
  error: null,
  selectWorkspace: () => undefined,
  createWorkspace: async () => defaultWorkspace,
  refreshWorkspaces: async () => undefined,
};

const activeTunnel: McpTunnel = {
  id: 'tnl_0123456789AbCdEfGhIjKlMn',
  type: 'tunnel',
  display_name: 'Private tools',
  domain: 'tunnel.example',
  created_at: '2026-08-21T00:00:00Z',
  archived_at: null,
  mcp_url: 'https://oma.example/v1/mcp/tnl_0123456789AbCdEfGhIjKlMn',
  connection: {
    state: 'connected',
    instance_count: 2,
    channels: [{ name: 'main', process_affinity: true, instance_count: 2 }],
  },
};
