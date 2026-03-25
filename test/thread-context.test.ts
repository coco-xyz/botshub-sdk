import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  ThreadContext,
  formatThreadLifecycleEvent,
  type ThreadLifecycleEvent,
} from '../src/index.js';

class FakeClient {
  private handlers = new Map<string, Set<(event: any) => void>>();
  private readonly thread: any;

  constructor(thread: any) {
    this.thread = thread;
  }

  async getProfile() {
    return { id: 'bot-1', name: 'mybot' };
  }

  async getThread(threadId: string) {
    return { ...this.thread, id: threadId };
  }

  on(event: string, handler: (event: any) => void) {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(handler);
  }

  off(event: string, handler: (event: any) => void) {
    this.handlers.get(event)?.delete(handler);
  }

  emit(event: string, payload: any) {
    for (const handler of this.handlers.get(event) ?? []) handler(payload);
  }

  emitError(err: unknown) {
    throw err;
  }
}

function makeThread(overrides: Record<string, unknown> = {}) {
  return {
    id: 'thread-1',
    org_id: 'org-1',
    topic: 'Test Thread',
    tags: ['collab'],
    status: 'active',
    initiator_id: 'bot-1',
    channel_id: null,
    context: null,
    close_reason: null,
    permission_policy: null,
    revision: 1,
    created_at: 1000,
    updated_at: 1000,
    last_activity_at: 1000,
    resolved_at: null,
    participants: [{
      thread_id: 'thread-1',
      bot_id: 'bot-1',
      name: 'mybot',
      label: null,
      joined_at: 1000,
    }],
    ...overrides,
  };
}

function makeMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: 'msg-1',
    thread_id: 'thread-1',
    sender_id: 'other-bot',
    sender_name: 'other-bot',
    content: overrides.content ?? 'hello @mybot',
    content_type: 'text',
    parts: [{ type: 'text', content: overrides.content ?? 'hello @mybot' }],
    mentions: [],
    mention_all: false,
    metadata: null,
    created_at: 2000,
    ...overrides,
  };
}

function nextTick() {
  return new Promise(resolve => setTimeout(resolve, 0));
}

describe('ThreadContext lifecycle buffering', () => {
  it('preserves invite delivery while exposing thread_created as lifecycle context', async () => {
    const client = new FakeClient(makeThread());
    const ctx = new ThreadContext(client as any, { botNames: ['mybot'] });
    const seen: any[] = [];
    ctx.onMention((trigger) => { seen.push(trigger); });

    await ctx.start();
    client.emit('thread_created', {
      type: 'thread_created',
      thread: makeThread(),
    });
    await nextTick();

    assert.equal(seen.length, 1);
    assert.equal(seen[0].reason, 'invite');
    assert.equal(seen[0].snapshot.newMessages.length, 0);
    assert.deepEqual(seen[0].snapshot.lifecycleEvents.map((e: ThreadLifecycleEvent) => e.type), ['thread_created']);
    assert.equal(
      formatThreadLifecycleEvent(seen[0].snapshot.lifecycleEvents[0]),
      'Thread created: "Test Thread" (tags: collab)',
    );
  });

  it('buffers thread lifecycle events silently until the next thread message delivery', async () => {
    const client = new FakeClient(makeThread());
    const ctx = new ThreadContext(client as any, {
      botNames: ['mybot'],
      lifecycle: { maxBufferSize: 10 },
    });
    const seen: any[] = [];
    ctx.onMention((trigger) => { seen.push(trigger); });

    await ctx.start();

    client.emit('thread_updated', {
      type: 'thread_updated',
      thread: makeThread({ topic: 'Updated Topic', updated_at: 1100 }),
      changes: ['topic'],
    });
    client.emit('thread_updated', {
      type: 'thread_updated',
      thread: makeThread({ topic: 'Updated Topic', context: 'ctx', updated_at: 1200 }),
      changes: ['context'],
    });
    client.emit('thread_status_changed', {
      type: 'thread_status_changed',
      thread_id: 'thread-1',
      topic: 'Updated Topic',
      from: 'active',
      to: 'reviewing',
      by: 'bot-2',
    });
    client.emit('thread_artifact', {
      type: 'thread_artifact',
      thread_id: 'thread-1',
      action: 'added',
      artifact: { artifact_key: 'spec', title: 'Spec', type: 'markdown', version: 1 },
    });
    client.emit('thread_artifact', {
      type: 'thread_artifact',
      thread_id: 'thread-1',
      action: 'updated',
      artifact: { artifact_key: 'spec', title: 'Spec v2', type: 'markdown', version: 2 },
    });
    client.emit('thread_participant', {
      type: 'thread_participant',
      thread_id: 'thread-1',
      bot_id: 'bot-3',
      bot_name: 'helper',
      action: 'joined',
      by: 'org:org-1',
      label: 'reviewer',
    });
    client.emit('thread_participant', {
      type: 'thread_participant',
      thread_id: 'thread-1',
      bot_id: 'bot-3',
      bot_name: 'helper',
      action: 'left',
      by: 'org:org-1',
      label: 'reviewer',
    });

    client.emit('thread_message', {
      type: 'thread_message',
      thread_id: 'thread-1',
      message: makeMessage(),
    });
    await nextTick();

    assert.equal(seen.length, 1);
    assert.equal(seen[0].reason, 'message');
    assert.deepEqual(
      seen[0].snapshot.lifecycleEvents.map((e: ThreadLifecycleEvent) => e.type),
      ['thread_updated', 'thread_status_changed', 'thread_participant', 'thread_artifact'],
    );
    assert.equal(seen[0].snapshot.lifecycleEvents[0].changes.join(','), 'topic,context');
    assert.equal(seen[0].snapshot.lifecycleEvents[2].action, 'left');
    assert.equal(seen[0].snapshot.lifecycleEvents[3].action, 'updated');
    assert.equal(ctx.getLifecycleBufferSize('thread-1'), 0);
  });

  it('supports lifecycle-only flush and marks those threads as active', async () => {
    const client = new FakeClient(makeThread());
    const ctx = new ThreadContext(client as any, { botNames: ['mybot'] });
    const seen: any[] = [];
    ctx.onMention((trigger) => { seen.push(trigger); });

    await ctx.start();
    client.emit('thread_participant', {
      type: 'thread_participant',
      thread_id: 'thread-1',
      bot_id: 'bot-9',
      bot_name: 'observer',
      action: 'joined',
      by: 'bot-2',
      label: null,
    });

    assert.deepEqual(ctx.getActiveThreads(), ['thread-1']);
    assert.match(ctx.toPromptContext('thread-1', 'summary'), /1 lifecycle event\(s\) buffered/);

    await ctx.flush('thread-1');

    assert.equal(seen.length, 1);
    assert.equal(seen[0].reason, 'flush');
    assert.equal(seen[0].snapshot.newMessages.length, 0);
    assert.equal(seen[0].snapshot.lifecycleEvents.length, 1);
    assert.deepEqual(ctx.getActiveThreads(), []);
  });

  it('buffers thread_created instead of delivering when triggerOnInvite is disabled', async () => {
    const client = new FakeClient(makeThread());
    const ctx = new ThreadContext(client as any, {
      botNames: ['mybot'],
      triggerOnInvite: false,
    });
    const seen: any[] = [];
    ctx.onMention((trigger) => { seen.push(trigger); });

    await ctx.start();
    client.emit('thread_created', {
      type: 'thread_created',
      thread: makeThread({ topic: 'Quiet Invite' }),
    });
    await nextTick();

    assert.equal(seen.length, 0);
    assert.equal(ctx.getLifecycleBufferSize('thread-1'), 1);

    await ctx.flush('thread-1');
    assert.equal(seen.length, 1);
    assert.equal(seen[0].reason, 'flush');
    assert.equal(seen[0].snapshot.lifecycleEvents[0].thread.topic, 'Quiet Invite');
  });

  it('does not advance message delta watermark on lifecycle-only delivery', async () => {
    const client = new FakeClient(makeThread());
    const ctx = new ThreadContext(client as any, { botNames: ['mybot'] });
    ctx.onMention(() => {});

    await ctx.start();
    client.emit('thread_participant', {
      type: 'thread_participant',
      thread_id: 'thread-1',
      bot_id: 'bot-7',
      bot_name: 'reviewer',
      action: 'joined',
      by: 'bot-2',
      label: null,
    });

    await ctx.flush('thread-1');

    client.emit('thread_message', {
      type: 'thread_message',
      thread_id: 'thread-1',
      message: makeMessage({ id: 'msg-2', content: 'plain message without mention', created_at: 1500 }),
    });

    assert.match(ctx.toPromptContext('thread-1', 'delta'), /plain message without mention/);
  });
});
