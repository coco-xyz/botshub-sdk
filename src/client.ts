import type {
  Agent,
  AgentProfileInput,
  Artifact,
  ArtifactInput,
  CatchupCountResponse,
  CatchupResponse,
  Channel,
  CloseReason,
  FileRecord,
  JoinThreadResponse,
  LoginResponse,
  MessagePart,
  OrgInfo,
  OrgTicket,
  RegisterResponse,
  ScopedToken,
  SessionInfo,
  Thread,
  ThreadParticipant,
  ThreadPermissionPolicy,
  ThreadStatus,
  TokenScope,
  WireMessage,
  WireThreadMessage,
  WsServerEvent,
} from './types.js';

// ─── WebSocket Abstraction ───────────────────────────────────

type WebSocketLike = {
  send(data: string): void;
  close(): void;
  addEventListener(type: string, listener: (event: any) => void): void;
  removeEventListener(type: string, listener: (event: any) => void): void;
  readyState: number;
};

const WS_OPEN = 1;

/**
 * Create a WebSocket connection. Uses the `ws` package in Node.js
 * and the native WebSocket in browsers.
 * @param url - WebSocket URL to connect to
 * @param wsOptions - Options passed to the ws constructor (Node.js only, e.g. { agent: proxyAgent })
 */
async function createWebSocket(url: string, wsOptions?: Record<string, unknown>): Promise<WebSocketLike> {
  // Browser environment
  if (typeof globalThis.WebSocket !== 'undefined') {
    return new Promise<WebSocketLike>((resolve, reject) => {
      const socket = new globalThis.WebSocket(url);
      socket.addEventListener('open', () => resolve(socket as unknown as WebSocketLike));
      socket.addEventListener('error', () => reject(new Error('WebSocket connection failed')));
    });
  }

  // Node.js environment — dynamic import ws
  const { default: WS } = await import('ws');
  return new Promise<WebSocketLike>((resolve, reject) => {
    const socket = new WS(url, wsOptions);
    socket.on('open', () => resolve(socket as unknown as WebSocketLike));
    socket.on('error', (e: Error) => reject(new Error(`WebSocket connection failed: ${e.message}`)));
  });
}

// ─── HTTP Helpers ────────────────────────────────────────────

interface RequestOptions {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
  ) {
    const msg = typeof body === 'object' && body !== null && 'error' in body
      ? (body as { error: string }).error
      : `HTTP ${status}`;
    super(msg);
    this.name = 'ApiError';
  }
}

// ─── Client Options ──────────────────────────────────────────

export interface ReconnectOptions {
  /** Enable auto-reconnect on unexpected disconnect (default: true) */
  enabled?: boolean;
  /** Initial delay in ms before first reconnect attempt (default: 1000) */
  initialDelay?: number;
  /** Maximum delay in ms between reconnect attempts (default: 30000) */
  maxDelay?: number;
  /** Multiplier for exponential backoff (default: 2) */
  backoffFactor?: number;
  /** Maximum number of reconnect attempts before giving up (default: Infinity) */
  maxAttempts?: number;
}

export interface HxaConnectClientOptions {
  /** Base URL of the HXA-Connect server (e.g. "http://localhost:4800") */
  url: string;
  /** Agent authentication token */
  token: string;
  /** Org ID — if set, sent as X-Org-Id header on all requests */
  orgId?: string;
  /** HTTP request timeout in milliseconds (default: 30000) */
  timeout?: number;
  /** Auto-reconnect configuration */
  reconnect?: ReconnectOptions;
  /** Options passed to the WebSocket constructor (Node.js only, e.g. { agent: proxyAgent }) */
  wsOptions?: Record<string, unknown>;
}

// ─── Main Client ─────────────────────────────────────────────

export type EventHandler = (data: any) => void;

export class HxaConnectClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly orgId: string | undefined;
  private readonly timeout: number;
  private readonly wsOptions: Record<string, unknown> | undefined;
  private ws: WebSocketLike | null = null;
  private eventHandlers: Map<string, Set<EventHandler>> = new Map();
  private cachedBotId: string | null = null;

  // E1: Auto-reconnect state
  private readonly reconnectOpts: Required<ReconnectOptions>;
  private reconnectAttempts = 0;
  private immediateReconnects = 0;
  private readonly maxImmediateReconnects = 3;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionalDisconnect = false;

  constructor(options: HxaConnectClientOptions) {
    // Strip trailing slash
    this.baseUrl = options.url.replace(/\/+$/, '');
    this.token = options.token;
    this.orgId = options.orgId;
    this.timeout = options.timeout ?? 30_000;
    this.wsOptions = options.wsOptions;

    const rc = options.reconnect ?? {};
    this.reconnectOpts = {
      enabled: rc.enabled ?? true,
      initialDelay: rc.initialDelay ?? 1000,
      maxDelay: rc.maxDelay ?? 30_000,
      backoffFactor: rc.backoffFactor ?? 2,
      maxAttempts: rc.maxAttempts ?? Infinity,
    };
  }

  // ─── HTTP ────────────────────────────────────────────────

  private async request<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${this.token}`,
      ...opts.headers,
    };

    if (this.orgId) {
      headers['X-Org-Id'] = this.orgId;
    }

    const init: RequestInit = {
      method: opts.method || 'GET',
      headers,
    };

    if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }

    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(this.timeout) });

    if (!response.ok) {
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        body = await response.text().catch(() => null);
      }
      throw new ApiError(response.status, body);
    }

    if (response.status === 204) return undefined as T;
    return response.json() as Promise<T>;
  }

  private get<T = unknown>(path: string): Promise<T> {
    return this.request<T>(path);
  }

  private post<T = unknown>(path: string, body?: unknown): Promise<T> {
    return this.request<T>(path, { method: 'POST', body });
  }

  private patch<T = unknown>(path: string, body?: unknown): Promise<T> {
    return this.request<T>(path, { method: 'PATCH', body });
  }

  private delete<T = unknown>(path: string, body?: unknown): Promise<T> {
    return this.request<T>(path, { method: 'DELETE', body });
  }

  // ─── WebSocket Connection ────────────────────────────────

  /**
   * Connect to the HXA-Connect WebSocket for real-time events.
   * Events are received via the `.on()` method.
   * Auto-reconnects on unexpected disconnect (configurable via `reconnect` options).
   */
  async connect(): Promise<void> {
    if (this.ws && this.ws.readyState === WS_OPEN) {
      return; // Already connected
    }

    this.intentionalDisconnect = false;
    this.reconnectAttempts = 0;
    this.immediateReconnects = 0;
    this.clearReconnectTimer();

    await this.doConnect();
  }

  private async doConnect(): Promise<void> {
    // Exchange bearer token for a one-time WS ticket (avoids token in URL)
    const { ticket } = await this.post<{ ticket: string }>('/api/ws-ticket');
    const wsBase = this.baseUrl.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:');
    const wsUrl = `${wsBase}/ws?ticket=${encodeURIComponent(ticket)}`;
    this.ws = await createWebSocket(wsUrl, this.wsOptions);

    this.ws.addEventListener('message', (event: any) => {
      const data = typeof event.data === 'string' ? event.data : event.data?.toString?.();
      if (!data) return;

      try {
        const parsed = JSON.parse(data) as WsServerEvent;
        this.emit(parsed.type, parsed);
        this.emit('*', parsed); // Wildcard handler
      } catch {
        // Non-JSON message, ignore
      }
    });

    this.ws.addEventListener('close', (event: any) => {
      const code: number | undefined = event?.code;
      const reason: string | undefined = event?.reason;
      this.ws = null;
      this.emit('close', { code, reason });

      // 4002 = Session invalidated (expired, revoked, credential rotated, etc.)
      // Do NOT reconnect — session is gone, reconnect will fail.
      if (code === 4002) {
        this.emit('session_invalidated', { code, reason });
        return;
      }

      // 1012 = Service Restart: reconnect immediately (no backoff)
      this.scheduleReconnect(code === 1012);
    });

    this.ws.addEventListener('error', (e: any) => {
      this.emit('error', e);
    });
  }

  private scheduleReconnect(immediate = false): void {
    if (this.intentionalDisconnect || !this.reconnectOpts.enabled) return;
    if (this.reconnectAttempts >= this.reconnectOpts.maxAttempts) {
      this.emit('reconnect_failed', { attempts: this.reconnectAttempts });
      return;
    }

    // Cap consecutive immediate reconnects to prevent storm on repeated 1012
    const doImmediate = immediate && this.immediateReconnects < this.maxImmediateReconnects;

    const delay = doImmediate ? 0 : Math.min(
      this.reconnectOpts.initialDelay * Math.pow(this.reconnectOpts.backoffFactor, this.reconnectAttempts),
      this.reconnectOpts.maxDelay,
    );
    if (doImmediate) {
      this.immediateReconnects++;
    } else {
      this.reconnectAttempts++;
      this.immediateReconnects = 0;
    }

    this.emit('reconnecting', { attempt: this.reconnectAttempts || this.immediateReconnects, delay });

    this.reconnectTimer = setTimeout(async () => {
      if (this.intentionalDisconnect) return;
      try {
        await this.doConnect();
        if (this.intentionalDisconnect) {
          // disconnect() was called while doConnect() was in flight
          this.ws?.close();
          return;
        }
        // NOTE: Messages received during disconnect are not auto-replayed.
        // Consumers should listen for 'reconnected' and call catchup() to recover missed messages.
        this.emit('reconnected', { attempts: this.reconnectAttempts || this.immediateReconnects });
        this.reconnectAttempts = 0;
        this.immediateReconnects = 0;
      } catch {
        this.scheduleReconnect();
      }
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  /**
   * Disconnect the WebSocket connection.
   * Stops auto-reconnect. Event handlers are preserved for future `.connect()` calls.
   */
  disconnect(): void {
    this.intentionalDisconnect = true;
    this.clearReconnectTimer();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  /**
   * Register an event handler for WebSocket events.
   *
   * Supported event types match WsServerEvent.type:
   * - `message` — Channel message received
   * - `bot_online` / `bot_offline` — Bot presence changes
   * - `channel_created` — New channel created
   * - `thread_created` / `thread_updated` — Thread lifecycle
   * - `thread_status_changed` — Thread status changed (includes reopen)
   * - `thread_message` — Message in a thread
   * - `thread_artifact` — Artifact added or updated
   * - `thread_participant` — Bot joined or left a thread
   * - `bot_renamed` — Bot display name changed
   * - `ack` — Acknowledgement for a WS request (includes ref)
   * - `error` — Error event (may include ref for correlation)
   * - `pong` — Pong response to ping
   * - `close` — WebSocket disconnected (includes code and reason)
   * - `session_invalidated` — Session expired/revoked/rotated (code 4002, no auto-reconnect)
   * - `reconnecting` / `reconnected` / `reconnect_failed` — Reconnect lifecycle
   * - `*` — Wildcard: receives all events
   */
  on(event: string, handler: EventHandler): void {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, new Set());
    }
    this.eventHandlers.get(event)!.add(handler);
  }

  /**
   * Remove an event handler.
   */
  off(event: string, handler: EventHandler): void {
    const handlers = this.eventHandlers.get(event);
    if (handlers) {
      handlers.delete(handler);
    }
  }

  /** @internal Emit an error to registered error handlers. */
  emitError(err: unknown): void {
    this.emit('error', err);
  }

  /** @internal Emit an event to registered handlers. Do not use from external code. */
  private emit(event: string, data: unknown): void {
    const handlers = this.eventHandlers.get(event);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(data);
        } catch (err) {
          // Don't let handler errors break the event loop, but surface them
          if (event !== 'error') {
            this.emit('error', err);
          }
        }
      }
    }
  }

  /**
   * Send a ping over the WebSocket. The server will respond with a `pong` event.
   */
  ping(): void {
    if (this.ws && this.ws.readyState === WS_OPEN) {
      this.ws.send(JSON.stringify({ type: 'ping' }));
    }
  }

  // ─── Static Auth Methods ─────────────────────────────────

  /**
   * Login to an HXA-Connect server and create a session.
   *
   * Supports three login types:
   * - `bot`: Authenticate as a bot owner using a bot token
   * - `org_admin`: Authenticate as an org administrator using org credentials
   * - `super_admin`: Authenticate as the super administrator
   *
   * Returns session info. The server also sets an HttpOnly session cookie.
   */
  static async login(
    url: string,
    credentials:
      | { type: 'bot'; token: string; owner_name?: string }
      | { type: 'org_admin'; org_id: string; org_secret: string }
      | { type: 'super_admin'; admin_secret: string },
  ): Promise<LoginResponse> {
    const baseUrl = url.replace(/\/+$/, '');

    const response = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(credentials),
    });

    if (!response.ok) {
      let respBody: unknown;
      try { respBody = await response.json(); } catch { respBody = await response.text().catch(() => null); }
      throw new ApiError(response.status, respBody);
    }

    return response.json() as Promise<LoginResponse>;
  }

  /**
   * Logout from an HXA-Connect server session.
   * Deletes the session and clears the session cookie.
   */
  static async logout(url: string): Promise<{ ok: boolean }> {
    const baseUrl = url.replace(/\/+$/, '');

    const response = await fetch(`${baseUrl}/api/auth/logout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });

    if (!response.ok) {
      let respBody: unknown;
      try { respBody = await response.json(); } catch { respBody = await response.text().catch(() => null); }
      throw new ApiError(response.status, respBody);
    }

    return response.json() as Promise<{ ok: boolean }>;
  }

  /**
   * Get the current session info from an HXA-Connect server.
   * Requires an active session cookie.
   */
  static async getSession(url: string): Promise<SessionInfo> {
    const baseUrl = url.replace(/\/+$/, '');

    const response = await fetch(`${baseUrl}/api/auth/session`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    });

    if (!response.ok) {
      let respBody: unknown;
      try { respBody = await response.json(); } catch { respBody = await response.text().catch(() => null); }
      throw new ApiError(response.status, respBody);
    }

    return response.json() as Promise<SessionInfo>;
  }

  /**
   * Register a new bot in an HXA-Connect org.
   * Supports two registration paths:
   * - **Ticket**: Use a registration ticket (member role)
   * - **Org secret**: Use the org secret directly (admin role)
   *
   * Returns bot info and a one-time token. Use the token to create an HxaConnectClient.
   */
  static async register(
    url: string,
    orgId: string,
    auth: { ticket: string } | { org_secret: string },
    name: string,
    opts?: {
      bio?: string;
      [key: string]: unknown;
    },
  ): Promise<RegisterResponse> {
    const baseUrl = url.replace(/\/+$/, '');
    const body: Record<string, unknown> = { org_id: orgId, ...auth, name, ...opts };

    const response = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      let respBody: unknown;
      try { respBody = await response.json(); } catch { respBody = await response.text().catch(() => null); }
      throw new ApiError(response.status, respBody);
    }

    return response.json() as Promise<RegisterResponse>;
  }

  // ─── Channels ────────────────────────────────────────────

  /**
   * List channels is not available via HTTP API.
   * Use `getChannel(id)` to get details of a known channel,
   * or listen for `channel_created` WebSocket events.
   * @deprecated No server endpoint exists for listing channels.
   */
  listChannels(): never {
    throw new Error('GET /api/channels is not available. Use getChannel(id) for a specific channel, or listen for channel_created WS events.');
  }

  /**
   * Get channel details including members.
   */
  getChannel(id: string): Promise<Channel & { members: { id: string; name: string | null; online: boolean | null }[] }> {
    return this.get(`/api/channels/${id}`);
  }

  /**
   * Get messages from a channel.
   *
   * When `before` is a number (timestamp), returns messages as a plain array (legacy mode).
   * When `before` is a string (message ID), uses cursor-based pagination and returns
   * `{ messages, has_more }`.
   */
  getMessages(
    channelId: string,
    opts: { limit?: number; before: string },
  ): Promise<{ messages: WireMessage[]; has_more: boolean }>;
  getMessages(
    channelId: string,
    opts?: { limit?: number; before?: number; since?: number },
  ): Promise<WireMessage[]>;
  getMessages(
    channelId: string,
    opts?: { limit?: number; before?: number | string; since?: number },
  ): Promise<WireMessage[] | { messages: WireMessage[]; has_more: boolean }> {
    const params = new URLSearchParams();
    if (opts?.limit !== undefined) params.set('limit', String(opts.limit));
    if (opts?.before !== undefined) params.set('before', String(opts.before));
    if (opts?.since !== undefined) params.set('since', String(opts.since));
    const qs = params.toString();
    return this.get(`/api/channels/${channelId}/messages${qs ? '?' + qs : ''}`);
  }

  // ─── Direct Messaging ────────────────────────────────────

  /**
   * Send a direct message to another bot by name or ID.
   * Automatically creates a direct channel if one doesn't exist.
   *
   * Either `content` or `opts.parts` (or both) must be provided.
   * If only parts are given, the server auto-generates content from parts.
   */
  send(
    to: string,
    content?: string,
    opts?: { parts?: MessagePart[]; content_type?: string },
  ): Promise<{ channel_id: string; message: WireMessage }> {
    const body: Record<string, unknown> = { to };
    if (content) body.content = content;
    if (opts?.content_type) body.content_type = opts.content_type;
    if (opts?.parts) body.parts = opts.parts;
    return this.post(`/api/send`, body);
  }

  // ─── Threads ─────────────────────────────────────────────

  /**
   * Create a new collaboration thread.
   */
  createThread(opts: {
    topic: string;
    tags?: string[];
    participants?: string[];
    context?: object | string;
    channel_id?: string;
    permission_policy?: ThreadPermissionPolicy;
  }): Promise<Thread> {
    return this.post<Thread>('/api/threads', {
      topic: opts.topic,
      tags: opts.tags,
      participants: opts.participants,
      channel_id: opts.channel_id,
      context: opts.context,
      permission_policy: opts.permission_policy,
    });
  }

  /**
   * Get thread details with participant info.
   */
  getThread(id: string): Promise<Thread & { participants: ThreadParticipant[] }> {
    return this.get(`/api/threads/${id}`);
  }

  /**
   * List threads the current bot participates in.
   * Optionally filter by status.
   */
  listThreads(opts?: { status?: ThreadStatus }): Promise<Thread[]> {
    const params = new URLSearchParams();
    if (opts?.status) params.set('status', opts.status);
    const qs = params.toString();
    return this.get<Thread[]>(`/api/threads${qs ? '?' + qs : ''}`);
  }

  /**
   * Update a thread's status, context, or topic.
   * Pass `revision` for optimistic concurrency control (sends If-Match header).
   */
  updateThread(
    id: string,
    updates: {
      status?: ThreadStatus;
      close_reason?: CloseReason;
      context?: object | string | null;
      topic?: string;
      permission_policy?: ThreadPermissionPolicy | null;
      revision?: number;
    },
  ): Promise<Thread> {
    const { revision, ...body } = updates;
    const headers: Record<string, string> | undefined =
      revision !== undefined ? { 'If-Match': `"${revision}"` } : undefined;
    return this.request<Thread>(`/api/threads/${id}`, { method: 'PATCH', body, headers });
  }

  // ─── Thread Messages ─────────────────────────────────────

  /**
   * Send a message within a thread.
   *
   * Either `content` or `opts.parts` (or both) must be provided.
   * If only parts are given, the server auto-generates content from parts.
   */
  sendThreadMessage(
    threadId: string,
    content?: string,
    opts?: { parts?: MessagePart[]; metadata?: object | string | null; content_type?: string; reply_to?: string },
  ): Promise<WireThreadMessage> {
    const body: Record<string, unknown> = {};
    if (content) body.content = content;
    if (opts?.content_type) body.content_type = opts.content_type;
    if (opts?.parts) body.parts = opts.parts;
    if (opts?.metadata !== undefined) body.metadata = opts.metadata;
    if (opts?.reply_to) body.reply_to = opts.reply_to;
    return this.post<WireThreadMessage>(`/api/threads/${threadId}/messages`, body);
  }

  /**
   * Get messages from a thread.
   * Returns messages in chronological order.
   */
  getThreadMessages(
    threadId: string,
    opts?: { limit?: number; before?: number; since?: number },
  ): Promise<WireThreadMessage[]> {
    const params = new URLSearchParams();
    if (opts?.limit !== undefined) params.set('limit', String(opts.limit));
    if (opts?.before !== undefined) params.set('before', String(opts.before));
    if (opts?.since !== undefined) params.set('since', String(opts.since));
    const qs = params.toString();
    return this.get<WireThreadMessage[]>(`/api/threads/${threadId}/messages${qs ? '?' + qs : ''}`);
  }

  // ─── Participants ────────────────────────────────────────

  /**
   * Invite a bot to join a thread.
   * @param threadId - The thread to invite to
   * @param botId - Bot ID or name to invite
   * @param label - Optional role label (e.g. "reviewer", "lead")
   */
  invite(threadId: string, botId: string, label?: string): Promise<ThreadParticipant> {
    return this.post<ThreadParticipant>(`/api/threads/${threadId}/participants`, {
      bot_id: botId,
      label,
    });
  }

  /**
   * Self-join a thread within the same org.
   * @param threadId - The thread to join
   */
  joinThread(threadId: string): Promise<JoinThreadResponse> {
    return this.post<JoinThreadResponse>(`/api/threads/${threadId}/join`, {});
  }

  /**
   * Leave a thread (remove self as participant).
   * @param threadId - The thread to leave
   */
  async leave(threadId: string): Promise<void> {
    if (!this.cachedBotId) {
      const me = await this.getProfile();
      this.cachedBotId = me.id;
    }
    await this.delete(`/api/threads/${threadId}/participants/${this.cachedBotId}`);
  }

  // ─── Artifacts ───────────────────────────────────────────

  /**
   * Add a new artifact to a thread.
   * Use a unique artifact_key for each distinct work product.
   */
  addArtifact(threadId: string, key: string, artifact: ArtifactInput): Promise<Artifact> {
    return this.post<Artifact>(`/api/threads/${threadId}/artifacts`, {
      artifact_key: key,
      type: artifact.type,
      title: artifact.title,
      content: artifact.content,
      language: artifact.language,
      url: artifact.url,
      mime_type: artifact.mime_type,
    });
  }

  /**
   * Update an existing artifact (creates a new version).
   */
  updateArtifact(
    threadId: string,
    key: string,
    updates: { content: string; title?: string | null },
  ): Promise<Artifact> {
    return this.patch<Artifact>(`/api/threads/${threadId}/artifacts/${encodeURIComponent(key)}`, updates);
  }

  /**
   * List the latest version of each artifact in a thread.
   */
  listArtifacts(threadId: string): Promise<Artifact[]> {
    return this.get<Artifact[]>(`/api/threads/${threadId}/artifacts`);
  }

  /**
   * Get all versions of a specific artifact.
   */
  getArtifactVersions(threadId: string, key: string): Promise<Artifact[]> {
    return this.get<Artifact[]>(`/api/threads/${threadId}/artifacts/${encodeURIComponent(key)}/versions`);
  }

  // ─── Files ───────────────────────────────────────────────

  /**
   * Upload a file to the HXA-Connect server.
   * Works in both Node.js (Buffer) and browser (Blob/File) environments.
   */
  async uploadFile(
    file: Buffer | Blob,
    name: string,
    mimeType?: string,
  ): Promise<FileRecord> {
    const url = `${this.baseUrl}/api/files/upload`;

    // Build multipart form data
    const formData = new FormData();

    if (typeof Blob !== 'undefined' && file instanceof Blob) {
      // Browser environment or Node 18+ with Blob
      formData.append('file', file, name);
    } else {
      // Node.js Buffer — wrap in Blob
      const blob = new Blob([file as Buffer], { type: mimeType || 'application/octet-stream' });
      formData.append('file', blob, name);
    }

    const uploadHeaders: Record<string, string> = {
      'Authorization': `Bearer ${this.token}`,
    };
    if (this.orgId) {
      uploadHeaders['X-Org-Id'] = this.orgId;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: uploadHeaders,
      body: formData,
      signal: AbortSignal.timeout(this.timeout),
    });

    if (!response.ok) {
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        body = await response.text().catch(() => null);
      }
      throw new ApiError(response.status, body);
    }

    return response.json() as Promise<FileRecord>;
  }

  /**
   * Get the download URL for a file by its ID.
   * Note: The URL requires authentication (Bearer token).
   */
  getFileUrl(fileId: string): string {
    return `${this.baseUrl}/api/files/${fileId}`;
  }

  // ─── Catchup (Offline Event Replay) ──────────────────────

  /**
   * Get events that occurred while this bot was offline.
   * Supports pagination via cursor.
   */
  catchup(opts: { since: number; cursor?: string; limit?: number }): Promise<CatchupResponse> {
    const params = new URLSearchParams();
    params.set('since', String(opts.since));
    if (opts?.cursor) params.set('cursor', opts.cursor);
    if (opts?.limit !== undefined) params.set('limit', String(opts.limit));
    const qs = params.toString();
    return this.get<CatchupResponse>(`/api/me/catchup${qs ? '?' + qs : ''}`);
  }

  /**
   * Get a count of missed events by type (lightweight check before full catchup).
   */
  catchupCount(opts: { since: number }): Promise<CatchupCountResponse> {
    const params = new URLSearchParams();
    params.set('since', String(opts.since));
    const qs = params.toString();
    return this.get<CatchupCountResponse>(`/api/me/catchup/count${qs ? '?' + qs : ''}`);
  }

  // ─── Profile ─────────────────────────────────────────────

  /**
   * Get the current bot's profile.
   */
  getProfile(): Promise<Agent> {
    return this.get<Agent>('/api/me');
  }

  /**
   * Update the current bot's profile fields.
   */
  updateProfile(fields: AgentProfileInput): Promise<Agent> {
    return this.patch<Agent>('/api/me/profile', fields);
  }

  /**
   * Rename the current bot.
   */
  rename(newName: string): Promise<Agent> {
    return this.patch<Agent>('/api/me/name', { name: newName });
  }

  /**
   * List other bots in the same organization.
   */
  listPeers(): Promise<Agent[]> {
    return this.get<Agent[]>('/api/peers');
  }

  // ─── Scoped Tokens ──────────────────────────────────────

  /**
   * Create a scoped token with limited permissions and optional expiry.
   * @param scopes - Array of permission scopes (e.g., ['read'], ['thread', 'message'])
   * @param opts.label - Human-readable label for this token
   * @param opts.expires_in - Token lifetime in milliseconds (omit for non-expiring)
   */
  createToken(
    scopes: TokenScope[],
    opts?: { label?: string; expires_in?: number },
  ): Promise<ScopedToken> {
    return this.post<ScopedToken>('/api/me/tokens', {
      scopes,
      label: opts?.label,
      expires_in: opts?.expires_in,
    });
  }

  /**
   * List all scoped tokens for the current bot.
   * Token values are not included — only metadata.
   */
  listTokens(): Promise<ScopedToken[]> {
    return this.get<ScopedToken[]>('/api/me/tokens');
  }

  /**
   * Revoke a scoped token by ID.
   */
  revokeToken(tokenId: string): Promise<{ ok: boolean }> {
    return this.delete<{ ok: boolean }>(`/api/me/tokens/${tokenId}`);
  }

  // ─── Inbox ───────────────────────────────────────────────

  /**
   * Get new messages across all channels since a timestamp.
   * @param since - Unix timestamp in milliseconds
   */
  inbox(since: number): Promise<WireMessage[]> {
    return this.get<WireMessage[]>(`/api/inbox?since=${since}`);
  }

  // ─── Org Admin ──────────────────────────────────────────

  /**
   * Create an org ticket for agent registration (admin only).
   */
  createOrgTicket(opts?: { reusable?: boolean; expires_in?: number }): Promise<OrgTicket> {
    return this.post<OrgTicket>('/api/org/tickets', opts);
  }

  /**
   * Rotate the org secret (admin only). Returns the new plaintext secret.
   */
  rotateOrgSecret(): Promise<{ org_secret: string }> {
    return this.post<{ org_secret: string }>('/api/org/rotate-secret');
  }

  /**
   * Change a bot's auth role (admin only).
   */
  setBotRole(botId: string, role: 'admin' | 'member'): Promise<{ bot_id: string; auth_role: string }> {
    return this.patch<{ bot_id: string; auth_role: string }>(`/api/org/bots/${botId}/role`, { auth_role: role });
  }

  /**
   * Get current org information.
   */
  getOrgInfo(): Promise<OrgInfo> {
    return this.get<OrgInfo>('/api/org');
  }
}
