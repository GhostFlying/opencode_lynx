# Network Bridge API Specification

This document describes the JS-side network API surface exposed through the native bridge (`OpenCodeBridgeModule`). All HTTP and SSE traffic from the Lynx app flows through this bridge to native (Android/iOS) transport implementations.

## Bridge Methods

The following bridge methods are registered via the `nativeBridge` LynxModule:

| Method | Direction | Purpose |
|--------|-----------|---------|
| `network.request` | JS → Native → JS | Execute an HTTP request |
| `network.sse.open` | JS → Native → JS + events | Open an SSE stream |
| `network.sse.close` | JS → Native → JS | Close an SSE stream |
| `backend.channel.open` | JS → Native → JS + events | Open a long-lived WebSocket channel (used by Codex) |
| `backend.channel.send` | JS → Native → JS | Send a JSON frame on an open channel |
| `backend.channel.close` | JS → Native → JS | Close a channel |

SSE events flow from native to JS via `sendGlobalEvent` on a per-stream event channel (`network.sse.event.<streamId>`). Backend-channel frames and state transitions flow on per-channel event names supplied by JS at open time.

---

## HTTP Request

### Input

```typescript
interface OpencodeNetworkRequest {
  path: string                        // Absolute URL (https://...)
  method?: string                     // HTTP method, defaults to "GET"
  headers?: Record<string, string>    // Request headers
  body?: unknown                      // Request body (string, object, or bytes)
}
```

### Output

```typescript
interface NetworkBridgeRequestResult<TBody = unknown> {
  ok: boolean           // true if status is 200-299
  status: number        // HTTP status code
  headers: Record<string, string>
  body: TBody           // Response body (string)
}
```

### Bridge Envelope (native → JS)

The native side returns a flat object. The JS bridge client normalizes it:

| Native field | Fallback field | Normalized to |
|---|---|---|
| `status` | `status_code` | `result.status` |
| `body` | `data` | `result.body` |
| `ok` | (computed from status) | `result.ok` |
| `headers` | — | `result.headers` (coerced to `Record<string, string>`) |
| `error_code` | — | throws `OpencodeNetworkBridgeError` |
| `error_message` | — | error message |

### Example

```typescript
const result = await gateway.opencode.network.request({
  path: 'https://api.example.com/v1/sessions',
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ title: 'New session' }),
})

if (result.ok) {
  console.log(result.body)
}
```

---

## SSE: Open Stream

### Input

```typescript
interface OpencodeNetworkSseOpenInput {
  path: string                        // Absolute URL for the SSE endpoint
  headers?: Record<string, string>    // Extra headers (e.g. auth)
}
```

### Options

```typescript
interface NetworkBridgeOpenSseStreamOptions {
  timeoutMs?: number                  // Open timeout (default 30s)
  abortSignal?: AbortSignal
  eventName?: string                  // Override the bridge event channel name
  onEvent?: (payload: unknown) => void
  onError?: (error: OpencodeWrapperError, payload: unknown) => void
}
```

### Output

```typescript
interface OpencodeNetworkSseHandle {
  id: string    // Stream ID used to close or identify events
}
```

### Bridge Envelope (native → JS)

| Native field | Fallback field | Normalized to |
|---|---|---|
| `id` | `stream_id` | `handle.id` |
| `event_name` | (fallback generated) | bridge event channel name |
| `error_code` | — | throws `OpencodeNetworkBridgeError` |

### Event Payload (streamed via bridge listener)

Each SSE event dispatched by native arrives as:

```typescript
{
  stream_id: string     // Matches the handle.id
  event_name: string    // The bridge channel name
  event: string         // SSE event type (default "message")
  data: string          // SSE data payload
  id?: string           // SSE event ID (for Last-Event-ID reconnect)
  retry?: number        // Server-suggested retry interval in ms
}
```

Events are filtered by `stream_id` — listeners only see events for their own stream.

### Example

```typescript
const handle = await gateway.opencode.network.sse.open(
  { path: 'https://api.example.com/v1/events?stream=global' },
  {
    onEvent(payload) {
      console.log('SSE event:', payload)
    },
    onError(err, payload) {
      console.error('SSE error:', err.message)
    },
  },
)
```

---

## SSE: Close Stream

### Input

```typescript
interface OpencodeNetworkSseHandle {
  id: string    // The stream ID returned by open
}
```

### Behavior

1. Removes the JS-side bridge event listener (`bridge.off`)
2. Sends `network.sse.close` to native with `{ id: streamId }`
3. Native cancels the connection and cleans up the session

### Example

```typescript
await gateway.opencode.network.sse.close(handle)
```

---

## Backend Channel: Open / Send / Close

These three methods provide a long-lived bidirectional WebSocket channel.
JS allocates two event names up front (one for inbound frames, one for
state transitions); native dispatches both via
`LynxContext.sendGlobalEvent`. Reconnect ownership lives in JS, not
native — native is transport-only.

### Open

`backend.channel.open` request body (snake_case keys, exactly as accepted
by the iOS/Android handlers):

```typescript
interface BackendChannelOpenRequest {
  url: string                          // ws:// or wss://; other schemes rejected
  headers?: Record<string, string>     // string-valued; non-string values are coerced to string on iOS, dropped on Android
  message_event_name: string           // global event name native uses for inbound frames
  state_event_name: string             // global event name native uses for state transitions
  ping_interval_ms?: number            // default 30_000
}
```

Response (success):

```typescript
{ channel_id: string }
```

Response (failure): `error_code: 'invalid_payload' | 'bridge_unavailable' | ...`,
`error_message: string`. Native may also surface the failure asynchronously
via `state_event_name` after returning a `channel_id`; JS treats that as
authoritative.

### Send

`backend.channel.send` request body:

```typescript
interface BackendChannelSendRequest {
  channel_id: string
  payload: Record<string, unknown>     // serialized to JSON text on the wire
}
```

Response (success): `{ sent: true }`. Failure: `sent: false`, `error_code`,
`error_message`.

### Close

`backend.channel.close` request body:

```typescript
interface BackendChannelCloseRequest {
  channel_id: string
  code?: number                        // WebSocket close code
  reason?: string
}
```

Response (success): `{ closed: true }`. Failure: `closed: false`,
`error_code`, `error_message`. `close()` is idempotent on the JS side; a
second call after a remote-driven close is a no-op.

### Inbound message event payload

Dispatched on `message_event_name` for every inbound text frame that
parses as a JSON object:

```typescript
{ frame: Record<string, unknown> }
```

Non-JSON text frames are surfaced as a non-terminal `state` event with
`error: 'non_json_frame'` instead of a `frame` event; the channel stays
open.

### State event payload

Dispatched on `state_event_name`:

```typescript
{ state: 'open' }
{ state: 'error', error: string, code?: number, reason?: string }   // non-terminal
{ state: 'closed', code?: number, reason?: string }                 // terminal
```

`closing` is reserved on the JS-side `ChannelState` union but is not
emitted by the current native implementations. After a `closed` state,
native has released its end of the channel; JS marks the channel closed
and unsubscribes from both event names automatically. Subsequent
`send()` calls reject; `close()` is a no-op.

---

## Error Handling

All bridge errors are normalized to `OpencodeNetworkBridgeError`:

```typescript
class OpencodeNetworkBridgeError extends OpencodeWrapperError {
  readonly kind: NetworkBridgeErrorKind
}

type NetworkBridgeErrorKind =
  | 'bridge_timeout'       // Request or open timed out
  | 'bridge_unavailable'   // Native bridge not available
  | 'bridge_cancelled'     // Request aborted or stream closed
  | 'bridge_protocol'      // Malformed response or protocol error
```

### Retryable Errors

| Kind | Retryable |
|------|-----------|
| `bridge_timeout` | yes |
| `bridge_unavailable` | yes |
| `bridge_cancelled` | no |
| `bridge_protocol` | no |

### Error Detection

Errors are classified by pattern-matching on the error message:

| Pattern keywords | Classified as |
|---|---|
| `timeout`, `timed out` | `bridge_timeout` |
| `nativemodules is not available`, `bridge unavailable`, ... | `bridge_unavailable` |
| `abort`, `cancelled`, `canceled` | `bridge_cancelled` |
| `protocol`, `invalid`, `malformed`, `missing` | `bridge_protocol` |

Native responses with `error_code` / `error_message` fields are also mapped to the appropriate `NetworkBridgeErrorKind`.

---

## Gateway Integration

App code accesses the network API through the gateway:

```typescript
const gateway = OpenCodeGateway.create({
  baseUrl: 'https://api.example.com',
  auth: 'bearer-token',
})

// Direct network calls
await gateway.opencode.network.request({ path: '...', method: 'GET' })
await gateway.opencode.network.sse.open({ path: '...' }, { onEvent: ... })
await gateway.opencode.network.sse.close(handle)

// SDK client (uses native fetch under the hood)
gateway.sessions.list()    // internally calls network.request via native fetch
```

The SDK client (`@opencode-ai/sdk`) is configured with a custom `fetch` implementation that converts standard `Request` objects into `network.request` bridge calls, so all SDK HTTP traffic also flows through the native bridge.

---

## SSE Lifecycle (App-Level)

The gateway provides a higher-level SSE subscription API with reconnection:

```typescript
const subscription = gateway.events.subscribe({
  onEvent(event, context) { /* parsed event */ },
  onLifecycleStateChange(state) { /* idle | connecting | open | reconnecting | stopped | failed */ },
  reconnect: {
    initialDelayMs: 1_000,
    multiplier: 2,
    maxDelayMs: 30_000,
    maxRetries: 5,
  },
})

subscription.stop()
subscription.reconnect()
```

This wraps `network.sse.open` / `network.sse.close` with:
- Automatic reconnection with exponential backoff
- Lifecycle state machine (`idle → connecting → open → reconnecting → ...`)
- Event parsing and reconciliation (dedup, ordering)
- AbortSignal integration

---

## Defaults

| Parameter | Value |
|-----------|-------|
| Method timeout | 30,000 ms |
| SSE reconnect initial delay | 1,000 ms |
| SSE reconnect multiplier | 2x |
| SSE reconnect max delay | 30,000 ms |
| SSE reconnect max retries | 5 |
| SSE event name prefix | `network.sse.event.` |
| Backend channel ping interval | 30,000 ms |
| Backend channel message event name prefix | `backend.channel.message.` |
| Backend channel state event name prefix | `backend.channel.state.` |

---

## Source Files

| File | Role |
|------|------|
| `src/opencode/network/contract.ts` | Type contracts |
| `src/opencode/network/bridge-client.ts` | Native bridge client, error normalization |
| `src/opencode/gateway.ts` | App-facing gateway, SSE subscription |
| `src/opencode/client.ts` | SDK client with native fetch |
| `src/opencode/events.ts` | SSE lifecycle, event parsing |
| `src/opencode/errors.ts` | Error types and classification |
| `src/opencode/types.ts` | Public type definitions |
| `src/opencode/index.ts` | Public exports |
| `src/backends/codex/channel.ts` | JS-side `backend.channel.*` client, message/state subscription |
| `src/backends/codex/protocol.ts` | JSON-RPC 2.0 client over the channel; owns reconnect |
| `src/backends/codex/adapter.ts` | BackendClient implementation for Codex |
