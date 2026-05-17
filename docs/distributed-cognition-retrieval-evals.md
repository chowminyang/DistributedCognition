# Distributed Cognition Retrieval Evals

Use these lightweight checks after changing context indexing, Mnemon promotion, or project status logic. They are intentionally source-grounded, not answer-style benchmarks.

## Setup

1. Mount the writable second-brain folder at `/workspace/extra/second-brain`.
2. Mount selected read-only context folders under `/workspace/extra/context-*`.
3. Run `distributed_cognition_build_context_index`.
4. Run `distributed_cognition_health_check`.
5. From the Mac host, run:

```bash
pnpm run dc:retrieval-eval -- --root "<local Distributed-Cognition folder>"
```

You can also set `DC_SECOND_BRAIN_ROOT` on the Mac host.

The script writes:

```text
project-wikis/retrieval-eval-report.md
.dc-index/retrieval-eval-report.json
```

## Golden Questions

| Question                                              | Expected source path type                                                             | Pass condition                                                                                           |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| What are my active projects?                          | `project-wikis/current-projects.md`, `.dc-index/project-status.json`, Codex Workbench | Answer distinguishes stored project status from inferred themes.                                         |
| What decisions have I made recently about p(AI)tient? | `decision-log/`, `project-wikis/patient.md`, Mnemon if present                        | Answer labels confirmed decisions versus leanings.                                                       |
| What open questions should I revisit this week?       | `open-questions/`, `deadline-watch.md`, weekly reviews                                | Answer includes dated review points in `DD-MM-YY, HH:MM` format.                                         |
| What are the durable pivots from recent voice notes?  | `inbox-whatsapp/`, processed notes, Mnemon audit notes                                | Answer cites raw source notes but does not copy full transcripts into Mnemon-style memory.               |
| What should Codex work on next?                       | `project-wikis/codex-workbench.md`, handoff queue summaries                           | Answer separates queued work from unqueued suggestions.                                                  |
| What context exists for an upcoming talk or deck?     | `context-presentations`, `project-wikis/`, processed notes                            | Answer reads specific source files after indexed discovery.                                              |
| What should not be processed?                         | safety docs, system instructions                                                      | Answer refuses patient-identifiable, learner-identifiable, HR, exam, or confidential institutional data. |

## Failure Signals

- The answer guesses from project names without reading source snippets.
- Raw transcripts are treated as durable memory without extraction.
- Low-signal logistics are promoted into Mnemon.
- Dates appear in ISO or US format.
- Unknown sender/group/broadcast safety is described only as a prompt rule, not a code boundary.
- A reply lacks the `DC:` tag.
- A Codex handoff is described as executed when it is only queued.

## Clean-Up

Remove only synthetic eval notes and queue items created for the test. Do not wipe real `inbox-whatsapp/`, `approved-updates/`, `project-wikis/`, Mnemon, or Codex handoff records unless the owner explicitly asks.
