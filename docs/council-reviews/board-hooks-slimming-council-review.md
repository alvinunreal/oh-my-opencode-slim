# Board/Hooks 精简 — Council 共识报告（2026-10-23）

## 议题
在 opencode v2 宿主机制已覆盖子任务生命周期大部分能力的前提下，裁剪 omos 子任务跟踪子系统的冗余：
`background-job-board.ts` (2,135) + `background-job-{store 330, coordinator 519, supervisor 208, terminal-gate 1336, persistence 561}` + `tool-execute-hooks.ts` (1,311) ≈ 6,400 LOC。
参照系：codex（主）、dsh（辅）、opencode v2.1.3 + v1.19.4 宿主源码（已本地落地）。

## 硬约束（用户，约束性）
1. **v1 支持保留**，不做 v1 退役；允许在保住 v1 行为前提下精简 v1 车道代码。
2. 提示词克制添加；token 极简。
3. 4 个模型面 task 工具不在范围（已定前沿最优）。

## 侦察证据（4 线）
- Lane A（omos 清点）：死代码 ~47 LOC；hooks 13+11 可选依赖；v1-only 车道 ~47；三层身份 82 行为无 callID 宿主而设。
- Lane B（v2.1.3 宿主）：原生 `subagent`+`background` 标志、Job 注册表、宿主完成通知（synthetic→inbox→wake）、重启标记+补送；无 jobs HTTP API/插件 job 域；无活挂起超时；`tool.transform` 可整体替换执行器。
- Lane C（codex 主参照，~11,200 LOC）：无 job board/租约/TTL/驱逐守护/状态持久化（仅 SQLite 父子边）；状态=live object watch；通知=父输入流排队消息。
- Lane D（dsh 辅参照）：settlement-notice 核心 ~90 LOC；父会话零跟踪状态；证明租约/持久板/别名表/驱逐/TUI 投影/拦截检测非必需。

## 席位
- A（模型面/token）：削板注入+别名+v1 车道+死代码；留 council 组装与后台默认翻转。
- B（架构）：溶解 store+coordinator（−849）；`tool.transform` 执行器包装（结构化结果杀死正则刮文案这一类机制）；supervisor→abort-watchdog；并发状态移出 board；目标 6,400→1,250（含被禁止的 v1 退役 −2,600）。
- C（正确性/风险）：纯投影丢 5 项无宿主等价物的安全属性（run fencing、uncertainty 降级、墓碑/删除纪元、租约护 trim、持久化 write-through）；v1 无 synthetic 通知，板是 v1 唯一通知机制，不可搁浅。

## 席后核实（orchestrator，2.1.3 + v1.19.4）
- 活挂起无宿主超时（重启预算仅覆盖崩溃循环）→ supervisor 能力保留。
- resume:false 重启通知确认（restart.ts:126-129,154）。
- callID 契约两代宿主必填（v2 tool.ts:109,128；v1.19.4 plugin/src/index.ts:267；omos 1.18.32 d.ts 同）→ 三层身份可退化 tier-1。
- 板注入 v2 已强制禁用（runtime.ts:386）；墙钟/并发默认均关；deferred-close 三 no-op 使 TerminalState 链生产从不触发。
- **修正**：coordinator 的 TerminalOutcome 派发承重（index.ts 六订阅者：913/980/1049/1337/1426/1055）；仅 TerminalState 链空洞。

## 共识处置表（Δ 对 6,400 基线；净 ≈ −3,010 → ~3,390）

| # | 机制 | 处置 | Δ LOC | 车道 |
|---|---|---|---|---|
| 1 | store 接口+coordinator 门面（溶解入 board 模块；保留 outcome 派发语义） | CUT | −849 | 双宿主 |
| 2 | 板死 API（47） | CUT | −47 | 双宿主 |
| 3 | deferred-close 三 no-op | CUT | −60 | 双宿主 |
| 4 | TerminalState 监听链（TUI 标记折入 outcome 派发） | CUT | −40 | 双宿主 |
| 5 | 板注入 v2 死管线分支 | CUT | −60 | v2-gated |
| 6 | 板注入 v1 车道 | KEEP-BUT-RESHAPE（变更增量+token 上限+trailing-volatile） | −150 | v1 保留 |
| 7 | 别名系统+child-ref 尾注 | KEEP-BUT-SIMPLIFY（单一格式、v2 可渲染原生 sessionID） | −50 | 双宿主 |
| 8 | launch/status 注册移 `tool.transform` 执行器包装（v2）；v1 prose 车道保留 | MOVE-SEAM | hooks 1,311→~800 | v2-gated |
| 9 | 漂移/掩码/三层身份+drain 兜底（单一 callID 身份；先立 before-hook 注册为唯一路径） | CUT | −180 | 双宿主 |
| 10 | supervisor → abort-watchdog（deadline⇒宿主 abort，杀合成终态） | KEEP-BUT-RESHAPE | 208→~120 | 双宿主 |
| 11 | 终态门：证据分类/去重/无结果停止 | KEEP | 0 | 双宿主 |
| 12 | 终态门：合成终态制造/deadline 通知注入/重启再通知 | CUT | 1,336→~780 | 双宿主 |
| 13 | run fencing（generation/terminalRevision）持久化 | KEEP | 0 | 双宿主 |
| 14 | 持久化 write-through（防重启双通知） | KEEP | 0 | 双宿主 |
| 15 | uncertainty+30min 降级（降为投影派生） | KEEP | −100 | 双宿主 |
| 16 | 墓碑+删除纪元 | KEEP | 0 | 双宿主 |
| 17 | 记录 35→~12 字段；租约 4→1 owner；计数器 4→1 ordinal；驱逐→投影 | SIMPLIFY | −450 | 双宿主 |
| 18 | 并发状态移出 board/hook 入队列模块 | MOVE-SEAM | −150 | 双宿主 |
| 19 | council 组装/后台默认翻转/4 工具 | KEEP | 0 | 范围外 |

## 阶段计划（v1 保留）
- **P0 纯删除零行为变化**（#2/#3/#4/#5）：若 cache-payload 快照移动即说明 v2 分支可达，步骤有错。
- **P1 溶解行为保持**（#1/#18/#17）：透镜中性——6 个 outcome 订阅者入口不变、持久化 schema key 不变。
- **P2 v2-gated 结构移动**（#8/#9）：v1 prose 车道特征测试先行，字节等同。
- **P3 双宿主重塑**（#10/#12/#6/#7/#15）：#10/#12 依赖 #13/#14 的重启去重钉住测试先行。
- **禁止**：B 席 P3（v1 车道退役 −2,600）；其 1,250 目标在约束下不可达。残存 v1 车道内部精简或可再 −300（不承诺）。

## 合并闸门（去重后 11 条）
1. `check:ci`+`typecheck`+`test` 每阶段；2. 缓存安全三套件+全部注入走 cache-safe-injection（板行仅 trailing-volatile）；3. 重启恰一次通知+围栏持久化+墓碑阻复活；4. **callID 契约钉死测试（新增永久）**；5. supervisor 用 test-timers 驱动（deadline⇒abort、无合成终态、`wallClockTimeoutMs=0` 全关）；6. 终态边界（无结果停止恰一次、证据分类金样、6 订阅者身份保持）；7. 别名跨重启稳定/单一格式（断言 child-ref 尾注不渲染）；8. 准入决策不变、`defaultConcurrency=0` 仍无限；9. v1 prose 车道特征测试 P1 前建立、P3 全程字节等同；10. 模型面冻结（4 工具 schema/描述零编辑）；11. 文档+codemap 同步。

## 不可约下限（C 注册表 + v1 附加）
run fencing、墓碑/纪元、租约护 trim、write-through、uncertainty 降级、证据分类+去重+无结果停止、准入、TUI 投影、abort-watchdog；v1 附加：prose 注册车道、v1 板注入（封顶）、别名（v1 唯一文本任务身份）。**现实下限 ≈ 2,800–3,200 LOC**。

## 待用户方向决策（2026-10-23 已裁定）
1. 后台默认翻转：**保留**（用户本人 PR，避免阻塞、便于主代理编排后并行推进）。
2. v1 板注入：**不改**（P3 中跳过 #6，不引入增量/上限模式）。
3. 别名策略：**单一格式 + v2 渲染原生 sessionID 并行**（删 child-ref 尾注重复格式）。
4. `wallClockTimeoutMs`：**保持 0（关）**。
5. 执行器包装：**确认在边界内，按 P0→P3 推进实施**。

## 会话
- 席位 A `ses_e9c4a140cffeeypi2ysT1U3doO`；B `ses_e9c3b6958ffesuEb1XSAEr3bl3`（替代模型 opencode/minimax-m3.1-flash-free，原 MiniMax 免费档退役）；C `ses_e9c4a1404ffemcyati85iN4peI`；synthesis `ses_e9b8a0aa4ffesTYPQTS6gvB1Bk`。
- 侦察线：omos 清点 `ses_e9c662759ffevpGkYl7MqEI7Mg`；v2 宿主 `ses_e9c75ed6effeqc2CgLx3hc4TqR`；codex `ses_e9c75ed6dffeKOPdKZdcaqC6S4`；dsh `ses_e9c75ed6cffe50Qg2Vr4LOJnyj`。
- 宿主源码：v2.1.3 dev @e965774fa0（/mnt/netshare2/liujiajun/opencode-v2-latest）；v1.19.4 worktree @148842ef（/mnt/netshare2/liujiajun/opencode-v1.19.4）。
