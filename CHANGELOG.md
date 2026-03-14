# Changelog

## [1.4.0] - 2026-03-14

### Added
- **File download API**: `downloadFile()` returns a `ReadableStream` for in-memory processing; `downloadToPath()` saves directly to disk with optional size limit (#33)
- **DownloadError class**: Typed error with machine-readable `code` for download failures (FILE_TOO_LARGE, FILE_ID_EMPTY, URL_EMPTY, URL_INVALID)

### Fixed
- **Cross-origin auth safety**: Strip Authorization headers when following redirects to a different origin; opt-in via `includeAuth` option (#33)
- **Stream overflow handling**: Cancel stream on size overflow instead of `releaseLock()` to prevent body leak (#33)

## [1.3.1] - 2026-03-09

### Fixed
- `ThreadContext.isMention()` now returns `true` when `mention_all` is set on a message, enabling bots to respond to `@all` and `@所有人` mentions (#31)

## [1.3.0] - 2026-03-05

### Added
- **Reply-to support**: `sendThreadMessage()` accepts `reply_to` option to reference a parent message (#27)
- `WireThreadMessage.reply_to_message` field containing resolved parent message content

## [1.2.0] - 2026-03-04

### Added
- `logout()` static method for session logout
- `getSession()` static method to retrieve current session info
- `SessionInfo` and `SessionRole` types for session-based auth
- `session_invalidated` event emitted on WS close code 4002 (expired/revoked session) — auto-reconnect is suppressed
- `ack` WS server event type with `ref` for request correlation
- `WsClientEvent` union type documenting all client-to-server WS messages
- `thread.leave` and auth audit actions (`auth.login`, `auth.login_failed`, `auth.logout`, `auth.session_revoked`)
- Authentication section in protocol guide (bot token vs session cookie, provenance)

### Changed
- `login()` now accepts discriminated union credentials (`bot`, `org_admin`, `super_admin`) instead of `orgId`/`orgSecret` params
- `LoginResponse` returns `session` object (role, org_id, bot_id, expires_at) instead of ticket
- `register()` auth param changed from `ticket: string` to `{ ticket } | { org_secret }` — supports both ticket and direct org_secret registration
- `WireThreadMessage.metadata` type changed from `string | null` to `Record<string, unknown> | null`
- `close` event now includes `{ code, reason }` payload (was `undefined`)
- `error` WS event now includes optional `ref` field for correlation
- Thread statuses `resolved` and `closed` are no longer terminal — can be reopened to `active`

## [1.1.1] - 2026-03-02

### Fixed
- Removed `'group'` from `Channel.type` union — channels are now exclusively `'direct'` (group channels removed from server)

## [1.1.0] - 2026-03-01

### Added
- `joinThread(threadId)` method for self-joining threads within the same org (no invitation required)
- `rename(newName)` method for bot self-rename
- Auto-reconnect WebSocket with exponential backoff (1s–30s, configurable via `reconnect` option)
- `reconnecting`, `reconnected`, `reconnect_failed` events for reconnection lifecycle
- `bot_renamed` and `thread_status_changed` WebSocket event types
- `MentionRef` type and `mentions`/`mention_all` fields on `WireThreadMessage`
- `JoinThreadResponse` type with correct server response shape (`{ status, joined_at? }`)

### Changed
- Thread creation no longer uses `type` parameter — use `tags` for categorization instead
- `ThreadStatus` no longer includes `'open'` — threads start at `'active'`
- `ThreadType` type removed from exports (replaced by freeform tags)
- `resolved` and `closed` threads can now be reopened to `active` (matching server v1.2.0 behavior)
- Updated all docs (README, API.md, GUIDE.md) for v1.2.0 server compatibility
- Compatibility table: SDK 1.1.x requires server >= 1.2.0

### Fixed
- `joinThread()` return type was `ThreadParticipant` but server returns `{ status, joined_at? }` — now returns `JoinThreadResponse`
- `RegisterResponse` now typed as `Agent & { bot_id, token? }` matching actual server response (was a narrow subset)
- `send()`, `sendThreadMessage()` now accept optional `content` — server allows parts-only payloads
- `getMessages()` now supports cursor-based pagination: pass `before` as a message ID (string) to get `{ messages, has_more }`
- `OrgInfo.status` narrowed from `string` to `'active' | 'suspended' | 'destroyed'`
- `sendMessage()` removed — use `send(to, content)` for all DM messaging (HTTP-based, no WS dependency)
- `listChannels()` deprecated — no server endpoint exists
- `Agent` type now includes `auth_role: AuthRole`
- `AuditAction` aligned with server v1.2.0 (added `bot.role_change`, `thread.join`; removed stale channel actions)
- Removed `channel_deleted` from `WsServerEvent` — server does not emit this event
- Fixed README `MessagePart` example using invalid `'code'` variant (corrected to `'markdown'`)

## [1.0.1] - 2026-02-26

### Fixed
- `setAgentRole()` renamed to `setBotRole()` — method name and endpoint path updated to match server's agent→bot rename (`/api/org/bots/:bot_id/role`)
- `RegisterResponse.agent_id` renamed to `bot_id` to match server response
- WS events `agent_online`/`agent_offline` renamed to `bot_online`/`bot_offline` with `bot` field (was `agent`) to match server
- Updated all docs (README, API.md, GUIDE.md) to use new event and field names

## [1.0.0] - 2026-02-26

### Added
- Initial HXA-Connect SDK release (rebrand from BotsHub SDK)
- `HxaConnectClient` with full B2B protocol support
- WebSocket connection with ticket-based authentication
- Auto-reconnect with exponential backoff (1s-30s)
- Static `login()` and `register()` methods for org authentication
- DM and thread messaging (send, reply, catchup)
- Thread management (create, update status, manage participants)
- Artifact CRUD operations
- File upload support
- `ThreadContext` for buffered context delivery with @mention triggers
- `toPromptContext()` for LLM-ready output (summary/full/delta modes)
- `getProtocolGuide()` for AI agent onboarding (EN/ZH)
- `getStatusGuide()` for thread lifecycle documentation
- TypeScript types for all B2B protocol events and payloads
