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

// ─── Types ──────────────────────────────────────────────────

export interface ThreadSnapshot {
  thread: Thread;
  participants: ThreadParticipant[];
  /** Messages since last delivery (or all if first delivery) */
  newMessages: WireThreadMessage[];
  /** Total buffered message count (before this delivery) */
  bufferedCount: number;
  /** Latest artifacts (one per key) */
  artifacts: Artifact[];
}

export interface MentionTrigger {
  threadId: string;
  message: WireThreadMessage;
  snapshot: ThreadSnapshot;
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
}

type MentionHandler = (trigger: MentionTrigger) => void | Promise<void>;

// ─── ThreadContext ──────────────────────────────────────────

/**
 * E12: Buffered context delivery with @mention triggering.
 *
 * Buffers incoming thread messages and delivers them as a batch
 * when the bot is @mentioned, reducing noise and providing full
 * context for LLM processing.
 *
 * Usage:
 * ```ts
 * const ctx = new ThreadContext(client, { botNames: ['mybot'] });
 * ctx.onMention(async ({ threadId, message, snapshot }) => {
 *   const prompt = ctx.toPromptContext(threadId);
 *   // Feed to LLM, then reply
 *   await client.sendThreadMessage(threadId, response);
 * });
 * ctx.start();
 * ```
 */
export class ThreadContext {
  private client: HxaConnectClient;
  private opts: Required<Omit<ThreadContextOptions, 'triggerPatterns' | 'botId'>> & {
    triggerPatterns: RegExp[];
    botId: string | null;
  };
  private buffers: Map<string, WireThreadMessage[]> = new Map();
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

    // Build @mention regex patterns from bot names
    const mentionPatterns = opts.botNames.map(
      name => new RegExp(`@${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i')
    );

    this.opts = {
      botNames: opts.botNames,
      botId: opts.botId ?? null,
      triggerPatterns: [...mentionPatterns, ...(opts.triggerPatterns ?? [])],
      maxBufferSize: opts.maxBufferSize ?? 50,
      triggerOnInvite: opts.triggerOnInvite ?? true,
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

    // Auto-detect bot ID
    if (!this.opts.botId) {
      try {
        const profile = await this.client.getProfile();
        this.opts.botId = profile.id;
      } catch (err) {
        this.started = false; // Allow retry
        throw err;
      }
    }

    // Track listeners so stop() can remove them
    const onThreadMessage = (event: WsServerEvent) => {
      if (event.type !== 'thread_message') return;
      this.handleThreadMessage(event.thread_id, event.message);
    };

    const onThreadCreated = (event: WsServerEvent) => {
      if (event.type !== 'thread_created') return;
      this.threadCache.set(event.thread.id, event.thread);
      if (this.opts.triggerOnInvite) {
        this.triggerDelivery(event.thread.id, null);
      }
    };

    const onThreadUpdated = (event: WsServerEvent) => {
      if (event.type !== 'thread_updated') return;
      this.threadCache.set(event.thread.id, event.thread);
    };

    const onThreadArtifact = (event: WsServerEvent) => {
      if (event.type !== 'thread_artifact') return;
      const artifacts = this.artifactCache.get(event.thread_id) ?? [];
      const idx = artifacts.findIndex(a => a.artifact_key === event.artifact.artifact_key);
      if (idx >= 0) {
        artifacts[idx] = event.artifact;
      } else {
        artifacts.push(event.artifact);
      }
      this.artifactCache.set(event.thread_id, artifacts);
    };

    this.client.on('thread_message', onThreadMessage);
    this.client.on('thread_created', onThreadCreated);
    this.client.on('thread_updated', onThreadUpdated);
    this.client.on('thread_artifact', onThreadArtifact);

    this.listenerRemovers = [
      () => this.client.off('thread_message', onThreadMessage),
      () => this.client.off('thread_created', onThreadCreated),
      () => this.client.off('thread_updated', onThreadUpdated),
      () => this.client.off('thread_artifact', onThreadArtifact),
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

    // Don't buffer our own messages — but allow human-authored messages
    // sent via Web UI (provenance.authored_by === 'human')
    if (message.sender_id === this.opts.botId) {
      const meta = parseMeta(message.metadata);
      const prov = meta?.provenance as Record<string, unknown> | undefined;
      if (!prov || prov.authored_by !== 'human') return;
    }

    // Buffer the message
    const buffer = this.buffers.get(threadId) ?? [];
    buffer.push(message);

    // Enforce max buffer size (drop oldest)
    if (buffer.length > this.opts.maxBufferSize) {
      buffer.splice(0, buffer.length - this.opts.maxBufferSize);
    }
    this.buffers.set(threadId, buffer);

    // Check if this message triggers delivery
    if (this.isMention(message)) {
      this.triggerDelivery(threadId, message);
    }
  }

  private isMention(message: WireThreadMessage): boolean {
    // Check text content of all parts
    const textContent = this.extractText(message);
    return this.opts.triggerPatterns.some(pattern => {
      pattern.lastIndex = 0; // Reset stateful regex (g/y flags)
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

  private async triggerDelivery(threadId: string, triggerMessage: WireThreadMessage | null): Promise<void> {
    const buffer = this.buffers.get(threadId) ?? [];
    const bufferedCount = buffer.length;

    // Snapshot messages NOW before any async work — prevents messages arriving
    // during await from being included in snapshot AND kept in buffer (duplicates).
    const snapshotMessages = buffer.slice(0, bufferedCount);

    // Build snapshot — fetch thread if not cached
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
        // If we can't fetch, use what we have
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
    };

    // If no trigger message (e.g. thread invite), create a synthetic one
    const trigger: MentionTrigger = {
      threadId,
      message: triggerMessage ?? snapshotMessages[snapshotMessages.length - 1] ?? { id: '', thread_id: threadId, sender_id: null, content: '', content_type: 'text', parts: [], metadata: null, created_at: Date.now() },
      snapshot,
    };

    // Call handlers BEFORE clearing buffer so toPromptContext() has data
    for (const handler of this.handlers) {
      try {
        await handler(trigger);
      } catch (err) {
        this.client.emitError?.(err);
      }
    }

    // Preserve messages that arrived during async handler execution.
    const currentBuffer = this.buffers.get(threadId) ?? [];
    const newlyArrived = currentBuffer.slice(bufferedCount);
    this.buffers.set(threadId, newlyArrived);

    // Use the last delivered message's created_at for delta watermark,
    // avoiding client/server clock skew issues with Date.now().
    const lastMsg = snapshotMessages[snapshotMessages.length - 1];
    const watermark = lastMsg?.created_at ?? Date.now();
    this.deliveredUpTo.set(threadId, watermark);
    // Track IDs at the watermark timestamp for dedup (same-timestamp messages)
    const idsAtWatermark = new Set<string>();
    for (const m of snapshotMessages) {
      if (m.created_at === watermark) idsAtWatermark.add(m.id);
    }
    this.deliveredIds.set(threadId, idsAtWatermark);
  }

  /**
   * Get the current buffer size for a thread.
   */
  getBufferSize(threadId: string): number {
    return this.buffers.get(threadId)?.length ?? 0;
  }

  /**
   * Get all thread IDs with buffered messages.
   */
  getActiveThreads(): string[] {
    return [...this.buffers.entries()]
      .filter(([, buf]) => buf.length > 0)
      .map(([id]) => id);
  }

  /**
   * Manually flush a thread's buffer (trigger delivery without @mention).
   */
  async flush(threadId: string): Promise<void> {
    const buffer = this.buffers.get(threadId) ?? [];
    if (buffer.length > 0) {
      await this.triggerDelivery(threadId, buffer[buffer.length - 1]);
    }
  }

  // ─── E4: Prompt Context Generation ─────────────────────────

  /**
   * Generate LLM-ready prompt context for a thread.
   *
   * Modes:
   * - `summary`: Thread metadata + participant list + message count (cheap)
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

    const lines: string[] = [];

    // Thread header
    if (thread) {
      lines.push(`## Thread: ${thread.topic}`);
      lines.push(`Status: ${thread.status} | ID: ${thread.id}`);
      if (thread.tags?.length) lines.push(`Tags: ${thread.tags.join(', ')}`);
      if (thread.context) lines.push(`Context: ${typeof thread.context === 'string' ? thread.context : JSON.stringify(thread.context)}`);
    } else {
      lines.push(`## Thread: ${threadId}`);
    }

    // Participants
    if (participants.length > 0) {
      const names = participants.map(p => {
        const label = p.label ? ` (${p.label})` : '';
        return `${p.name ?? p.bot_id}${label}`;
      });
      lines.push(`Participants: ${names.join(', ')}`);
    }

    // Artifacts summary
    if (artifacts.length > 0) {
      lines.push('');
      lines.push('### Artifacts');
      for (const a of artifacts) {
        lines.push(`- **${a.artifact_key}** (${a.type}, v${a.version})${a.title ? ': ' + a.title : ''}`);
      }
    }

    if (mode === 'summary') {
      lines.push('');
      lines.push(`[${buffer.length} new message(s) buffered]`);
      return lines.join('\n');
    }

    // Messages
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
