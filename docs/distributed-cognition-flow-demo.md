# Distributed Cognition Flow Demo

Date: 17-05-26, 12:24

This demo proves the intended end-to-end path using synthetic data in a temporary sandbox. It did not touch the live WhatsApp session, the real Dropbox-backed second-brain folder, the real Mnemon database, or any real Codex project.

## Flow Demonstrated

1. A WhatsApp-style reflection was captured as an inbound note.
2. Distributed Cognition wrote the raw message to `inbox-whatsapp/`.
3. It wrote a processed reflection to `daily-reflections/`.
4. It promoted only the durable memory candidate into Mnemon.
5. It rejected a low-signal memory candidate.
6. It indexed a temporary Codex project into the Codex Workbench status.
7. It queued a handoff to `codex-local`.
8. The host-side Codex bridge executed the handoff with local Codex on this host.
9. Local Codex edited the temporary project and ran its test command.
10. The handoff moved from `queued/` to `completed/` and the handoff note was updated.

## Synthetic WhatsApp Input

```text
WhatsApp demo reflection: I keep losing good thinking after meetings. Important pivot: Distributed Cognition should store only durable keys, pivots, decisions, recurring themes, and open questions in Mnemon, while raw meeting clutter stays in Markdown. Please ask a local Codex agent to create a tiny demo note showing this flow.
```

## Raw Capture Result

Distributed Cognition created:

```text
inbox-whatsapp/17-05-26-1223-demo-whatsapp-reflection.md
```

The raw note preserved the original text and recorded:

```text
Source: whatsapp-text
Inferred message type: reflection
Captured at: 17-05-26, 12:23
```

## Processed Reflection Result

Distributed Cognition created:

```text
daily-reflections/17-05-26-1223-demo-whatsapp-reflection.md
```

The processed note extracted:

```text
New insight:
The system should distinguish raw capture from durable memory.

Decision made or leaning:
Use Mnemon for keys, pivots, decisions, recurring themes, and open questions, not every detail.

Long-term memory candidate:
Yes
```

## Mnemon Result

The durable memory candidate was stored in the sandbox Mnemon database:

```text
id: 44d841b1590703a2ba2b2f3672e294d1
layer: procedural
entity_type: rule
entity_name: Distributed Cognition memory promotion
importance: 0.93
confidence: 0.9
source_file: inbox-whatsapp/17-05-26-1223-demo-whatsapp-reflection.md
```

Stored memory:

```text
Distributed Cognition should promote only durable keys, pivots, decisions, recurring themes, and open questions into Mnemon; raw meeting clutter should remain in Markdown notes.
```

A deliberately low-signal test memory was rejected:

```text
Memory not stored: not enough durable-memory signal; keep this in Markdown unless a concise stable fact, decision, preference, correction, or project constraint is extracted
```

This is the intended behaviour: Mnemon gets the keys and pivots, not every stray detail.

## Codex Workbench Result

Distributed Cognition indexed one temporary project and wrote:

```text
project-wikis/codex-workbench.md
.dc-index/codex-status.json
```

## Codex Handoff Result

Distributed Cognition queued this local handoff:

```text
id: codex-170526-1223-242b3c4b
project: Demo Project
target: codex-local
note: pending-review/17-05-26-1223-codex-handoff-demo-project.md
queue: .dc-index/codex-handoffs/queued/codex-170526-1223-242b3c4b.json
```

Task:

```text
Create docs/demo-agent-note.md with a short public-safe note explaining that this temporary project received a local Codex handoff from Distributed Cognition. Keep it under 120 words.
```

The host-side Codex bridge first validated the queue in dry-run mode, then executed it locally with Codex. After execution, the handoff was moved to:

```text
.dc-index/codex-handoffs/completed/codex-170526-1223-242b3c4b.json
```

The handoff note was updated:

```text
Status: completed
Completed at: 17-05-26, 12:24
Executor: local Codex on this host
```

## Local Codex Result

Local Codex created this file in the temporary project:

```text
docs/demo-agent-note.md
```

Codex reported:

```text
Created docs/demo-agent-note.md with a 50-word public-safe note.

Verification:
- wc -w docs/demo-agent-note.md -> 50 words, under 120.
- npm test -> passed (demo tests ok).
```

## What This Proves

The working path is:

```text
personal WhatsApp message
  -> Distributed Cognition capture
  -> raw Markdown note
  -> processed reflection
  -> Mnemon durable-memory filter
  -> Codex Workbench project status
  -> codex-local handoff queue
  -> host-side Codex bridge
  -> local Codex edits a project
  -> completed handoff record
```

The important boundary is that WhatsApp and Docker do the listening, capture, sorting, and queueing. Local Codex on the Mac does the deeper execution work only after a handoff is created for an allowlisted local project.

## Safety Notes

- The demo used synthetic content.
- The demo used a temporary second-brain root.
- The demo used a temporary Mnemon database.
- The demo used a temporary Codex project.
- No live WhatsApp messages were sent.
- No real Dropbox files were modified.
- No real Codex project was modified.
- No secrets, phone numbers, patient data, learner data, HR material, or exam material were included.
