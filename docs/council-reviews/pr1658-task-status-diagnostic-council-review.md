# PR 1658 审查 + task 工具族前沿对照 —— Council 审查报告

- 日期：2026-10-22
- 审查对象：PR 1658（task_status 活跃来源溯源 + 只读 diagnostic 模式，+1395/−20）；附带议题：omos task 工具族（v2 面）是否还可精简
- 调研基线（均为本次会话核实）：
  - omos master `a598a262`（前次收敛裁决 5ef71005 已落地：v2 仅注册 task_status/task_message/task_reply/task_cancel 共 713 B；task_revive、wait_for_user 为 v1-only；续跑走原生 `subagent(sessionID,…)`；markReconciled 内化；untracked-incomplete 收养；markUsed 时序已修）
  - opencode V2 `anomalyco/opencode` 默认分支 **dev** `c93aaae371`（本地 `/mnt/netshare2/liujiajun/opencode-v2-latest`；该仓库无 master，`v2` 分支落后 dev 453 commits，dev 为 HEAD）
  - codex `openai/codex` @86e17e9（`/mnt/netshare2/liujiajun/codex`）
  - dsh `deepseek-ai/deepseek-harness` @687f282e（`/mnt/netshare2/liujiajun/deepseek-harness`）
- 审查方式：4 路 explorer 并行调研（omos 清单 / v2 宿主 / codex / dsh）→ council 三席独立审查 → council 综合席裁决；发起方对席位两处事实错误做了源码级纠正后裁决。

---

## 0. 结论摘要

| 议题 | 裁决 |
|---|---|
| PR 1658 合并处置 | **(ii) 修 F1–F3 并裁掉 untracked 诊断路径（仅保留 tracked 诊断）后合并**（三席一致） |
| +227 B 模型可见文本 | **描述句 +92 B 删到 0；保留参数描述 ~135 B**；描述须保留"untracked → read-only observed state"句 |
| v2 task 工具族再精简 | **已处前沿最优，勿再砍**（无 wait/list/resume 工具正是优点；防轮询走运行时输出而非描述字节） |
| v2 shim 无界转换 | **升级为合并闸门**（修正暴露面后裁决：tracked 诊断与 result:true 同样经过该无界同步转换） |
| task_cancel "revived" 死链 | **真实但不在本 PR 范围**——按 flavor 拆分描述（v2 改 `subagent(sessionID,…)`，v1 不动），列为后续项 |

---

## 1. 前沿设计对照（子代理生命周期）

三家前沿 harness 在模型面生命周期上高度趋同，omos 前次收敛方向被反向验证：

| 能力 | codex V2 | dsh | opencode v2 | omos v2 面 |
|---|---|---|---|---|
| spawn | `spawn_agent`（立即返回 name/nickname） | `subagent`（立即返回 id） | `subagent`（前台阻塞/后台） | 原生 `subagent` |
| 结果投递 | 邮箱消息（FINAL_ANSWER / `Agent errored: …`）排队 | settlement 通知（status+final+diagnostic，idle 排队/busy steer） | 合成 `<subagent sessionID state>` 项 | 同 v2 + KV 持久重投 |
| 等待 | `wait_agent`（事件驱动、**不返回内容**） | 无（服务侧） | 无 | 无（push+wake） |
| 追话/steer | `send_message`(queue-only) / `followup_task`(唤醒) | `send_message`（steer；隐式 cold-resume） | `subagent(sessionID)` 续跑（默认 steer） | 同 v2 + `task_message`(queue-only) |
| 取消 | `interrupt_agent`（轮级，代理存活；无 kill） | `interrupt_agent`（非阻塞） | 无模型工具（服务面） | `task_cancel`（模型面） |
| 续跑 | V2 无工具（send 隐式重载，"resume the parent first"） | 无工具（send 隐式 cold-resume） | `subagent(sessionID)` | 同 v2（task_revive 已退役） |
| 转录/诊断读 | **无** | **无**（诊断走通知） | **无**（插件面有 `session.context`） | PR 1658 新增（recovery 通道定位） |
| 权限代答 | 无此概念 | 无 | — | `task_reply`（76 B） |

要点：
1. **resume 并入 message 动词**（codex V2 删除 resume_agent；dsh 冷续跑）——omos 退役 task_revive 与此一致。
2. **push-first**：三家都不给模型"读子代理转录"的工具，失败证据随完成通知推送；omos 的 tracked diagnostic 应定位为"推送丢失后的重取通道"，而非并立设计。
3. **描述极简主义**：codex V2 把委派政策散文移出工具描述（V1→V2 的演进），可选参数默认隐藏；dsh 的 `list_agents` 描述内嵌防轮询句。omos 已用运行时输出做防轮询（RUNNING_GUIDANCE 等），零闲置 token，优于内嵌。
4. v2 宿主核实：原生 `subagent` 至今无 `delivery` 参数（task_message queue-only 的存在依据）；完成通知重启重投（KV）；`Job.cancel`/`session.interrupt` 仅服务面；无模型面转录读取。

## 2. PR 1658 本体

**价值面**：`last_activity_source`（回答 #1031 的活跃来源歧义）与 `diagnostic: true`（失败/取消/停止子代理的有界 6144 B 只读摘录，无副作用，测试全 spy 佐证）是真Parent能力；json-error-recovery 排除 task_status 是正确配套。基 blob 与 master 完全一致，可干净套用。无注入管线改动（工具面变化 = 一次性缓存重暖，教义允许）。

**确认缺陷**（修复后合并）：
- F1（Greptile P2）：untracked v2 子会话 `terminal_reason` 回退到 `round.text`（部分发现被误标为失败原因）→ 修在 tracked reason-selection：宿主 outcome 理由 → assistant error → 部分发现只留在摘录内。
- F2（Codex P2）：输入存在性 fail-closed 检查计入 v1 compaction 触发条目 → 该机制随 untracked 路径裁剪而消失。
- F3（Codex P2）：摘录收集不跳过 compaction 轮 → 修复落在共享 `diagnosticExcerptOf`，**裁剪后仍必须保留且 flavor 无关（无条件过滤）**。

## 3. 合并清单（顺序执行，每项小而可测）

1. 裁剪 untracked 诊断路径：`diagnostic:true` 仅服务 tracked 子会话；untracked 会话返回 master 既有 observed-state 提示（与今日行为持平，无回归）。
2. F3 无条件落地：`diagnosticExcerptOf` 的 compaction 排除 flavor 无关化。
3. F1 落地 tracked reason-selection（见上排序）。
4. **v2 shim 转换加界**（`src/v2/client-shim.ts:441-490`）：带 limit hint 时先对 data 数组**从尾部切片再 map**；若 hint 管线实现过繁，退化为常量尾截——仍须本 PR 内完成。理由：修正后暴露面表明 tracked 诊断与既有 result:true 读取同样暴露于无界同步转换，本 PR 的卖点（有界摘录）直接架在该无界路径之上。
5. 文本：删 +92 B 描述句；保留参数描述（去掉引用已裁路径的措辞）；确认描述保留 "untracked → read-only observed state" 句；净增 ≈ +135 B；`bun test --update-snapshots` 刻意更新快照（一次性 fleet 缓存失效）。
6. 终态 next-step 指引：诊断输出尾加一行静态指引（工具结果内容，零提示字节成本）。
7. `last_activity_source` 词表用测试钉死（不进描述）。
8. 文档同步收缩（untracked 部分随裁剪删除）。
9. 闸门：`bun run check:ci` → `bun run typecheck` → `bun test`（含 cache-safety property/snapshot/tripwire）。

## 4. PR 之外的后续项

| 项 | 说明 |
|---|---|
| task_cancel 描述 flavor 拆分 | 共享串（`src/tools/cancel-task.ts:86-88`）在 v2 含 "revived" 死链（~140 B）。照 `TASK_REPLY_PERMISSION_ONLY_DESCRIPTION` 先例拆分：v2 改指 `subagent(sessionID,…)`；**禁止改共享串**（会破坏 v1 准确性）。 |
| 观察期 | `last_activity_source` 无描述教学是否被模型误用；有证据再补参数描述一词，别处不加。 |
| 双真相源 | 宿主 KV 结算 vs 插件转录解析：F1 的宿主优先排序为缓解；长期考虑彻底放弃转录推导理由。 |
| shim 加界收尾 | 确认 client-shim 其余调用方带 limit hint；若第 4 项走了常量尾截退化方案，开 issue 收尾。 |

## 5. 分歧记录

- 席位 A 两处前提被纠正（"裁剪即消除无界摄入"不成立——tracked 读取共享同一转换；task_status 并非全豁免而是 warn-only 轮询防护），其结论（指引行、时机）均保留。
- 席位 C 的"shim 加界降为后续项"被否决（理由见第 3 节第 4 条），其"截断须保最新内容"要求并入修复方案。
- 席位 A 的 ≤80–90 B 目标被否决：会删掉唯一静态教学面，全靠误用后纠错。
- 席位 B 的"现在接受 +227 B"以其自设条件（裁剪同批修剪）收敛于席位 C 方案，无活分歧。

## 6. 对用户（council 重度用法）的影响

- 按裁决落地：日常 council 流程零变化（不经过这些工具）；council-inject 字节、v1-only 文本、注入管线零触碰。
- v2 模型面维持 4 工具 / 713 B（修后 ≈ 848 B），少于 codex（6 工具）与 dsh（5–7 工具）的模型面，且唯一具备完成通知重启重投。
