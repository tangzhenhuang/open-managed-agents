package tunnels

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os/exec"
	"strconv"
	"testing"
	"time"

	"github.com/superduck-ai/open-managed-agents/internal/config"

	"github.com/redis/go-redis/v9"
)

func TestBrokerLifecycleAndProcessAffinity(t *testing.T) {
	client := startTestRedis(t)
	clock := time.Date(2026, time.August, 20, 1, 2, 3, 0, time.UTC)
	broker := NewBroker(client, config.TunnelConfig{
		PresenceTTL:        time.Minute,
		TombstoneTTL:       5 * time.Minute,
		MaxPendingRequests: 256,
		MaxPendingBytes:    32 << 20,
	})
	broker.now = func() time.Time { return clock }
	ctx := context.Background()
	tunnelUUID := "11111111-1111-4111-8111-111111111111"
	declarations := []ChannelDeclaration{{Name: "main", ProcessAffinity: true}}

	first := testQueuedCommand("req_first", clock, "")
	if err := broker.Enqueue(ctx, tunnelUUID, first); !errors.Is(err, ErrNoConnector) {
		t.Fatalf("Enqueue without connector = %v, want ErrNoConnector", err)
	}
	if err := broker.ensureActiveTokenVersion(ctx, tunnelUUID, 1); err != nil {
		t.Fatalf("ensureActiveTokenVersion: %v", err)
	}
	if err := broker.RegisterConnector(ctx, tunnelUUID, "instance-a", 1, declarations); err != nil {
		t.Fatalf("RegisterConnector: %v", err)
	}
	if err := broker.Enqueue(ctx, tunnelUUID, first); err != nil {
		t.Fatalf("Enqueue: %v", err)
	}
	claimed, err := broker.Claim(ctx, tunnelUUID, "instance-a", 1, declarations, 25)
	if err != nil {
		t.Fatalf("Claim: %v", err)
	}
	if len(claimed) != 1 || claimed[0].RequestID != first.RequestID || claimed[0].ShardToken == "" {
		t.Fatalf("Claim() = %+v", claimed)
	}
	if err := broker.SubmitResponse(ctx, tunnelUUID, "instance-a", 1, "wrong", testTerminalResponse(first.RequestID, "session-1")); !errors.Is(err, ErrResponseMismatch) {
		t.Fatalf("SubmitResponse wrong shard = %v, want ErrResponseMismatch", err)
	}
	wrongType := TunnelResponse{
		RequestID: first.RequestID, Channel: "main",
		ResponseType: ResponseTypeSessionTermination,
	}
	if err := broker.SubmitResponse(ctx, tunnelUUID, "instance-a", 1, claimed[0].ShardToken, wrongType); !errors.Is(err, ErrResponseMismatch) {
		t.Fatalf("SubmitResponse wrong response type = %v, want ErrResponseMismatch", err)
	}
	notification := TunnelResponse{
		RequestID: first.RequestID, Channel: "main", ResponseType: ResponseTypeJSONRPCNotify,
		JSONResponse: json.RawMessage(`{"jsonrpc":"2.0","method":"notifications/progress"}`),
	}
	if err := broker.SubmitResponse(ctx, tunnelUUID, "instance-a", 1, claimed[0].ShardToken, notification); err != nil {
		t.Fatalf("SubmitResponse notification: %v", err)
	}
	if response, state, err := broker.GetResponse(ctx, tunnelUUID, first.RequestID); err != nil || state != "dispatched" || response != nil {
		t.Fatalf("GetResponse after notification = (%+v, %q, %v)", response, state, err)
	}
	if err := broker.SuspendTokenVersion(ctx, tunnelUUID, 1); err != nil {
		t.Fatalf("SuspendTokenVersion: %v", err)
	}
	if _, err := broker.Claim(ctx, tunnelUUID, "instance-a", 1, declarations, 25); !errors.Is(err, ErrTokenRetired) {
		t.Fatalf("Claim with retired token = %v, want ErrTokenRetired", err)
	}
	terminal := testTerminalResponse(first.RequestID, "session-1")
	if err := broker.SubmitResponse(ctx, tunnelUUID, "instance-a", 1, claimed[0].ShardToken, terminal); err != nil {
		t.Fatalf("SubmitResponse terminal with retired token: %v", err)
	}
	if err := broker.SubmitResponse(ctx, tunnelUUID, "instance-a", 1, claimed[0].ShardToken, terminal); err != nil {
		t.Fatalf("SubmitResponse duplicate terminal: %v", err)
	}
	response, state, err := broker.GetResponse(ctx, tunnelUUID, first.RequestID)
	if err != nil || state != "completed" || response == nil || response.ResponseCode != http.StatusOK {
		t.Fatalf("GetResponse terminal = (%+v, %q, %v)", response, state, err)
	}
	if err := broker.ActivateTokenVersion(ctx, tunnelUUID, 2); err != nil {
		t.Fatalf("ActivateTokenVersion: %v", err)
	}
	if commands, err := broker.Claim(ctx, tunnelUUID, "instance-a", 2, declarations, 25); err != nil || len(commands) != 0 {
		t.Fatalf("register rotated token connector = (%+v, %v)", commands, err)
	}

	second := testQueuedCommand("req_second", clock, "session-1")
	if err := broker.Enqueue(ctx, tunnelUUID, second); err != nil {
		t.Fatalf("Enqueue affinity request: %v", err)
	}
	if commands, err := broker.Claim(ctx, tunnelUUID, "instance-b", 2, declarations, 25); err != nil || len(commands) != 0 {
		t.Fatalf("Claim from non-owner = (%+v, %v), want empty", commands, err)
	}
	commands, err := broker.Claim(ctx, tunnelUUID, "instance-a", 2, declarations, 25)
	if err != nil || len(commands) != 1 || commands[0].RequestID != second.RequestID {
		t.Fatalf("Claim from affinity owner = (%+v, %v)", commands, err)
	}
	clock = clock.Add(2 * time.Minute)
	if err := broker.cleanup(ctx, tunnelUUID); err != nil {
		t.Fatalf("cleanup expired affinity: %v", err)
	}
	if count := client.HLen(ctx, broker.affinityKey(tunnelUUID)).Val(); count != 0 {
		t.Fatalf("expired affinity owner count = %d, want 0", count)
	}
	if count := client.ZCard(ctx, broker.affinityExpiryKey(tunnelUUID)).Val(); count != 0 {
		t.Fatalf("expired affinity index count = %d, want 0", count)
	}
}

func TestBrokerCancelAndExpiry(t *testing.T) {
	client := startTestRedis(t)
	clock := time.Date(2026, time.August, 20, 2, 0, 0, 0, time.UTC)
	broker := NewBroker(client, config.TunnelConfig{
		PresenceTTL: time.Minute, TombstoneTTL: 5 * time.Minute,
		MaxPendingRequests: 1, MaxPendingBytes: 1024,
	})
	broker.now = func() time.Time { return clock }
	ctx := context.Background()
	tunnelUUID := "22222222-2222-4222-8222-222222222222"
	declarations := []ChannelDeclaration{{Name: "main"}}
	if err := broker.ensureActiveTokenVersion(ctx, tunnelUUID, 1); err != nil {
		t.Fatalf("ensureActiveTokenVersion: %v", err)
	}
	if err := broker.RegisterConnector(ctx, tunnelUUID, "instance", 1, declarations); err != nil {
		t.Fatalf("RegisterConnector: %v", err)
	}
	canceled := testQueuedCommand("req_canceled", clock, "")
	if err := broker.Enqueue(ctx, tunnelUUID, canceled); err != nil {
		t.Fatalf("Enqueue canceled: %v", err)
	}
	if err := broker.Cancel(ctx, tunnelUUID, canceled.RequestID); err != nil {
		t.Fatalf("Cancel: %v", err)
	}
	if _, state, err := broker.GetResponse(ctx, tunnelUUID, canceled.RequestID); err != nil || state != "canceled" {
		t.Fatalf("GetResponse canceled = (%q, %v)", state, err)
	}

	expired := testQueuedCommand("req_expired", clock, "")
	if err := broker.Enqueue(ctx, tunnelUUID, expired); err != nil {
		t.Fatalf("Enqueue expired: %v", err)
	}
	clock = clock.Add(2 * time.Minute)
	if _, state, err := broker.GetResponse(ctx, tunnelUUID, expired.RequestID); err != nil || state != "expired" {
		t.Fatalf("GetResponse expired = (%q, %v)", state, err)
	}
}

func TestBrokerSubscriptionBeforeEnqueuePreservesFastNotification(t *testing.T) {
	client := startTestRedis(t)
	clock := time.Date(2026, time.August, 20, 3, 0, 0, 0, time.UTC)
	broker := NewBroker(client, config.TunnelConfig{
		PresenceTTL: time.Minute, TombstoneTTL: 5 * time.Minute,
		MaxPendingRequests: 8, MaxPendingBytes: 4096,
	})
	broker.now = func() time.Time { return clock }
	ctx := context.Background()
	tunnelUUID := "33333333-3333-4333-8333-333333333333"
	declarations := []ChannelDeclaration{{Name: "main"}}
	if err := broker.ensureActiveTokenVersion(ctx, tunnelUUID, 1); err != nil {
		t.Fatalf("ensureActiveTokenVersion: %v", err)
	}
	if err := broker.RegisterConnector(ctx, tunnelUUID, "instance", 1, declarations); err != nil {
		t.Fatalf("RegisterConnector: %v", err)
	}
	command := testQueuedCommand("req_fast_notification", clock, "")
	waiter, err := broker.subscribeResponse(ctx, tunnelUUID, command.RequestID, true)
	if err != nil {
		t.Fatalf("subscribeResponse: %v", err)
	}
	defer waiter.Close()
	if err := broker.Enqueue(ctx, tunnelUUID, command); err != nil {
		t.Fatalf("Enqueue: %v", err)
	}
	claimed, err := broker.Claim(ctx, tunnelUUID, "instance", 1, declarations, 1)
	if err != nil || len(claimed) != 1 {
		t.Fatalf("Claim = (%+v, %v)", claimed, err)
	}
	notification := TunnelResponse{
		RequestID: command.RequestID, Channel: "main", ResponseType: ResponseTypeJSONRPCNotify,
		JSONResponse: json.RawMessage(`{"jsonrpc":"2.0","method":"notifications/progress"}`),
	}
	if err := broker.SubmitResponse(ctx, tunnelUUID, "instance", 1, claimed[0].ShardToken, notification); err != nil {
		t.Fatalf("SubmitResponse notification: %v", err)
	}
	terminal := testTerminalResponse(command.RequestID, "")
	if err := broker.SubmitResponse(ctx, tunnelUUID, "instance", 1, claimed[0].ShardToken, terminal); err != nil {
		t.Fatalf("SubmitResponse terminal: %v", err)
	}
	var notifications []TunnelResponse
	response, err := waiter.Wait(ctx, func(value TunnelResponse) {
		notifications = append(notifications, value)
	})
	if err != nil {
		t.Fatalf("Wait: %v", err)
	}
	if len(notifications) != 1 || notifications[0].ResponseType != ResponseTypeJSONRPCNotify {
		t.Fatalf("notifications = %+v", notifications)
	}
	if response.ResponseType != ResponseTypeJSONRPC {
		t.Fatalf("terminal response = %+v", response)
	}
}

func testQueuedCommand(requestID string, now time.Time, affinityKey string) queuedCommand {
	payload := json.RawMessage(`{"jsonrpc":"2.0","id":1,"method":"tools/list"}`)
	return queuedCommand{
		RequestID: requestID, CommandType: CommandTypeJSONRPC, Channel: "main",
		CreatedAt: now, Headers: http.Header{}, JSONRPC: payload,
		ExpiresAt: now.Add(time.Minute), PayloadSize: int64(len(payload)), AffinityKey: affinityKey,
	}
}

func testTerminalResponse(requestID, sessionID string) TunnelResponse {
	return TunnelResponse{
		RequestID: requestID, Channel: "main", ResponseCode: http.StatusOK,
		ResponseType:    ResponseTypeJSONRPC,
		JSONResponse:    json.RawMessage(`{"jsonrpc":"2.0","id":1,"result":{}}`),
		ResponseHeaders: http.Header{"Mcp-Session-Id": []string{sessionID}},
	}
}

func startTestRedis(t *testing.T) *redis.Client {
	t.Helper()
	path, err := exec.LookPath("redis-server")
	if err != nil {
		t.Skip("redis-server is not installed")
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("reserve Redis port: %v", err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	_ = listener.Close()
	var logs bytes.Buffer
	command := exec.Command(path,
		"--bind", "127.0.0.1", "--port", strconv.Itoa(port),
		"--protected-mode", "no", "--save", "", "--appendonly", "no",
		"--dir", t.TempDir(),
	)
	command.Stdout = &logs
	command.Stderr = &logs
	if err := command.Start(); err != nil {
		t.Fatalf("start redis-server: %v", err)
	}
	t.Cleanup(func() {
		_ = command.Process.Kill()
		_, _ = command.Process.Wait()
	})
	client := redis.NewClient(&redis.Options{Addr: fmt.Sprintf("127.0.0.1:%d", port)})
	t.Cleanup(func() { _ = client.Close() })
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for {
		if err := client.Ping(ctx).Err(); err == nil {
			return client
		}
		select {
		case <-ctx.Done():
			t.Fatalf("redis-server did not start: %s", logs.String())
		case <-time.After(10 * time.Millisecond):
		}
	}
}
