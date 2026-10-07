# ZJSearch 下一代(v2)设计:代码结构 × Agentic Harness

状态:提案(draft v1,2026-10-07)。分支 `zjsearch`。
本文基于对当前代码的全量调研(所有结论带 file:line 证据),回答两个问题:

1. **代码结构重排**——后端从零设计文件结构(重点是解散 `capabilities/` 的模糊地带、拆解 `executor.py`/`route.py` 两个巨石),前端统一设计语言并把工具行渲染参数化;
2. **Agentic & Harness**——以两张样例报告(多肽原料药产业调研 / 深圳住宅市场价格矩阵)为验收基准,当前架构能否胜任、差距在哪、怎么补。

---

## 0. 结论(TL;DR)

**当前架构做得出"答案",做不出这两份"报告"。** 差距不在模型能力,在 harness 的五个硬限制:

| # | 硬限制 | 证据 |
|---|---|---|
| 1 | **答案 = 单次 write turn 的一坨 markdown**。无大纲、无分节、无逐节上下文装配 | `framework/loop.py:389-433`(全答案一次补全) |
| 2 | **deep 模式的输出 shape 是坏的**:`_DEPTH_SHAPE` 没有 `"deep"` 键, unreachable 的 `"quality"` 键("## 分节长文")才是报告形态——即 deep 一直在用 balanced 的 "Keep it moderate" 写长文 | `runtime/writer.py:21-36,136`、`runtime/profile.py:13`(模式只有 speed/balanced/deep) |
| 3 | **writer 上下文 40k 字符**(deep 96k),整块淘汰;researcher 转写只增不压缩;learnings 是 400 字符的散文事实,**没有表格/数据点这类结构化产物通道**——价格矩阵、产能对比表只能靠 writer 从 300 字符摘要里凭记忆重建 | `runtime/context.py:30-36`、`tools/learnings.py:19-24`、`runtime/feed.py:25-27` |
| 4 | **calculator / MCP 的结果永远进不了 writer 的上下文**(只进 researcher 对话),而 `<figures>` 规则又禁止 writer 无来源地给数字——推导表格在协议上不可能 | `runtime/executor.py:929-963`(MCP 分支无 `feed.append`)、`spine.py:129-141` |
| 5 | **write 调用没有服务端 max_tokens**(openai/gemini/dashscope 全靠部署方 params;Anthropic 默认 **4096**)——1-2 万字符的报告会直接被 `length` 截断 | `infra/caching.py:14-17,42` |

**代码结构**:后端 12,150 行里 `executor.py`(1,455 行,≥7 种职责)+ `route.py`(619 行,"thin by design" 但内嵌两段 LLM gate prompt)占掉 17%;同一功能散落 4 处(加一个工具要同步改 `tools/__init__.py`、executor if-chain、`rows.py` if-chain、route 装配);横切件(raw-args 守卫 ×8、config 样板 ×7、receipt 手拼 ×32、NDJSON ×2、SSRF ×2、相关性排序 ×2)全部存在 2-8 份手抄。前端 `AiSearchRunSection.tsx` 1,236 行,10 个工具行组件各自复刻 open/debug 状态机,metric 内容各写各的(两行空 metric 渲染孤儿分隔符、一行把原始查询串塞进数字槽),右侧栏 6 个 section 头手写 6 遍。

**方案骨架**(后文展开):

- **Harness v2 = REPORT 运行模型**:现有单循环保留为"浅模式";报告模式升级为三阶段 **PLAN(大纲先行)→ RESEARCH(现有 loop 增强)→ SYNTHESIZE(逐节撰写)**。新增 Run Corpus(运行内语料检索)、结构化产物通道(表格/数据点,单元格级引用)、逐节 write + 节级引用 gate、wire 协议增量(`outline`/`artifact`/`section` 事件)、客户端 Document 渲染器(TOC + 真表格)。
- **后端 v2 = Tool-as-Package + 薄 API 面**:`ai/` 内重组为 `core / llm / agent / prompts / tools / runs / api` 七个包;每个工具一个自包含包(spec+run+settle+row 语义),`capabilities/` 解体归位,executor/route 的 if-chain 与手拼 receipt 全部由注册表和底座取代。迁移用绞杀式(strangler)分五阶段,不做大爆炸重写。
- **前端 v2 = 一个 ToolRow 内核 + 每工具一个 settlement-view 声明**;Rail 统一 `RailSection`/`CapSection`;答案渲染升级为 Document 渲染器(无大纲时退回现有 MarkdownAnswer,完全向后兼容)。

---

## 1. 验收基准:两份报告的形态学

两张样例图是同一套报告语言,拆解出可验收的元素清单:

**结构元素**

1. 封面头:分类标签 + 主标题 + 副标题 + 元信息(日期 / 数据窗口);
2. Executive Summary:带标签的结论块(基线判断 / 核心逻辑),每条加粗、可带引用;
3. 编号章节(I / II / 1. / 2.),章节内再分小节;
4. **实体卡片**:公司卡(采购市场地位 / 研发与生产布局 / 供应链战略 / 客户与商业模式 / 财务与研发投入)、片区卡(价格锚点 / 成交价 / 挂牌价 / 数据来源)——本质是"结构化字段 + 粗体标签";
5. **数据表格**:公司/产能/投资/投产时间矩阵;项目/均价/户型/成交周期矩阵——**单元格带来源标注**;
6. 战略建议卡:Recommendation / Key Considerations / Suggested Actions / Risk Assessment 四字段;
7. 风险矩阵、Q&A 段;
8. **研究方法与数据说明**脚注(方法、局限、数据窗口)。

**量化基准**(从报告体量反推)

| 维度 | 量级 |
|---|---|
| 成品长度 | 10,000–25,000 字符(约 6k–15k output tokens) |
| 章节 | 6–12 个一级章节,每个 1–3k 字符 |
| 来源 | 40–150 个不同来源,[n] 引用 100–400 处 |
| 工具调用 | 60–200 次(搜索为主,web_reader 15–40 次,计算若干) |
| 表格 | 3–10 张,每张 5–20 行 |
| 耗时 | 10–30 分钟 wall clock |

当前最深档(deep,depth-probe 最高 rung 120 轮)在"调研量"上够得着,**在"产出"上完全够不着**——这是本方案的第二部分要解决的。

---

## 2. 现状体检(事实清单)

### 2.1 Harness:十个硬限制

1. **单次 write turn**:`loop.py:389-433` —— 答案由一次无工具的流式补全产出;`length` 截断只会记进 `settle.finish`,没有续写。
2. **deep shape 缺键**:`writer.py:21-36` 的 `_DEPTH_SHAPE` 键为 speed/balanced/**quality**;模式实际是 speed/balanced/**deep**(`profile.py:13`)→ deep 落到 balanced 的 "Keep it moderate";`writer.py:33` 的分节长文 shape 永远不可达。同族死键还有 `context.py:30-36` 的 `"goal": 96_000`(goal 模式已不存在)。
3. **prompt 与配置互相矛盾**:deep 的 researcher prompt 写 "up to 18 rounds, about 10 minutes"(`researcher.py:55` 附近),配置实际是 120 轮 / depth-ladder 最高 120(`route.py:216-256`、`infra/decision.py:116-117`)。
4. **writer 上下文 40k/96k 字符整块淘汰**(`context.py:30-72`):20-40 轮 deep run 的 feed 必然触顶;被淘汰的来源连引用号都带不走(淘汰通知要求"只引用剩下的")。
5. **researcher 转写零压缩**:`loop.py:325-338` 只增不减,web_reader 全文默认**无上限**进转写(`reader/config.py:92-103`);唯一缓解是 prefix caching(省钱不省延迟);24k 字符后的 `FEED_CONVERGE_NOTE` 是"劝模型别再搜",不是压缩。
6. **无结构化产物通道**:learnings 是 400 字符散文;没有表格/数据点/图表数据工具;MCP 结果 20k 字符只进对话不进 feed(`executor.py:929-963`);calculator 结果同样不进 feed。writer 建表只能凭 300 字符摘要 + 记忆,`<figures>` 又正确地禁止它无来源推导 → 数字密集的表格在协议上做不出来。
7. **无图表管线**:图片限于 ≤2 组 × ≤4 张搜索结果图(`writer.py:79-81`);markdown 图片被禁(`spine.py:109-112`);客户端唯一数据图组件 Stock.tsx 的绘图原语是模块私有的。
8. **并发上限 3**:`MAX_PARALLEL = 3`(`executor.py:64-70`),搜索/读页并发、其余工具串行;200 次调用 ≈ 67 个网络波次,墙钟时间失控。
9. **引用保障是提示词级的**:post-write 审计已删(`audit.py:12-15`,理由成立——"答案之后的裁决只能徽章不能修");pre-write evidence check 只覆盖 ≤8 个头源(`executor.py:1142-1210`)。对 40-150 源的报告,这个护栏面不够。
10. **coverage 的文案在撒谎**:模块 docstring 与给模型的 feed 文案仍承诺"a subtask with sources is marked done automatically"(`coverage.py:4-8`、`executor.py:672-676`),实现早已是 PROVENANCE ONLY(`coverage.py:56-61`)——模型被承诺一个不存在的自动化。

### 2.2 后端结构:十个热点

(全量 71 文件 12,150 行;runtime ≈ 5,700 / infra ≈ 3,240 / capabilities ≈ 1,686 / framework ≈ 815)

1. **`runtime/executor.py` 1,455 行** ≥7 职责:工具派发 if-chain(593-1047)、32 处手拼 receipt、四个内联决策 gate(各带 prompt 文本)、belief-ledger 状态机、排序级联编排、SystemOne 格式化。
2. **`runtime/route.py` 619 行**:"thin by design" 的视图函数内含 clarify 预 gate prompt(156-185)、深度探测 5 档评分 rubric(216-256)、工具面装配、[n] 预编号闭包、gallery 校验、187 行 `_Ndjson` 用量合并状态机(413-599)。
3. **~1,000+ 行 prompt 文本散在 Python**(`researcher.py`/`writer.py`/`gates.py` + 决策 gate 指令散落 executor ×4、route ×2、audit),无 prompt 注册表;`spine.py` 只覆盖共享契约。
4. **calculator 被劈成两半两层**:`tools/calculator.py`(spec/parser)+ `capabilities/calculator.py`(求值+settlement),后者**向上 import** runtime(`capabilities/calculator.py:23`)——唯一公开的层序违例。
5. **`capabilities/mcp.py` 310 行 7 种职责**:config、SDK 探测、会话生命周期、spec 生成、渐进披露策略、一个关键词搜索引擎(工具发现)、线程桥接;被三层同时 import。
6. **加一个工具要改 4 处**:`tools/__init__.py` 装配、`executor.execute` if-chain、`rows.display_item` if-chain(两条链手动同步)、`route.py:343-353` 工具面列表。
7. **横切件手抄**:raw-args JSON 守卫 ×8(`tools/args.py` 是正主,7 处绕开)、`settings.get("zjsearch", {})` + env-key 回退 ×7、`enabled/configured/sdk_missing/capability` 四件套 ×7、HMAC prologue ×4(`infra/http.authorize` 存在但 3 个路由手抄)、`_Ndjson`+`_UpstreamDead` ×2(route/overview)、SSRF 门 ×2(images/fetch,黑名单还不一致)、rerank→embed 相关性排序 ×2(`overview._ordered_context` vs `context._relevance_order`)、关键词评分器 ×4。
8. **零 Blueprint,12 个 `install(app)`**,9 个路由 + 1 个 before_request;启用门(gate/configured/sdk-missing)每个 install 各写一遍、措辞各异。
9. **用量记账 5 种形状**:loop `_Tally`、executor 的 rerank/decision 桶、route 的 gate_usage 折叠,decision-token 折叠舞蹈在 executor 重复 4 次。
10. **`stream.py` 429 行**重实现搜索页渲染路径(自有 `_render_context`),feed.py/page.py/knowledge_page.py 三处 lazy `from searx import webapp` 带 cyclic-import 压制。

### 2.3 前端:十个不一致

(aiSearch/ 共 4,388 行;`AiSearchRunSection.tsx` 1,236 行;markdown 渲染 = react-markdown + GFM + mermaid + KaTeX,**表格已支持**)

1. **metric 内容各行其是**:AskRow/MemoryRow 成功态 metric 返回 `""` 但 shell 无条件追加 `· formatMs(ms)` → 孤儿分隔符(`AskRow.tsx:36`、`MemoryRow.tsx:41`、`rowBase.tsx:103-113`,已亲自复核);TaskRow 把原始查询串塞进 mono 数字槽;JudgeRow 塞原始裁决串;McpRow 固定"完成"不带计数。
2. **debug 组成 7-vs-3 分叉**:TaskRow/LearningsRow/AskRow 只挂 DebugArgs 且只看 `rawArgs !== null`——这三类工具带 feed 的调用**在界面上没有任何 receipt 可看**;其余 7 行是 args+feed。
3. **CalcRow 破行法**:唯一无 chevron、结果常显在 Collapse 之外的行(设计上可接受,但未写成规范)。
4. **DecisionsCard 手写第二套行语言并整块复制两遍**(:242-281 与 :289-328),不走 CallRowShell:无 `text-[11px]`、无 middot、`ms` 为空时隐藏。
5. **一页两套时长格式**:行内 `formatMs`;run 头部 ElapsedTimer 手拼秒/分字符串(`AiSearchRunSection.tsx:554-574`);另有 `toFixed(2)` vs 共享 `formatScore`(`toFixed(1)`)两种分数格式。
6. **READ_PANE 机器底衬手抄三次**且互有漂移(DebugArgs 无 font-mono、DebugFeed 有、ThinkScroll 用 px-3);HOVER_CHIP 复制时丢了 backdrop-blur 和 group-focus-within。
7. **6 个 rail section 头手写 6 遍**,其中 Sources 一处类名漂移(`flex shrink-0 flex-wrap`)。
8. **cap-and-expand 三种体制 + 一个没有**:sources/findings/gaps 父控布尔、DecisionsCard 自持 useCapExpand(→ citation-locate 链打不开它)、AskArchiveCard 硬丢旧条目无展开。
9. **CapChip 类名复制 4 份**,margin 漂移(mt-2 vs mt-1.5)。
10. **展开体节奏漂移**:TaskRow/LearningsRow/AskRow/DecisionsCard 四个同形列表四种 px/py/行距,文本管线两种(裸 span vs Snippet+escapeHtml)。

前端已有的正确地基(保留):`rowBase.tsx` 的共享行壳与右侧 mono cluster、`formatMs` 的分层格式、GFM 表格渲染、引用 chip 链、`useCapExpand`+`CapChip`、审计离线闭环(`pnpm run audit` + ai-mock)。

---

## 3. Harness v2:REPORT 运行模型

设计立场:**报告是一个 output 契约,不是第四种 agent**。现有单循环一字不动地继续服务 speed/balanced;报告是 deep 之上的"产出形态"升级(`report` 形态),复用全部既有机制(task ledger、stall 策略、registry、rank、clarify、事件溯源)。

### 3.1 三阶段总览

```
PLAN        RESEARCH                         SYNTHESIZE
─────       ────────                         ──────────
大纲 gate →  现有 loop(增强:                 逐节 write(每节一次补全)
(report     · corpus 持续入库                 · 节上下文 = 大纲+findings
meta+       · extract/表格产物工具              +该节 packed corpus+artifacts
sections)   · compaction(转写折叠)            +相邻节摘要)
  ↓         · researcher 可修订大纲            · 节级引用 gate(交付前)
task ledger ←                                 · settle 前方法论文本自动生成
```

浅模式(单写)与报告模式在 wire 上的差别:报告模式多发 `outline` / `artifact` / `section` 事件,`answer` 缓冲被 `sections[]` 取代;客户端按 **有无 outline 事件** 选渲染器——旧服务器/旧客户端互相兼容。

### 3.2 大纲:task_write 的结构化超集

不新增孤立工具——把 `task_write` 的 `items[{title,status}]` 升维为 `sections[{title, brief, key_questions[], artifact_needs[]}]`:

- **初始化**:clarify(若有)解决方向后,一个 json_completion gate 从 `question + clarified + depth-rung` 生成 4-10 节的大纲骨架(含报告 meta:标题/副标题/数据窗口)——模型写,不免费瞎猜;
- **Living list**:RESEARCH 阶段 researcher 照旧用 `task_write` 增量修订(它是既有的 living task list 机制,coverage 匹配逻辑原样沿用);允许增删节、改 brief;
- **双重身份**:大纲既是 researcher 的作业清单(coverage/ledger 关闭条件),也是 writer 的写作骨架,也是客户端的目录/进度面(每节状态:调研中 → 撰写中 → 完成);
- **验收钩子**:每节 `artifact_needs[]`(如 `table:capacity`, `table:price-matrix`)声明该节需要的产物,SYNTHESIZE 前校验——产物缺失的节要么降级为"定性论述",要么在成稿中显式标注证据缺口。

### 3.3 Run Corpus:运行内语料检索(逐节上下文装配的地基)

现状的根本矛盾:writer 要写 8 节,但 40k 字符装不下 100 个来源;`<findings>` 是散文,撑不起表格。解法是把"运行"本身变成可检索语料:

- **入库**(RESEARCH 期间持续):每个 web_search 的全量结果(30 条/次,feed 只展示 5+5)、web_reader 全文(现归档进 knowledge 的同一份)、learnings 事实、calculator 结果、extract 表格行;
- **索引**:内存 BM25(复用 `bm25_reranker` 的 CJK tokenizer)起步;`zjsearch.embedding` 开启时加向量通道——直接把 `overview._ordered_context` 与 `context._relevance_order` 这对重复实现合并成唯一的 `corpus.order()`;
- **消费**:每节 write 前 `corpus.pack(section, budget)` —— 该节 key_questions + brief 作查询,取 top-k 块(块 = 来源段/事实/表格行),按节预算(6-10k 字符)打包;**相邻节只带标题+一句话摘要**,防重复;
- **附带收益**:follow-up 问答可以первый从 run corpus 作答(现在 follow-up 只有 4 轮 2k 字符历史);断点继续(continue)后新 run 可继承语料索引的持久化部分。

### 3.4 结构化产物:`extract_table` 工具 + Artifacts 通道

这是让"表格带单元格引用"成为可能的核心新增:

- 工具 `extract_table`(researcher 调用):`{title, columns[], rows: [{cells[], refs: [n]}]}` —— researcher 在阅读中把分散数据固化成表,**单元格级 [n] 绑定**;校验 refs 必须已在 registry(与 gallery 白名单同一信任模型);
- 产物在 wire 上以 `artifact` 事件给客户端(replace-per-id,同 `tasks` 的快照语义);SYNTHESIZE 时以"已验证数据"身份进入对应节的上下文,writer 的职责从"重建表"降为"引用并解说表"——与 `<figures>` 诚实规则完全自洽(数字来自被引用的输入,推导留给 calculator 并要求写明推导);
- `record_datum`(轻量单点:数值 + refs + 语境一句话)作为表的补充,喂给执行摘要与对比句;
- 客户端:`ArtifactTable` 真表格组件(单元格引用 chip 可点击定位 rail 来源),样式沿用 `AiSummary` 现有 GFM 表格语言。

### 3.5 分节撰写协议(SYNTHESIZE)

- 每节**一次独立 write call**(顺序执行;节间无依赖的以后可并行):
  上下文 = 全局 spine(答案契约/引用规则/figures)+ 大纲全文 + 全部 findings(压缩态)+ 本节 `corpus.pack()` + 本节 artifacts + 前节末尾 200 字符摘要;
  输出 = 本节 markdown(1-3k 字符),流式走 `section` 事件(增量 append 到该节缓冲,客户端实时渲染该节);
- **节级引用 gate(交付前)**:每节交付时对"本节 [n] 所指来源是否支撑对应句子"做一次抽查式校验(判断模型,复用 decision 面或 json gate;每节抽 3-5 处)。失败 → **该节立即重写一次**(带上违规点),而不是徽章。这是 post-write 审计被删除时给出的理由("答案之后只能徽章")在结构上的修复:审计挪进了节间,答案还未最终交付;
- `related`/gallery 契约只在**最后一节**尾部生效(follow-ups fence 不变);
- **执行摘要节**最后写(它综述全文,必须看到全部节成品);方法论脚注由**机器生成**(轮次/来源数/调用数/模型/耗时/数据窗口),不劳模型。

### 3.6 上下文工程:转写折叠(compaction)

- 触发:累计 feed 字符越过阈值(现 24k 的 `FEED_CONVERGE_NOTE` 位置)或轮次 > N;
- 动作:把最旧 K 轮的 tool 结果消息折叠为一条机械摘要消息(保留:每轮的 learnings 增量、查询列表、命中计数;丢弃:原始 feed 文本——反正已入 corpus);
- **前缀缓存友好**:折叠点对齐到 K 的倍数轮,两次折叠之间前缀字节稳定(折叠是低频跳变,不是每轮扰动);
- learnings/task/registry 是持久账本,永不折叠。

### 3.7 执行预算

- `MAX_PARALLEL` 3 → **6**(配置化 `zjsearch.feature.ai_search.max_parallel`);
- write max_tokens **服务端显式化**:speed 2k / balanced 4k / deep 6k / report 每节 4k(部署可 `zjsearch.ai.params.max_tokens` 覆盖;Anthropic 的 4096 隐式默认随之消亡);
- 节级超时与整 run 墙钟护栏(goal 的 `max_seconds` 机制沿用,报告档默认 0 = 不限,可配);
- 深度探测 ladder 不变(deep 最高 120 轮),报告模式在 rung ≥ 3 时才开放(12+ 轮的题不值得报告形态)。

### 3.8 Wire 协议增量(闭集扩充,向后兼容)

| 事件 | 载荷 | 语义 |
|---|---|---|
| `outline` | `{title, subtitle, window?, sections: [{id, title, brief?, status}]}` | 快照 replace(同 `tasks`);客户端目录 + 进度 |
| `artifact` | `{id, kind: "table", title, columns, rows, refs}` | 快照 replace per id;单元格 [n] 绑定 |
| `section` | `{id, delta}` | 该节 markdown 增量;`settle` 前 sections 全部落位 |

浅模式不发这三个事件;客户端以"收到过 `outline` 与否"切换 Answer 渲染。`settle` 语义不变;late set(related/memory/tags/usage)不变。

### 3.9 客户端:Document 渲染

- 有 outline:`DocumentView` = 封面头(meta)+ 粘性 TOC(章节锚点,`scrollIntoViewAnimated` 既有链)+ 逐节 `MarkdownAnswer` 复用(节内渲染器就是现有 markdown 管线:GFM 表格/mermaid/KaTeX/引用 chip 全部继承)+ `ArtifactTable` 替换对应占位;
- 无 outline:现有 `MarkdownAnswer` 原样(单写模式);
- 执行摘要、建议卡、风险矩阵 = markdown 结构(粗体字段标签),不新增协议;
- 图表(chart)列 P2:先提升 `Stock.tsx` 的 `makeScale`/`SegmentLine`/`RangeLine` 为 `lib/chart.tsx` 公共原语,`artifact kind:"chart"` 后续接入;v1 报告以表格为主(两张样例亦是)。

### 3.10 质量与诚实

- 引用密度:每节 prompt 要求"每个实质断言带 [n];无来源支撑的断言要么删要么明确标注证据缺口"——与 spine 的 grounding 规则同源;
- 矛盾检测:`audit.finding_conflict`(embed 近邻 + noul)从"ledger 记录时"扩展到"节撰写前对本节引用集复查";
- 方法论脚注:机器生成,含局限陈述(数据窗口内、引擎覆盖范围)——样例报告的"研究方法与数据说明"是诚信特性,不是装饰;
- 修复 §2.1-10 的文案谎言(coverage 自动标 done)。

---

## 4. 后端结构 v2(from zero)

### 4.1 目标目录树

原则:依赖严格向下 `api → runs → tools → agent → llm → core`;**tools 与 runs 都不允许 import api**;prompts 独立成包(它是被 runs/tools 消费的素材,不是逻辑)。

```
searx/zjsearch/
  __init__.py                 # install(app) 链(保持)
  stream.py                   # 渲染/流式搜索页(保持,内聚已可)
  pwa.py                      # 保持
  ai/
    __init__.py               # 装配:遍历 api/routes 注册
    core/                     # 【新】横切底座,零 AI 语义
      config.py               #   settings 读取 + env-key 回退(归一 7 处)
      security.py             #   HMAC(自 infra/security 迁入)
      usage.py                #   Usage dataclass + fold(归一 5 种记账形状)
      ndjson.py               #   Ndjson 流包装(归一 route/overview 两份)
      text.py                 #   raw_args/json 守卫、截断、keyword scorer(归一 8+4 处)
      guard.py                #   SSRF 门(归一 images/fetch 两套黑名单)
      clock.py                #   超时常量集中 + ms 计时器
    llm/                      # 【= infra 改名】供应商层
      sdk/  caching.py  jsongate.py  streaming.py
      embed.py  rerank.py  decision.py  http.py
    agent/                    # 【= framework 改名】引擎层
      loop.py  wire.py  executor.py(仅契约)  echo.py  thinkgate.py  fences.py
    prompts/                  # 【新】prompt 注册表:文本离开业务文件
      spine.py  researcher.py  writer.py  gates.py  referee.py  extractor.py
      (每个块 = 常量 + 变量注入函数;语言指令唯一出口)
    tools/                    # 【核心重组】一工具一包,自包含
      base.py                 #   Tool 协议 + ToolContext + Receipt builder(归一 32 处手拼)
      registry.py             #   TOOLS: {name: Tool};派发、spec 汇总、row 语义
      web_search/  web_reader/  calculator/  learnings/  tasks/
      ask_user/  memory/  past_research/  judge/  mcp/
      extract/                #   【新】表格/数据点产物工具(§3.4)
      (每包:spec.py 模式+描述 | run.py 执行 | settle.py receipt+feed 贡献)
      web_reader/ 内含原 capabilities/reader 的 fetch/extract/config 三件套
    runs/                     # 【= runtime 业务核心】具体任务
      profile.py              #   模式/预算(修死键)
      search/
        gather.py             #   搜索执行+settle(自 executor 解体)
        ledger.py             #   belief ledger + coverage
        referee.py            #   plan_review / coverage_referee / evidence_check / read_gate
        rank.py  registry.py  feed.py  coverage.py
        context.py            #   writer 上下文预算(与 corpus 合并 §3.3)
        corpus.py             #   【新】Run Corpus(§3.3)
        task.py               #   run 装配(原 route._search 的业务件)
      report/                 #   【新】报告运行(§3)
        outline.py  sections.py  synth.py  artifacts.py  method_note.py
      overview.py  thread.py
    api/                      # 【= 路由集中地】HTTP 面,薄
      authorize.py            #   统一 HMAC prologue(归一 4 处)
      routes.py               #   9 个端点的视图,只做:解析→调 runs→包流
      install.py              #   唯一 add_url_rule 处(或保留 per-module install,但门走 authorize)
```

改名说明:`infra→llm`、`framework→agent`、`runtime→runs` 是**可选的纯重命名**,放迁移最后一拍;先到位的是内容划界(下面 §4.6)。

### 4.2 Tool-as-Package 契约

```python
class Tool(Protocol):
    name: str
    def spec(self, ctx: RunContext) -> ToolSpec          # JSON schema + description
    def run(self, ctx: RunContext, args: dict) -> ToolOutcome   # 执行(async 友好)
    def settle(self, outcome: ToolOutcome) -> Receipt     # wire "call" 事件字段
    def feed(self, outcome: ToolOutcome) -> str | None    # 对 writer/corpus 的贡献
```

- `registry.TOOLS` 是唯一派发表:executor 的 if-chain 与 `rows.display_item` 的 if-chain 同时消亡;**新增工具 = 一个包 + 一行注册**(现在要动 4 处);
- `Receipt` 由 base 的 builder 统一构造(status/n/ms/feed[:800]/...),32 处手拼消失;
- 工具包内部自由(web_reader 保持 fetch/extract/config 三模块),对外只有契约;
- `run()` 的并发语义在包上声明:`parallel=True`(search/reader/mcp)进线程池,`inline`(计算/记账类)当场执行——现在"哪些能并行"是 executor 里的隐式知识。

### 4.3 现文件 → 新位置映射(capabilities 解体表)

| 现位置 | 新位置 | 备注 |
|---|---|---|
| `runtime/tools/{web_search,web_reader,learnings,tasks,ask_user,judge,memory,past_research,calculator}.py`(spec/parser) | `tools/<name>/spec.py` | 与实现合体 |
| `runtime/executor.py` 派发分支 | `tools/registry.py` | if-chain → dict |
| `runtime/tools/rows.py` | 删除(前端 settlement-view 取代;后端仅在 Receipt 里带 label/metric 语义字段) | |
| `capabilities/calculator.py` | `tools/calculator/`(eval+settle 并入) | 消灭上向 import |
| `capabilities/reader/*` | `tools/web_reader/` | 三模块原样迁 |
| `capabilities/mcp.py` | `tools/mcp/`(拆 config/connection/spec/discovery 四模块) | |
| `capabilities/user_memory.py` | `tools/memory/` | |
| `capabilities/past_research.py` | `tools/past_research/` | |
| `capabilities/images.py` | `runs/attachments.py`(overview 专属多模态附件) | SSRF 门换 `core/guard` |
| `runtime/{researcher,writer,spine,gates}.py` 的 prompt 文本 | `prompts/` | 业务文件只留装配函数 |
| `runtime/route.py` 的 gate/prompt/装配 | `runs/search/{task,referee}.py` + `prompts/` | route 只剩 HTTP |
| `runtime/executor.py` 的搜索执行/ledger/referee | `runs/search/{gather,ledger,referee}.py` | executor 本体瘦回 <300 行的 orchestration |
| `route._Ndjson` + `overview._Ndjson` | `core/ndjson.py` | |
| `overview._ordered_context` + `context._relevance_order` | `runs/corpus.py` 唯一实现 | |

### 4.4 依赖规则与守护

- 一条 nose2 单测(`tests/unit/test_zjsearch_layers.py`,后端测试是上游既有设施,不违反"client 无测试"政策):静态扫描 `ai/` 的 import 边,断言无向上/跨包违例,并列出白名单(searx 核心的 3 处 lazy webapp);
- pylint 照旧两把尺;`raw_args`/receipt/usage 之类归一后,新增重复会被 review 直接看见(文件数少了)。

### 4.5 迁移路径(为什么不是大爆炸)

zjsearch 分支持续在发功能,大爆炸重写必然长期双头。绞杀式五阶段,每阶段独立可发布、lint + AI-mock 审计通过:

- **M1 底座**:建 `core/`(ndjson/usage/text/guard/config/security),调用点逐个切换。行为零变化。
- **M2 工具包化**:逐工具迁移(每个工具一个 commit:spec+run+settle 合体、registry 注册、删 if-chain 分支)。calculator 先行(消灭层序违例),mcp 最后。
- **M3 route 瘦身**:gate/装配逻辑迁 `runs/search/`,`api/` 面收口;`prompts/` 建。
- **M4 executor 解体**:gather/ledger/referee/corpus 拆分;context 归一。
- **M5 改名拍**(可选):infra→llm、framework→agent、runtime→runs。

---

## 5. 前端结构 v2

### 5.1 ToolRow 内核 + settlement-view 注册表

把 10 个行组件的公共骨架(open/debug 状态机、shell、Collapse 编排)收进唯一内核,每工具只剩一个**声明式 view**:

```
features/results/aiSearch/tools/
  types.ts        # ToolView 契约:
                  #   label(call): string
                  #   metric(call, phase): MetricSpec   // {kind:"count"|"chars"|"value"|"text", text}
                  #   expandable(call): boolean         // 默认 true
                  #   Content?: (call) => ReactNode     // 展开体
                  #   Debug?: "full" | "args"           // 默认 "full"(消灭 7-vs-3 分叉)
  ToolRow.tsx     # 唯一内核:状态机 + CallRowShell + Collapse 编排
                  # 内核规则:metric.text 为空 ⇒ 不渲染 middot(修复孤儿 ·)
  registry.ts     # TOOL_VIEWS: Record<ToolName, ToolView>;未知工具 → webSearch 兜底(现状保持)
  views/
    webSearch.tsx  webReader.tsx  calculator.tsx  learnings.tsx  tasks.tsx
    askUser.tsx    judge.tsx      memory.tsx     pastResearch.tsx  mcp.tsx
```

- 与后端 `Tool.name` 注册表镜像(同 macros.html↔types.ts 的同步契约模式):后端新增工具,前端没写 view 时兜底行 + args/receipt debug 仍可用(不再静默破相);
- Debug 统一:所有可调工具行都有 args + receipt 两个 pane,失败 receipt 渲染为 Error pane(现有语义保留);calculator 是**成文特例**:无 chevron、结果常显——写进规范而不是留在代码里靠读;
- DecisionsCard 的行并入 CallRowShell 视觉(11px mono + middot + metric 槽),删除复制两遍的手写块。

### 5.2 Metric / Timing 规范(一份表格管所有行)

| 工具 | pending | ok | 说明 |
|---|---|---|---|
| web_search | 检索中… | `{n} 条结果` / 无结果 | n=0 显式"无结果",不显示 "0 条" |
| web_reader | 读取中… | `{chars} 字`(12.3k 缩写) | |
| calculator | 计算中… | `= {result}` | 特例:无 chevron |
| task_write | 生成中… | `{done}/{total}` | 替换现在的原始查询串 |
| learnings | 记录中… | `{n} 条事实` | |
| ask_user | 等待输入… | 回答摘要 ≤1 行 | |
| judge | 判断中… | `{choice} · {score}`(formatScore) | |
| user_memory | 保存中… | `{n} 条记忆` / `已保存` | 空 metric ⇒ 无分隔符 |
| past_research | 检索中… | `{n} 条命中` | |
| mcp_* | 执行中… | 完成描述(有计数带计数) | |

通用规则:全部 `font-mono text-[11px] tabular-nums`(共享 cluster 已是,规范成文);时长一律 `formatMs`;run 级时长 ElapsedTimer 改用 `formatDuration`(与 formatMs 同族,消除第二套词汇);分数一律 `formatScore`。

### 5.3 Rail 统一:`RailSection` + `CapSection`

```
rail/
  RailSection.tsx   # 唯一 section chrome(icon + title + count;6 处手写归一)
  CapSection.tsx    # = RailSection + useCapExpand + CapChip + forwardRef(forceExpand)
                    # citation-locate 从此能打开任意节(修复 DecisionsCard 不可达)
  TaskCard / FindingsCard / GapsCard / SourcesCard / DecisionsCard / AskArchiveCard
```

- 所有 cap 节统一 `useCapExpand` 单一体制(cap 4,父控/受控混合消除);AskArchiveCard 硬丢旧条目改为标准 cap+expand;
- `CapChip` 类名只存在于 CapSection 一处。

### 5.4 Answer / Document 渲染器

- `MarkdownAnswer`(AiSummary)保持为**节内渲染器**;新增 `report/DocumentView.tsx`:封面头 + TOC(锚点滚动走 `motion.ts`)+ 逐节渲染 + `ArtifactTable`;
- knowledge 页那份重复的 markdown table override 收编为共享 `lib/markdownParts.tsx`;
- `AiSearchRunSection.tsx`(1,236 行)拆为:`AnswerPane` / `RunRail` / `AskGate` / `Composer` / `ElapsedTimer` 五块,页面文件回到组装层(对齐"pages 薄、features 厚"的家规)。

### 5.5 目标目录树

```
features/results/aiSearch/
  timeline.ts  useAiSearch.ts(depth.ts / ledger.ts 保持)
  runs/AiSearchRunSection.tsx(拆后)
  tools/(§5.1)  rail/(§5.3)  report/(§5.4)
  calls/rowBase.tsx(内核吸收后仅留 CallResults/CallContent 等内容件)
```

---

## 6. 路线图

| 里程碑 | 内容 | 验收 |
|---|---|---|
| **M0 止血**(可立即做,不等重构) | ① `_DEPTH_SHAPE` 补 `deep` 键(真分节长文 shape)+ 清死键(quality/goal);② deep prompt 的 "18 rounds" 与配置对齐;③ 行内核空 metric 不渲染 middot;④ coverage 文案改诚实(PROVENANCE ONLY);⑤ ElapsedTimer/DecisionsCard 数字格式统一 | lint + 审计通过;deep 模式产出明显变长变结构化 |
| **M1 Harness spike** | report 形态最小闭环:outline gate + Run Corpus(BM25 起步)+ extract_table + 3 节 SYNTHESIZE + `outline/artifact/section` wire + 客户端 DocumentView 雏形 | 用两份样例报告的原题重跑,人工对比:结构齐、表格有单元格引用、长度 ≥8k 字符 |
| **M2 前端统一** | ToolRow 内核 + views + RailSection/CapSection + RunSection 拆分 | 审计页无回归;新增工具只写一个 view 文件 |
| **M3 后端 M1+M2 阶段**(core/ + 工具包化) | 见 §4.5 | 分层测试绿;两把 pylint 绿;行为零变化 |
| **M4 Harness 完全体** | 节级引用 gate + compaction + 并发 6 + max_tokens 显式化 + 方法论脚注 + 断点续写覆盖 report 模式 | 120 轮级长跑稳定;引用抽查失败自动重写生效 |
| **M5 后端 M3+M4 阶段**(route 瘦身 + executor 解体 + 可选改名) | 见 §4.5 | 全量审计 fixtures 覆盖 report 模式(ai-mock 扩充) |

依赖关系:M1 不依赖后端重构(在现有文件里先长出 report/,证明价值);结构迁移(M3/M5)随时可以插入而不与 harness 冲突——这正是绞杀式的意义。

---

## 7. 风险与未决问题

1. **成本**:报告模式一次 run 输出 30-60k tokens(逐节 write 比单写贵)+ 更长的 RESEARCH。缓解:prefix caching 已按 dialect 设计;节级 write 共享字节稳定前缀;报告档显式标注为 deep+ 消耗级。
2. **节间连贯**:逐节撰写可能松散。缓解:大纲 brief + 相邻节摘要 + 全局 findings 三层黏合;执行摘要最后写兜底全文口径;不满意时保留"单写模式"作为 fallback 形态(同一 harness,不同 output shape)。
3. **小模型大纲质量**:大纲烂则全文烂。缓解:outline gate 带结构校验(节数/字段);质量差可由 clarify 轮人工纠偏;未来可加"大纲修订"人机环节。
4. **corpus 一致性**:BM25 内存索引在进程内,断点继续后跨 run 复用要靠 knowledge 的 document 归档重建索引(v1 先做 run 内,跨 run 留待 v2.1)。
5. **重构窗口**:M3-M5 期间分支功能冻结策略需要约定(或严格按工具粒度小步走,保持每步可发版)。
6. **未决**:① 节级引用 gate 用 decision 模型还是 json gate(成本/准确权衡);② `section` 事件是否携带每节独立 settle(供 TOC 打勾)——倾向是;③ 图表(P2)的最小 kind 集(先 line/bar,数据来自 artifact);④ follow-up 是否升级为"report 内追问"(corpus 作答,不重跑研究)——倾向是,零新增协议。

---

## 附:本方案的直接 bug 修复清单(均已在代码中核实)

| 位置 | 问题 | 修法 |
|---|---|---|
| `runtime/writer.py:21-36` | `_DEPTH_SHAPE` 无 `deep` 键,`quality` 不可达 | 补 deep(结构化长文),删 quality |
| `runtime/context.py:30-36` | `"goal"` 死键 | 删 |
| `runtime/researcher.py`(deep 块) | "up to 18 rounds" vs 配置 120 | 文案对齐 rung |
| `runtime/coverage.py:4-8`、`executor.py:672-676` | 承诺"自动标 done"但实现是 PROVENANCE ONLY | 改文案 |
| `calls/rowBase.tsx:103-113` | 空 metric 仍渲染 `· 耗时` | metric 空 ⇒ 无分隔符 |
| `DecisionsCard.tsx:93` vs `format.ts:72-74` | `toFixed(2)` vs `formatScore` | 统一 |
| `AiSearchRunSection.tsx:554-574` | ElapsedTimer 第二套时长词汇 | `formatDuration` |
| `route.py:343-353` + 两 if-chain | 加工具改 4 处 | registry(结构性,归 M2/M3) |

---

## 实施状态(2026-10-07 重构落地)

本方案已实施完毕,验证状态:

- **后端结构 v2**:`ai/` 重组为 `core / llm / agent / prompts / tools / runs / api` 七包;capabilities 解体(每工具一个自包含包);executor 按 state/gather/referee/handlers 四 mixin 拆分;路由集中 `api/` 且 HMAC prologue / NDJSON / SSRF / config / raw-args / usage 全部归一。两把 pylint 通过(engines 10.00,主包零告警),nose2 340/340。
- **Harness v2(report 模式)**:wire 三事件(outline/artifact/section)、Run Corpus(BM25+rerank+embed 兜底)、`extract_table` 工具(单元格级 [n])、大纲 gate、逐节 SYNTHESIZE、节级引用 gate(decision 模型,交付前重写)、机器方法论脚注、MAX_PARALLEL=6、Anthropic 默认 max_tokens 16384。
- **前端 v2**:ToolRow 内核 + 11 个 settlement-view(空 metric 不再渲染孤儿分隔符、debug 全行通用、任务行 done/total 计数)、RailHeader 六卡统一、DecisionsCard 去重收编、formatDuration 单一时长词汇、deep 模式真分节 shape、DocumentView(TOC+分节流渲染)。
- **调试台**:`/zjsearch/ai/thread/<uuid>?aidebug` —— fixture wire 流走真实 fold+渲染管线,覆盖全部工具行×状态/报告进行中/澄清门/失败态,支持流式回放。
- **真实环境验证**:balanced 模式端到端(79 次工具调用、15 轮、465 源、rerank 级联 61 次、ledger 59 条事实、calculator 验算、4/4 子任务关闭,7 分钟);report 模式验证了 clarify 预 gate(高风险交付物先对齐,`settle: awaiting`)。浏览器视觉校验通过(暗色,调试台四场景)。
- **已知环境约束**:共享代理出口 IP 高频检索会触发引擎 CAPTCHA/限流(真实部署应使用独享出口或官方搜索 API);这属于部署网络层,与本次重构无关。
