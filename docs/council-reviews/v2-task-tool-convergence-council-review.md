# v2 任务控制工具收敛提案 —— Council 审查报告

- 日期：2026-10-21
- 审查对象：omos（本仓库工作区）在 OpenCode v2 latest（`anomalyco/opencode` @ `15adc3d91e`，2026-10-20，本地镜像 `/mnt/netshare2/liujiajun/opencode-v2-latest`）上的 task 控制工具退役提案
- 审查方式：council 三席独立审查（councillor-a/b/c）+ council 综合席裁决；所有载荷事实经发起方与席位对照两套源码逐行核验，席位分歧处由综合席改判并复核
- 状态：**未提 issue**。本报告为提案的复审存档；若未来推进，须满足 §5.3 强制捆绑清单后按 §8 验收

---

## 0. 结论摘要

| 工具 | 原提案 | 终裁 | 关键理由 |
|---|---|---|---|
| `task_status` / `task_cancel` / `task_reply` | 保留 | **保留**（三席共识） | 通知丢失后的唯一重取通道 / 模型侧取消唯一通道 / 权限代答薄封装 |
| `task_message` | v2 退役 | **v2 降级 queue-only（不退役）** | queue 是宿主模型面不可表达的原始能力；steer 通道当前被 omos 自身 hook 拦死；降级后 v1/v2 语义收敛 |
| `task_revive` | v2 退役 | **v2 退役**，但与 hooks 改造**原子捆绑** | 单一续跑动词符合收敛目标；但直接退役 = 文案死链 + 静默重复派发，捆绑清单缺一不发 |
| 别名→sessionID 翻译 | "移入 hooks 层" | **改写为"确认现状"** | 机制已在 hooks 层且必须在 hooks 层（branded schema 先于 decode 校验），无代码搬移必要 |
| 提示词 / 注入 / docs 清理 | 是 | **是，但逐条 flavor 化**；v1-only 文本绝不动 | 全局替换会误伤 v1 并击穿 v1 cache |

**一句话总纲**：保留 `task_message`（queue-only）+ 退役 `task_revive`（原子捆绑：门控放宽、对账内化、收养、markUsed 修复、全量文案、flavor 化），v1 完全不动。

---

## 1. 背景与动机

用户以 council 模式为主要用法，观察到 OpenCode 原生 subagent 已内置"启动子代理 / sessionID 恢复会话 / 后台完成通知"，怀疑 omos 的 task 系列工具冗余，考虑 `disabled_tools` 全禁或按提案退役。经逐行源码核对与 council 三席审查，收敛为 §0 结论。

### 1.1 council 模式不依赖 task_* 工具（发起方核验，载荷事实）

- 触发：关键词注入规程只引用原生委派工具，零 `task_*` 引用（`src/hooks/council-inject/index.ts:100-111`）。
- 派发席位：原生 `subagent()` 并行调用（v2）。
- 结果回收：orchestrator 发 `Seats: <id, id>` 行，hook 层正则解析（`tool-execute-hooks.ts:71`）并组装席位结果进综合代理上下文（`:96-147`）——纯 hook。
- 席位只读 allowlist（`src/agents/councillor.ts:81`），council 综合代理 synthesis-only 权限。
- 运行中异常路径分别落在 `task_cancel`（席位卡死）、`task_status`（通知丢失重取）、`task_reply`（权限代答）、`task_message`（中途排队备注）。

---

## 2. 已核实的源码事实（v2 host @15adc3d91e，行号均已对照本地镜像）

1. 原生工具面无任何 task_* 工具；委派唯一原生工具 `subagent`（`packages/core/src/tool/plugin/subagent.ts:17`）。
2. `subagent` 以 `sessionID` 恢复只校验存在性 + 父子关系，无状态门槛（`subagent.ts:153-167`）；继续时可换 agent/model（`:171-182`）。
3. `sessions.prompt` 的 `delivery` 默认 `"steer"`（`session/prompt.ts:50`）；inbox：steer = step boundary 插入，queue = idle boundary 消费（`session/inbox.ts:44-49`）；`subagent.ts:203-204` 注释 "default wake starts an idle child or steers a running one"。
4. 原生后台完成通知：`SubagentCompletion.deliver` → 父会话 synthetic `<subagent sessionID state>`（`session/subagent-completion.ts:24-45`）。
5. 原生重启自愈：后台 job 持久化（`job.ts:199-210` persistBackground），重启后终态重投递、运行中续跑再通知（`session/execution/restart.ts:139-196` recoverSubagent）。
6. 无模型面取消：`Job.cancel`（`job.ts:412`）/ `session.interrupt`（`protocol/src/groups/session.ts:685`）仅为 service/HTTP，面向 TUI/用户。
7. `Form.Service.reply` 存在（`core/src/form.ts:92`）且协议暴露 `POST /api/session/:sid/form/:fid/reply`（`protocol/src/groups/session.ts:781`），但宿主**插件会话域无 form**（`plugin/src/effect/session.ts:152-170`，16 方法无 form）；omos `task_reply` 靠创建时能力探测代答（权限类可用；form 类仅当宿主 client 暴露，pinned 版本缺席时诚实失败）。
8. `task_message` 的 queue 语义（idle boundary 消费、`resume:false` 不唤醒）在 v2 仅由 omos client-shim 的 `noReply → {delivery:'queue', resume:false}` 翻译承载（`src/v2/client-shim.ts:560-577`）；原生 `subagent` Input 无 delivery 参数（`subagent.ts:29-48`），模型面只能 steer。
9. v2-latest core 中 `noReply` 零命中——纯 v1 概念，shim 翻译是 queue 唯一载体。

### 2.1 omos 侧恢复门控事实（综合席修正后发起方复核确认）

- 续跑入口 `resolveReusable ?? resolveRecoverable`（`tool-execute-hooks.ts:411-415`）；`isReusable` 只要求"终态 + 已 reconcile + 非 statusUncertain"，**不要求 completed**（`background-job-board.ts:1890-1895`）→ **reconciled 的 error/cancelled 今天已可原生续跑**。
- `terminalStateOf('stopped') === undefined`（`background-job-board.ts:1925-1931`）→ **stopped 永不 reusable**，含已 ack 的 stopped 也被 `refuseKnownTaskResume` 拒（`tool-execute-hooks.ts:188-197`）——必须改判定谓词，不是 ack 一下即可。
- `refuseKnownTaskResume` 与 v2 提示词（`orchestrator.ts:92-96`）把非 reusable 态全部指向 `task_revive`。
- `statusUncertain` 非 revive 独有：task_revive 自己也拒（`task-revive.ts:651`）；`markStatusUncertain` 只作用于 running（`board:883-896`）。
- 运行中拦截：对已跟踪 `running` 子会话的原生 `subagent()` 调用直接 throw（`tool-execute-hooks.ts:430-434`，文案含 "cannot be resumed or amended"）。
- 委托路径 recovery 调用不带 `purpose:'revive'`（`:473-480`）；`session-recovery.ts:348-356` 对 v2 incomplete 轮次直接 refuse。**untracked 且历史 incomplete（重启时正在运行）为唯一收养缺口**；untracked completed 轮次走 `restoreRetainedSession`（`session-recovery.ts:435-472`）会注册 board 行，Seats 仍可解析。
- `registerLaunch(preserveRun:false)` 本身重置 `terminalUnreconciled/completedAt/generation`（`board:493-537`），成功续跑后无永久泄漏；风险窗口在"续跑被宿主拒绝"与 `markUsed` 提前开逃生舱（见 §6.3）。

---

## 3. 原提案（提交 council 前）

v2 限：保留 `task_status` / `task_cancel` / `task_reply`；退役 `task_message`、`task_revive`（收敛到原生 `subagent(sessionID,…)`）；别名翻译移入 hooks 层；同步清理提示词 / 注入文本 / `docs/background-orchestration.md`。v1 全保留。

已知风险（当时认知）：queue 语义损失是"唯一功能减损"；工具集变化一次性重置 prompt cache。

---

## 4. 三席立场与分歧

| 议题 | A 席 | B 席 | C 席 |
|---|---|---|---|
| 保留三件 | 同意 | 同意 | 同意 |
| `task_message` | 直接退役（降级缺模型心智支持） | **反对退役，降级 queue-only** | **反对退役，降级 queue-only** |
| `task_revive` | 退役 + 原子捆绑 hooks 改造 | **反对当前形态退役**（收窄留任或两阶段） | 退役 + 三项强制捆绑条件 |
| 落地形态 | queue 损失非唯一（运行中修正 + 恢复准入 + 对账闭环都要改） | 双退 = steer 被自家 hook 拦 + queue 被删，两条修正通道全断 | 双退留两处死路回归 |

三席独立指出的共性问题：`tool-execute-hooks.ts:430-434` 运行中拦截、`:438-448` 恢复门槛与 `refuseKnownTaskResume` 文案、health-check 无 flavor 感知、`ORCHESTRATOR_DEFAULT_TOOL_NAMES` 硬编码、测试按 flavor 拆分、cache 一次性失效需刻意快照更新。

---

## 5. Council 裁决（综合席）

### 5.1 `task_message`：v2 降级 queue-only（B/C 胜，A 的措辞强制项并入）

- 双退 = 两条修正通道全断：steer 被 `:430-434` 拦截、queue 被删除。queue 不是过时路径，是宿主模型面无法表达、只能由插件承载的能力。
- A 席的"双模式心智负担"论点随降级方案本身消解：降级 = **删除** `delivery` 参数与 steer 分支，只剩单一 queue 语义；且与 v1 描述（`task-message.ts:57`）对齐，v1/v2 语义收敛而非发散。
- 具体形态（B 方案 + A 强制项）：删 `task-message.ts:68-80`（delivery 参数）与 `:145-185`（steer 确认分支，连带解除对 `promptMessageIDFor`/`revived-run-tracker` 的依赖，**`revivedRunTracker` 本身不要连带删**——terminal gate 与 v1 revive 仍用）；保留 message lease（`:117-125`）与 running 门槛（`:432-455`）。
- 强制项（A，无论退役/降级都成立）：重写 `tool-execute-hooks.ts:430-434` 拦截文案，不得暗示存在原生运行中修正通道；改为"仍在运行不能用 `subagent(sessionID)` 续跑；如只需追加不唤醒的备注用 `task_message`（空闲边界消费、不保证被读取）；如需真正续跑等终态通知后再 `subagent(sessionID)`"。

### 5.2 `task_revive`：v2 退役（A/C 胜），B 的缺口清单升格为合并闸门

- 分歧本质是**发货顺序**而非终态：B 的两阶段终点也是退役（收养与 live 验证下沉 hooks）。留任收窄 = 模型要记"completed → subagent；stopped/unreconciled → task_revive"的状态机路由，是更重的双通道心智负担。
- 事实修正（综合席复核，见 §6）：真正死路只有 stopped（含已 ack）与 unreconciled，`isReusable` 谓词必须改，不能靠 ack；statusUncertain 非 revive 独有（两边都拒）；untracked completed 轮次已可经 `restoreRetainedSession` 注册行，Seats 可解析——唯一真实收养缺口是 **untracked-incomplete（重启时正在运行）**。

### 5.3 强制捆绑清单（退役 `task_revive` 同批落地，缺一不发）

- **(a) 放宽 v2 续跑谓词**（A+C）：`:436-448` 与 `:488-491` 的 `hostFlavor === 'v2'` 放行谓词从 `isNativeContinuableCompleted` 扩为"agent 匹配 且 状态非 running"（completed/error/cancelled/stopped/reconciled 全放行）；保留 agent 不匹配拒绝（switchAgent 风险，`subagent.ts:171-182`）。
- **(b) 对账内化**（A）：`acquireRelaunchLease` 成功后、发出续跑 prompt 前，若 `terminalUnreconciled` 或 `state==='stopped'`，按 `task-revive.ts:389-405` 的 generation/revision 校验模式调用 `markReconciled`；校验失败即放弃本次续跑。
- **(c) 重启后 untracked-incomplete 收养**（B #2 + C）：委托路径 recovery 传 `purpose:'revive'`（或新增 `'resume'`）并透传 `allowQueuedContinuation`，把 `kind:'adoptable'` 结果按 `task-revive.ts:661-708` 方式 `registerLaunch({adopted:true, recoveredWithoutPrompt:true})`（约 20 行移植）。否则重启时在跑的席位在 synthesis 里永久变成 `[no response — unresolved ref]` 占位符，属可感知回归，不能只写文档打发。
- **(d) 修 `task_status` markUsed 时机**（B，独立 bug）：`task-status.ts:346` 在非终态 throw 之前已 `markUsed` —— 对 stopped 任务读结果会静默打开重复派发守卫逃生舱（`:550-571`），模型重试即静默新开会话。修法：只对真正交付结果的分支 mark（error/cancelled 的 throw 文案本身即结果）；stopped/no-result 分支不 mark。
- **(e) 全量文案 flavor 化重写**（A+C+B 行号清单）：`tool-execute-hooks.ts:193,201-202,208`；`session-recovery.ts:165,250`（**`:104` 仅 v1 可达，不要动**）；`task-ref.ts:76-85`；`task-message.ts:66,440,449`；`orchestrator.ts:92-96,167`；`docs/background-orchestration.md` 按 v1/v2 拆段（`:33-47,104-108,130-150,245-259,443-448,613-614,718,745`）。全部改为 `subagent(sessionID: "...", prompt: "...")` 措辞。
- **(f) health-check 与默认工具名单 flavor 化**（B+C 共识，算术见 §6.4）：`minimumExpectedToolCount` 增加 flavor 参数；`BASELINE_TOOL_NAMES` 的 `task_revive` 在 v2 永不注册，共享配置里 `disabled_tools:["task_revive"]` 会错误下调阈值掩盖真实缺工具；`ORCHESTRATOR_DEFAULT_TOOL_NAMES`（`agents/index.ts:54-61`）同理；`tool-loop-guard/hook.ts:62-63` 豁免项 v1 保留（无害）。
- **(g) 注册方式**：用 `hostFlavor !== 'v2'` 门控 `task_revive` 注册（照 `index.ts:1577` `shouldRegisterWaitForUser` 模式），**不是删代码**——v1 全保留靠此维持。

**回退闸门（B 的两阶段，降级为发货路径而非终态）**：若 (b)/(c) 无法同批落地，不要发半退役版本——Phase 1 先落 (a)+(b)+(d)+文案，`task_revive` 暂留收窄为异常恢复专用；Phase 2 落 (c) 后再删注册。**明确否决"先退役、后补 hooks"的排期。**

### 5.4 明确禁区（裁决否决项）

1. **v1-only board 注入文本绝不动**：`background-job-board.ts` 的 `task_revive only` / `Recovery: … task_revive`（`:1559,1562,1566,1740,1972 REVIVE_ONLY,1989`）是 v1 渲染面，v2 永不渲染（`board-injection.ts` 对 v2 及 boardless 早退）。改了 = 白击穿 v1 cache 且 v1 测试挂掉。**否决 A 席"清理 board 文本"项。**
2. **council-inject 块字节绝不动**：`buildCouncilModeBlock`（`council-inject/index.ts:102-112`）只引用原生委派词汇；且经 `appendTaggedSyntheticPart` 落在首条触发消息（transcript 中段），改字节 = 击穿已缓存前缀，比尾区注入危险一个量级。任何"顺手润色"一律拒绝。**council 重度用户的 cache 不受本提案影响正因此条。**
3. `cache-safety.property.test.ts` / `cache-safety-harness.test.ts` / tripwire：本提案不新增 transform step、不注入 volatile 内容，应零改动；有 diff 即说明越界改了注入管线，回退。

---

## 6. 对三席的事实纠正（复核确认，避免错误前提进 PR）

1. **"v2 只允许 completed 续跑"过宽**（A/C 原提法）：`isReusable` 已放行 reconciled 的 error/cancelled（`board:1890-1895`）；真正死路 = stopped（`terminalStateOf('stopped')=undefined`，`:1925-1931`）与 unreconciled。
2. **"statusUncertain 是 revive 独有语义"不成立**（B 原提法）：task_revive 自身拒绝 statusUncertain（`task-revive.ts:651`），那是两边都不能处理的真空，不是退役回归。
3. **"board 行永久泄漏"过重**（A 席）：成功续跑会经 `registerLaunch` 重置；真实风险窗口是"续跑被宿主拒绝 + `markUsed` 已提前打开逃生舱"→ 静默重复派发（B 的链条，列为强制项 (d)）。
4. **health-check 算术纠正**（三席数字全不对）：`toolCount = 注册工具数 + marketplace 2`（`index.ts:1606-1610`），且 `interview_submit_state` 默认注册。默认 v2 现状 11 vs 阈值 8（余量 3）；仅退役 revive 后 10 vs 8（余量 2）；双退役 9 vs 8（余量 1）；用户禁 interview 命令时再降 1。方向结论不变：**必须 flavor 化基线，保持 ≥1 余量**。
5. **"委派路径完全不收养 untracked"过宽**（C 席）：completed 轮次走 `restoreRetainedSession` 会注册行；缺口收敛为 incomplete 轮次（重启时正在运行）。

---

## 7. 剩余不确定性（实现评审时必须带进）

1. **queue-only 的"空闲边界消费"实测**：需在 pinned v2 上验证"派发 → 运行中 queue 一条 → 子任务自然结束一轮时是否在同一 run 内消费"（`runner/llm.ts:158-167` promotion 语义）；若不能，文案须写"可能滞留至下次显式唤醒"，不得宣称已修正。
2. **(c) 收养后的 prompt 语义**：原生续跑 untracked-incomplete 会以默认 `delivery:'steer'` 发送；若宿主还在跑该子会话，prompt 是"并入当前 run"。语义可接受但需测试固定；不可接受则拒绝并在文案给"重新派发"指引（C 的可选项）。
3. **(b) 的时序竞态**：`markReconciled` 在 lease 后、prompt 前；若期间宿主已重新置 running（`markRunningFromLiveSession` 清 `terminalUnreconciled`），须按 generation/revision 校验失败即放弃（沿用 revive `:389-405` 模式）。
4. **(d) 对 #1070 契约的影响**：stopped/no-result 从 markUsed 剔除后，确认无其他路径依赖"读一次即解锁"防死循环（相关测试逐条过）。
5. **重启前已投递但 board 丢失的席位文本**：属既有重启限制，本次退役不使其恶化；若 (c) 落地则顺带用原生 resume 恢复行。PR 描述须明确"不是本提案引入"。

---

## 8. 验收清单

**构建与静态**
- [ ] `bun run check:ci` / `bun run typecheck` / `bun test` 全绿
- [ ] `bun test --update-snapshots` 的 diff 只含预期 prompt 面（`agents/__snapshots__/orchestrator.test.ts.snap`），PR 描述声明"一次性 cache 失效"；若 `cache-safety.property.test.ts` / tripwire 有 diff → 回退

**v2 行为单测（按 flavor 拆，v1 既有断言一条不许改）**
- [ ] `subagent(sessionID)` 续跑：completed（未 reconcile）、reconciled error/cancelled、**stopped**、**unreconciled error/cancelled** 全部放行；agent 不匹配仍拒绝
- [ ] 续跑 stopped/unreconciled 后旧轮次 `markReconciled`（generation/revision 校验）；宿主拒绝时不留悬空 unreconciled
- [ ] 重启场景：untracked completed 席位 resume 后 `Seats:` 可解析；untracked **incomplete** 按 (c) 收养或按文档拒绝，两种都断言无"静默新派发"
- [ ] `task_status(result:true)` 对 stopped 不再 markUsed；error/cancelled 按原契约交付并 mark
- [ ] `task_message`：v2 schema 无 `delivery`；running 下 queue 成功返回"queued, consumption not confirmed"；非 running 拒绝文案 flavor 正确
- [ ] 别名：v2 传 `task_id` 别名与 `sessionID` 均能规范化；控制工具别名解析保持工具内路径
- [ ] health-check：v2 默认 / v2+disabled_commands:["interview"] / v2+disabled_tools:["task_revive"] 三组合断言（按 §6.4 数字）

**手工 v2 e2e（pinned 宿主）**
- [ ] 派发 → 运行中 queue 一条 → 观察消费边界与"未确认消费"文案
- [ ] 制造 stopped → 原位续跑成功，旧轮次闭环，无重复派发
- [ ] 重启后：完成席位 resume 后 Seats 解析；运行中席位收养/拒绝行为符合决定
- [ ] Council 全流程（`Seats:` 行、失败席位重派、权限代答），council-inject 块字节零变化

**文案与文档**
- [ ] `grep -rn "task_revive"` 逐条 flavor 化（v2 可达路径改写；`session-recovery.ts:104` 与 board 注入文本保持原样）
- [ ] `docs/background-orchestration.md` 按 v1/v2 拆段；README 相关章节同步（若有）

---

## 9. 对用户（council 重度用法）的直接影响

- **按裁决方案落地**：council 日常流程零变化（触发注入、席位派发、Seats 回收不经过这些工具）；异常路径更稳——席位卡死可取消、通知丢失可重取、权限可代答，stopped 席位从"静默重派丢上下文"变为"可原位续跑"；council-inject 字节不变，会话缓存无额外损耗（除系统提示词一次性失效）。
- **禁用全部 omos 工具（极端配置，不等价）**：council happy path 仍完好；代价集中在 task_cancel 缺失（失控席位只能 TUI 手动处理）、task_status 缺失（重复派发守卫的逃生舱失效）、task_reply 缺失（headless 下权限 ask 令席位永挂）。且 hook 注入文案仍指向已禁用工具，产生模型死链噪音。
- **`disabled_tools` 写 `"task"` 无效**：委派工具是宿主原生工具，不在 plugin 注册过滤范围。

---

## 10. 本报告之外的事项

- 未提 issue（用户决定）。若未来推进：按 §5.3 捆绑清单 + §8 验收执行；向宿主反馈"给 `subagent` 增加 `delivery` 参数"可重新评估 `task_message` 退役（pinned `15adc3d91e` 无此参数，B 席假设声明）。
- 审查参与会话（追溯用）：councillor-a `ses_ea238b645ffeme9uGWxSwXTuvU` / councillor-b `ses_ea238b644ffe6UrVGF2hlwcdqK` / councillor-c `ses_ea238b638ffeIrYUj9lr3CDdUM` / council 综合 `ses_ea2161b8fffeR8IxCGH9YW36PH`。三席审查期间遇宿主重启，A/C 席经 `task_revive` 原位恢复完成，B 席观测为 untracked 后同路径恢复——本身即 §5.3(c) 缺口的一个现场实例。
