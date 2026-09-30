# Agent Note: 最终回答的证据是对本轮次工具记录的启发式折叠

Status: implemented

[English](2026-09-30-graph-evidence-heuristic-claims.md) | 中文

## 问题

一个轮次可能以一个回答结束，而该回答提到的文件与命令在本轮次中没有任何内容查看过。会话日志已经保存了每个工具调用与工具结果，但没有任何东西把回答与它们关联起来，被压缩的片段也完全无法读回。

## 决策

声明是最终回答提到的文件路径或 shell 命令：行内代码，或正文中以根开头或形似文件的路径。`@deepseek-ai/dsh-experimental-graph-projection` 的 `graphEvidence` 投影按轮次折叠工具调用参数与工具结果提到的路径和命令，以及本轮次最新 assistant 消息的声明及其叶子：`tool-record`、`observed` 或 `absence`；没有叶子的声明是 parametric。该折叠是确定性的，不调用模型。`graph_cite` 针对一条声明读取同样的记录。`verifier-gate` 把检查记录在 `loop/verdict.evidence` 上，并且只在 `evidence.mode: enforce` 时引导缺少证据的回答。`history_read` 列出被压缩替换或缩短的片段，并把其中一个通过会话查询服务读取后作为新的工具结果返回。

## 考虑过的替代方案

- **在回答上引用来源事件。** `assistant/message` 不能携带 `sourceEventSeqs`，因此回答从不引用其来源。
- **让模型把声明关联到证据。** 它每个轮次需要一次请求，并让关口依赖一次不确定的调用；在 shadow 数据表明启发式不够之前推迟。
- **记录 `graph/claim` 事件。** 声明与叶子是已记录事件的纯函数，而关口对它们的使用已经记录在 `loop/verdict` 上。
- **同步读取被遮蔽的事件。** 禁止新增对会话历史的同步读取；通过会话查询服务的分页读取取而代之。

## 后果

该检查证明被提到的路径或命令出现在本轮次的工具记录中，而不证明其周围的陈述为真。文件系统观察是 Cordis 事件而不是会话事件，因此不是叶子。替换的工具结果（例如被裁剪的结果）不是新证据。history_read 的结果落在缓存的提示前缀之后，从不改写更早的上下文。在 `loop-graph-profile` 中，证据步骤以 shadow 模式启动。挂载的知识库是日志之外的唯一来源：`graph_cite` 与门控在判定时通过可选的 `ctx.get('knowledge')` 读取，为知识库能解析的页面或边添加 `graph-edge` 叶子，且只记录在使用它的工具结果或 `loop/verdict` 中。
