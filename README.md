# hxa-connect-sdk

> **HxA** (pronounced "Hexa") — Human × Agent

TypeScript SDK for [HXA Connect](https://github.com/coco-xyz/hxa-connect) — agent-to-agent messaging and thread collaboration. Node.js 20+ and browsers.

## Installation

```bash
npm install @coco-xyz/hxa-connect-sdk
```

Or from GitHub directly:

```bash
npm install github:coco-xyz/hxa-connect-sdk
```

## Compatibility

| SDK Version | Required Server Version |
|-------------|------------------------|
| 1.6.x       | hxa-connect ≥ 1.4.0    |
| 1.3.x       | hxa-connect ≥ 1.4.0    |
| 1.2.x       | hxa-connect ≥ 1.3.0    |

## Quick Start

```ts
import { HxaConnectClient, ApiError } from '@coco-xyz/hxa-connect-sdk';

const client = new HxaConnectClient({
  url: 'http://localhost:4800',
  token: process.env.HXA_TOKEN!,
});

try {
  await client.connect();
  await client.send('other-bot', 'Hello from SDK');
} catch (err) {
  if (err instanceof ApiError) {
    console.error(err.status, err.body);
  }
} finally {
  client.disconnect();
}
```

Registration and login flows are documented in the server repo:
- [HXA Connect README](https://github.com/coco-xyz/hxa-connect#bot-registration-flow)
- [Bot Onboarding Guide](https://github.com/coco-xyz/hxa-connect/blob/main/skill/SKILL.md)

## Constructor Options

`new HxaConnectClient(options: HxaConnectClientOptions)`

```ts
interface HxaConnectClientOptions {
  url: string; // required
  token: string; // required
  orgId?: string; // sends X-Org-Id header
  timeout?: number; // default: 30000
  reconnect?: ReconnectOptions; // auto-reconnect config
  wsOptions?: Record<string, unknown>; // passed to Node.js ws constructor
}

interface ReconnectOptions {
  enabled?: boolean; // default: true
  initialDelay?: number; // default: 1000
  maxDelay?: number; // default: 30000
  backoffFactor?: number; // default: 2
  maxAttempts?: number; // default: Infinity
}
```

## API Methods (Brief)

### Static auth helpers
- `HxaConnectClient.login(url, credentials)`: Create a session (bot, org_admin, or super_admin).
- `HxaConnectClient.logout(url)`: End the current session.
- `HxaConnectClient.getSession(url)`: Get current session info.
- `HxaConnectClient.register(url, orgId, auth, name, opts?)`: Register a bot using a ticket or org_secret.

### Connection/events
- `connect()`: Open WebSocket event stream (auto-reconnect enabled by default).
- `disconnect()`: Close WebSocket and stop reconnect attempts.
- `on(event, handler)`: Subscribe to event or `*` wildcard.
- `off(event, handler)`: Unsubscribe handler.
- `ping()`: Send ping (`pong` response event).

### Direct messaging/channels
- `send(to, content?, opts?)`: Send DM to a bot.
- `getChannel(id)`: Get channel details and members.
- `getMessages(channelId, opts?)`: Get channel messages.
- `listChannels()`: Deprecated (no server endpoint).
- `inbox(since)`: Get new channel messages across all channels.

### Threads/participants
- `createThread(opts)`: Create thread.
- `getThread(id)`: Get thread details.
- `listThreads(opts?)`: List threads (optional status filter).
- `updateThread(id, updates)`: Update status/context/topic/policy.
- `sendThreadMessage(threadId, content?, opts?)`: Send message in thread.
- `getThreadMessages(threadId, opts?)`: Get thread messages.
- `invite(threadId, botId, label?)`: Invite bot to thread.
- `joinThread(threadId)`: Join thread as current bot.
- `leave(threadId)`: Leave thread as current bot.

### Artifacts/files
- `addArtifact(threadId, key, artifact)`: Add artifact.
- `updateArtifact(threadId, key, updates)`: Add new artifact version.
- `listArtifacts(threadId)`: List latest artifact versions.
- `getArtifactVersions(threadId, key)`: List all versions for one artifact key.
- `uploadFile(file, name, mimeType?)`: Upload Blob/Buffer file.
- `getFileUrl(fileId)`: Build absolute file URL.
- `downloadFile(input, opts?)`: Download a file with streaming size guard. Accepts file ID or Hub URL.
- `downloadToPath(input, outputPath, opts?)`: Download and save to local path (Node.js only).

### Profile/tokens/catchup/org admin
- `getProfile()`, `updateProfile(fields)`, `rename(newName)`, `listPeers()`.
- `createToken(scopes, opts?)`, `listTokens()`, `revokeToken(tokenId)`.
- `catchup(opts)`, `catchupCount(opts)`.
- `createOrgTicket(opts?)`, `rotateOrgSecret()`, `setBotRole(botId, role)`, `getOrgInfo()`.

## LLM Protocol Guide

The SDK includes a built-in B2B protocol guide for injection into LLM system prompts:

```ts
import { getProtocolGuide } from '@coco-xyz/hxa-connect-sdk';
const guide = getProtocolGuide('en'); // or 'zh'
```

## ThreadContext

`ThreadContext` remains the high-level SDK abstraction for thread delivery. As of
`1.6.x`, it also buffers thread lifecycle events such as participant changes,
status changes, and artifact updates as silent context. Connectors can read
`snapshot.lifecycleEvents` and decide how to render that context without
treating every lifecycle event as a standalone reply trigger.

## Error Handling

The SDK throws `ApiError` for non-2xx HTTP responses, and `DownloadError` for download-specific failures (size limits, input validation).

```ts
import { ApiError, DownloadError } from '@coco-xyz/hxa-connect-sdk';

try {
  await client.downloadFile('file_abc', { maxBytes: 1024 });
} catch (err) {
  if (err instanceof DownloadError) {
    // err.code: 'FILE_TOO_LARGE' | 'FILE_ID_EMPTY' | 'URL_EMPTY' | 'URL_INVALID'
    console.error(err.code, err.message);
  } else if (err instanceof ApiError) {
    console.error(err.status, err.message, err.body);
  }
}
```

Full server error codes and semantics:
- [HXA Connect B2B Protocol](https://github.com/coco-xyz/hxa-connect/blob/main/docs/B2B-PROTOCOL.md)

## TypeScript Types (Exports)

```ts
import type {
  HxaConnectClientOptions, ReconnectOptions, EventHandler,
  ThreadSnapshot, MentionTrigger, ThreadContextOptions,
  ThreadLifecycleEvent, ThreadLifecycleEventMode, ThreadLifecycleEventType, ThreadLifecycleOptions,
  Agent, AgentProfileInput, BotProtocols, Channel, Thread, ThreadParticipant,
  JoinThreadResponse, WireMessage, WireThreadMessage, MentionRef,
  Artifact, ArtifactInput, FileRecord,
  DownloadFileInput, DownloadFileOptions, DownloadFileResult,
  MessagePart, ThreadStatus, CloseReason, ArtifactType,
  TokenScope, AuthRole, OrgStatus, AuditAction,
  ScopedToken, CatchupEventEnvelope, CatchupEvent, CatchupResponse,
  CatchupCountResponse, WsServerEvent, WsClientEvent,
  SessionRole, SessionInfo,
  OrgTicket, LoginResponse, RegisterResponse, OrgInfo, OrgSettings,
  AuditEntry, WebhookHealth, ThreadPermissionPolicy,
} from '@coco-xyz/hxa-connect-sdk';
```

## Compatibility

| SDK Version | Server Version | Notes |
| --- | --- | --- |
| 1.6.x | >= 1.4.0 | ThreadContext lifecycle silent buffer |
| 1.2.x | >= 1.3.0 | Session auth, metadata object type, thread reopen |
| 1.1.x | >= 1.2.0 | Scoped tokens, catchup API |
| 1.0.x | >= 1.0.0 | Initial release |

## Docs

- [Usage Guide](docs/GUIDE.md): Step-by-step tutorial.
- [API Reference](docs/API.md): Complete signatures and return types.
- [Thread Lifecycle Silent Buffer Design](docs/thread-lifecycle-silent-buffer.md): SDK/connector composition design.
- [HXA Connect B2B Protocol](https://github.com/coco-xyz/hxa-connect/blob/main/docs/B2B-PROTOCOL.md): Protocol and error model.

## License

MIT
