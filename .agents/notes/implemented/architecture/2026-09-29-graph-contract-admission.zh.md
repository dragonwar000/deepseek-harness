# Agent Note: Graph 计划是记录在会话日志中的已审计契约

Status: implemented

[English](2026-09-29-graph-contract-admission.md) | 中文

## 问题

多单元工作（并行执行、独立验证者、综合步骤）需要一个声明式结构，并且能在任何部分运行之前被检查。以散文写成的计划无法检查；保存在会话日志之外存储中的计划无法重放、恢复，也无法在崩溃后被信任。社区插件要么审计磁盘上的文件而不记录版本（`whale4rain/dsh-graph-engineering`），要么保存一个独立的项目存储（`octie-dsh-plugin`）。

## 决策

`@deepseek-ai/dsh-experimental-graph-contract` 定义模型编写的 `dsh-graph/v1` 计划，以及针对它的确定性审计。模型以 JSON 把计划传给 `graph_audit`；zod schema 在这个解析器边界解析它并拒绝未知键，因此由 harness 拥有的字段（`status`、`basis`、`version`）不能出现在计划中。`auditPlan` 检查结构、闭合性、L2 起的锚点与全新验证、L3 的人工与交接关卡、可共享波次的节点之间互不相交的写入前缀、允许且已注册的工具、子代理深度、最坏情况运行预算、输入回退值，以及冻结的 acceptance。每个发现都带有固定的修复方法；在 `enforce` 模式下只有严重级别为 `reject` 的发现会阻止准入，`shadow` 模式准入每个成功解析的版本，同时报告相同的发现；无法解析的版本在两种模式下都记录为未准入，因此 `graph_run` 永远不会收到它。

每次输入带有可读计划 id 的调用都会追加一个 `graph/plan` 事件，其中包含由 harness 分配的版本、摘要、准入结果、已解析的计划或 `null`，以及各项发现。`graphPlans` 投影把这些事件折叠为版本、拒绝记忆、由第一个成功解析的版本冻结的 acceptance，以及最新准入的计划；graph 运行器只读取该投影。`./invariant` 伴随插件检查版本连续，且每条记录的准入与其模式和发现一致。

## 考虑过的替代方案

**复用 Agent Teams 任务板。** 它的事件与投影绑定在 Team 成员关系上，每次变更都需要 Lead 或所有者，且就绪状态逐个任务计算，没有排序或准入。graph 契约复用它的模式（zod 投影状态、前缀不变量、写入前缀重叠），但不依赖该包。

**把被拒绝的计划存入存储域。** 第二个存储可能与日志产生偏差，而且跨会话的范围与保留期都没有定义。拒绝记忆是 `graph/plan` 的会话内投影；跨会话记忆等待演进关卡。

**为计划使用类型化的工具参数。** 工具参数语言没有类型化的映射，而计划嵌套了多层映射与 schema；计划参数使用 `json`，zod schema 是唯一的校验器。

**glob 写入范围。** 判断两个 glob 是否重叠代价不低；路径前缀与 Agent Teams 的规范化方式以及运行器的写入约束一致。

## 后果

审计与模型无关，也不需要模型调用，但模型必须从工具描述中学习计划格式，这会让挂载该插件的会话的每个请求增加约 450 个 token。可选启用的 `@deepseek-ai/dsh-experimental-loop-graph-profile` 组合包以 `shadow` 模式把它与 `@deepseek-ai/dsh-experimental-graph-projection` 一起挂载，因此启用该组合包会让每个请求付出这一成本；`dsh-base` 不挂载它。本格式版本中的计划是有向无环图；带保护的环需要之后的兼容扩展。发现以审计时的部署为准，因此之后才注册的工具按调用时的注册表判定。
