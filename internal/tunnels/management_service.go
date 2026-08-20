package tunnels

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"time"

	"github.com/superduck-ai/open-managed-agents/internal/config"
	"github.com/superduck-ai/open-managed-agents/internal/db"
	"github.com/superduck-ai/open-managed-agents/internal/ids"
	"github.com/superduck-ai/open-managed-agents/internal/secrets"

	"github.com/google/uuid"
)

type Service struct {
	cfg       config.TunnelConfig
	db        *db.DB
	secretSvc *secrets.Service
	now       func() time.Time
	random    io.Reader
	broker    *Broker
}

func (s *Service) WithBroker(broker *Broker) *Service {
	if s != nil {
		s.broker = broker
	}
	return s
}

func NewService(cfg config.TunnelConfig, database *db.DB, secretSvc *secrets.Service) *Service {
	if database == nil {
		panic("tunnels: database is required")
	}
	return &Service{
		cfg:       cfg,
		db:        database,
		secretSvc: secretSvc,
		now:       func() time.Time { return time.Now().UTC() },
		random:    rand.Reader,
	}
}

func (s *Service) Create(ctx context.Context, input createTunnelInput) (db.MCPTunnel, error) {
	if s.secretSvc == nil {
		return db.MCPTunnel{}, internalError("Could not protect tunnel token", errors.New("tunnel secrets service is unavailable"))
	}
	tunnelID, err := ids.New("tnl_")
	if err != nil {
		return db.MCPTunnel{}, internalError("Could not generate tunnel ID", fmt.Errorf("generate tunnel ID: %w", err))
	}
	token, err := s.newConnectorToken()
	if err != nil {
		return db.MCPTunnel{}, internalError("Could not generate tunnel token", err)
	}
	defer clear(token.Plaintext)
	scope := tunnelScope{OrganizationUUID: input.OrganizationUUID, WorkspaceUUID: input.WorkspaceUUID}
	envelope, err := s.secretSvc.SealTunnel(ctx, tokenBinding(scope, tunnelID, token.ID), token.Plaintext)
	if err != nil {
		return db.MCPTunnel{}, internalError("Could not protect tunnel token", fmt.Errorf("seal tunnel token: %w", err))
	}
	now := s.now()
	created, err := s.db.CreateMCPTunnel(ctx, db.MCPTunnel{
		UUID:             uuid.NewString(),
		ExternalID:       tunnelID,
		OrganizationUUID: input.OrganizationUUID,
		WorkspaceUUID:    input.WorkspaceUUID,
		DisplayName:      input.DisplayName,
		Domain:           uuid.NewString() + "." + s.cfg.DomainSuffix,
		CreatedAt:        now,
	}, tokenVersion(token, envelope, now))
	if err != nil {
		return db.MCPTunnel{}, internalError("Could not create tunnel", fmt.Errorf("create tunnel: %w", err))
	}
	return created, nil
}

func (s *Service) Get(ctx context.Context, scope tunnelScope, tunnelID string) (db.MCPTunnel, error) {
	tunnel, err := s.db.GetMCPTunnel(ctx, scope.OrganizationUUID, scope.WorkspaceUUID, tunnelID)
	if err != nil {
		return db.MCPTunnel{}, mapTunnelLookupError(err, tunnelID, "retrieve")
	}
	return tunnel, nil
}

func (s *Service) List(ctx context.Context, scope tunnelScope, includeArchived bool, limit, offset int) ([]db.MCPTunnel, bool, error) {
	tunnels, hasMore, err := s.db.ListMCPTunnelsPage(ctx, db.ListMCPTunnelsParams{
		OrganizationUUID: scope.OrganizationUUID,
		WorkspaceUUID:    scope.WorkspaceUUID,
		IncludeArchived:  includeArchived,
		Limit:            limit,
		Offset:           offset,
	})
	if err != nil {
		return nil, false, internalError("Could not list tunnels", fmt.Errorf("list tunnels: %w", err))
	}
	return tunnels, hasMore, nil
}

func (s *Service) Archive(ctx context.Context, scope tunnelScope, tunnelID string) (db.MCPTunnel, error) {
	tunnel, err := s.Get(ctx, scope, tunnelID)
	if err != nil {
		return db.MCPTunnel{}, err
	}
	if tunnel.ArchivedAt != nil {
		return tunnel, nil
	}
	current, err := s.db.GetActiveMCPTunnelToken(ctx, scope.OrganizationUUID, scope.WorkspaceUUID, tunnelID)
	if err != nil {
		return db.MCPTunnel{}, mapTunnelLookupError(err, tunnelID, "archive")
	}
	if err := s.suspendTokenVersion(ctx, tunnel.UUID, current.Version); err != nil {
		return db.MCPTunnel{}, internalError("Could not archive tunnel", err)
	}
	archived := false
	defer func() {
		if !archived {
			_ = s.activateTokenVersion(context.WithoutCancel(ctx), tunnel.UUID, current.Version)
		}
	}()
	tunnel, err = s.db.ArchiveMCPTunnel(ctx, scope.OrganizationUUID, scope.WorkspaceUUID, tunnelID)
	if err != nil {
		return db.MCPTunnel{}, mapTunnelLookupError(err, tunnelID, "archive")
	}
	archived = true
	return tunnel, nil
}

func (s *Service) RevealToken(ctx context.Context, scope tunnelScope, tunnelID string) (db.MCPTunnelTokenVersion, []byte, error) {
	if s.secretSvc == nil {
		return db.MCPTunnelTokenVersion{}, nil, internalError("Could not reveal tunnel token", errors.New("tunnel secrets service is unavailable"))
	}
	token, err := s.db.GetActiveMCPTunnelToken(ctx, scope.OrganizationUUID, scope.WorkspaceUUID, tunnelID)
	if err != nil {
		return db.MCPTunnelTokenVersion{}, nil, mapTunnelLookupError(err, tunnelID, "retrieve")
	}
	if token.Envelope == nil {
		return db.MCPTunnelTokenVersion{}, nil, internalError(
			"Could not reveal tunnel token",
			fmt.Errorf("tunnel %q token %q: %w", tunnelID, token.ExternalID, db.ErrIncompleteSecretEnvelope),
		)
	}
	plaintext, err := s.secretSvc.OpenTunnel(ctx, tokenBinding(scope, tunnelID, token.ExternalID), *token.Envelope)
	if err != nil {
		return db.MCPTunnelTokenVersion{}, nil, internalError("Could not reveal tunnel token", fmt.Errorf("open tunnel token: %w", err))
	}
	return token, plaintext, nil
}

func (s *Service) RotateToken(ctx context.Context, scope tunnelScope, tunnelID string) (db.MCPTunnelTokenVersion, []byte, error) {
	if s.secretSvc == nil {
		return db.MCPTunnelTokenVersion{}, nil, internalError("Could not protect tunnel token", errors.New("tunnel secrets service is unavailable"))
	}
	tunnel, err := s.Get(ctx, scope, tunnelID)
	if err != nil {
		return db.MCPTunnelTokenVersion{}, nil, err
	}
	if tunnel.ArchivedAt != nil {
		return db.MCPTunnelTokenVersion{}, nil, archivedTunnel(tunnelID)
	}
	current, err := s.db.GetActiveMCPTunnelToken(ctx, scope.OrganizationUUID, scope.WorkspaceUUID, tunnelID)
	if err != nil {
		return db.MCPTunnelTokenVersion{}, nil, mapTunnelLookupError(err, tunnelID, "rotate token for")
	}
	if err := s.suspendTokenVersion(ctx, tunnel.UUID, current.Version); err != nil {
		return db.MCPTunnelTokenVersion{}, nil, internalError("Could not rotate tunnel token", err)
	}
	rotated := false
	defer func() {
		if !rotated {
			_ = s.activateTokenVersion(context.WithoutCancel(ctx), tunnel.UUID, current.Version)
		}
	}()
	token, err := s.newConnectorToken()
	if err != nil {
		return db.MCPTunnelTokenVersion{}, nil, internalError("Could not generate tunnel token", err)
	}
	plaintext := token.Plaintext
	envelope, err := s.secretSvc.SealTunnel(ctx, tokenBinding(scope, tunnelID, token.ID), plaintext)
	if err != nil {
		clear(plaintext)
		return db.MCPTunnelTokenVersion{}, nil, internalError("Could not protect tunnel token", fmt.Errorf("seal tunnel token: %w", err))
	}
	created, err := s.db.RotateMCPTunnelToken(ctx, scope.OrganizationUUID, scope.WorkspaceUUID, tunnelID, tokenVersion(token, envelope, s.now()))
	if err != nil {
		clear(plaintext)
		return db.MCPTunnelTokenVersion{}, nil, mapTunnelLookupError(err, tunnelID, "rotate token for")
	}
	rotated = true
	if err := s.activateTokenVersion(ctx, tunnel.UUID, created.Version); err != nil {
		clear(plaintext)
		return db.MCPTunnelTokenVersion{}, nil, internalError("Could not activate rotated tunnel token", err)
	}
	return created, plaintext, nil
}

func (s *Service) suspendTokenVersion(ctx context.Context, tunnelUUID string, tokenVersion int64) error {
	if s.broker == nil {
		return nil
	}
	return s.broker.SuspendTokenVersion(ctx, tunnelUUID, tokenVersion)
}

func (s *Service) activateTokenVersion(ctx context.Context, tunnelUUID string, tokenVersion int64) error {
	if s.broker == nil {
		return nil
	}
	return s.broker.ActivateTokenVersion(ctx, tunnelUUID, tokenVersion)
}

func (s *Service) newConnectorToken() (connectorToken, error) {
	randomBytes := make([]byte, 32)
	if _, err := io.ReadFull(s.random, randomBytes); err != nil {
		return connectorToken{}, fmt.Errorf("read connector token entropy: %w", err)
	}
	plaintext := []byte(base64.RawURLEncoding.EncodeToString(randomBytes))
	clear(randomBytes)
	hash := sha256.Sum256(plaintext)
	return connectorToken{
		ID:        "ttkn_" + hex.EncodeToString(hash[:]),
		Plaintext: plaintext,
		Hash:      hash[:],
	}, nil
}
