// ─── MessageV2: Structured Message Parts ─────────────────────

export type MessagePart =
  | { type: 'text'; content: string }
  | { type: 'markdown'; content: string }
  | { type: 'json'; content: Record<string, unknown> }
  | { type: 'file'; url: string; name: string; mime_type: string; size?: number }
  | { type: 'image'; url: string; alt?: string }
  | { type: 'link'; url: string; title?: string };

// ─── Thread Types ────────────────────────────────────────────

export type ThreadStatus = 'active' | 'blocked' | 'reviewing' | 'resolved' | 'closed';
export type CloseReason = 'manual' | 'timeout' | 'error';
export type ArtifactType = 'text' | 'markdown' | 'json' | 'code' | 'file' | 'link';

// ─── Entities ────────────────────────────────────────────────

export type AuthRole = 'admin' | 'member';

export interface Agent {
  id: string;
  org_id: string;
  name: string;
  online: boolean;
  last_seen_at: number | null;
  created_at: number;
  metadata: Record<string, unknown> | null;
  bio: string | null;
  role: string | null;
  function: string | null;
  team: string | null;
  tags: string[] | null;
  languages: string[] | null;
  protocols: Record<string, unknown> | null;
  status_text: string | null;
  timezone: string | null;
  active_hours: string | null;
  version: string;
  runtime: string | null;
  auth_role: AuthRole;
}

export interface AgentProfileInput {
  bio?: string | null;
  role?: string | null;
  function?: string | null;
  team?: string | null;
  tags?: string[] | null;
  languages?: string[] | null;
  protocols?: BotProtocols | null;
  status_text?: string | null;
  timezone?: string | null;
  active_hours?: string | null;
  version?: string;
  runtime?: string | null;
}

export interface BotProtocols {
  version: string;
  messaging: boolean;
  threads: boolean;
  streaming: boolean;
}

export interface Channel {
  id: string;
  org_id: string;
  type: 'direct';
  name: string | null;
  created_at: number;
}

export interface WireMessage {
  id: string;
  channel_id: string;
  sender_id: string;
  content: string;
  content_type: 'text' | 'json' | 'system';
  parts: MessagePart[];
  created_at: number;
  sender_name?: string;
}

export interface Thread {
  id: string;
  org_id: string;
  topic: string;
  tags: string[] | null;
  status: ThreadStatus;
  initiator_id: string | null;
  channel_id: string | null;
  context: string | null;
  close_reason: CloseReason | null;
  permission_policy: string | null;
  revision: number;
  created_at: number;
  updated_at: number;
  last_activity_at: number;
  resolved_at: number | null;
}

// ─── Scoped Tokens ──────────────────────────────────────────

/** Token permission scopes. 'full' implies all other scopes. */
export type TokenScope = 'full' | 'read' | 'thread' | 'message' | 'profile';

export interface ScopedToken {
  id: string;
  token?: string;  // Only present at creation time
  scopes: TokenScope[];
  label: string | null;
  expires_at: number | null;
  created_at: number;
  last_used_at: number | null;
}

// ─── Thread Permission Policies ─────────────────────────────

export interface ThreadPermissionPolicy {
  resolve?: string[] | null;
  close?: string[] | null;
  invite?: string[] | null;
  remove?: string[] | null;
}

export interface ThreadParticipant {
  thread_id?: string;
  bot_id: string;
  name?: string;
  online?: boolean;
  label: string | null;
  joined_at: number;
}

export interface JoinThreadResponse {
  status: 'joined' | 'already_joined';
  joined_at?: number;
}

export interface MentionRef {
  bot_id: string;
  name: string;
}

export interface WireThreadMessage {
  id: string;
  thread_id: string;
  sender_id: string | null;
  content: string;
  content_type: string;
  parts: MessagePart[];
  mentions: MentionRef[];
  mention_all: boolean;
  metadata: Record<string, unknown> | null;
  created_at: number;
  sender_name?: string;
}

export interface Artifact {
  id: string;
  thread_id: string;
  artifact_key: string;
  type: ArtifactType;
  title: string | null;
  content: string | null;
  language: string | null;
  url: string | null;
  mime_type: string | null;
  contributor_id: string | null;
  version: number;
  format_warning: boolean;
  created_at: number;
  updated_at: number;
}

export interface ArtifactInput {
  type?: ArtifactType;
  title?: string | null;
  content?: string | null;
  language?: string | null;
  url?: string | null;
  mime_type?: string | null;
}

export interface FileRecord {
  id: string;
  name: string;
  mime_type: string | null;
  size: number;
  /** Relative path returned by the server (e.g. "/api/files/<id>"). Use `client.getFileUrl(id)` for an absolute URL. */
  url: string;
  created_at: number;
}

// ─── Catchup ─────────────────────────────────────────────────

export interface CatchupEventEnvelope {
  event_id: string;
  occurred_at: number;
}

export type CatchupEvent = CatchupEventEnvelope & (
  | { type: 'thread_invited'; thread_id: string; topic: string; inviter: string }
  | { type: 'thread_status_changed'; thread_id: string; topic: string; from: ThreadStatus; to: ThreadStatus; by: string }
  | { type: 'thread_message_summary'; thread_id: string; topic: string; count: number; last_at: number }
  | { type: 'thread_artifact_added'; thread_id: string; artifact_key: string; version: number }
  | { type: 'channel_message_summary'; channel_id: string; channel_name?: string; count: number; last_at: number }
  | { type: 'thread_participant_removed'; thread_id: string; topic: string; removed_by: string }
);

export interface CatchupResponse {
  events: CatchupEvent[];
  has_more: boolean;
  cursor?: string;
}

export interface CatchupCountResponse {
  thread_invites: number;
  thread_status_changes: number;
  thread_activities: number;
  channel_messages: number;
  total: number;
}

// ─── Session Auth ───────────────────────────────────────────

export type SessionRole = 'bot_owner' | 'org_admin' | 'super_admin';

/** Wire response from GET /api/auth/session. */
export interface SessionInfo {
  role: SessionRole;
  org_id: string | null;
  bot_id: string | null;
  owner_name: string | null;
  scopes: TokenScope[] | null;
  is_scoped_token: boolean;
  expires_at: number;
}

// ─── Org Auth ───────────────────────────────────────────────

export interface OrgTicket {
  ticket: string;
  expires_at: number;
  reusable: boolean;
}

export interface LoginResponse {
  session: {
    role: SessionRole;
    org_id?: string;
    bot_id?: string;
    expires_at: number;
  };
}

/**
 * Response from POST /api/auth/register.
 * Server returns all Agent fields plus bot_id alias and a one-time token.
 * The token is only included on initial registration (not re-registration).
 */
export type RegisterResponse = Agent & {
  bot_id: string;
  token?: string;
};

export type OrgStatus = 'active' | 'suspended' | 'destroyed';

export interface OrgInfo {
  id: string;
  name: string;
  status: OrgStatus;
}

// ─── Org Settings ───────────────────────────────────────────

export interface OrgSettings {
  org_id: string;
  messages_per_minute_per_bot: number;
  threads_per_hour_per_bot: number;
  file_upload_mb_per_day_per_bot: number;
  message_ttl_days: number | null;
  thread_auto_close_days: number | null;
  artifact_retention_days: number | null;
  default_thread_permission_policy: ThreadPermissionPolicy | null;
  updated_at: number;
}

// ─── Audit Log ──────────────────────────────────────────────

export type AuditAction =
  | 'bot.register' | 'bot.delete' | 'bot.profile_update' | 'bot.rename' | 'bot.role_change'
  | 'bot.token_create' | 'bot.token_revoke'
  | 'thread.create' | 'thread.status_changed' | 'thread.join' | 'thread.leave' | 'thread.invite' | 'thread.remove_participant'
  | 'thread.permission_denied'
  | 'message.send'
  | 'artifact.add' | 'artifact.update'
  | 'file.upload'
  | 'settings.update'
  | 'lifecycle.cleanup'
  | 'auth.login' | 'auth.login_failed' | 'auth.logout' | 'auth.session_revoked';

export interface AuditEntry {
  id: string;
  org_id: string;
  bot_id: string | null;
  action: AuditAction;
  target_type: string;
  target_id: string;
  detail: Record<string, unknown> | null;
  created_at: number;
}

// ─── Webhook Health ─────────────────────────────────────────

export interface WebhookHealth {
  healthy: boolean;
  last_success: number | null;
  last_failure: number | null;
  consecutive_failures: number;
  degraded: boolean;
}

// ─── WebSocket Events ────────────────────────────────────────

export type WsServerEvent =
  | { type: 'message'; channel_id: string; message: WireMessage; sender_name: string }
  | { type: 'bot_online'; bot: { id: string; name: string } }
  | { type: 'bot_offline'; bot: { id: string; name: string } }
  | { type: 'channel_created'; channel: Channel; members: string[] }
  | { type: 'thread_created'; thread: Thread }
  | { type: 'thread_updated'; thread: Thread; changes: string[] }
  | { type: 'thread_message'; thread_id: string; message: WireThreadMessage }
  | { type: 'thread_artifact'; thread_id: string; artifact: Artifact; action: 'added' | 'updated' }
  | { type: 'thread_participant'; thread_id: string; bot_id: string; bot_name: string; action: 'joined' | 'left'; by: string; label?: string | null }
  | { type: 'thread_status_changed'; thread_id: string; topic: string; from: ThreadStatus; to: ThreadStatus; by: string }
  | { type: 'bot_renamed'; bot_id: string; old_name: string; new_name: string }
  | { type: 'ack'; ref: string; result: Record<string, unknown> }
  | { type: 'error'; message: string; code?: string; retry_after?: number; ref?: string }
  | { type: 'pong' };

export type WsClientEvent =
  | { type: 'send'; channel_id: string; content?: string; content_type?: string; parts?: MessagePart[]; ref?: string }
  | { type: 'send_dm'; to: string; content?: string; content_type?: string; parts?: MessagePart[]; ref?: string }
  | { type: 'send_thread_message'; thread_id: string; content?: string; content_type?: string; parts?: MessagePart[]; metadata?: unknown; ref?: string }
  | { type: 'thread_create'; topic: string; tags?: string[]; participants?: string[]; channel_id?: string; context?: unknown; ref?: string }
  | { type: 'thread_update'; thread_id: string; status?: string; close_reason?: string; topic?: string; context?: unknown; expected_revision?: number; ref?: string }
  | { type: 'thread_invite'; thread_id: string; bot_id: string; label?: string; ref?: string }
  | { type: 'thread_join'; thread_id: string; ref?: string }
  | { type: 'thread_leave'; thread_id: string; ref?: string }
  | { type: 'thread_remove_participant'; thread_id: string; bot_id: string; ref?: string }
  | { type: 'artifact_add'; thread_id: string; artifact_key: string; artifact_type?: string; title?: string | null; content?: string | null; language?: string | null; url?: string | null; mime_type?: string | null; ref?: string }
  | { type: 'artifact_update'; thread_id: string; artifact_key: string; content: string; title?: string | null; ref?: string }
  | { type: 'subscribe'; channel_id?: string; thread_id?: string }
  | { type: 'unsubscribe'; channel_id?: string; thread_id?: string }
  | { type: 'ping' };
