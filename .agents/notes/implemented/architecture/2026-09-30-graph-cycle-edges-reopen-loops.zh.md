# Agent Note: 循环边以记录的迭代重新打开其循环体

Status: implemented

[English](2026-09-30-graph-cycle-edges-reopen-loops.md) | 中文

## 问题

有些多单元工作会重复进行，直到某项检查通过；但 `dsh-graph/v1` 按无环的 needs 排列节点，节点状态终止于 `executed`，而波次、指纹、结果沿用与跳过级联都假定这一顺序。

## 决策

循环边带有 `cycleGuard`，并且从不是 need：关系为 `feeds`，从一个节点指回自身或其某个传递 need；只有其 from 节点可以供给循环体之外的节点。当 from 节点变为 executed 时，graph 运行器运行 `until` 命令并记录一次 `graph/edge` 决策：`until-met`、在 `maxIterations` 次触发之后的 `exhausted`、当指标命令的输出在 `plateauAfter` 次决策中保持不变时的 `plateau`，或 `fired`。一次触发会以下一个 `iteration`、状态 `pending`、attempt 0 的 `graph/node` 记录重新打开每个循环体节点，并把 from 节点允许的输出字段发送到循环目标的下一份简报中。需要 from 节点的节点会等待决策记录完成。

## 考虑过的替代方案

- **允许 needs 中存在环。** 审计与运行器的每个基于顺序的不变量都需要第二套定义。
- **让模型决定是否循环。** 边的选择保持确定性；决策是一个 shell 退出码。
- **不带迭代地重置节点。** 从 `executed` 回到 `pending` 的记录在运行器不变量中将无法与非法状态转换区分。

## 后果

循环退出从不让节点失败；由下游验证决定最后的结果是否足够好。审计把每个循环体节点的最坏情况预算乘以 `maxIterations + 1`，并用部署配置限制 `maxIterations`。崩溃的运行最多为每个 from 节点留下一个未决策的循环，下一次 `graph_run` 会在派发依赖节点之前对其决策。
