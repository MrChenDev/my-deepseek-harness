# Agent Note: 在关闭 step 边界释放未结算的工具调用

Status: implemented

[English](2026-09-22-v4-closing-boundary-releases-unsettled-tool-calls.md) | 中文

## Problem

终止性工具调度失败会保留 step 内已记录的 `tool/call` 事件且不为它们记录结果；agent loop 随后关闭该 step，并以 `error` 原因结束回合。原生 V4 关系校验要求每个关闭边界都结清已声明或已开始的调用，于是读取方拒绝本检出自己写入的日志：工具内失败的会话无法重新打开，记录同样事件的 V3 前身也无法迁移。

Session invariant 与 interrupted-turn closer 早已把 step 边界视为结算终点。`packages/core/session/src/invariant.ts` 在 `step/end` 清空待结算调用，`openTurnClosers` 对已关闭 step 中的调用保持原样，包括它们缺失的结果。

## Decision

`step/end` 与 `turn/end` 释放关闭 step 中未结算的调用。被释放的调用 id 不再处于已声明状态，因此之后命名它的 `tool/result` 仍被拒绝；没有声明的结果、重复声明，以及 name 或 arguments 不一致的 start 保持原有拒绝。

对工具调用而言，这取代 [原生 V4 关系强制校验](../architecture/2026-09-17-native-v4-read-validation.zh.md)中的关闭边界结算要求；该决策的其他关系不变。

## Alternatives considered

**拒绝该日志，并在 V3→V4 迁移中合成修复结果。** 当前写入方原生地记录同样的事件序列，只修迁移会留下无法读取的当前格式会话；合成结果的崩溃恢复措辞属于 `packages/core/session/src/repair.ts`。

**在 agent loop 的失败路径中合成结果。** 调度器契约保留已记录的 `tool/call` 事件而不合成结果；凭空得出的结果会成为模型可见历史。

**保留严格的关闭边界检查。** 它拒绝 harness 自己写入的日志，并与同一生命周期的 invariant 和 closer 行为矛盾。

## Consequences

step 以未结算调用关闭的会话可以恢复，其派生历史保留已记录的 assistant 工具调用而没有工具结果。崩溃恢复仍用合成结果关闭开放的尾部回合；它不修复已关闭 step 中的调用。与日志矛盾的结果，例如命名 step 从未声明的调用，仍被拒绝。

## Testing

`packages/session/session-format-v3-to-v4/tests/relationships.spec.ts` 覆盖原生接纳该释放以及拒绝被释放 id 的后续结果；`tests/interrupted-turn.spec.ts` 覆盖经重启迁移的同样记录事件。
