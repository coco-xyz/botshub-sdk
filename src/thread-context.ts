import type { HxaConnectClient } from './client.js';
import type {
  Thread,
  ThreadParticipant,
  WireThreadMessage,
  Artifact,
  WsServerEvent,
  ThreadStatus,
} from './types.js';

// ─── Helpers ─────────────────────────────────────────────────

/** Parse metadata — handles both parsed object (current) and string (legacy) forms. */
function parseMeta(metadata: Record<string, unknown> | string | null | undefined): Record<string, unknown> | null {
  if (!metadata) return null;
  if (typeof metadata === 'string') {
    try { return JSON.parse(metadata); } catch { return null; }
  }
  return metadata;
}

/**
 * Build a display-friendly sender name.
 * For human-authored messages (Web UI), shows "owner_name (via bot_name)".
 */
function displaySender(msg: WireThreadMessage): string {
  const botName = msg.sender_name ?? msg.sender_id ?? 'system';
  const meta = parseMeta(msg.metadata);
  const prov = meta?.provenance as Record<string, unknown> | undefined;
  if (prov?.authored_by === 'human' && prov.owner_name) {
    return `${prov.owner_name} (via ${botName})`;
  }
  return botName;
}

function lifecycleThreadId(event: ThreadLifecycleEvent): string {
  return event.type === 'thread_created' || event.type === 'thread_updated'
    ? event.thread.id
    : event.thread_id;
}

function appendBounded<T>(items: T[], item: T, maxSize: number): T[] {
  const next = [...items, item];
  if (next.length > maxSize) {
    next.splice(0, next.length - maxSize);
  }
  return next;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

// ─── Types ──────────────────────────────────────────────────

export type ThreadLifecycleEventType =
  | 'thread_created'
  | 'thread_updated'
  | 'thread_status_changed'
  | 'thread_artifact'
  | 'thread_participant';

export type ThreadLifecycleEvent = Extract<WsServerEvent, { type: ThreadLifecycleEventType }>;
export type ThreadLifecycleEventMode = 'deliver' | 'buffer' | 'ignore';

export interface ThreadLifecycleOptions {
  /** Max raw lifecycle events buffered per thread before oldest are dropped (default: 25). */
  maxBufferSize?: number;
  /** Per-event mode override. */
  modes?: Partial<Record<ThreadLifecycleEventType, ThreadLifecycleEventMode>>;
}

export interface ThreadSnapshot {
  thread: Thread;
  participants: ThreadParticipant[];
  /** Messages since last delivery (or all if first delivery) */
  newMessages: WireThreadMessage[];
  /** Total buffered message count (before this delivery) */
  bufferedCount: number;
  /** Latest artifacts (one per key) */
  artifacts: Artifact[];
  /** Coalesced lifecycle events pending for this delivery. */
  lifecycleEvents: ThreadLifecycleEvent[];
}

export interface MentionTrigger {
  threadId: string;
  message: WireThreadMessage;
  snapshot: ThreadSnapshot;
  /** Why delivery happened. */
  reason: 'message' | 'invite' | 'lifecycle' | 'flush';
}

export interface ThreadContextOptions {
  /** Bot name(s) that trigger @mention delivery (e.g. ["mybot", "my-bot"]) */
  botNames: string[];
  /** Bot ID (auto-detected from profile if not provided) */
  botId?: string;
  /** Additional patterns that trigger delivery (regex) */
  triggerPatterns?: RegExp[];
  /** Max messages to buffer per thread before auto-delivering (default: 50) */
  maxBufferSize?: number;
  /** Also trigger on thread_created events where this bot is a participant */
  triggerOnInvite?: boolean;
  /** Lifecycle event buffering policy. */
  lifecycle?: ThreadLifecycleOptions;
}

type MentionHandler = (trigger: MentionTrigger) => void | Promise<void>;

export function formatThreadLifecycleEvent(event: ThreadLifecycleEvent): string {
  switch (event.type) {
    case 'thread_created': {
      const topic = event.thread.topic || 'untitled';
      const tags = event.thread.tags?.length ? ` (tags: ${event.thread.tags.join(', ')})` : '';
      return `Thread created: "${topic}"${tags}`;
    }
    case 'thread_updated': {
      const topic = event.thread.topic || 'untitled';
      const changes = event.changes.length ? event.changes.join(', ') : 'unknown fields';
      return `Thread updated: "${topic}" (${changes})`;
    }
    case 'thread_status_changed': {
      const by = event.by ? ` by ${event.by}` : '';
      return `Thread status changed: "${event.topic}" ${event.from} -> ${event.to}${by}`;
    }
    case 'thread_artifact': {
      const artifact = event.artifact;
      const title = artifact.title || artifact.artifact_key;
      return `Artifact ${event.action}: "${title}" (type: ${artifact.type})`;
    }
    case 'thread_participant': {
      const name = event.bot_name || event.bot_id;
      const label = event.label ? ` [${event.label}]` : '';
      const by = event.by ? ` by ${event.by}` : '';
      return `${name}${label} ${event.action} the thread${by}`;
    }
  }
}

function coalesceLifecycleEvents(events: ThreadLifecycleEvent[]): ThreadLifecycleEvent[] {
  let created: Extract<ThreadLifecycleEvent, { type: 'thread_created' }> | undefined;
  let updated: Extract<ThreadLifecycleEvent, { type: 'thread_updated' }> | undefined;
  let statusChanged: Extract<ThreadLifecycleEvent, { type: 'thread_status_changed' }> | undefined;
  const artifactEvents = new Map<string, Extract<ThreadLifecycleEvent, { type: 'thread_artifact' }>>();
  const participantEvents = new Map<string, Extract<ThreadLifecycleEvent, { type: 'thread_participant' }>>();

  for (const event of events) {
    switch (event.type) {
      case 'thread_created':
        created = event;
        break;
      case 'thread_updated':
        updated = updated
          ? { ...event, changes: uniqueStrings([...updated.changes, ...event.changes]) }
          : event;
        break;
      case 'thread_status_changed':
        statusChanged = event;
        break;
      case 'thread_artifact':
        artifactEvents.set(event.artifact.artifact_key, event);
        break;
      case 'thread_participant':
        participantEvents.set(event.bot_id, event);
        break;
    }
  }

  const result: ThreadLifecycleEvent[] = [];
  if (created) result.push(created);
  if (updated) result.push(updated);
  if (statusChanged) result.push(statusChanged);
  result.push(...participantEvents.values());
  result.push(...artifactEvents.values());
  return result;
}

// ─── ThreadContext ──────────────────────────────────────────

/**
 * E12: Buffered context delivery with @mention triggering.
 *
 * Buffers incoming thread messages and delivers them as a batch
 * when the bot is @mentioned, reducing noise and providing full
 * context for LLM processing.
 *
 * Lifecycle events can also be buffered as silent context. By default:
 * - `thread_created` delivers immediately when `triggerOnInvite` is enabled
 * - other thread lifecycle events are buffered and attached to the next delivery
 *
 * Usage:
 * ```ts
 * const ctx = new ThreadContext(client, { botNames: ['mybot'] });
 * ctx.onMention(async ({ threadId, snapshot }) => {
 *   const prompt = ctx.toPromptContext(threadId);
 *   // Feed to LLM, then reply
 *   await client.sendThreadMessage(threadId, response);
 * });
 * ctx.start();
 * ```
 */
export class ThreadContext {
  private client: HxaConnectClient;
  private opts: Required<Omit<ThreadContextOptions, 'triggerPatterns' | 'botId' | 'lifecycle'>> & {
    triggerPatterns: RegExp[];
    botId: string | null;
    lifecycle: {
      maxBufferSize: number;
      modes: Record<ThreadLifecycleEventType, ThreadLifecycleEventMode>;
    };
  };
  private buffers: Map<string, WireThreadMessage[]> = new Map();
  private lifecycleBuffers: Map<string, ThreadLifecycleEvent[]> = new Map();
  private threadCache: Map<string, Thread> = new Map();
  private participantCache: Map<string, ThreadParticipant[]> = new Map();
  private artifactCache: Map<string, Artifact[]> = new Map();
  private deliveredUpTo: Map<string, number> = new Map(); // threadId → last delivered timestamp
  private deliveredIds: Map<string, Set<string>> = new Map(); // threadId → delivered message IDs at watermark
  private handlers: MentionHandler[] = [];
  private started = false;
  private listenerRemovers: (() => void)[] = [];

  constructor(client: HxaConnectClient, opts: ThreadContextOptions) {
    this.client = client;

    const mentionPatterns = opts.botNames.map(
      name => new RegExp(`@${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i')
    );

    const lifecycleModes: Record<ThreadLifecycleEventType, ThreadLifecycleEventMode> = {
      thread_created: opts.triggerOnInvite === false ? 'buffer' : 'deliver',
      thread_updated: 'buffer',
      thread_status_changed: 'buffer',
      thread_artifact: 'buffer',
      thread_participant: 'buffer',
      ...(opts.lifecycle?.modes ?? {}),
    };

    this.opts = {
      botNames: opts.botNames,
      botId: opts.botId ?? null,
      triggerPatterns: [...mentionPatterns, ...(opts.triggerPatterns ?? [])],
      maxBufferSize: opts.maxBufferSize ?? 50,
      triggerOnInvite: opts.triggerOnInvite ?? true,
      lifecycle: {
        maxBufferSize: opts.lifecycle?.maxBufferSize ?? 25,
        modes: lifecycleModes,
      },
    };
  }

  /**
   * Register a handler called when the bot is @mentioned in a thread.
   * The handler receives the triggering message and a snapshot of the thread context.
   */
  onMention(handler: MentionHandler): void {
    this.handlers.push(handler);
  }

  /**
   * Start listening for thread events via WebSocket.
   * Auto-detects bot ID from profile if not provided.
   */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    if (!this.opts.botId) {
      try {
        const profile = await this.client.getProfile();
        this.opts.botId = profile.id;
      } catch (err) {
        this.started = false;
        throw err;
      }
    }

    const onThreadMessage = (event: WsServerEvent) => {
      if (event.type !== 'thread_message') return;
      this.handleThreadMessage(event.thread_id, event.message);
    };

    const onThreadCreated = (event: WsServerEvent) => {
      if (event.type !== 'thread_created') return;
      this.handleLifecycleEvent(event);
    };

    const onThreadUpdated = (event: WsServerEvent) => {
      if (event.type !== 'thread_updated') return;
      this.handleLifecycleEvent(event);
    };

    const onThreadArtifact = (event: WsServerEvent) => {
      if (event.type !== 'thread_artifact') return;
      this.handleLifecycleEvent(event);
    };

    const onThreadStatusChanged = (event: WsServerEvent) => {
      if (event.type !== 'thread_status_changed') return;
      this.handleLifecycleEvent(event);
    };

    const onThreadParticipant = (event: WsServerEvent) => {
      if (event.type !== 'thread_participant') return;
      this.handleLifecycleEvent(event);
    };

    this.client.on('thread_message', onThreadMessage);
    this.client.on('thread_created', onThreadCreated);
    this.client.on('thread_updated', onThreadUpdated);
    this.client.on('thread_artifact', onThreadArtifact);
    this.client.on('thread_status_changed', onThreadStatusChanged);
    this.client.on('thread_participant', onThreadParticipant);

    this.listenerRemovers = [
      () => this.client.off('thread_message', onThreadMessage),
      () => this.client.off('thread_created', onThreadCreated),
      () => this.client.off('thread_updated', onThreadUpdated),
      () => this.client.off('thread_artifact', onThreadArtifact),
      () => this.client.off('thread_status_changed', onThreadStatusChanged),
      () => this.client.off('thread_participant', onThreadParticipant),
    ];
  }

  /**
   * Stop listening (removes internal handlers). Buffers are preserved.
   */
  stop(): void {
    this.started = false;
    for (const remove of this.listenerRemovers) remove();
    this.listenerRemovers = [];
  }

  private handleThreadMessage(threadId: string, message: WireThreadMessage): void {
    if (!this.started) return;

    if (message.sender_id === this.opts.botId) {
      const meta = parseMeta(message.metadata);
      const prov = meta?.provenance as Record<string, unknown> | undefined;
      if (!prov || prov.authored_by !== 'human') return;
    }

    const buffer = this.buffers.get(threadId) ?? [];
    buffer.push(message);

    if (buffer.length > this.opts.maxBufferSize) {
      buffer.splice(0, buffer.length - this.opts.maxBufferSize);
    }
    this.buffers.set(threadId, buffer);

    if (this.isMention(message)) {
      void this.triggerDelivery(threadId, message, 'message');
    }
  }

  private handleLifecycleEvent(event: ThreadLifecycleEvent): void {
    if (!this.started) return;

    this.applyLifecycleCaches(event);

    const mode = this.opts.lifecycle.modes[event.type];
    if (mode === 'ignore') return;

    const threadId = lifecycleThreadId(event);
    const buffer = this.lifecycleBuffers.get(threadId) ?? [];
    this.lifecycleBuffers.set(threadId, appendBounded(buffer, event, this.opts.lifecycle.maxBufferSize));

    if (mode === 'deliver') {
      const reason = event.type === 'thread_created' ? 'invite' : 'lifecycle';
      void this.triggerDelivery(threadId, null, reason);
    }
  }

  private applyLifecycleCaches(event: ThreadLifecycleEvent): void {
    switch (event.type) {
      case 'thread_created':
      case 'thread_updated':
        this.threadCache.set(event.thread.id, event.thread);
        break;
      case 'thread_status_changed': {
        const prev = this.threadCache.get(event.thread_id);
        if (prev) {
          this.threadCache.set(event.thread_id, { ...prev, status: event.to, topic: event.topic });
        }
        break;
      }
      case 'thread_artifact': {
        const artifacts = [...(this.artifactCache.get(event.thread_id) ?? [])];
        const idx = artifacts.findIndex(a => a.artifact_key === event.artifact.artifact_key);
        if (idx >= 0) {
          artifacts[idx] = event.artifact;
        } else {
          artifacts.push(event.artifact);
        }
        this.artifactCache.set(event.thread_id, artifacts);
        break;
      }
      case 'thread_participant': {
        const participants = this.participantCache.get(event.thread_id);
        if (!participants) break;
        if (event.action === 'joined') {
          if (!participants.some(p => p.bot_id === event.bot_id)) {
            participants.push({
              thread_id: event.thread_id,
              bot_id: event.bot_id,
              name: event.bot_name,
              label: event.label ?? null,
              joined_at: Date.now(),
            });
          }
        } else {
          const idx = participants.findIndex(p => p.bot_id === event.bot_id);
          if (idx >= 0) participants.splice(idx, 1);
        }
        this.participantCache.set(event.thread_id, participants);
        break;
      }
    }
  }

  private isMention(message: WireThreadMessage): boolean {
    if (message.mention_all) return true;
    if (this.opts.botId && message.mentions?.some(m => m.bot_id === this.opts.botId)) return true;
    const textContent = this.extractText(message);
    return this.opts.triggerPatterns.some(pattern => {
      pattern.lastIndex = 0;
      return pattern.test(textContent);
    });
  }

  private extractText(message: WireThreadMessage): string {
    const parts: string[] = [message.content];
    if (message.parts) {
      for (const part of message.parts) {
        if ('content' in part && typeof part.content === 'string') {
          parts.push(part.content);
        }
      }
    }
    return parts.join(' ');
  }

  private async triggerDelivery(
    threadId: string,
    triggerMessage: WireThreadMessage | null,
    reason: MentionTrigger['reason'],
  ): Promise<void> {
    const buffer = this.buffers.get(threadId) ?? [];
    const bufferedCount = buffer.length;
    const snapshotMessages = buffer.slice(0, bufferedCount);

    const lifecycleBuffer = this.lifecycleBuffers.get(threadId) ?? [];
    const lifecycleCount = lifecycleBuffer.length;
    const snapshotLifecycleRaw = lifecycleBuffer.slice(0, lifecycleCount);
    const snapshotLifecycleEvents = coalesceLifecycleEvents(snapshotLifecycleRaw);

    let thread = this.threadCache.get(threadId);
    let participants = this.participantCache.get(threadId);
    if (!thread || !participants) {
      try {
        const full = await this.client.getThread(threadId);
        thread = full;
        participants = full.participants;
        this.threadCache.set(threadId, full);
        this.participantCache.set(threadId, full.participants);
      } catch {
        thread = thread ?? { id: threadId, topic: 'unknown' } as Thread;
        participants = participants ?? [];
      }
    }

    const artifacts = this.artifactCache.get(threadId) ?? [];

    const snapshot: ThreadSnapshot = {
      thread,
      participants,
      newMessages: snapshotMessages,
      bufferedCount,
      artifacts,
      lifecycleEvents: snapshotLifecycleEvents,
    };

    const trigger: MentionTrigger = {
      threadId,
      message: triggerMessage ?? snapshotMessages[snapshotMessages.length - 1] ?? {
        id: '',
        thread_id: threadId,
        sender_id: null,
        content: '',
        content_type: 'text',
        parts: [],
        metadata: null,
        created_at: Date.now(),
      },
      snapshot,
      reason,
    };

    for (const handler of this.handlers) {
      try {
        await handler(trigger);
      } catch (err) {
        this.client.emitError?.(err);
      }
    }

    const currentBuffer = this.buffers.get(threadId) ?? [];
    const newlyArrived = currentBuffer.slice(bufferedCount);
    this.buffers.set(threadId, newlyArrived);

    const currentLifecycleBuffer = this.lifecycleBuffers.get(threadId) ?? [];
    const newlyArrivedLifecycle = currentLifecycleBuffer.slice(lifecycleCount);
    this.lifecycleBuffers.set(threadId, newlyArrivedLifecycle);

    if (snapshotMessages.length > 0) {
      const lastMsg = snapshotMessages[snapshotMessages.length - 1];
      const watermark = lastMsg.created_at;
      this.deliveredUpTo.set(threadId, watermark);
      const idsAtWatermark = new Set<string>();
      for (const m of snapshotMessages) {
        if (m.created_at === watermark) idsAtWatermark.add(m.id);
      }
      this.deliveredIds.set(threadId, idsAtWatermark);
    }
  }

  /**
   * Get the current buffer size for a thread.
   */
  getBufferSize(threadId: string): number {
    return this.buffers.get(threadId)?.length ?? 0;
  }

  /**
   * Get the number of pending lifecycle events for a thread.
   */
  getLifecycleBufferSize(threadId: string): number {
    return this.lifecycleBuffers.get(threadId)?.length ?? 0;
  }

  /**
   * Get all thread IDs with buffered messages or lifecycle events.
   */
  getActiveThreads(): string[] {
    const ids = new Set<string>();
    for (const [id, buf] of this.buffers.entries()) {
      if (buf.length > 0) ids.add(id);
    }
    for (const [id, buf] of this.lifecycleBuffers.entries()) {
      if (buf.length > 0) ids.add(id);
    }
    return [...ids];
  }

  /**
   * Manually flush a thread's buffer (trigger delivery without @mention).
   */
  async flush(threadId: string): Promise<void> {
    const buffer = this.buffers.get(threadId) ?? [];
    const lifecycle = this.lifecycleBuffers.get(threadId) ?? [];
    if (buffer.length > 0 || lifecycle.length > 0) {
      await this.triggerDelivery(threadId, buffer[buffer.length - 1] ?? null, 'flush');
    }
  }

  // ─── E4: Prompt Context Generation ─────────────────────────

  /**
   * Generate LLM-ready prompt context for a thread.
   *
   * Modes:
   * - `summary`: Thread metadata + participant list + pending counts
   * - `full`: Summary + all buffered messages as conversation (default)
   * - `delta`: Only new messages since last delivery
   */
  toPromptContext(
    threadId: string,
    mode: 'summary' | 'full' | 'delta' = 'full',
  ): string {
    const thread = this.threadCache.get(threadId);
    const participants = this.participantCache.get(threadId) ?? [];
    const buffer = this.buffers.get(threadId) ?? [];
    const artifacts = this.artifactCache.get(threadId) ?? [];
    const lifecycleEvents = coalesceLifecycleEvents(this.lifecycleBuffers.get(threadId) ?? []);

    const lines: string[] = [];

    if (thread) {
      lines.push(`## Thread: ${thread.topic}`);
      lines.push(`Status: ${thread.status} | ID: ${thread.id}`);
      if (thread.tags?.length) lines.push(`Tags: ${thread.tags.join(', ')}`);
      if (thread.context) lines.push(`Context: ${typeof thread.context === 'string' ? thread.context : JSON.stringify(thread.context)}`);
    } else {
      lines.push(`## Thread: ${threadId}`);
    }

    if (participants.length > 0) {
      const names = participants.map(p => {
        const label = p.label ? ` (${p.label})` : '';
        return `${p.name ?? p.bot_id}${label}`;
      });
      lines.push(`Participants: ${names.join(', ')}`);
    }

    if (artifacts.length > 0) {
      lines.push('');
      lines.push('### Artifacts');
      for (const a of artifacts) {
        lines.push(`- **${a.artifact_key}** (${a.type}, v${a.version})${a.title ? ': ' + a.title : ''}`);
      }
    }

    if (lifecycleEvents.length > 0) {
      lines.push('');
      lines.push('### Lifecycle Events');
      for (const event of lifecycleEvents) {
        lines.push(`- ${formatThreadLifecycleEvent(event)}`);
      }
    }

    if (mode === 'summary') {
      lines.push('');
      lines.push(`[${buffer.length} new message(s), ${lifecycleEvents.length} lifecycle event(s) buffered]`);
      return lines.join('\n');
    }

    const messages = mode === 'delta'
      ? buffer.filter(m => {
          const watermark = this.deliveredUpTo.get(threadId) ?? 0;
          const ids = this.deliveredIds.get(threadId);
          if (m.created_at > watermark) return true;
          if (m.created_at === watermark && ids && !ids.has(m.id)) return true;
          return false;
        })
      : buffer;

    if (messages.length > 0) {
      lines.push('');
      lines.push(mode === 'delta' ? '### New Messages' : '### Messages');
      for (const msg of messages) {
        const sender = displaySender(msg);
        const time = new Date(msg.created_at).toISOString().slice(11, 19);
        lines.push(`[${time}] ${sender}: ${msg.content}`);
      }
    }

    return lines.join('\n');
  }

  /**
   * E4: Get a status transition guide for the current thread state.
   * Helps LLMs understand what status transitions are valid.
   */
  getStatusGuide(currentStatus: ThreadStatus): string {
    const guides: Record<string, string> = {
      active: 'Thread is active. You can:\n- Set to "blocked" if waiting for external input\n- Set to "reviewing" when deliverables are ready\n- Set to "resolved" if the goal is achieved\n- Set to "closed" to abandon',
      blocked: 'Thread is blocked. You can:\n- Set to "active" when the blocker is resolved',
      reviewing: 'Thread is in review. You can:\n- Set to "active" if changes are needed\n- Set to "resolved" if approved\n- Set to "closed" to abandon',
      resolved: 'Thread is resolved. Content changes are locked, but you can:\n- Set to "active" to reopen and continue work',
      closed: 'Thread is closed. Content changes are locked, but you can:\n- Set to "active" to reopen and continue work',
    };
    return guides[currentStatus] ?? `Unknown status: ${currentStatus}`;
  }
}
