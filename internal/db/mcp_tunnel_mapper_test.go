package db

import (
	"strings"
	"testing"
	"time"

	"github.com/superduck-ai/yourbatis"
)

func TestMCPTunnelMapperScopesEveryResourceLookup(t *testing.T) {
	t.Parallel()
	organizationUUID := "11111111-1111-4111-8111-111111111111"
	workspaceUUID := "22222222-2222-4222-8222-222222222222"
	tunnelID := "tnl_example"
	tests := []mapperBuilderContract{
		{
			statement: mCPTunnelMapperFindByExternalIDStatement,
			bound: buildMCPTunnelMapperFindByExternalID(
				yourbatis.DialectPostgres, organizationUUID, workspaceUUID, tunnelID,
			),
			wantID: "MCPTunnelMapper.FindByExternalID", wantKind: yourbatis.StatementSelect,
			wantArgumentNames: []string{"organizationUUID", "workspaceUUID", "externalID"},
			wantSQLFragments:  []string{"organization_uuid = $1", "workspace_uuid = $2", "external_id = $3"},
		},
		{
			statement: mCPTunnelMapperFindByDomainStatement,
			bound: buildMCPTunnelMapperFindByDomain(
				yourbatis.DialectPostgres, organizationUUID, workspaceUUID, "example.tunnel.invalid",
			),
			wantID: "MCPTunnelMapper.FindByDomain", wantKind: yourbatis.StatementSelect,
			wantArgumentNames: []string{"organizationUUID", "workspaceUUID", "domain"},
			wantSQLFragments:  []string{"organization_uuid = $1", "workspace_uuid = $2", "domain = $3"},
		},
		{
			statement: mCPTunnelMapperFindActiveForUpdateStatement,
			bound: buildMCPTunnelMapperFindActiveForUpdate(
				yourbatis.DialectPostgres, organizationUUID, workspaceUUID, tunnelID,
			),
			wantID: "MCPTunnelMapper.FindActiveForUpdate", wantKind: yourbatis.StatementSelect,
			wantArgumentNames: []string{"organizationUUID", "workspaceUUID", "externalID"},
			wantSQLFragments:  []string{"organization_uuid = $1", "workspace_uuid = $2", "external_id = $3", "archived_at IS NULL", "FOR UPDATE"},
		},
		{
			statement: mCPTunnelMapperArchiveByExternalIDStatement,
			bound: buildMCPTunnelMapperArchiveByExternalID(
				yourbatis.DialectPostgres, organizationUUID, workspaceUUID, tunnelID,
			),
			wantID: "MCPTunnelMapper.ArchiveByExternalID", wantKind: yourbatis.StatementUpdate,
			wantArgumentNames: []string{"organizationUUID", "workspaceUUID", "externalID"},
			wantSQLFragments:  []string{"COALESCE(archived_at, NOW())", "organization_uuid = $1", "workspace_uuid = $2", "external_id = $3", "RETURNING"},
		},
	}
	for _, contract := range tests {
		assertMapperBuilderContract(t, contract)
	}
}

func TestMCPTunnelMapperListFiltersArchivedByDefault(t *testing.T) {
	t.Parallel()
	params := listMCPTunnelsMapperParams{
		OrganizationUUID: "organization", WorkspaceUUID: "workspace", Limit: 21, Offset: 2,
	}
	bound := buildMCPTunnelMapperListPage(yourbatis.DialectPostgres, params)
	assertMapperBuilderContract(t, mapperBuilderContract{
		statement: mCPTunnelMapperListPageStatement, bound: bound,
		wantID: "MCPTunnelMapper.ListPage", wantKind: yourbatis.StatementSelect,
		wantArgumentNames: []string{"params.OrganizationUUID", "params.WorkspaceUUID", "params.Limit", "params.Offset"},
		wantSQLFragments:  []string{"archived_at IS NULL", "ORDER BY created_at DESC, uuid DESC", "LIMIT $3", "OFFSET $4"},
	})
	params.IncludeArchived = true
	if sql := buildMCPTunnelMapperListPage(yourbatis.DialectPostgres, params).SQL; strings.Contains(sql, "archived_at IS NULL") {
		t.Fatalf("include-archived query still filters archived rows: %q", sql)
	}
}

func TestMCPTunnelTokenMapperProtectsCredentialArguments(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, time.August, 20, 1, 0, 0, 0, time.UTC)
	insert := buildMCPTunnelTokenMapperInsert(yourbatis.DialectPostgres, insertMCPTunnelTokenParams{
		UUID: "token-uuid", ExternalID: "ttkn_example", TunnelUUID: "tunnel-uuid", Version: 1,
		TokenHash: []byte("hash"), Ciphertext: []byte("ciphertext"), Nonce: []byte("nonce"),
		WrappedDEK: []byte("wrapped"), FormatVersion: 1, KeyProvider: "local", KeyVersion: 1, CreatedAt: now,
	})
	assertMapperBuilderContract(t, mapperBuilderContract{
		statement: mCPTunnelTokenMapperInsertStatement, bound: insert,
		wantID: "MCPTunnelTokenMapper.Insert", wantKind: yourbatis.StatementInsert,
		wantArgumentNames: []string{
			"params.UUID", "params.ExternalID", "params.TunnelUUID", "params.Version",
			"params.TokenHash", "params.Ciphertext", "params.Nonce", "params.WrappedDEK",
			"params.FormatVersion", "params.KeyProvider", "params.KeyVersion", "params.CreatedAt",
		},
		wantSensitiveArgumentNames: []string{
			"params.TokenHash", "params.Ciphertext", "params.Nonce", "params.WrappedDEK",
		},
		wantSQLFragments: []string{"INSERT INTO mcp_tunnel_token_versions", "RETURNING"},
	})

	lookup := buildMCPTunnelTokenMapperFindByHashAndTunnelExternalID(
		yourbatis.DialectPostgres, []byte("hash"), "tnl_example",
	)
	assertMapperBuilderContract(t, mapperBuilderContract{
		statement: mCPTunnelTokenMapperFindByHashAndTunnelExternalIDStatement, bound: lookup,
		wantID: "MCPTunnelTokenMapper.FindByHashAndTunnelExternalID", wantKind: yourbatis.StatementSelect,
		wantArgumentNames:          []string{"tokenHash", "tunnelExternalID"},
		wantSensitiveArgumentNames: []string{"tokenHash"},
		wantSQLFragments:           []string{"JOIN mcp_tunnels", "tv.token_hash = $1", "t.external_id = $2"},
	})
}
