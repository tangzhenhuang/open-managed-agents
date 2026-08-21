import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocation } from '@tanstack/react-router';
import { AlertCircle, Archive, Cable, Copy, Eye, Loader2, Plus, RotateCw, Search } from 'lucide-react';
import { useMemo, useState, type FormEvent } from 'react';

import { useAuth } from '../../shared/auth/context';
import { useFormatters, useI18n } from '../../shared/i18n';
import { copyText as copyToClipboard } from '../../shared/lib/clipboard';
import { cn } from '../../shared/lib/utils';
import { Alert, AlertDescription, AlertTitle } from '../../shared/ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from '../../shared/ui/alert-dialog';
import { Badge } from '../../shared/ui/badge';
import { Button } from '../../shared/ui/button';
import {
  CopyIdCell,
  DataTableCell,
  DataTableRow,
  MoreActionsButton,
  dataTableClassName,
  dataTableHeaderCellClassName,
  dataTableHeaderRowClassName,
} from '../../shared/ui/data-table-interactions';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../shared/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../../shared/ui/dropdown-menu';
import { Input } from '../../shared/ui/input';
import { Label } from '../../shared/ui/label';
import { ResourceFilterDropdown, ResourceSearchField } from '../../shared/ui/resource-list-controls';
import { ResourceListState } from '../../shared/ui/resource-list-state';
import { toast, Toaster } from '../../shared/ui/sonner';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../shared/ui/table';
import { useWorkspace } from '../../shared/workspaces/context';
import { workspaceIdFromPath } from '../../shared/workspaces/presentation';
import {
  archiveMcpTunnel,
  createMcpTunnel,
  listMcpTunnels,
  revealMcpTunnelToken,
  rotateMcpTunnelToken,
  type McpTunnel,
  type TunnelConnectionState,
} from './api';
import { tunnelClientYaml, visibleTunnelRefreshInterval } from './config';

type PendingAction = { type: 'rotate' | 'archive'; tunnel: McpTunnel };
type SecretDisclosure = { tunnel: McpTunnel; token: string; source: 'created' | 'revealed' | 'rotated' };
type TunnelStatusFilter = 'active' | 'all';

const DEFAULT_LOCAL_MCP_URL = 'http://127.0.0.1:3000/mcp';

export function McpTunnelsPage() {
  const location = useLocation();
  const { msg } = useI18n();
  return (
    <>
      <Toaster
        position="top-right"
        duration={2200}
        closeButton
        containerAriaLabel={msg('common.notifications', 'Notifications')}
        toastOptions={{ closeButtonAriaLabel: msg('common.close', 'Close') }}
      />
      <McpTunnelsContent routeWorkspaceId={workspaceIdFromPath(location.pathname)} />
    </>
  );
}

export function McpTunnelsContent({ routeWorkspaceId }: { routeWorkspaceId?: string }) {
  const { msg } = useI18n();
  const queryClient = useQueryClient();
  const { csrfToken } = useAuth();
  const { orgUuid, activeWorkspaceId } = useWorkspace();
  const workspaceId = routeWorkspaceId || activeWorkspaceId;
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<TunnelStatusFilter>('active');
  const [filterOpen, setFilterOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [displayName, setDisplayName] = useState('');
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [secretDisclosure, setSecretDisclosure] = useState<SecretDisclosure | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const includeArchived = statusFilter === 'all';

  const tunnelsQuery = useQuery({
    queryKey: ['console-mcp-tunnels', orgUuid, workspaceId, includeArchived],
    queryFn: () => listMcpTunnels(orgUuid ?? '', workspaceId, includeArchived),
    enabled: Boolean(orgUuid && workspaceId),
    refetchInterval: visibleTunnelRefreshInterval,
    refetchIntervalInBackground: false,
  });

  const refreshTunnels = async () => {
    await queryClient.invalidateQueries({ queryKey: ['console-mcp-tunnels', orgUuid, workspaceId] });
  };

  const handleCreate = async (event: FormEvent) => {
    event.preventDefault();
    if (!orgUuid) return;
    setBusyAction('create');
    setActionError(null);
    try {
      const tunnel = await createMcpTunnel(orgUuid, workspaceId, displayName.trim(), csrfToken);
      setCreateOpen(false);
      setDisplayName('');
      await refreshTunnels();
      toast.success(msg('mcpTunnels.toast.created', 'MCP tunnel created'));
      try {
        const token = await revealMcpTunnelToken(orgUuid, workspaceId, tunnel.id, csrfToken);
        setSecretDisclosure({ tunnel, token: token.tunnel_token, source: 'created' });
      } catch (error) {
        const detail = errorMessage(error, msg('mcpTunnels.error.generic', 'Something went wrong. Please try again.'));
        setActionError(
          msg(
            'mcpTunnels.error.createdRevealFailed',
            'The tunnel was created, but its token could not be revealed: {detail}',
            { detail },
          ),
        );
      }
    } catch (error) {
      setActionError(errorMessage(error, msg('mcpTunnels.error.generic', 'Something went wrong. Please try again.')));
    } finally {
      setBusyAction(null);
    }
  };

  const handleReveal = async (tunnel: McpTunnel) => {
    if (!orgUuid) return;
    setBusyAction(`reveal:${tunnel.id}`);
    setActionError(null);
    try {
      const token = await revealMcpTunnelToken(orgUuid, workspaceId, tunnel.id, csrfToken);
      setSecretDisclosure({ tunnel, token: token.tunnel_token, source: 'revealed' });
    } catch (error) {
      setActionError(errorMessage(error, msg('mcpTunnels.error.generic', 'Something went wrong. Please try again.')));
    } finally {
      setBusyAction(null);
    }
  };

  const handleConfirmedAction = async () => {
    if (!orgUuid || !pendingAction) return;
    const { tunnel, type } = pendingAction;
    setBusyAction(`${type}:${tunnel.id}`);
    setActionError(null);
    try {
      if (type === 'rotate') {
        const token = await rotateMcpTunnelToken(orgUuid, workspaceId, tunnel.id, csrfToken);
        setSecretDisclosure({ tunnel, token: token.tunnel_token, source: 'rotated' });
        toast.success(msg('mcpTunnels.toast.rotated', 'Tunnel token rotated'));
      } else {
        await archiveMcpTunnel(orgUuid, workspaceId, tunnel.id, csrfToken);
        toast.success(msg('mcpTunnels.toast.archived', 'MCP tunnel archived'));
      }
      setPendingAction(null);
      await refreshTunnels();
    } catch (error) {
      setActionError(errorMessage(error, msg('mcpTunnels.error.generic', 'Something went wrong. Please try again.')));
    } finally {
      setBusyAction(null);
    }
  };

  const filteredTunnels = useMemo(() => filterTunnels(tunnelsQuery.data ?? [], search), [search, tunnelsQuery.data]);
  const hasFilters = Boolean(search.trim()) || statusFilter !== 'active';

  return (
    <section className="min-h-[calc(100vh-48px)] text-foreground">
      <header className="mb-5 flex items-start justify-between gap-6">
        <div>
          <h1 className="text-[28px] font-semibold leading-tight text-foreground">
            {msg('mcpTunnels.title', 'MCP tunnels')}
          </h1>
          <p className="mt-2 text-[15px] leading-5 text-muted-foreground">
            {msg(
              'mcpTunnels.description',
              'Connect local MCP servers to managed agent sessions without exposing the local server directly.',
            )}
          </p>
        </div>
        <Button type="button" className="h-9 shrink-0" onClick={() => setCreateOpen(true)} disabled={!orgUuid}>
          <Plus className="size-4" aria-hidden />
          {msg('mcpTunnels.createTunnel', 'Create tunnel')}
        </Button>
      </header>

      <div className="mb-7 flex flex-wrap items-center gap-2">
        <ResourceSearchField
          id="mcp-tunnel-search"
          value={search}
          placeholder={msg('mcpTunnels.searchPlaceholder', 'Search by name or exact ID')}
          onChange={setSearch}
        />
        <ResourceFilterDropdown
          label={msg('common.status', 'Status')}
          valueLabel={statusFilter === 'active' ? msg('common.active', 'Active') : msg('common.all', 'All')}
          options={[
            { value: 'active', label: msg('common.active', 'Active') },
            { value: 'all', label: msg('common.all', 'All') },
          ]}
          value={statusFilter}
          menu="status"
          open={filterOpen}
          menuWidthClass="w-[230px]"
          onOpenChange={(menu) => setFilterOpen(Boolean(menu))}
          onSelect={setStatusFilter}
        />
      </div>

      {actionError ? (
        <Alert variant="destructive" className="mb-3">
          <AlertCircle aria-hidden />
          <AlertTitle>{msg('mcpTunnels.error.actionFailed', 'Action failed')}</AlertTitle>
          <AlertDescription>{actionError}</AlertDescription>
        </Alert>
      ) : null}

      {tunnelsQuery.isError ? (
        <ResourceListState
          icon={AlertCircle}
          title={msg('mcpTunnels.error.loadFailed', 'Could not load MCP tunnels')}
          body={errorMessage(
            tunnelsQuery.error,
            msg('mcpTunnels.error.generic', 'Something went wrong. Please try again.'),
          )}
          actionLabel={msg('common.retry', 'Retry')}
          onAction={() => void tunnelsQuery.refetch()}
        />
      ) : (
        <div className="overflow-visible">
          <TunnelTable
            tunnels={filteredTunnels}
            loading={tunnelsQuery.isPending}
            busyAction={busyAction}
            onCopy={(value) => void copyText(value, msg('mcpTunnels.toast.mcpUrlCopied', 'MCP URL copied'))}
            onReveal={(tunnel) => void handleReveal(tunnel)}
            onAction={setPendingAction}
          />
          {tunnelsQuery.isSuccess && !filteredTunnels.length ? (
            <ResourceListState
              icon={hasFilters ? Search : Cable}
              title={
                hasFilters
                  ? msg('mcpTunnels.empty.filteredTitle', 'No matching MCP tunnels')
                  : msg('mcpTunnels.empty.title', 'No MCP tunnels yet')
              }
              body={
                hasFilters
                  ? msg('mcpTunnels.empty.filteredBody', 'Try a different search or reset the filters.')
                  : msg(
                      'mcpTunnels.empty.body',
                      'Create a tunnel to connect a local MCP server to managed agent sessions.',
                    )
              }
              actionLabel={
                hasFilters
                  ? msg('mcpTunnels.resetFilters', 'Reset filters')
                  : msg('mcpTunnels.createTunnel', 'Create tunnel')
              }
              onAction={() => {
                if (hasFilters) {
                  setSearch('');
                  setStatusFilter('active');
                } else {
                  setCreateOpen(true);
                }
              }}
            />
          ) : null}
        </div>
      )}

      <CreateTunnelDialog
        open={createOpen}
        displayName={displayName}
        busy={busyAction === 'create'}
        onOpenChange={(open) => {
          setCreateOpen(open);
          if (!open) setDisplayName('');
        }}
        onDisplayNameChange={setDisplayName}
        onSubmit={handleCreate}
      />
      <SecretDialog disclosure={secretDisclosure} onClose={() => setSecretDisclosure(null)} />
      <ConfirmActionDialog
        action={pendingAction}
        busy={Boolean(pendingAction && busyAction === `${pendingAction.type}:${pendingAction.tunnel.id}`)}
        onClose={() => setPendingAction(null)}
        onConfirm={() => void handleConfirmedAction()}
      />
    </section>
  );
}

function TunnelTable({
  tunnels,
  loading,
  busyAction,
  onCopy,
  onReveal,
  onAction,
}: {
  tunnels: McpTunnel[];
  loading: boolean;
  busyAction: string | null;
  onCopy: (value: string) => void;
  onReveal: (tunnel: McpTunnel) => void;
  onAction: (action: PendingAction) => void;
}) {
  const { msg } = useI18n();
  const formatters = useFormatters();
  return (
    <Table className={dataTableClassName}>
      <TableHeader>
        <TableRow className={dataTableHeaderRowClassName}>
          <TableHead className={cn(dataTableHeaderCellClassName, 'w-[160px]')}>{msg('common.id', 'ID')}</TableHead>
          <TableHead className={cn(dataTableHeaderCellClassName, 'w-auto')}>{msg('common.name', 'Name')}</TableHead>
          <TableHead className={cn(dataTableHeaderCellClassName, 'w-[200px]')}>
            {msg('mcpTunnels.column.mcpUrl', 'MCP URL')}
          </TableHead>
          <TableHead className={cn(dataTableHeaderCellClassName, 'w-[120px]')}>
            {msg('mcpTunnels.column.connection', 'Connection')}
          </TableHead>
          <TableHead className={cn(dataTableHeaderCellClassName, 'w-[70px]')}>
            {msg('mcpTunnels.column.channels', 'Channels')}
          </TableHead>
          <TableHead className={cn(dataTableHeaderCellClassName, 'w-[70px]')}>
            {msg('mcpTunnels.column.instances', 'Instances')}
          </TableHead>
          <TableHead className={cn(dataTableHeaderCellClassName, 'w-[140px]')}>
            {msg('common.created', 'Created')}
          </TableHead>
          <TableHead
            className={cn(dataTableHeaderCellClassName, 'w-[48px] px-2')}
            aria-label={msg('common.actions', 'Actions')}
          />
        </TableRow>
      </TableHeader>
      <TableBody>
        {loading ? (
          <TableRow className="border-0 hover:bg-transparent">
            <TableCell colSpan={8} className="h-[280px] text-center text-sm text-muted-foreground">
              {msg('mcpTunnels.loading', 'Loading MCP tunnels...')}
            </TableCell>
          </TableRow>
        ) : (
          tunnels.map((tunnel) => (
            <DataTableRow key={tunnel.id} className={tunnel.archived_at ? 'opacity-65' : undefined}>
              <DataTableCell edge="start">
                <CopyIdCell
                  value={tunnel.id}
                  ariaLabel={msg('mcpTunnels.copyTunnelId', 'Copy tunnel ID {id}', { id: tunnel.id })}
                  className="gap-1.5"
                />
              </DataTableCell>
              <DataTableCell className="truncate text-foreground">
                <span className="inline-flex max-w-full items-center gap-2">
                  <span className="truncate">{tunnel.display_name || tunnel.id}</span>
                  {tunnel.archived_at ? (
                    <Badge variant="secondary" className="h-6 rounded-md px-2 text-xs font-medium">
                      {msg('common.archived', 'Archived')}
                    </Badge>
                  ) : null}
                </span>
              </DataTableCell>
              <DataTableCell className="truncate">
                <CopyIdCell
                  value={tunnel.mcp_url}
                  ariaLabel={msg('mcpTunnels.copyMcpUrl', 'Copy MCP URL')}
                  textClassName="text-muted-foreground"
                />
              </DataTableCell>
              <DataTableCell className="truncate">
                <ConnectionBadge state={tunnel.connection.state} />
              </DataTableCell>
              <DataTableCell className="text-muted-foreground">{tunnel.connection.channels.length}</DataTableCell>
              <DataTableCell className="text-muted-foreground">{tunnel.connection.instance_count}</DataTableCell>
              <DataTableCell className="truncate text-muted-foreground">
                {formatTunnelCreatedAt(tunnel.created_at, formatters.date)}
              </DataTableCell>
              <DataTableCell edge="end" className="px-2">
                <TunnelActions
                  tunnel={tunnel}
                  busy={Boolean(busyAction?.endsWith(tunnel.id))}
                  onCopy={onCopy}
                  onReveal={onReveal}
                  onAction={onAction}
                />
              </DataTableCell>
            </DataTableRow>
          ))
        )}
      </TableBody>
    </Table>
  );
}

function TunnelActions({
  tunnel,
  busy,
  onCopy,
  onReveal,
  onAction,
}: {
  tunnel: McpTunnel;
  busy: boolean;
  onCopy: (value: string) => void;
  onReveal: (tunnel: McpTunnel) => void;
  onAction: (action: PendingAction) => void;
}) {
  const { msg } = useI18n();
  const name = tunnel.display_name || tunnel.id;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <MoreActionsButton label={msg('mcpTunnels.actionsFor', 'Actions for {name}', { name })} disabled={busy} />
        }
      />
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => onCopy(tunnel.mcp_url)}>
          <Copy /> {msg('mcpTunnels.action.copyMcpUrl', 'Copy MCP URL')}
        </DropdownMenuItem>
        <DropdownMenuItem disabled={Boolean(tunnel.archived_at)} onClick={() => onReveal(tunnel)}>
          <Eye /> {msg('mcpTunnels.action.viewToken', 'View token')}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={Boolean(tunnel.archived_at)} onClick={() => onAction({ type: 'rotate', tunnel })}>
          <RotateCw /> {msg('mcpTunnels.action.rotateToken', 'Rotate token')}
        </DropdownMenuItem>
        <DropdownMenuItem
          variant="destructive"
          disabled={Boolean(tunnel.archived_at)}
          onClick={() => onAction({ type: 'archive', tunnel })}
        >
          <Archive /> {msg('common.archive', 'Archive')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ConnectionBadge({ state }: { state: TunnelConnectionState }) {
  const { msg } = useI18n();
  const label =
    state === 'connected'
      ? msg('mcpTunnels.connection.connected', 'Connected')
      : state === 'disconnected'
        ? msg('mcpTunnels.connection.disconnected', 'Disconnected')
        : msg('mcpTunnels.connection.unknown', 'Unknown');
  return (
    <Badge
      variant="secondary"
      className={cn(
        'h-6 rounded-md px-2 text-xs font-medium',
        state === 'connected' ? 'status-success' : 'text-secondary-foreground',
      )}
    >
      {label}
    </Badge>
  );
}

function CreateTunnelDialog({
  open,
  displayName,
  busy,
  onOpenChange,
  onDisplayNameChange,
  onSubmit,
}: {
  open: boolean;
  displayName: string;
  busy: boolean;
  onOpenChange: (open: boolean) => void;
  onDisplayNameChange: (value: string) => void;
  onSubmit: (event: FormEvent) => void;
}) {
  const { msg } = useI18n();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form className="grid gap-4" onSubmit={onSubmit}>
          <DialogHeader>
            <DialogTitle>{msg('mcpTunnels.create.title', 'Create MCP tunnel')}</DialogTitle>
            <DialogDescription>
              {msg(
                'mcpTunnels.create.description',
                'The token will be revealed once after creation and can be viewed again later.',
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="tunnel-display-name">{msg('common.name', 'Name')}</Label>
            <Input
              id="tunnel-display-name"
              value={displayName}
              maxLength={500}
              placeholder={msg('mcpTunnels.create.namePlaceholder', 'Local tools')}
              onChange={(event) => onDisplayNameChange(event.target.value)}
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {msg('common.cancel', 'Cancel')}
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? <Loader2 className="animate-spin" /> : <Plus />}
              {msg('common.create', 'Create')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function SecretDialog({ disclosure, onClose }: { disclosure: SecretDisclosure | null; onClose: () => void }) {
  const { msg } = useI18n();
  const [localMcpUrl, setLocalMcpUrl] = useState(DEFAULT_LOCAL_MCP_URL);
  const close = () => {
    setLocalMcpUrl(DEFAULT_LOCAL_MCP_URL);
    onClose();
  };
  if (!disclosure) return null;
  const yaml = tunnelClientYaml(disclosure.tunnel, localMcpUrl);
  const title =
    disclosure.source === 'created'
      ? msg('mcpTunnels.secret.readyTitle', 'Tunnel ready')
      : disclosure.source === 'rotated'
        ? msg('mcpTunnels.secret.rotatedTitle', 'New tunnel token')
        : msg('mcpTunnels.secret.title', 'Tunnel token');
  return (
    <Dialog open onOpenChange={(nextOpen) => !nextOpen && close()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {msg(
              'mcpTunnels.secret.description',
              'Keep this token secret. It is held only in this dialog and cleared when you close it.',
            )}
          </DialogDescription>
        </DialogHeader>
        <SecretField label={msg('mcpTunnels.secret.token', 'Tunnel token')} value={disclosure.token} />
        <SecretField
          label={msg('mcpTunnels.secret.canonicalUrl', 'Canonical MCP URL')}
          value={disclosure.tunnel.mcp_url}
        />
        <div className="grid gap-2">
          <Label htmlFor="local-mcp-url">{msg('mcpTunnels.secret.localUrl', 'Local MCP server URL')}</Label>
          <Input id="local-mcp-url" value={localMcpUrl} onChange={(event) => setLocalMcpUrl(event.target.value)} />
        </div>
        <div className="grid gap-2">
          <div className="flex items-center justify-between gap-3">
            <Label>{msg('mcpTunnels.secret.yaml', 'Tunnel-client YAML')}</Label>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => void copyText(yaml, msg('mcpTunnels.toast.yamlCopied', 'YAML copied'))}
            >
              <Copy /> {msg('common.copy', 'Copy')}
            </Button>
          </div>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-lg bg-muted p-3 text-xs">
            <code>{yaml}</code>
          </pre>
          <p className="text-xs text-muted-foreground">
            {msg('mcpTunnels.secret.envPrefix', 'Set ')}
            <code>OMA_TUNNEL_TOKEN</code>
            {msg('mcpTunnels.secret.envSuffix', ' to the token shown above before starting tunnel-client.')}
          </p>
        </div>
        <DialogFooter>
          <Button onClick={close}>{msg('common.done', 'Done')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SecretField({ label, value }: { label: string; value: string }) {
  const { msg } = useI18n();
  return (
    <div className="grid gap-2">
      <Label>{label}</Label>
      <div className="flex min-w-0 items-center gap-2 rounded-lg border bg-muted/40 p-2">
        <code className="min-w-0 flex-1 break-all text-xs">{value}</code>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={msg('mcpTunnels.copyValue', 'Copy {label}', { label })}
          onClick={() => void copyText(value, msg('mcpTunnels.toast.valueCopied', '{label} copied', { label }))}
        >
          <Copy />
        </Button>
      </div>
    </div>
  );
}

function ConfirmActionDialog({
  action,
  busy,
  onClose,
  onConfirm,
}: {
  action: PendingAction | null;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const { msg } = useI18n();
  const rotating = action?.type === 'rotate';
  return (
    <AlertDialog open={Boolean(action)} onOpenChange={(open) => !open && !busy && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogMedia>{rotating ? <RotateCw /> : <Archive />}</AlertDialogMedia>
          <AlertDialogTitle>
            {rotating
              ? msg('mcpTunnels.confirm.rotateTitle', 'Rotate tunnel token?')
              : msg('mcpTunnels.confirm.archiveTitle', 'Archive MCP tunnel?')}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {rotating
              ? msg(
                  'mcpTunnels.confirm.rotateBody',
                  'The current tunnel-client credential will stop working immediately.',
                )
              : msg(
                  'mcpTunnels.confirm.archiveBody',
                  'Archived tunnels reject Connector requests and cannot be restored in this release.',
                )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>{msg('common.cancel', 'Cancel')}</AlertDialogCancel>
          <AlertDialogAction variant={rotating ? 'default' : 'destructive'} disabled={busy} onClick={onConfirm}>
            {busy ? <Loader2 className="animate-spin" /> : null}
            {rotating ? msg('mcpTunnels.action.rotateToken', 'Rotate token') : msg('common.archive', 'Archive')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function filterTunnels(tunnels: McpTunnel[], search: string) {
  const query = search.trim();
  if (!query) return tunnels;
  const normalizedQuery = query.toLocaleLowerCase();
  return tunnels.filter(
    (tunnel) => tunnel.id === query || (tunnel.display_name ?? '').toLocaleLowerCase().includes(normalizedQuery),
  );
}

function formatTunnelCreatedAt(
  value: string,
  formatDate: (value: string | number | Date, options?: Intl.DateTimeFormatOptions) => string,
) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return formatDate(date, { dateStyle: 'medium', timeStyle: 'short' });
}

async function copyText(value: string, successMessage: string) {
  await copyToClipboard(value);
  toast.success(successMessage);
}

function errorMessage(error: unknown, fallback: string) {
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') {
    return error.message;
  }
  return fallback;
}
