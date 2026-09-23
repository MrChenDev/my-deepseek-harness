# Agent Note: Release unsettled tool calls at a closing step boundary

Status: implemented

English | [中文](2026-09-22-v4-closing-boundary-releases-unsettled-tool-calls.zh.md)

## Problem

A terminal tool-scheduler failure keeps the `tool/call` events already recorded in the step and records no results for them; the agent loop then closes the step and ends the turn with reason `error`. Native V4 relationship validation required every closing boundary to settle advertised or started calls, so the reader refused logs this checkout had written: a session that failed inside a tool could not be reopened, and a V3 predecessor recording the same events could not be migrated.

The Session invariant and the interrupted-turn closers already treat the step boundary as the end of settlement. `packages/core/session/src/invariant.ts` clears pending calls at `step/end`, and `openTurnClosers` leaves calls in closed steps unchanged, including their missing results.

## Decision

`step/end` and `turn/end` release the closing step's unsettled calls. The released call id is no longer advertised, so a later `tool/result` naming it is still refused; results without an advertisement, repeated advertisements, and starts whose name or arguments differ keep their existing refusals.

This replaces the closing-boundary settlement requirement of [mandatory native V4 relationship validation](../architecture/2026-09-17-native-v4-read-validation.md) for tool calls; that decision's other relationships are unchanged.

## Alternatives considered

**Refuse the log and synthesize repair results in the V3→V4 migration.** The current writer records the same event sequence natively, so a migration-only repair would leave current-format sessions unreadable, and the crash-recovery wording for a synthetic result belongs to `packages/core/session/src/repair.ts`.

**Synthesize results in the agent loop's failure path.** The scheduler contract preserves recorded `tool/call` events without fabricating results, and an invented outcome would become model-visible history.

**Keep the strict closing-boundary check.** It refuses logs the harness itself writes and contradicts the invariant and closer behavior for the same lifecycle.

## Consequences

A session whose step closed with unsettled calls restores, and its derived history keeps the recorded assistant tool call without a tool result. Crash recovery still closes an open tail turn with synthetic results; it does not repair calls in closed steps. A result that contradicts the log, such as one naming a call the step never advertised, remains a refusal.

## Testing

`packages/session/session-format-v3-to-v4/tests/relationships.spec.ts` covers native admission of the release and the refusal of a later result for the released id; `tests/interrupted-turn.spec.ts` covers the same recorded events through the restart migration.
