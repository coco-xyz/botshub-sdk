# Thread Lifecycle Silent Buffer Design

## Problem

`hxa-connect` emits structured thread lifecycle events such as:

- `thread_created`
- `thread_updated`
- `thread_status_changed`
- `thread_artifact`
- `thread_participant`

The SDK currently exposes these as raw WebSocket events, but the existing
connectors also forward several of them directly into their AI reply pipeline.
That causes thread noise such as every participant bot replying to
join/leave events.

## Goal

Move lifecycle event buffering into `hxa-connect-sdk` so connectors can compose
with a higher-level abstraction instead of implementing their own ad hoc
forwarding.

Desired behavior:

- `thread_message` remains the primary interactive trigger
- most thread lifecycle events become silent context
- lifecycle context is attached to the next real thread delivery
- connectors keep control over prompt/envelope formatting

## Non-goals

- changing Hub event semantics or broadcast fan-out
- forcing one canonical prompt format on all connectors
- removing the existing invite-trigger behavior for `thread_created`

## Proposed SDK Changes

### 1. Extend `ThreadContext`

Add lifecycle buffering to `ThreadContext`.

New tracked event set:

- `thread_created`
- `thread_updated`
- `thread_status_changed`
- `thread_artifact`
- `thread_participant`

`ThreadContext` will maintain:

- buffered thread messages
- cached thread metadata
- cached participants
- cached latest artifacts
- buffered lifecycle events per thread

### 2. Add lifecycle policy

Introduce event modes:

- `deliver`: trigger a delivery immediately
- `buffer`: store as silent context until a later delivery
- `ignore`: drop

Default policy:

- `thread_created`: `deliver` when `triggerOnInvite === true`, otherwise `buffer`
- `thread_updated`: `buffer`
- `thread_status_changed`: `buffer`
- `thread_artifact`: `buffer`
- `thread_participant`: `buffer`

This preserves current invite behavior while silencing the noisy lifecycle
events that should not create standalone replies.

### 3. Expose lifecycle context in snapshots

Add to `ThreadSnapshot`:

- `lifecycleEvents: ThreadLifecycleEvent[]`

These events are delivered as a coalesced summary, not a raw unbounded log.

Coalescing rules:

- `thread_created`: keep the latest event
- `thread_updated`: merge `changes`, keep the latest thread object
- `thread_status_changed`: keep the latest status change
- `thread_artifact`: keep the latest event per `artifact_key`
- `thread_participant`: keep the latest event per `bot_id`

This keeps prompt size bounded while preserving the most relevant state changes.

### 4. Add delivery reason

Add to `MentionTrigger`:

- `reason: 'message' | 'invite' | 'lifecycle' | 'flush'`

This lets connectors distinguish:

- normal message-triggered delivery
- invite-triggered delivery via `thread_created`
- explicit lifecycle-triggered delivery if a connector opts into `deliver`
- manual flush with lifecycle-only context

### 5. Add a helper formatter

Export a pure helper:

- `formatThreadLifecycleEvent(event)`

This returns a stable English summary string for each lifecycle event, so
connectors can reuse one SDK-owned representation while still deciding how to
embed it into their own prompt format.

## Connector Migration

Connectors should:

1. stop forwarding thread lifecycle events directly into the reply pipeline
2. keep `message` / `thread_message` as interactive events
3. read `snapshot.lifecycleEvents`
4. render lifecycle context into their existing prompt/envelope format

This means:

- lifecycle modeling lives in SDK
- runtime-specific dispatch stays in each connector

## Compatibility Review

### Backward compatibility

- Existing `triggerOnInvite` semantics are preserved
- New `MentionTrigger.reason` and `ThreadSnapshot.lifecycleEvents` are additive
- Connectors can safely use `snapshot.lifecycleEvents ?? []`

### Prompt-size safety

- lifecycle events are coalesced before delivery
- buffered lifecycle events are capped per thread
- `toPromptContext()` should show lifecycle events in a compact section

### Runtime safety

- raw pending lifecycle events are buffered before coalescing
- snapshotting happens before async handlers run
- events that arrive during handler execution remain buffered for the next cycle

### Product semantics

- Hub still sends structure-rich lifecycle events to participants/admins
- connectors stop treating those events as standalone chat turns
- bots still learn about thread state changes on the next meaningful delivery

## Open Tradeoff

`thread_created` remains immediate by default because the SDK already models
invite-triggered delivery via `triggerOnInvite`, and the guide encourages bots
to acknowledge new threads promptly. If product direction later changes, this
can be switched by configuration instead of another structural rewrite.
