// frontend/index.js for Memory Wizard (st-memory-wizzard)
//
// ══════════════════════════════════════════════════════════════════════
//  文件导航：本文件较大，按 `REGION:` 关键字搜索可在各功能区段间跳转。
//  主要区段顺序：配置与默认值 → 运行时状态 → 通用工具 → LLM 调用基建 →
//  记忆树(查找/渲染/持久化) → 摘要数据模型 → 楼层覆盖映射 → 宏编译 →
//  伪造聊天历史注入 → 宏注册 → 配置 load/save → 摘要 load/render →
//  路由与生成钩子 → 填树管线 → 日记/周记/史记融合 → 时记规则 →
//  删楼重映射 → 上下文融合沙盒 → 设置表单事件绑定 → 初始化。
// ══════════════════════════════════════════════════════════════════════

const MODULE_NAME = 'st-memory-wizzard';
const LOG_PREFIX = '[Memory Wizard]';

// Build request headers for all plugin backend fetch() calls.
// SillyTavern enforces CSRF protection: every POST must carry the X-CSRF-Token
// header, otherwise the server returns 403 "Invalid CSRF token".
// SillyTavern's script.js exports getRequestHeaders() which bundles both
// Content-Type and the token. We try to use it; if unavailable, fall back to
// reading the token from the global `token` variable that ST sets on page load.
function getWizardHeaders() {
    try {
        // Prefer SillyTavern's own helper (always up-to-date)
        const stHeaders = window.SillyTavern?.getContext()?.getRequestHeaders?.();
        if (stHeaders) return stHeaders;
    } catch (_) { /* ignore */ }
    // Fallback: manually construct with the global CSRF token
    const headers = { 'Content-Type': 'application/json' };
    if (typeof window.token === 'string' && window.token) {
        headers['X-CSRF-Token'] = window.token;
    }
    return headers;
}

// ══════════════════════════════════════════════════════════════════════
// REGION: 配置与默认值（config 对象 + 内置默认 prompts / 常量）
// ══════════════════════════════════════════════════════════════════════
let config = {
    N_RECAP: 10,
    N_TREEFILL: 10,        // 后快模型填树触发条数：每累积这么多新楼层，打包发给「回复后·填记忆树模型」填树（与日记归档完全解耦）
    N_MERGE: 100,
    N_MELON: 500,
    N_SHIJI: 20,
    K_RECALL: 5,
    TOKEN_CAP: 8000,
    // "Morning recap" trigger: when the latest reply arrives after a long pause
    // since the previous reply AND the current local clock falls inside the
    // user-defined morning window, auto-summarize all uncovered earlier floors
    // (capped at morningMaxFloors) into a single 日记. The new reply itself is
    // NOT included in the summary — it's the wake-up message.
    // Per-layer automatic summarization toggles. All default true so existing
    // setups keep their old behavior. The master switch (isEnabled) gates
    // EVERYTHING; these three only matter when the master is on.
    autoRecap: true,       // 自动生成日记
    autoWeekly: true,      // 自动把日记融合成周记 (cascade)
    autoHistorical: true,  // 自动把周记融合成史记 (cascade)
    enableMorningRecap: false,
    morningGapMinutes: 360,      // gap since previous reply, in minutes (6h default)
    morningWindowStart: "05:00", // local-time window lower bound (HH:MM)
    morningWindowEnd: "10:00",   // local-time window upper bound (HH:MM)
    morningMaxFloors: 50,        // upper bound on how many floors a morning recap covers
    morningMinFloors: 1,         // skip morning recap if uncovered floor count is below this
    // 写日记轮跳过时记滚动缓存断点（防无效缓存）。本轮回复后若会触发日记/晨间归档，
    // 那批最老时记楼即将被归档、时记窗口整体位移，滚动断点缓存的大前缀下一轮必然作废。
    // 此时只保留 preset 周记/日记 之间的 system 固定锚点。默认开；可关掉用于调试对比。
    skipRollingOnRecapTurn: true,
    PIN_BUDGET: 3000,
    treeInjectionMode: 'all',  // [deprecated, migration-only] 旧二档注入模式；已由下面 mtInclude*/mthInclude* 取代，仅在 loadConfig 迁移时读一次
    // {{memory_tree}} 注入内容开关（可任意组合；全关 → 该宏输出空串）
    mtIncludePath: true,        // 路径/节点名称（每个节点块的【path】行）
    mtIncludeHint: false,       // hint（{{memory_tree}} 原本不含 hint，默认关以保持旧行为）
    mtIncludePinBody: true,     // pin 正文（钉死节点，走 PIN_BUDGET）
    mtIncludeRoutedBody: true,  // 路由召回正文（路由没跑时回退全树，走 TOKEN_CAP）
    mtIncludeAllBody: false,    // 全部节点正文（字面全树非 pin，绕过路由，走 TOKEN_CAP）
    // world-info 式关键词硬触发：keywords 命中最近聊天的节点，命中即把正文注入 {{memory_tree}}（绕过路由）。
    // 默认关。{{memory_tree}} 本就是逐轮变化的召回宏，应放在滚动缓存断点之后，故此开关不影响 header/system 前缀缓存。
    mtKeywordTrigger: false,
    // {{memory_tree_header}} 注入内容开关
    mthIncludePath: true,       // 路径/节点名称（- title）
    mthIncludeHint: true,       // hint（| hint）
    // {{memory_tree_header}} 路径索引瘦身（默认 0 = 关，零行为变化）
    mthMaxDepth: 0,             // 最大层级：>0 时只保留前 N 层，更深的节点（及子树）不进索引，被砍处母标题加 …
    mthMaxChildren: 0,          // 子项折叠阈值：>0 时某节点可见直接子项 > N 则折叠（不展开子项，母标题加「(N 项)」）
    TIMEOUT_MS: 8000,
    SUPP_READ: 1,
    fableProfile: "",     // 旧版统一档；新版各任务独立配置后保留作回退链(见 getProfileFor)，勿删
    flashProfile: "",     // 旧版统一档；新版各任务独立配置后保留作回退链(见 getProfileFor)，勿删
    fusionProfile: "",
    // Fusion panel (史记/周记融合器) sticky settings — remembered across refresh.
    fusionSource: "floors",        // 'floors' | 'records'
    fusionType: "historical",      // 楼层正文模式融合成的摘要类型
    fusionRecordFrom: "weekly",    // 已有记录模式的来源层
    fusionRecordPicks: {},          // 已有记录模式勾选态：{ historical:[idx,...], weekly:[...], recap:[...] }
    fusionStart: "",               // 起始楼层编号（legacy/global fallback）
    fusionEnd: "",                 // 结束楼层编号（含；legacy/global fallback）
    fusionRangesByChat: {},         // 每个角色/群组一套上下文融合起止楼层：{ [activeChatId]: { start, end } }
    // Per-task connection profiles. Each one drives a specific call-site:
    routingProfile: "",     // 回复前·记忆树检索 (路由召回)
    routingKeywords: "",    // 逗号分隔；非空时仅当上一AI回复或最新user回复命中关键词才触发前模型路由（空=每轮）
    routingDummyTool: true, // 给路由请求附一个无操作 dummy tool（tool_choice:auto），绕过某些反代「empty tools」拒绝；个别厂商不收 tools 时可关
    // 场景化主回复连接配置：开启后，每次生成前由前快模型从三种场景（教学/剧情/亲密）
    // 中选一种，并在本次生成开始前切换酒馆「主回复」连接配置，对当前这条回复生效。
    sceneSwitchEnabled: false,
    sceneTeachingProfile: "",   // 教学场景 → 切换到的连接配置名
    scenePlotProfile: "",       // 剧情场景
    sceneIntimateProfile: "",   // 亲密场景
    gatewayProfile: "",         // 本地反代网关按钮切换到的连接配置名（Claude源 + reverse_proxy=http://127.0.0.1:8788）
    promptSceneSelect: "",      // 自定义·场景选择 prompt（空=内置默认）
    recordTagEnabled: true, // 主模型输出 <标签>…</标签> 时按需调 treeFill 填树
    recordTagName: "record",// 触发按需填树的标签名（默认 record，可自定义为任意标签）
    recallTagName: "recall",// 主模型主动补读的标签名（默认 recall，可自定义）
    promptRouting: "",      // 自定义·前模型路由 prompt（空=内置默认）
    promptRecall: "",       // 自定义·补读续写注入文本（空=内置默认；支持 {path}/{content}）
    promptTreeFill: "",     // 自定义·每X条自动填树 prompt 头部（空=内置默认）
    promptRecordFill: "",   // 自定义·record 函数触发填树 prompt 头部（空=内置默认）
    promptTreeFillMethod: "", // 自定义·填树方法说明（缩进树→完整路径，空=内置默认）
    treeFillProfile: "",    // 回复后·填记忆树 (事实抽取/写树)
    recapProfile: "",       // 日记自动生成
    weeklyProfile: "",      // 周记自动 fuse
    historicalProfile: "",  // 史记自动 fuse
    // 全局兜底：任一任务 profile 调用失败（额度耗尽/密钥失效/超时）时先用它重试一次，
    // 它也失败才回退到酒馆激活 API。空=保持旧行为（直接回退激活 API）。
    fallbackProfile: "",
    macroMemory: "memory_tree",
    macroTreeHeader: "memory_tree_header",
    macroHistorical: "memory_historical",
    macroWeekly: "memory_weekly",
    macroRecap: "memory_daily",
    macroShiji: "memory_hourly",
    macroFusion: "memory",
    fusionTemplate: `{{memory_historical}}

(以上为史记)

{{memory_weekly}}

(以上为周记)

{{memory_daily}}

(以上为日记)

{{memory_tree_header}}

(以上为记忆树路径索引)

{{cache_anchor}}

{{memory_hourly}}`,
    uiColor: "#a3842e",
    uiWidth: 90,
    uiHeight: 95,
    sandboxPageSize: 100,
    sandboxRegex: "",
    sandboxKeyword: "",
    sandboxKeywordMode: "phrase", // 关键词空格分词时的匹配方式：phrase=整段 | and=都含 | or=任一
    sandboxMatchMode: "keyword",
    shijiRegex: "",            // legacy single-regex; migrated into shijiRules on load
    shijiMode: 'uncovered',    // 时记 floor selection: 'fixed' | 'uncovered'
    shijiKeepFloors: 0,        // 始终保持X楼：始终至少保留最近 X 楼正文（即使已被日记/周记/史记覆盖），防刚总结完无正文参照导致角色偏移。0=关闭
    shijiShowFloor: false,      // 时记注入是否附带楼层编号 [楼层 N]
    shijiShowRealDate: false,   // legacy: 已被 shijiShowDateAi/User 取代，迁移时读取
    shijiShowDateAi: false,     // AI 楼附带现实时间
    shijiShowDateUser: false,   // User 楼附带现实时间
    shijiShowModel: false,      // 时记每楼附带模型名（msgModel 读取）
    shijiRules: [],            // [{ regex, posMin|null, posMax|null, role:'ai'|'user'|'both' }]
    summaryDefaultShowRealTime: false, // 新建日记/周记/史记默认开启蓝色小时钟（现实时间注入）
    fakeChatHistory: false,         // 伪造成聊天历史：用 setExtensionPrompt(IN_CHAT) 把记忆插进 user 消息前，并计入 Itemization
    fakeChatHistoryIncludeSummaries: false, // 伪造历史时，将史记/周记/日记合成一条 assistant 消息
    // Saved match-mode templates: [{ name, filters:[...], keyword, regex }]. The
    // active one drives both the editor view and {{history}}.
    matchTemplates: [],
    activeMatchTemplate: "",
    fusionIncludePreset: false,
    fusionApplyFilters: true,
    // When true, every other existing (non-archived) record — 史记/周记/日记 — is sent
    // alongside the fusion request so the AI knows the prior summaries and which
    // content is already covered (avoids duplicating earlier records).
    fusionIncludeRecords: false,
    autoFusionTreeOps: false,    // 自动周记/史记融合时是否发送记忆树路径并要求模型输出 ops 插树
    manualFusionTreeOps: false,  // 手动融合（融合面板「开始融合」）时是否一并发送记忆树路径并解析返回的 <treeops> 填树
    // 史记→史记 同层融合不再有独立设置：复用上方 records 版的 promptHistorical / fusionIncludeRecords / manualFusionTreeOps。
    // Auto-fusion thresholds: how many lower records merge into one higher record.
    RECAP_TO_WEEKLY: 10,      // N daily(recap) -> 1 weekly
    WEEKLY_TO_HISTORICAL: 5,  // N weekly -> 1 historical
    recapKeepLatest: 0,       // 日记：触发周记融合时始终保留最新X条日记不参与本次融合（防融合后近期细节骤减）。0=关闭
    weeklyKeepLatest: 0,      // 周记：触发史记融合时始终保留最新X条周记不参与本次融合。0=关闭
    keepLatestInclusive: false, // 保留条数是否算在融合阈值内。false=外加(5+2→攒7融5)，true=包含(5含2→攒5融3)
    // 直融旁路：队尾连续未覆盖楼 ≥ 阈值时，跳过中间层直接融成 1 条周记/史记。
    // 优先级 史记 > 周记 > 日记。默认 0 = 关（走原日记 cascade 路径，零行为变化）。
    // 触发后取队尾未覆盖段最早「阈值」条楼融成 1 条，覆盖后这批退出未覆盖集合，剩余积压留后续。
    directHistoricalMin: 0,   // 未覆盖楼 ≥ 此值 → 直融 1 条史记（跳过日记/周记）
    directWeeklyMin: 0,       // 未覆盖楼 ≥ 此值 → 直融 1 条周记（跳过日记）
    promptHistorical: `You are a professional historian. Your task is to merge and summarize the following numbered chat messages into a single historical summary (史记) of about 300 words.
Focus on major character development, plot points, and the grand narrative arc. Output only the summarized text directly in Chinese, without any JSON format, codeblock markdown tags, or prefix/suffix.`,
    promptWeekly: `You are a professional chronicler. Your task is to merge and summarize the following numbered chat messages into a weekly summary (周记) of about 150-200 words.
Focus on recent key interactions, character moods, and unresolved questions. Output only the summarized text directly in Chinese, without any JSON format, codeblock markdown tags, or prefix/suffix.`,
    promptRecap: `Write a storyline recap of the following numbered chat messages.
Focus on the dramatic arc, conversation tone, and quick recap of recent events. Max 200 Chinese characters. Output only the recap text directly in Chinese, without any JSON format, codeblock markdown tags, or prefix/suffix.`,
    // Pre-summarization regex: applied to EACH floor's body before building the LLM
    // context for auto-summarization (日记 / 晨间日记). Used to shrink bloated floors
    // (CoT, status blocks, etc.) so the request stays under the model's context window.
    // Empty = no preprocessing (raw body). Mode: 'keep' extracts only matches,
    // 'remove' deletes matches. Mirrors the 时记 regex mechanism.
    recapPreRegex: "",
    recapPreRegexMode: 'remove',   // 'keep' | 'remove' (legacy; migrated into recapPreRegexRules)
    recapPreRegexRules: [],        // [{ regex, posMin|null, posMax|null, role:'ai'|'user'|'both', mode:'keep'|'remove' }] — one per row, chained top→bottom
    aiShrinkProfile: "",
    aiShrinkPrompt: "",
    anthropicCacheEnabled: false,      // 尝试为 Claude/Anthropic 请求添加 prompt-cache 锚点
    anthropicCacheScope: 'internal',   // 'internal' | 'main' | 'both'
    anthropicCacheProviderMode: 'auto',// 'auto'=仅 Claude/OpenRouter/Anthropic 命中；'force'=自定义端点也强行写 cache_control
    anthropicCacheTTL: '5m',           // '5m' | '1h'
    anthropicCacheControlJson: '{\n  "type": "ephemeral",\n  "ttl": "5m"\n}', // 实际注入到 text block 的 cache_control JSON
    anthropicCacheMainMode: 'manual',  // 主聊天实验锚点：'manual'={{cache_anchor}} | 'depth'=倒数深度 | 'gateway'={{cache_anchor}}→纯文本[[CACHE_BREAK]]交本地网关转cache_control
    // 滚动缓存（rolling cache）：gateway 模式下，除「史记后」固定断点外，再在最近的几条时记楼末尾
    // 追加 [[CACHE_BREAK]]，让缓存前缀「跟着对话往后滚」。倒数索引：0=最新一条时记楼、1=倒数第二…
    // 每轮只有最新 user 输入是 fresh，其余 read 命中。Anthropic 最多 4 个断点，固定点占 1，滚动最多 3。
    // 空串=关闭滚动（只用史记后固定点）。容错：放多个点时，即便最后一条被 swipe/编辑改写，靠前的点仍命中。
    anthropicCacheRollingDepths: '0,1',
    anthropicCacheDepth: 4,
    anthropicCacheMinChars: 1200,
    anthropicCacheDebug: false,
    anthropicCacheAiExplain: false,
    anthropicCacheTestMode: 'recommend',
    // ── 世界书面板（World Book）──
    wbProfile: "",                 // 单条 AI 连接配置
    wbMultiProfile: "",            // 多条 AI 连接配置
    wbPromptReduce: "",            // 单条·缩减 prompt（空=内置默认）
    wbPromptComplete: "",          // 单条·补全 prompt
    wbPromptRewrite: "",           // 单条·重构 prompt
    wbPromptMulti: "",             // 多条修改 prompt
    wbAllowChangeExisting: false,  // 多条：允许修改已有条目
    wbAllowAddNew: false,          // 多条：允许新增条目
    wbAllowDeleteMerge: false,     // 多条：允许删除/合并已有条目
    wbSelectedBook: "",            // 上次选择的世界书名
    wbLastSingleMode: "reduce",    // 单条模式当前预设 reduce/complete/rewrite
    wbFollowCharBook: true         // 跟随角色卡绑定世界书
};

// ── Built-in default prompts (single source of truth) ──
// The settings UI pre-fills the editable textareas with these so users see/edit
// the real defaults instead of a blank box. At call time, an empty config value
// falls back to the same constant — so a box left untouched and a box explicitly
// holding the default text behave identically.
const DEFAULT_ROUTING_PROMPT = `You are a memory routing assistant. Your task is to analyze the conversation history and select the most relevant memory paths from the provided memory tree index to help answer the user's latest query.`;
const DEFAULT_RECALL_TEMPLATE = `[系统补读: {path}]\n{content}`;
// Built-in SYSTEM prompt for the Memory Tree browser's "AI 缩减" feature. This is
// intentionally NOT the generic "helpful assistant" prompt; it only teaches the model
// the machine-readable edit format. The user's textarea remains the task prompt and
// controls what to change.
const AI_SHRINK_SYSTEM_PROMPT = `你是 Memory Wizard 的记忆树整理器。你的任务是根据用户给出的记忆树与整理要求，输出可由插件执行的 JSON 修改建议。

必须只输出 JSON 数组，不要 markdown，不要解释，不要代码块。
每个数组元素是一条操作：
[
  {"op": "update", "path": "原节点完整路径", "content": "精简后的新内容"},
  {"op": "move", "path": "原节点完整路径", "parent": "新的母路径/可新建", "title": "可选新标题"},
  {"op": "insert", "parent": "母路径/可新建", "title": "新节点标题", "hint": "新提示", "keywords": "触发词1, 触发词2", "content": "新节点正文"}
]

操作规则：
- update：修改现有节点。path 必须是原树里已存在的完整路径。可带 content / title / hint / keywords / parent / newPath。
- move：移动现有节点。path 必须存在；用 parent 指定新母路径，或用 newPath 指定完整目标路径；可同时 title 改名。目标母路径不存在时插件会自动创建。
- insert：新增节点。无需 path；必须有 title 和 content；parent 可为空（顶层）或为新/旧母路径；母路径不存在时插件会自动创建。
- content：提供时覆盖该节点正文。保留关键信息，删除冗余/重复/不重要细节。
- hint：提供时更新节点提示。
- keywords：逗号分隔，插件会并入现有关键词，不覆盖。
- 不要编造用户没有给出的事实；不要删除核心信息；只输出确实需要修改/移动/新增的节点。`;
// Scene-selection default prompt (call type: scene routing). The model reads the
// latest conversation and returns exactly one scene id: teaching | plot | intimate.
const DEFAULT_SCENE_SELECT_PROMPT = `你是一个对话场景分类器。阅读下面最近的对话，判断接下来这条回复最适合哪一种场景，并只输出严格 JSON。

三种场景：
- teaching（教学）：知识讲解、答疑、分析、推理、信息整理等理性/说明性内容。
- plot（剧情）：日常叙事、推进剧情、动作描写、对话互动、情绪铺陈等一般角色扮演内容。
- intimate（亲密）：高强度情感/亲密/私密的贴身互动场景。

只输出如下 JSON，不要 markdown、不要多余文字：
{"reason": "一句话理由", "scene": "teaching | plot | intimate 三选一"}`;
// Tree-fill default HEADER. Like the routing prompt, the live node-path reference
// + strict-JSON output rules are ALWAYS appended after this header at call time
// (they are structural and the parser depends on them), so the editable box holds
// only the instruction header — never the {nodes} list or the JSON schema.
const DEFAULT_TREEFILL_PROMPT = `You are a factual data extraction bot. Analyze the following conversation block and identify any key facts (new concepts, theories, relationship details, promises, real-world events, project status, unresolved tasks, etc.).
Determine whether to insert a new node, update an existing node, or archive a node in the Memory Tree.`;

// Default header for the on-demand <record>-tag tree fill (call type 2).
const DEFAULT_RECORDFILL_PROMPT = `You are a factual data extraction bot. The user (the roleplay's main model) has explicitly requested that certain facts be written into the Memory Tree. Follow the record instruction below precisely, using the provided source text as the factual basis. Decide whether to insert new nodes, update existing nodes, or archive nodes.`;

// Default "how to reconstruct full paths from the indented tree" method block
// (call type 3). Shared by both tree-fill (1) and record-fill (2). Editable via
// config.promptTreeFillMethod; the fixed JSON schema is always appended after it.
const DEFAULT_TREEFILL_METHOD = `The reference is an indented tree. Each line is one node: "- title | optional hint".
When you need an existing node path, build the FULL path by joining the node title with all ancestor titles using "/".
Example:
- 知识
  - 德国观念论
    - 康德 | 批判哲学
The full path is "知识/德国观念论/康德".`;

// The structural tail appended after the (default or custom) tree-fill header.
// Layout: [live indented tree reference] + [method block (config or default)] +
// [fixed JSON schema + op rules]. Only the method block is user-editable.
function buildTreeFillTail() {
    const methodBlock = (config.promptTreeFillMethod || '').trim() || DEFAULT_TREEFILL_METHOD;
    return `

Memory Tree Path Reference (Existing nodes, indented tree):
${getTreePathIndex(memoryTree, { ignoreSendPath: true }) || '（当前记忆树为空）'}

${methodBlock}

Output format must be a strict JSON object:
{
  "ops": [
    {"op": "insert", "parent": "知识/德国观念论", "title": "康德", "hint": "关于康德的生平与思想", "content": "...", "keywords": "康德, 批判哲学"},
    {"op": "update", "path": "项目/MemoryWizard", "append": "6/12 完成静帧组件", "keywords": "静帧, 组件"},
    {"op": "archive", "path": "挂账/旧账"}
  ]
}

About "keywords" (optional, world-info style): a comma-separated list of trigger words.
Whenever the latest user OR AI message contains ANY of these words, the node is FORCE-included
into the memory index and context regardless of routing. Add keywords for nodes whose recall
should be triggered by concrete surface terms (proper nouns, item/place/character names, recurring
topics). Use the SAME language/wording the conversation actually uses. Omit the field (or use "")
when no obvious trigger word applies. On "update", any given keywords are MERGED into the node's
existing keywords (union), never replacing them.

Instructions:
1. "insert": Use only if the topic is new. Hint should be a short phrase summarizing WHEN to read this node.
2. "insert.parent", "update.path", and "archive.path" must be FULL slash-joined paths reconstructed from the tree reference.
3. "update": Use to add details to an existing path in the reference tree.
4. "archive": Move node out of the index list but keep on disk. There is no physical delete.
5. PREFER an existing path from the reference tree for "insert.parent". But if NO existing category fits the new fact well, you MAY invent a new parent path — write the full slash-joined path you want (e.g. "知识/新分类"); any missing 母节点 (parent categories) will be created automatically. Do not force an unrelated fact under an ill-fitting existing parent just to avoid creating a new category.
6. Output only JSON, do not include codeblock markers.`;
}

// Manual-fusion tree-fill instruction block (the <treeops> task appended after the
// fusion system prompt when config.manualFusionTreeOps is on). Defined as a shared
// helper so BOTH the real send (buildFusionInvocation) and the token-count preview
// (updateFusionTokenStats → buildFusionPayload) include the exact same text, keeping
// the displayed "范围 X–Y 楼 · N tokens" honest.
function buildManualTreeOpsBlock() {
    const methodBlock = (config.promptTreeFillMethod || '').trim() || DEFAULT_TREEFILL_METHOD;
    return `

——————————
【附加任务：填记忆树】
在上方融合正文全部输出完成后，另起一行追加一个 <treeops> 块，里面是一个严格 JSON 对象，列出本次融合中应写入记忆树的操作（新事实 insert、补充已有节点 update、作废 archive）。若没有需要写入的内容，输出 <treeops>{"ops":[]}</treeops>。

记忆树路径索引（insert.parent / update.path / archive.path 优先使用以下现有路径）：
${getTreePathIndex(memoryTree, { ignoreSendPath: true }) || '（当前记忆树为空）'}

${methodBlock}

关于 insert.parent：优先挂到上方现有路径；若没有合适的现有分类，可自行新建母路径（直接写出完整斜杠路径，如「知识/新分类」），缺失的母节点会被自动创建。不要为避免新建分类而硬塞进不合适的现有母路径。

<treeops> 块格式（必须是合法 JSON，不要用 markdown 代码块包裹）：
<treeops>
{
  "ops": [
    {"op": "insert", "parent": "知识/德国观念论", "title": "康德", "hint": "可选提示", "content": "...", "keywords": "康德, 批判哲学"},
    {"op": "update", "path": "项目/MemoryWizard", "append": "新增进展...", "keywords": "可选触发词"},
    {"op": "archive", "path": "挂账/旧账"}
  ]
}
</treeops>

可选 "keywords"（逗号分隔触发词，模拟世界书）：当最近一条 user 或 AI 消息包含其中任意词时，该节点会被强制纳入记忆，无论路由是否召回。为有明确触发词（专有名词、人物/地点/物品名、复现话题）的节点添加；无明显触发词则省略。update 时并入现有关键词（取并集，不覆盖）。

注意：<treeops> 块只在融合正文之后出现一次；融合正文本身不要包含任何 ops/JSON。`;
}

// ══════════════════════════════════════════════════════════════════════
// REGION: 运行时可变状态（记忆树 / 摘要 / 各类会话标志与选择集）
// ══════════════════════════════════════════════════════════════════════
let memoryTree = [];
// The shared branch: one global root ("共有记忆") that every character/group sees and
// can edit, like a user persona. It is stored in its own backend document
// (shared_memory_tree.json), merged into memoryTree on load, and split back out on
// save so it never gets duplicated into per-character files. SHARED_ROOT_PATH is the
// root path; any node whose path is the root or starts with "共有记忆/" belongs to it.
const SHARED_ROOT_PATH = "共有记忆";
let sharedTreeLoaded = false; // becomes true once the shared document has been fetched this session
let treeLoadInProgress = false; // suppresses shared-tree saves while a chat's tree is mid-load
function isSharedPath(p) {
    return typeof p === 'string' && (p === SHARED_ROOT_PATH || p.startsWith(SHARED_ROOT_PATH + '/'));
}
// Split memoryTree into [personalForest, sharedForest]: shared = the 共有记忆 root and
// its subtree; personal = everything else. Operates on the top-level forest only,
// since the shared branch is always a root-level node.
function splitSharedFromTree(forest) {
    const personal = [];
    const shared = [];
    (Array.isArray(forest) ? forest : []).forEach(n => {
        if (n && n.path === SHARED_ROOT_PATH) shared.push(n);
        else personal.push(n);
    });
    return { personal, shared };
}
let summaries = {
    recaps: [],
    weeklySummaries: [],
    historicalSummaries: [],
    lastArchivedIndex: 0,
    // Independent cursor for the post-flash tree-fill pipeline. Decoupled from
    // lastArchivedIndex (which drives 日记 archiving) so tree-fill and recap fire
    // on their own counts (config.N_TREEFILL vs config.N_RECAP). Migrated from
    // lastArchivedIndex on first load when absent (see loadSettings).
    lastTreeFillIndex: 0,
    // Independent cursor for the post-flash tree-fill pipeline. Decoupled from
    // lastArchivedIndex (which drives 日记 archiving). Migrated from
    // lastArchivedIndex on first load when absent (see normalizeSummaries).
    lastTreeFillIndex: 0,
    // Anchor bundle for delete-floor resilience: stable fingerprints of a few
    // boundary messages so absolute floor pointers can be realigned after the
    // user manually deletes leading chat messages. See detectAndRealignFloors().
    floorAnchors: null
};

// Fill in fields that may be missing from server-loaded summaries (old data
// predating a field). Idempotent. Critically: lastTreeFillIndex migrates from
// lastArchivedIndex so legacy chats don't re-fill the tree for already-archived
// floors the first time the decoupled pipeline runs.
function normalizeSummaries() {
    if (!summaries || typeof summaries !== 'object') return;
    if (!Array.isArray(summaries.recaps)) summaries.recaps = [];
    if (!Array.isArray(summaries.weeklySummaries)) summaries.weeklySummaries = [];
    if (!Array.isArray(summaries.historicalSummaries)) summaries.historicalSummaries = [];
    if (typeof summaries.lastArchivedIndex !== 'number') summaries.lastArchivedIndex = 0;
    if (typeof summaries.lastTreeFillIndex !== 'number') {
        summaries.lastTreeFillIndex = summaries.lastArchivedIndex || 0;
    }
}

let activeChatId = "";
let injectedPathsThisTurn = [];
let suppReadCountThisTurn = 0;  // how many supplementary reads used this turn
let isHandlingRecall = false;   // re-entrancy guard for the recall branch

let registeredMacroMemory = "";
let registeredMacroTreeHeader = "";
let registeredMacroHistorical = "";
let registeredMacroWeekly = "";
let registeredMacroRecap = "";
let registeredMacroShiji = "";
let registeredMacroFusion = "";
let lastCompiledMemory = "";
// 路由本轮召回/钉死的节点对象数组（按 path 去重的来源），供 {{memory_tree}} 按 mtInclude* 开关重新拼装。
// 路由没跑 / 召回为空时 recalled = []，mtIncludeRoutedBody 据此不发任何内容（不回退全树）。
let lastCompiledNodes = { pinned: [], recalled: [] };
let isArchivingInProgress = false;
let isRoutingInProgress = false;
const collapsedPaths = new Set();
let allExpanded = false;
// First full-tree render after a (re)load starts fully collapsed: all non-root
// folders are added to collapsedPaths so only the top-level category titles show
// and the first chevron click always expands. Reset to false whenever fresh tree
// data is loaded for a chat; renderTreeView flips it true after collapsing once.
let treeCollapseInitialized = false;

// Batch-edit (multi-select) state for the memory-tree browser. We track selected
// node PATHS (unique & stable) rather than object references, so selection keeps
// working in search mode where rendered nodes are clones of the real tree nodes.
let treeSelectionMode = false;
let selectedPaths = new Set();
let lastTreeMoveUndoSnapshot = null; // { tree, collapsedPaths, activePath } for one-step drag-move undo
// Layered-summary batch-edit selection state. Keys are "${type}:${index}" strings,
// where type ∈ {historical, weekly, recap} and index is the array position.
let summarySelectionMode = false;
let selectedSummaries = new Set();
// Runtime-only remap state (not persisted). The annotation is PERMANENTLY ON:
// computeFloorRemap() is re-run against the current chat on every summaries load /
// render (loadSummaries / renderAllSummaryLists), so this stays current across page
// refresh and chat switch. The "重新映射楼层" button just forces an immediate refresh.
// Keyed by "type:index"; value is the display annotation for the source label.
// null only when there's no reachable chat to map against.
let floorRemapState = null; // null = no chat to map; Map otherwise
let currentRenderNodes = null;          // the node array last passed to renderTreeView
let currentRenderParentEl = null;       // the container last passed to renderTreeView
let nodeEditDraftSnapshot = null;       // one-node/subtree snapshot for Cancel in the editor
// Paths of nodes created by AI during THIS frontend session only. Not persisted;
// naturally disappears on plugin/page initialization.
let aiNewNodePathsThisSession = new Set();
let sandboxChatContext = [];
let fusionAbortController = null;
// When a summary item jump button is clicked, this stores {type, index, lo, hi} so
// renderSandboxChat can highlight the covered range with a stronger border.
// null means no highlight is active.
let sandboxJumpHighlight = null;
// AI shrink state: path → suggested new content (pending user confirm/reject)
let pendingAiShrinkEdits = new Map();
let aiShrinkAbortController = null;
// True once the user edits a sandbox floor textarea this session. Drives the
// visibility of the "应用更改到聊天" button. Reset (and edits discarded) on
// every reload — sandbox floor edits are session-only and NOT persisted.
let sandboxEditsDirty = false;
let lastMainPromptCacheSnapshot = null;
let previousMainPromptCacheSnapshot = null;
let lastMainPromptCacheSnapshotMeta = null;

// Active match/filter tags for the context-fusion browser. Each tag is
// { type: 'regex'|'keyword'|'time'|'size', value, label }. Multiple tags stack
// (pixiv-style removable chips). 'size' is a sort directive, the rest filter.
let sandboxFilters = [];
// The current match mode selected in the dropdown (what a new tag will be).
let sandboxMatchMode = 'keyword';
// The last compiled {{history}} block (full matched context window). Exposed via
// the {{history}} macro for external callers.
let lastCompiledHistory = "";
// Which fusion-prompt textarea was last focused (for the {{history}} chip insert).
let lastFocusedFusionPrompt = 'wizard-prompt-historical';

// ══════════════════════════════════════════════════════════════════════
// REGION: 通用工具（消息角色/名称解析 / 编辑距离 / Anthropic 缓存基建等）
// ══════════════════════════════════════════════════════════════════════
// ── 消息角色 / 名称解析 helper ─────────────────────────────────
// 统一散落各处的 `msg.is_user ? ...` 判定。四个变体语义不同，分开：
//   msgOpenAiRole — OpenAI 风格 'user'|'assistant'（system 归 assistant），优先取 msg.role；建 LLM payload 用。
//   msgRoleSide   — 'user'|'ai'（system 归 ai 侧）；时记/正则规则的角色窗判定用。
//   msgName       — 显示名：优先 msg.name，否则 User/System/Assistant。
//   msgRoleLabel  — 规范角色标签 User/System/Assistant（忽略 msg.name）；LLM 上下文前缀用。
function msgOpenAiRole(msg) {
    return msg?.role || (msg?.is_user ? 'user' : 'assistant');
}
function msgRoleSide(msg) {
    return msg && msg.is_user ? 'user' : 'ai';
}
function msgName(msg) {
    return msg?.name || (msg?.is_user ? 'User' : (msg?.is_system ? 'System' : 'Assistant'));
}
function msgRoleLabel(msg) {
    return msg?.is_system ? 'System' : (msg?.is_user ? 'User' : 'Assistant');
}

// Levenshtein distance for fuzzy matching and duplication check
function editDistance(s1, s2) {
    s1 = (s1 || "").toLowerCase();
    s2 = (s2 || "").toLowerCase();
    const costs = [];
    for (let i = 0; i <= s1.length; i++) {
        let lastValue = i;
        for (let j = 0; j <= s2.length; j++) {
            if (i === 0) {
                costs[j] = j;
            } else {
                if (j > 0) {
                    let newValue = costs[j - 1];
                    if (s1.charAt(i - 1) !== s2.charAt(j - 1)) {
                        newValue = Math.min(Math.min(newValue, lastValue), costs[j]) + 1;
                    }
                    costs[j - 1] = lastValue;
                    lastValue = newValue;
                }
            }
        }
        if (i > 0) costs[s2.length] = lastValue;
    }
    return costs[s2.length];
}

function getSimilarity(s1, s2) {
    const dist = editDistance(s1, s2);
    const maxLen = Math.max((s1 || "").length, (s2 || "").length);
    if (maxLen === 0) return 1.0;
    return 1.0 - (dist / maxLen);
}

function anthropicCacheEnabledFor(scope) {
    if (!config.anthropicCacheEnabled) return false;
    const mode = config.anthropicCacheScope || 'internal';
    if (mode === 'both') return true;
    return mode === scope;
}

function defaultAnthropicCacheControlJson() {
    const ttl = config.anthropicCacheTTL === '1h' ? '1h' : '5m';
    return JSON.stringify({ type: 'ephemeral', ttl }, null, 2);
}

function parseAnthropicCacheControlJson() {
    const raw = (config.anthropicCacheControlJson || '').trim() || defaultAnthropicCacheControlJson();
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('必须是 JSON object');
        return { ok: true, value: parsed, raw: JSON.stringify(parsed, null, 2) };
    } catch (e) {
        return { ok: false, error: e.message, value: { type: 'ephemeral', ttl: config.anthropicCacheTTL === '1h' ? '1h' : '5m' }, raw };
    }
}

function anthropicCacheControl() {
    return { ...parseAnthropicCacheControlJson().value };
}

function syncAnthropicCacheControlJsonFromTtlIfDefault() {
    const current = (config.anthropicCacheControlJson || '').trim();
    if (!current || /^\{\s*"type"\s*:\s*"ephemeral"\s*,\s*"ttl"\s*:\s*"(?:5m|1h)"\s*\}$/s.test(current)) {
        config.anthropicCacheControlJson = defaultAnthropicCacheControlJson();
        $('#wizard-anthropic-cache-control-json').val(config.anthropicCacheControlJson);
    }
}

function isAnthropicCacheCandidate(profileConfig = {}, profile = null) {
    if (!config.anthropicCacheEnabled) return false;
    if (config.anthropicCacheProviderMode === 'force') return true;
    const haystack = [
        profileConfig.apiType,
        profileConfig.apiUrl,
        profileConfig.model,
        profile?.api,
        profile?.['api-url'],
        profile?.model,
    ].filter(Boolean).join(' ').toLowerCase();
    return /claude|anthropic|openrouter/.test(haystack);
}

function cacheableTextLength(text) {
    return typeof text === 'string' ? text.trim().length : 0;
}

function makeCachedTextContent(text) {
    return [{ type: 'text', text: text || '', cache_control: anthropicCacheControl() }];
}

function applyCacheToMessageContent(msg, label = 'message') {
    if (!msg) return false;
    const key = msg.content !== undefined ? 'content' : 'mes';
    const minChars = Math.max(0, parseInt(config.anthropicCacheMinChars) || 0);
    if (typeof msg[key] === 'string') {
        if (cacheableTextLength(msg[key]) < minChars) return false;
        msg[key] = makeCachedTextContent(msg[key]);
        return true;
    }
    if (Array.isArray(msg[key])) {
        if (msg[key].some(p => p?.cache_control)) return false;
        for (let i = msg[key].length - 1; i >= 0; i--) {
            const part = msg[key][i];
            if (part?.type === 'text' && cacheableTextLength(part.text) >= minChars) {
                part.cache_control = anthropicCacheControl();
                return true;
            }
        }
    }
    if (config.anthropicCacheDebug) writeLog(`CacheControl skipped ${label}: text shorter than min chars (${minChars}).`, 'DEBUG');
    return false;
}

function applyManualCacheAnchorToText(text) {
    if (typeof text !== 'string' || !text.includes('{{cache_anchor}}')) return { changed: false, content: text };
    const parts = text.split('{{cache_anchor}}');
    const before = parts.shift();
    const after = parts.join('{{cache_anchor}}');
    const minChars = Math.max(0, parseInt(config.anthropicCacheMinChars) || 0);
    const content = [];
    if (before) {
        const block = { type: 'text', text: before };
        if (cacheableTextLength(before) >= minChars) block.cache_control = anthropicCacheControl();
        else if (config.anthropicCacheDebug) writeLog(`CacheControl manual anchor found but prefix is only ${cacheableTextLength(before)} chars (< ${minChars}). Marker removed without cache_control.`, 'WARNING');
        content.push(block);
    }
    if (after) content.push({ type: 'text', text: after });
    if (!content.length) content.push({ type: 'text', text: '' });
    return { changed: true, cached: content.some(p => p.cache_control), standalone: !before && !after, content };
}

function applyCacheToPreviousMessage(chat, anchorIndex) {
    for (let i = anchorIndex - 1; i >= 0; i--) {
        if (applyCacheToMessageContent(chat[i], `main/manual previous #${i}`)) return i;
    }
    return -1;
}

function analyzeMainPromptCacheControls(chat) {
    const report = {
        enabled: anthropicCacheEnabledFor('main'),
        mode: config.anthropicCacheMainMode || 'manual',
        minChars: Math.max(0, parseInt(config.anthropicCacheMinChars) || 0),
        candidateCount: 0,
        cacheableCount: 0,
        depthTargets: [],
    };
    if (!report.enabled || !Array.isArray(chat)) return report;
    if (report.mode === 'manual' || report.mode === 'gateway') {
        chat.forEach((msg, i) => {
            const key = msg?.content !== undefined ? 'content' : 'mes';
            const text = msg?.[key];
            if (typeof text !== 'string' || !text.includes('{{cache_anchor}}')) return;
            report.candidateCount += 1;
            const prefix = text.split('{{cache_anchor}}')[0] || '';
            // gateway 模式下 cache_control 由网关注入，prefix 长度门槛不再适用，统一计为可缓存。
            if (report.mode === 'gateway' || cacheableTextLength(prefix) >= report.minChars) report.cacheableCount += 1;
            report.depthTargets.push({ index: i, chars: cacheableTextLength(prefix) });
        });
    } else {
        const depth = Math.max(0, parseInt(config.anthropicCacheDepth) || 0);
        let passedPrefill = false;
        let roleSwitches = 0;
        let prevRole = '';
        for (let i = chat.length - 1; i >= 0; i--) {
            const msg = chat[i];
            if (!msg) continue;
            const role = msgOpenAiRole(msg);
            if (!passedPrefill && role === 'assistant') continue;
            passedPrefill = true;
            if (role !== prevRole) {
                if (roleSwitches === depth || roleSwitches === depth + 2) {
                    const key = msg.content !== undefined ? 'content' : 'mes';
                    const text = Array.isArray(msg[key]) ? msg[key].map(p => p?.text || '').join('') : msg[key];
                    const chars = cacheableTextLength(text);
                    report.candidateCount += 1;
                    if (chars >= report.minChars) report.cacheableCount += 1;
                    report.depthTargets.push({ index: i, role, chars });
                }
                if (roleSwitches === depth + 2) break;
                roleSwitches += 1;
                prevRole = role;
            }
        }
    }
    return report;
}

function refreshAnthropicCacheConfigFromUi() {
    const $enabled = $('#wizard-anthropic-cache-enabled');
    if (!$enabled.length) return;
    config.anthropicCacheEnabled = $enabled.prop('checked');
    config.anthropicCacheScope = $('#wizard-anthropic-cache-scope').val() || 'internal';
    config.anthropicCacheProviderMode = $('#wizard-anthropic-cache-provider-mode').val() || 'auto';
    config.anthropicCacheTTL = $('#wizard-anthropic-cache-ttl').val() || '5m';
    config.anthropicCacheControlJson = $('#wizard-anthropic-cache-control-json').val() || defaultAnthropicCacheControlJson();
    config.anthropicCacheMainMode = $('#wizard-anthropic-cache-main-mode').val() || 'manual';
    config.anthropicCacheRollingDepths = ($('#wizard-anthropic-cache-rolling-depths').val() ?? '').trim();
    config.skipRollingOnRecapTurn = $('#wizard-skip-rolling-on-recap-turn').prop('checked');
    config.anthropicCacheDepth = Math.max(0, parseInt($('#wizard-anthropic-cache-depth').val()) || 0);
    config.anthropicCacheMinChars = Math.max(0, parseInt($('#wizard-anthropic-cache-min-chars').val()) || 0);
    config.anthropicCacheDebug = $('#wizard-anthropic-cache-debug').prop('checked');
    config.anthropicCacheAiExplain = $('#wizard-anthropic-cache-ai-explain').prop('checked');
    config.anthropicCacheTestMode = $('#wizard-anthropic-cache-test-mode').val() || 'recommend';
    updateAnthropicCacheControlPreview();
}

function updateAnthropicCacheControlPreview() {
    const $preview = $('#wizard-anthropic-cache-control-preview');
    if (!$preview.length) return;
    const parsed = parseAnthropicCacheControlJson();
    if (parsed.ok) {
        const warnings = [];
        if (parsed.value.type !== 'ephemeral') warnings.push('Anthropic 通常要求 type="ephemeral"');
        if (parsed.value.ttl && !['5m', '1h'].includes(parsed.value.ttl)) warnings.push('ttl 通常只支持 5m / 1h');
        const suffix = warnings.length ? ` ｜ 注意：${warnings.join('；')}` : '';
        $preview.css('color', warnings.length ? '#fbbf24' : '#9ca3af').text(`当前将注入: ${parsed.raw.replace(/\s+/g, ' ')}${suffix}`);
    } else {
        $preview.css('color', '#f87171').text(`JSON 解析失败，将回退默认结构: ${parsed.error}`);
    }
}

function cacheProbeCard(title, body, accent = '#fbbf24') {
    return `<div style="background: rgba(255,255,255,0.035); border: 1px solid rgba(255,255,255,0.08); border-left: 3px solid ${accent}; border-radius: 6px; padding: 10px 12px; margin-top: 8px;">
        <div style="font-weight: 600; color: #f3f4f6; margin-bottom: 6px; display: flex; align-items: center; gap: 6px;">${title}</div>
        <div style="color: #d1d5db; line-height: 1.55;">${body}</div>
    </div>`;
}

function cacheProbeKV(label, value, color = '#d1d5db') {
    return `<div style="display: flex; gap: 8px; justify-content: space-between; border-bottom: 1px dashed rgba(255,255,255,0.06); padding: 3px 0;">
        <span style="color:#9ca3af;">${label}</span>
        <span style="color:${color}; text-align:right; word-break:break-all;">${value}</span>
    </div>`;
}

function cacheProbeList(items) {
    return `<ol style="margin: 4px 0 0 1.35em; padding: 0; color: #d1d5db;">${items.map(item => `<li style="margin: 4px 0;">${item}</li>`).join('')}</ol>`;
}

function renderCacheSettingsCheckResult(text) {
    const safe = escapeHtml(text || '无结果');
    $('#wizard-anthropic-cache-test-result').show().html(cacheProbeCard('1. 设置检查', safe, '#fbbf24'));
}

function cloneChatMessages(value) {
    try {
        if (typeof structuredClone === 'function') return structuredClone(value);
    } catch (_) { /* fall back */ }
    return JSON.parse(JSON.stringify(value || []));
}

function messageContentText(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.map(part => part?.text || '').join('');
    return '';
}

function cacheBlockLabel(block) {
    if (!block) return '无';
    return `第 ${block.messageIndex + 1} 条消息 / 第 ${block.partIndex + 1} 个 text block`;
}

function compactCacheSnippet(text, max = 180) {
    const value = String(text || '').replace(/\s+/g, ' ').trim();
    if (value.length <= max) return value;
    return `${value.slice(0, Math.floor(max / 2))} …… ${value.slice(-Math.floor(max / 2))}`;
}

function cacheSentenceLocator(text) {
    const lines = String(text || '').split(/\n+/).map(x => x.trim()).filter(Boolean);
    const useful = lines.filter(x => x.length > 12 && !/^[-—=*_`]+$/.test(x));
    const first = useful[0] || lines[0] || '';
    const last = useful[useful.length - 1] || lines[lines.length - 1] || '';
    return { first: compactCacheSnippet(first, 180), last: compactCacheSnippet(last, 180) };
}

function captureMainPromptCacheSnapshot(eventData) {
    if (!eventData || !Array.isArray(eventData.chat)) return;
    const snapshot = cloneChatMessages(eventData.chat);
    const blocks = inspectCacheableBlocks(snapshot);
    previousMainPromptCacheSnapshot = lastMainPromptCacheSnapshot;
    lastMainPromptCacheSnapshot = snapshot;
    lastMainPromptCacheSnapshotMeta = {
        capturedAt: new Date().toISOString(),
        chatLength: snapshot.length,
        dryRun: !!eventData.dryRun,
        mode: config.anthropicCacheMainMode || 'manual',
        scope: config.anthropicCacheScope || 'internal',
        cacheBlockCount: blocks.length,
        firstCacheBlockHash: blocks[0]?.hash || '',
    };
    if (config.anthropicCacheDebug) {
        writeLog(`CacheControl main payload snapshot captured: messages=${snapshot.length}, cacheBlocks=${blocks.length}.`, 'DEBUG');
    }
}

function renderCacheOfflineProbeResult(result) {
    const sim = result.simulation;
    const controlJson = result.cacheControl.ok
        ? JSON.stringify(result.cacheControl.value, null, 2)
        : JSON.stringify(result.cacheControl.value, null, 2);
    const controlStatus = result.cacheControl.ok ? 'JSON 有效，可注入' : `JSON 无效，模拟时回退默认结构：${result.cacheControl.error}`;
    const controlColor = result.cacheControl.ok ? '#34d399' : '#f87171';
    const roundColor = sim.matched ? '#34d399' : '#f87171';
    const costColor = sim.estimatedDeltaUsd >= 0 ? '#34d399' : '#f87171';
    const meta = result.snapshotMeta || {};
    const block = result.placement?.block || null;
    const isRecommendMode = result.mode === 'offline_recommend_best_cache_point';
    const manualLabel = isRecommendMode
        ? '推荐模式：本次已忽略你当前的 cache 点；上方位置是插件按 payload/历史自动推断的最佳候选。'
        : (result.hasCacheControl
            ? '检测模式：这里只判断你当前 {{cache_anchor}} / depth 的落点是否合格。'
            : '检测模式：当前 payload/历史里没有找到可用 cache_control。');
    const cacheResultText = isRecommendMode
        ? `推荐模式不依赖当前 cache_control；当前 payload 中已有 ${meta.cacheBlockCount || 0} 个真实 cache_control 仅供对照`
        : (result.hasCacheControl ? `发现 ${meta.cacheBlockCount || 0} 个 cache_control block` : '最终 payload/历史没有 cache_control');
    const html = [
        cacheProbeCard('1. cache_control 结构', [
            `<pre style="white-space: pre-wrap; margin: 0 0 6px 0; color: #d1d5db; background: rgba(0,0,0,0.22); border-radius: 4px; padding: 8px; font-family: var(--monoFontFamily, monospace);">${escapeHtml(controlJson)}</pre>`,
            cacheProbeKV('状态', escapeHtml(controlStatus), controlColor),
            cacheProbeKV(isRecommendMode ? '推荐模式说明' : '当前点注入结果', cacheResultText, result.hasCacheControl ? '#34d399' : '#f87171'),
        ].join(''), '#60a5fa'),
        cacheProbeCard('2. Payload 快照来源', [
            cacheProbeKV('来源', escapeHtml(result.source || '未知'), '#fbbf24'),
            cacheProbeKV('捕获时间', escapeHtml(meta.capturedAt || '未记录'), '#d1d5db'),
            cacheProbeKV('messages 数', `${meta.chatLength ?? 0}`, '#d1d5db'),
            cacheProbeKV('cache blocks', `${meta.cacheBlockCount ?? 0}`, (meta.cacheBlockCount || 0) || isRecommendMode ? '#34d399' : '#f87171'),
            cacheProbeKV('测试模式', isRecommendMode ? '教我放哪里（忽略当前 cache 点）' : '检测当前点是否合格', '#fbbf24'),
            cacheProbeKV('数据来源', meta.fallback ? '未等新 AI 回复，自动使用当前聊天历史最近两轮回退' : '真实 payload 快照', '#34d399'),
            cacheProbeKV('测试性质', '本地离线测试，不发送 provider 请求', '#34d399'),
        ].join(''), '#fbbf24'),
        cacheProbeCard('3. 两轮真实 payload 离线模拟', [
            cacheProbeKV('第 1 轮 cache 动作', `写入稳定前缀 ≈ ${fmtNum(sim.round1?.simulated_cache_creation_input_tokens)} tokens`, '#fbbf24'),
            cacheProbeKV('第 2 轮 cache 动作', sim.matched ? `读取同一段前缀 ≈ ${fmtNum(sim.round2?.simulated_cache_read_input_tokens)} tokens` : '没有读到：两轮前缀不一致或没有 cache block', roundColor),
            cacheProbeKV('两轮前缀 hash', `${escapeHtml(sim.round1PrefixHash || '无')} → ${escapeHtml(sim.round2PrefixHash || '无')}`, roundColor),
            cacheProbeKV('两轮是否相同', sim.matched ? '相同：理论上可 cache read' : '不同：理论上不会 cache read', roundColor),
            cacheProbeKV('第 1 轮未缓存后缀', `约 ${fmtNum(sim.suffix1Tokens)} tokens`, '#9ca3af'),
            cacheProbeKV('第 2 轮未缓存后缀', `约 ${fmtNum(sim.suffix2Tokens)} tokens`, '#9ca3af'),
        ].join(''), '#22c55e'),
        cacheProbeCard(isRecommendMode ? '4. 自动推荐放置位置 / 直接告诉我放哪里' : '4. 当前 cache 点检测结果', [
            `<div style="font-size:1.05em;color:${result.hasCacheControl ? '#34d399' : '#f87171'};font-weight:700;margin-bottom:6px;">${escapeHtml(result.placement.humanAnswer)}</div>`,
            block ? [
                cacheProbeKV(isRecommendMode ? '推荐落点' : '当前落点', escapeHtml(cacheBlockLabel(block)), '#fbbf24'),
                cacheProbeKV('角色', escapeHtml(block.role || 'unknown'), '#d1d5db'),
                cacheProbeKV('文本规模', `${fmtNum(block.chars)} 字 / ${fmtNum(block.tokens)} tokens`, '#d1d5db'),
            ].join('') : '',
            cacheProbeList((result.placement.steps || []).map(escapeHtml)),
            result.placement.locator ? `<div style="margin-top:8px;color:#d1d5db;font-size:0.92em;">
                <div style="color:#9ca3af;margin-bottom:3px;">落点文本开头：</div>
                <div style="background:rgba(0,0,0,0.22);padding:6px;border-radius:4px;">${escapeHtml(result.placement.locator.first || '无')}</div>
                <div style="color:#9ca3af;margin:6px 0 3px;">落点文本结尾：</div>
                <div style="background:rgba(0,0,0,0.22);padding:6px;border-radius:4px;">${escapeHtml(result.placement.locator.last || '无')}</div>
            </div>` : '',
            `<div style="margin-top:8px;color:#fbbf24;">${escapeHtml(manualLabel)}</div>`,
        ].join(''), '#22c55e'),
        result.diffHtml ? cacheProbeCard('5. 两轮文本对比图', result.diffHtml, '#22c55e') : '',
        cacheProbeCard(result.diffHtml ? '6. 为什么会/不会 read' : '5. 为什么会/不会 read', [
            cacheProbeKV('判断', escapeHtml(result.placement.reason), roundColor),
            cacheProbeKV('缓存稳定前缀', `约 ${fmtNum(result.placement.stableChars)} 字 / ${fmtNum(result.placement.stableTokens)} tokens`, '#fbbf24'),
            cacheProbeKV('覆盖比例', `第1轮约 ${result.placement.round1CoveragePercent}% / 第2轮约 ${result.placement.round2CoveragePercent}%`, result.hasCacheControl ? '#34d399' : '#f87171'),
            (meta.cacheBlockCount || 0) > 4 ? `<div style="margin-top:6px;color:#f87171;font-size:0.92em;">注意：Anthropic 通常最多支持 4 个 cache breakpoint；当前最终 payload 有 ${meta.cacheBlockCount} 个，请减少锚点或调整 depth。</div>` : '',
        ].join(''), '#60a5fa'),
        result.placement?.currentBlock ? cacheProbeCard(result.diffHtml ? '7. 当前手动落点（仅供对照）' : '6. 当前手动落点（仅供对照）', [
            cacheProbeKV('当前落点', escapeHtml(cacheBlockLabel(result.placement.currentBlock)), '#fbbf24'),
            cacheProbeKV('当前覆盖', `约 ${fmtNum(result.placement.currentBlock.tokens)} tokens`, '#d1d5db'),
            `<div style="margin-top:6px;color:#9ca3af;font-size:0.92em;">上面的推荐结果已经忽略当前手动点；这里仅显示你现在放的点作为对照。</div>`,
        ].join(''), '#f97316') : '',
        result.aiExplanation ? cacheProbeCard(result.diffHtml ? (result.placement?.currentBlock ? '8. AI 文字解释' : '7. AI 文字解释') : (result.placement?.currentBlock ? '7. AI 文字解释' : '6. AI 文字解释'), `<div style="white-space: pre-wrap;">${escapeHtml(result.aiExplanation)}</div>`, '#fbbf24') : '',
        cacheProbeCard(result.aiExplanation ? (result.diffHtml ? '8. 输入费用估算' : '7. 输入费用估算') : (result.diffHtml ? '7. 输入费用估算' : '6. 输入费用估算'), [
            cacheProbeKV('无缓存两轮输入', usd(sim.estimatedNoCacheInputCostUsd)),
            cacheProbeKV('模拟缓存两轮输入', usd(sim.estimatedWithCacheInputCostUsd)),
            cacheProbeKV('预计变化', `${usd(sim.estimatedDeltaUsd)} / ${sim.estimatedDeltaPercent.toFixed(1)}%`, costColor),
            `<div style="margin-top:6px;color:#9ca3af;font-size:0.92em;">按输入 $${sim.inputPriceUsdPerMTok}/1M tokens 粗估；不是 Anthropic count_tokens。输出费用未估算。</div>`,
        ].join(''), '#a78bfa'),
        cacheProbeCard('注意', '本结果来自本地离线模拟，不是 provider usage。它使用 SillyTavern 已组装完成的真实主聊天 messages 快照，不再拼接额外 system prompt。真实是否命中仍以 provider 返回的 usage.cache_read_input_tokens 为准；如果网关/反代丢弃 cache_control，离线模拟无法发现。只有打开“AI 文字解释放置位置”时，才会额外调用一次模型。', '#f97316'),
    ].join('');
    $('#wizard-anthropic-cache-test-result').show().html(html);
}

function renderCacheProbeError(message) {
    $('#wizard-anthropic-cache-test-result').show().html(cacheProbeCard('离线模拟失败', escapeHtml(message), '#f87171'));
}

function buildAnthropicCacheTestReport() {
    const context = window.SillyTavern?.getContext();
    const chat = Array.isArray(context?.chat) ? context.chat : [];
    const mainReport = analyzeMainPromptCacheControls(chat);
    const cmProfiles = context?.extensionSettings?.connectionManager?.profiles || [];
    const profileNames = [
        config.routingProfile,
        config.treeFillProfile,
        config.recapProfile,
        config.weeklyProfile,
        config.historicalProfile,
        config.fusionProfile,
        config.aiShrinkProfile,
    ].filter(Boolean);
    const internal = profileNames.map(name => {
        const profile = cmProfiles.find(p => p.name === name);
        return { name, candidate: isAnthropicCacheCandidate({}, profile) };
    });
    const snapshotBlocks = Array.isArray(lastMainPromptCacheSnapshot) ? inspectCacheableBlocks(lastMainPromptCacheSnapshot) : [];
    const snapshotReport = {
        captured: Array.isArray(lastMainPromptCacheSnapshot),
        meta: lastMainPromptCacheSnapshotMeta,
        cacheBlockCount: snapshotBlocks.length,
    };
    return { mainReport, internal, snapshotReport };
}

function getCacheUsageValue(resp, key, seen = new Set()) {
    if (!resp || typeof resp !== 'object' || seen.has(resp)) return 0;
    seen.add(resp);
    if (typeof resp[key] === 'number') return resp[key];
    if (typeof resp.usage?.[key] === 'number') return resp.usage[key];
    for (const value of Object.values(resp)) {
        if (!value || typeof value !== 'object') continue;
        if (Array.isArray(value)) {
            for (const item of value) {
                const nested = getCacheUsageValue(item, key, seen);
                if (nested) return nested;
            }
        } else {
            const nested = getCacheUsageValue(value, key, seen);
            if (nested) return nested;
        }
    }
    return 0;
}

function summarizeCacheUsage(resp) {
    return {
        creation: getCacheUsageValue(resp, 'cache_creation_input_tokens'),
        read: getCacheUsageValue(resp, 'cache_read_input_tokens'),
        input: getCacheUsageValue(resp, 'input_tokens'),
        output: getCacheUsageValue(resp, 'output_tokens'),
    };
}

function buildCurrentChatRpCacheProbePrompt(chat) {
    return buildCurrentChatRpCacheProbe(chat).text;
}

function buildCurrentChatRpCacheProbe(chat) {
    const stableParts = [];
    const source = Array.isArray(chat) ? chat : [];
    const maxChars = 60000;
    for (let i = Math.max(0, source.length - 160); i < source.length; i++) {
        const msg = source[i];
        if (!msg) continue;
        const role = msgOpenAiRole(msg);
        const key = msg.content !== undefined ? 'content' : 'mes';
        const raw = Array.isArray(msg[key]) ? msg[key].map(p => p?.text || '').join('') : (msg[key] || '');
        const text = String(raw).trim();
        if (!text) continue;
        stableParts.push({ label: `#${i} [${role}]`, text: `#${i} [${role}]\n${text}`, floor: i, role, chars: cacheableTextLength(text) });
    }
    let truncated = false;
    let transcript = stableParts.map(p => p.text).join('\n\n---\n\n');
    if (transcript.length > maxChars) {
        truncated = true;
        transcript = transcript.slice(-maxChars);
    }
    if (cacheableTextLength(transcript) < Math.max(0, parseInt(config.anthropicCacheMinChars) || 0)) {
        transcript = `${transcript}\n\n${'CACHE_PROBE_STABLE_PREFIX '.repeat(120)}`;
    }
    const prefixHeader = '你正在进行 SillyTavern Memory Wizzard cache_control 真实探针。\n\n下面这整段内容视为“当前 ST 的完整 RP 上下文/当前回复前缀”，它必须在两次请求中逐字保持一致，用来测试 Anthropic Prompt Cache 写入与读取。\n\n=== 当前 ST RP 上下文开始 ===\n';
    const suffixInstruction = '\n=== 当前 ST RP 上下文结束 ===\n\n请继续扮演当前 RP 场景中的 assistant，回答用户的下一轮 RP。';
    return {
        text: `${prefixHeader}${transcript}${suffixInstruction}`,
        stableText: `${prefixHeader}${transcript}`,
        suffixInstruction,
        stableParts,
        truncated,
        maxChars,
    };
}

function recommendCacheControlPlacement(probe, round1Messages, round2Messages) {
    const stable = probe?.stableText || '';
    const hash1 = djb2Hash(stable);
    const hash2 = djb2Hash(stable);
    const tokens = estimateAnthropicTokens(stable);
    const total1 = estimateAnthropicTokens(flattenMessageText(round1Messages));
    const total2 = estimateAnthropicTokens(flattenMessageText(round2Messages));
    const coverage1 = total1 ? Math.round(tokens / total1 * 1000) / 10 : 0;
    const coverage2 = total2 ? Math.round(tokens / total2 * 1000) / 10 : 0;
    const last = probe?.stableParts?.length ? probe.stableParts[probe.stableParts.length - 1] : null;
    const humanAnswer = last
        ? `把 {{cache_anchor}} 放在你模板/预设里“聊天历史注入结束的位置”：也就是第 ${last.floor} 楼这条 ${last.role} 历史消息之后、本轮最新 user 输入之前。`
        : '把 {{cache_anchor}} 放在固定背景/角色卡/世界书/历史上下文全部结束之后、本轮最新 user 输入之前。';
    return {
        anchor: '聊天历史结束后、本轮 user 输入之前',
        reason: '两轮对比中，这一段之前的内容保持不变；这一段之后会出现本轮 user、assistant 回复、第二轮 user，所以不能再往后放。',
        humanAnswer,
        steps: [
            '找到你的预设/模板里“历史聊天记录”被插入的位置。',
            '把 {{cache_anchor}} 放在历史聊天记录的后面。',
            '不要放到本轮最新 user 输入后面，也不要放到 assistant 回复/prefill 后面。',
            '如果你的模板顺序是：角色卡/世界书 → 历史聊天 → 最新 user，那么就放在“历史聊天”和“最新 user”之间。',
        ],
        stableChars: cacheableTextLength(stable),
        stableTokens: tokens,
        round1CoveragePercent: coverage1,
        round2CoveragePercent: coverage2,
        hash1,
        hash2,
        matched: hash1 === hash2,
        lastStableLabel: last?.label || '无稳定历史消息',
        truncated: !!probe?.truncated,
    };
}

function buildPayloadOfflineRound2(round1Messages) {
    const round2 = cloneChatMessages(round1Messages);
    round2.push({ role: 'assistant', content: '【离线模拟 assistant 回复】这里代表第一轮真实回复产生后的 assistant 消息；本地模拟不会发送给 provider。' });
    round2.push({ role: 'user', content: '【Offline Cache Probe Round 2】这里代表第二轮 user 新输入；用于检查 cache breakpoint 之前是否仍可复用。' });
    return round2;
}

function chatMessageToPayloadMessage(msg) {
    if (!msg) return null;
    const raw = msg.content !== undefined ? msg.content : msg.mes;
    const text = Array.isArray(raw) ? raw.map(p => p?.text || '').join('') : String(raw || '');
    if (!text.trim()) return null;
    return { role: msgOpenAiRole(msg), content: text };
}

function buildHistoryFallbackProbeMessages() {
    const context = window.SillyTavern?.getContext();
    const chat = Array.isArray(context?.chat) ? context.chat : [];
    const payload = chat.map(chatMessageToPayloadMessage).filter(Boolean);
    if (payload.length < 2) return null;
    const split = payload.length >= 4 ? Math.max(1, payload.length - 2) : payload.length;
    const round1 = payload.slice(0, split);
    const round2 = payload.slice(0, payload.length);
    if (!round1.length || !round2.length) return null;
    if ((config.anthropicCacheTestMode || 'recommend') === 'current') {
        applyMainPromptCacheControls(round1);
        applyMainPromptCacheControls(round2);
    }
    return {
        round1Messages: round1,
        round2Messages: round2,
        meta: {
            capturedAt: new Date().toISOString(),
            chatLength: round1.length,
            dryRun: false,
            mode: config.anthropicCacheMainMode || 'manual',
            scope: config.anthropicCacheScope || 'internal',
            fallback: true,
        },
    };
}

function virtualCacheBlockForMessage(messages, messageIndex, textEnd = null, label = '') {
    if (!Array.isArray(messages) || messageIndex < 0 || messageIndex >= messages.length) return null;
    const fullText = messageContentText(messages[messageIndex]?.content);
    const cutText = textEnd == null ? fullText : fullText.slice(0, Math.max(0, textEnd));
    const prefixText = `${flattenMessageText(messages.slice(0, messageIndex))}\n${cutText}`.trim();
    return {
        messageIndex,
        partIndex: 0,
        role: msgOpenAiRole(messages[messageIndex]),
        blockChars: cacheableTextLength(cutText),
        blockTokens: estimateAnthropicTokens(cutText),
        chars: cacheableTextLength(prefixText),
        tokens: estimateAnthropicTokens(prefixText),
        ttl: config.anthropicCacheTTL || '5m',
        type: 'ephemeral',
        hash: djb2Hash(prefixText),
        virtual: true,
        textEnd,
        label,
        prefixText,
        anchorText: cutText,
    };
}

function recommendedCutOffsets(text) {
    const value = String(text || '');
    const cuts = [];
    const markerPatterns = [
        /\[History Ends\]/gi,
        /<\/DataBank>/gi,
        /<\/Chat History>/gi,
        /历史聊天结束/gi,
        /聊天历史结束/gi,
    ];
    markerPatterns.forEach(re => {
        let match;
        while ((match = re.exec(value)) !== null) {
            cuts.push({ index: match.index + match[0].length, label: match[0] });
        }
    });
    const dynamicPatterns = [
        /\[Input_Stream\]/gi,
        /<user_input>/gi,
        /下面是用户的输入/gi,
        /在生成正文前/gi,
        /\[Output_Sequence\]/gi,
    ];
    dynamicPatterns.forEach(re => {
        const match = re.exec(value);
        if (match && match.index > 0) cuts.push({ index: match.index, label: `动态段前：${match[0]}` });
    });
    return cuts.filter(c => c.index > 0 && c.index < value.length);
}

function messageLooksDynamic(msg, index, total) {
    const role = msgOpenAiRole(msg);
    const text = messageContentText(msg?.content);
    if (!text.trim()) return true;
    if (index >= total - 2) return true;
    if (role === 'assistant' && index >= total - 3) return true;
    return /\{\{user\}\}|\{\{input\}\}|\{\{lastMessage\}\}|\b\d{1,2}:\d{2}\b|\b20\d{2}[-\/]\d{1,2}[-\/]\d{1,2}\b|当前时间|现在时间|随机|random/i.test(text);
}

function recommendBestCachePlacementIgnoringAnchors(round1Messages, round2Messages) {
    const total1 = estimateAnthropicTokens(flattenMessageText(round1Messages));
    const total2 = estimateAnthropicTokens(flattenMessageText(round2Messages));
    const minChars = Math.max(0, parseInt(config.anthropicCacheMinChars) || 0);
    let best = null;
    for (let i = 0; i < round1Messages.length; i++) {
        if (messageLooksDynamic(round1Messages[i], i, round1Messages.length)) continue;
        const text = messageContentText(round1Messages[i]?.content);
        const cutCandidates = recommendedCutOffsets(text).map(c => virtualCacheBlockForMessage(round1Messages, i, c.index, c.label)).filter(Boolean);
        const candidates = [...cutCandidates, virtualCacheBlockForMessage(round1Messages, i)].filter(Boolean);
        for (const block of candidates) {
            if (!block || block.chars < minChars) continue;
            best = block;
        }
    }
    if (!best) return null;
    const locator = cacheSentenceLocator(best.anchorText || messageContentText(round1Messages[best.messageIndex]?.content));
    const nextMessage = round1Messages[best.messageIndex + 1];
    const nextLocator = nextMessage ? cacheSentenceLocator(messageContentText(nextMessage.content)) : null;
    const coverage1 = total1 ? Math.round(best.tokens / total1 * 1000) / 10 : 0;
    const coverage2 = total2 ? Math.round(best.tokens / total2 * 1000) / 10 : 0;
    return {
        anchor: `${cacheBlockLabel(best)}（role=${best.role || 'unknown'}）`,
        humanAnswer: `不考虑你当前手动 cache 点时，建议把 {{cache_anchor}} 放在最终 payload 的 ${cacheBlockLabel(best)} 之后，也就是这段文字结尾之后：“${locator.last || '无法提取'}”。`,
        reason: '这是本地模拟中最后一个看起来稳定、且仍在最新 user / 末尾动态内容之前的位置；放这里能比当前落点缓存更多前缀。',
        steps: [
            `推荐落点文本结尾：“${locator.last || '无法提取'}”。`,
            nextLocator?.first ? `推荐落点后一段开头：“${nextLocator.first}”。如果这就是最新 user 或动态段，不要再往后放。` : '推荐落点已经接近 payload 末尾，后面没有可继续判断的文本段。',
            '把 {{cache_anchor}} 移到对应 preset prompt 后面；如果最终 payload 文本里有标题，就优先找包含上述句子的 prompt。',
            '如果移动后真实 provider read=0，再往前退一段，避开动态时间、最新 user、随机变量和 assistant prefill。',
        ],
        locator,
        nextLocator,
        stableChars: best.chars,
        stableTokens: best.tokens,
        round1CoveragePercent: coverage1,
        round2CoveragePercent: coverage2,
        matched: true,
        block: best,
        lastStableLabel: `${cacheBlockLabel(best)}（role=${best.role || 'unknown'}）`,
        truncated: false,
    };
}

function splitMessagesAtBlock(messages, block) {
    if (!block) return { prefix: [], suffix: messages || [] };
    if (block.textEnd == null) {
        return {
            prefix: (messages || []).slice(0, block.messageIndex + 1),
            suffix: (messages || []).slice(block.messageIndex + 1),
        };
    }
    const prefix = (messages || []).slice(0, block.messageIndex);
    const suffix = [];
    const msg = messages[block.messageIndex];
    const text = messageContentText(msg?.content);
    prefix.push({ role: msg?.role || 'system', content: text.slice(0, block.textEnd) });
    const rest = text.slice(block.textEnd).trim();
    if (rest) suffix.push({ role: msg?.role || 'system', content: rest });
    suffix.push(...(messages || []).slice(block.messageIndex + 1));
    return { prefix, suffix };
}

function renderCachePayloadDiff(round1Messages, round2Messages, block) {
    if (!block) return '';
    const split1 = splitMessagesAtBlock(round1Messages, block);
    const split2 = splitMessagesAtBlock(round2Messages, block);
    const samePreview = compactCacheSnippet(flattenMessageText(split1.prefix), 900);
    const removedPreview = compactCacheSnippet(flattenMessageText(split1.suffix), 700);
    const addedPreview = compactCacheSnippet(flattenMessageText(split2.suffix), 700);
    return `<div style="display:grid;gap:8px;">
        <div style="display:flex;gap:8px;flex-wrap:wrap;font-size:0.9em;">
            <span style="color:#34d399;">绿色 = 两轮相同、cache 可覆盖的前缀</span>
            <span style="color:#f87171;">红色 = 第 1 轮 cache 后面的未缓存后缀</span>
            <span style="color:#60a5fa;">蓝色 = 第 2 轮 cache 后面的新增/变化后缀</span>
        </div>
        <div style="border:1px solid rgba(52,211,153,0.35);background:rgba(34,197,94,0.09);border-radius:6px;padding:8px;">
            <div style="color:#34d399;font-weight:600;margin-bottom:4px;">相同前缀（已缓存范围，到 ${escapeHtml(cacheBlockLabel(block))} 为止）</div>
            <pre style="white-space:pre-wrap;margin:0;color:#d1fae5;max-height:220px;overflow:auto;">${escapeHtml(samePreview || '无')}</pre>
        </div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:8px;">
            <div style="border:1px solid rgba(248,113,113,0.35);background:rgba(239,68,68,0.08);border-radius:6px;padding:8px;">
                <div style="color:#f87171;font-weight:600;margin-bottom:4px;">第 1 轮未缓存后缀</div>
                <pre style="white-space:pre-wrap;margin:0;color:#fee2e2;max-height:220px;overflow:auto;">${escapeHtml(removedPreview || '无')}</pre>
            </div>
            <div style="border:1px solid rgba(96,165,250,0.35);background:rgba(59,130,246,0.08);border-radius:6px;padding:8px;">
                <div style="color:#60a5fa;font-weight:600;margin-bottom:4px;">第 2 轮未缓存/新增后缀</div>
                <pre style="white-space:pre-wrap;margin:0;color:#dbeafe;max-height:220px;overflow:auto;">${escapeHtml(addedPreview || '无')}</pre>
            </div>
        </div>
    </div>`;
}

function recommendCacheControlPlacementFromPayload(round1Messages, round2Messages, testMode = 'recommend') {
    const blocks1 = inspectCacheableBlocks(round1Messages);
    const blocks2 = inspectCacheableBlocks(round2Messages);
    const first = blocks1[0] || null;
    const second = blocks2.find(b => first && b.hash === first.hash && b.tokens === first.tokens) || null;
    const best = testMode === 'recommend' ? recommendBestCachePlacementIgnoringAnchors(round1Messages, round2Messages) : null;
    const chosen = best?.block || first;
    const total1 = estimateAnthropicTokens(flattenMessageText(round1Messages));
    const total2 = estimateAnthropicTokens(flattenMessageText(round2Messages));
    const stableTokens = chosen?.tokens || 0;
    const stableChars = chosen?.chars || 0;
    const coverage1 = total1 ? Math.round(stableTokens / total1 * 1000) / 10 : 0;
    const coverage2 = total2 ? Math.round(stableTokens / total2 * 1000) / 10 : 0;
    if (!chosen) {
        return {
            anchor: '最终 payload 没有 cache_control',
            reason: '两轮对比没有找到任何 cache_control block，所以不能模拟 cache write/read。',
            humanAnswer: '最终 payload 没有任何 cache_control，本次不能判断读缓存。',
            steps: [
                '把 cache 生效范围切到“仅主聊天实验锚点”或“两者都启用”。',
                '手动模式：确认当前酒馆 preset/template 里真的写了 {{cache_anchor}}。',
                '确认 {{cache_anchor}} 前面的文本长度超过“最小字符数”。',
                '倒数深度模式：调整 depth，让它落在可缓存的 text block 上。',
            ],
            stableChars,
            stableTokens,
            round1CoveragePercent: coverage1,
            round2CoveragePercent: coverage2,
            matched: false,
            block: null,
            lastStableLabel: '无 cache_control block',
            truncated: false,
        };
    }
    const actual = `${cacheBlockLabel(chosen)}（role=${chosen.role || 'unknown'}）`;
    const anchorText = messageContentText(round1Messages[chosen.messageIndex]?.content);
    const locator = cacheSentenceLocator(anchorText);
    const nextMessage = round1Messages[chosen.messageIndex + 1];
    const nextLocator = nextMessage ? cacheSentenceLocator(messageContentText(nextMessage.content)) : null;
    const currentInfo = first ? `当前手动落点是 ${cacheBlockLabel(first)}，覆盖约 ${first.tokens ? Math.round(first.tokens / total1 * 1000) / 10 : 0}%。` : '当前没有手动落点。';
    const humanAnswer = best
        ? `不考虑你当前的 cache 点，推荐把 {{cache_anchor}} 放在最终 payload 的 ${actual} 之后，也就是这段文字结尾之后：“${locator.last || '无法提取'}”。${currentInfo}`
        : (testMode === 'current'
            ? `检测当前 cache 点：当前落点是 ${actual}，等价于放在这一段文字结尾之后：“${locator.last || '无法提取'}”。`
            : `没有找到比当前 cache 点更合适的自动推荐位置；当前落点是 ${actual}。`);
    return {
        anchor: actual,
        reason: best
            ? '这是忽略当前手动锚点后，本地模拟能找到的最后一个看起来稳定、且仍在最新 user / 末尾动态内容之前的位置。'
            : (second ? (testMode === 'current' ? '当前 cache block 两轮匹配；按离线模拟判断当前点合格。' : '当前 cache block 两轮匹配，但没有找到更靠后的稳定推荐点。') : '第二轮没有找到相同的 cache block；理论上不会读取缓存。'),
        humanAnswer,
        steps: best?.steps || [
            `当前落点文本结尾是：“${locator.last || '无法提取'}”。`,
            nextLocator?.first ? `下一段开头是：“${nextLocator.first}”。` : '当前落点后面没有下一段 payload。',
            '如果想提高覆盖率，需要找到更靠后且两轮不变的 prompt 段。',
        ],
        locator,
        nextLocator,
        recommended: !!best,
        currentBlock: first,
        stableChars,
        stableTokens,
        round1CoveragePercent: coverage1,
        round2CoveragePercent: coverage2,
        matched: best ? true : !!second,
        block: chosen,
        lastStableLabel: actual,
        truncated: false,
    };
}

async function explainAnthropicCachePlacementWithAi(result) {
    const profile = getProfileFor('routing') || getProfileFor('recap') || getProfileFor('treeFill');
    if (!profile) throw new Error('未配置可用于 AI 解释的模型：请先设置“回复前·记忆树检索模型”或日记/填树模型。');
    const sim = result.simulation;
    const p = result.placement || {};
    const prompt = `你是 SillyTavern Memory Wizzard 的 cache_control 放置诊断器。用户不需要“稳定内容之后、最新 user 之前”这种老生常谈。你必须根据下面的真实 payload 落点信息，给出具体、可执行的诊断。

必须输出中文，按这 4 段写：
1. 推荐实际落点：说明插件忽略用户当前 cache 点后，推荐等价于放在什么句子/文本之后。
2. 覆盖率问题：解释为什么这个推荐点能覆盖 ${p.round1CoveragePercent}%，后面哪些后缀仍然没有缓存。
3. 怎么移动：基于“推荐落点文本结尾”和“后一段开头”告诉用户应把 {{cache_anchor}} 移到哪个 prompt/哪段文字之后。
4. 提高命中率：给出 2-4 条具体建议，必须提到动态时间/最新 user/Chat History 是否会变化。

不要泛泛而谈。不要说 system.content[0]。不要声称这是 provider 真实 usage，这是离线模拟。

离线模拟数据：
第1轮写入 tokens≈${sim.round1.simulated_cache_creation_input_tokens}
第2轮读取 tokens≈${sim.round2.simulated_cache_read_input_tokens}
第1轮未缓存后缀≈${sim.suffix1Tokens}
第2轮未缓存后缀≈${sim.suffix2Tokens}
两轮 hash：${sim.round1PrefixHash} → ${sim.round2PrefixHash}
两轮是否匹配：${sim.matched ? '匹配' : '不匹配'}
推荐落点：${p.anchor}
推荐落点文本开头：${p.locator?.first || '无'}
推荐落点文本结尾：${p.locator?.last || '无'}
推荐落点后一段开头：${p.nextLocator?.first || '无'}
覆盖比例：第1轮约 ${p.round1CoveragePercent}%，第2轮约 ${p.round2CoveragePercent}%
判断：${p.reason}`;
    return await runProfileLlmCall(profile, [{ role: 'user', content: prompt }], '你只负责做 cache_control 落点诊断，输出中文、具体建议，不要 markdown 表格。', 0.1, config.TIMEOUT_MS, null, true, true);
}

function pickAnthropicCacheProbeProfile() {
    const context = window.SillyTavern?.getContext();
    const cmProfiles = context?.extensionSettings?.connectionManager?.profiles || [];
    const names = [
        config.fusionProfile,
        config.routingProfile,
        config.treeFillProfile,
        config.recapProfile,
        config.weeklyProfile,
        config.historicalProfile,
        config.aiShrinkProfile,
    ].filter(Boolean);
    for (const name of names) {
        const profile = cmProfiles.find(p => p.name === name);
        if (profile && isAnthropicCacheCandidate({}, profile)) return { profile, name };
    }
    for (const profile of cmProfiles) {
        if (isAnthropicCacheCandidate({}, profile)) return { profile, name: profile.name || profile.id };
    }
    return null;
}

function estimateAnthropicTokens(text) {
    // Offline approximation only. Anthropic's real tokenizer is provider-side; keep
    // the estimate conservative and label it as approximate everywhere in the UI.
    const value = String(text || '');
    return Math.max(1, Math.max(estimateTokens(value), Math.ceil(value.length / 4)));
}

function flattenMessageText(messages) {
    return messages.map(m => Array.isArray(m.content) ? m.content.map(p => p?.text || '').join('') : (m.content || '')).join('\n');
}

function inputPriceUsdPerMTok() {
    // Visible default for Claude Opus 4.8 input. Output is not estimated because no
    // model is called in the offline simulator.
    return 5;
}

function usd(value) {
    return `$${Number(value || 0).toFixed(6)}`;
}

function fmtNum(value) {
    return Number(value || 0).toLocaleString();
}

function inspectCacheableBlocks(messages) {
    const blocks = [];
    const prefixParts = [];
    messages.forEach((msg, messageIndex) => {
        const role = msgOpenAiRole(msg);
        const parts = Array.isArray(msg?.content) ? msg.content : [{ type: 'text', text: msg?.content || '' }];
        parts.forEach((part, partIndex) => {
            const text = part?.text || '';
            if (text) prefixParts.push(`[${role}]\n${text}`);
            if (!part?.cache_control) return;
            const prefixText = prefixParts.join('\n');
            blocks.push({
                messageIndex,
                partIndex,
                role,
                blockChars: cacheableTextLength(text),
                blockTokens: estimateAnthropicTokens(text),
                chars: cacheableTextLength(prefixText),
                tokens: estimateAnthropicTokens(prefixText),
                ttl: part.cache_control.ttl || '5m',
                type: part.cache_control.type || 'ephemeral',
                hash: djb2Hash(prefixText),
            });
        });
    });
    return blocks;
}

function djb2Hash(text) {
    let hash = 5381;
    for (let i = 0; i < text.length; i++) hash = ((hash << 5) + hash) + text.charCodeAt(i);
    return (hash >>> 0).toString(16).padStart(8, '0');
}

function simulateAnthropicCacheBilling(round1Messages, round2Messages, overrideBlock = null) {
    const blocks1 = inspectCacheableBlocks(round1Messages);
    const blocks2 = inspectCacheableBlocks(round2Messages);
    const first = overrideBlock || blocks1[0] || null;
    const second = overrideBlock ? overrideBlock : blocks2.find(b => first && b.hash === first.hash && b.tokens === first.tokens) || null;
    const suffix1Tokens = Math.max(0, estimateAnthropicTokens(flattenMessageText(round1Messages)) - (first?.tokens || 0));
    const suffix2Tokens = Math.max(0, estimateAnthropicTokens(flattenMessageText(round2Messages)) - (second?.tokens || 0));
    const writeMultiplier = (first?.ttl === '1h') ? 2.0 : 1.25;
    const readMultiplier = 0.1;
    const stableTokens = first?.tokens || 0;
    const noCacheTokens = stableTokens + suffix1Tokens + stableTokens + suffix2Tokens;
    const withCacheTokens = Math.round(stableTokens * writeMultiplier + suffix1Tokens + (second ? stableTokens * readMultiplier : stableTokens * writeMultiplier) + suffix2Tokens);
    const price = inputPriceUsdPerMTok();
    const noCacheUsd = noCacheTokens * price / 1_000_000;
    const withCacheUsd = withCacheTokens * price / 1_000_000;
    return {
        mode: 'offline_simulation_no_llm',
        source: 'current ST chat approximation',
        blocks1,
        blocks2,
        injected: !!first,
        matched: !!second,
        ttl: first?.ttl || config.anthropicCacheTTL || '5m',
        round1PrefixHash: first?.hash || '',
        round2PrefixHash: second?.hash || blocks2[0]?.hash || '',
        stableTokens,
        suffix1Tokens,
        suffix2Tokens,
        round1: {
            simulated_cache_creation_input_tokens: stableTokens,
            simulated_cache_read_input_tokens: 0,
            estimated_uncached_input_tokens: suffix1Tokens,
            estimated_billable_input_token_equivalent: Math.round(stableTokens * writeMultiplier + suffix1Tokens),
        },
        round2: {
            simulated_cache_creation_input_tokens: second ? 0 : (blocks2[0]?.tokens || 0),
            simulated_cache_read_input_tokens: second?.tokens || 0,
            estimated_uncached_input_tokens: suffix2Tokens,
            estimated_billable_input_token_equivalent: Math.round((second ? stableTokens * readMultiplier : stableTokens * writeMultiplier) + suffix2Tokens),
        },
        writeMultiplier,
        readMultiplier,
        inputPriceUsdPerMTok: price,
        estimatedNoCacheInputCostUsd: noCacheUsd,
        estimatedWithCacheInputCostUsd: withCacheUsd,
        estimatedDeltaUsd: noCacheUsd - withCacheUsd,
        estimatedDeltaPercent: noCacheUsd > 0 ? ((noCacheUsd - withCacheUsd) / noCacheUsd * 100) : 0,
    };
}

function runAnthropicCacheOfflineProbe() {
    refreshAnthropicCacheConfigFromUi();
    if (!config.anthropicCacheEnabled) throw new Error('cachecontrol 锚点未启用。');
    const scope = config.anthropicCacheScope || 'internal';
    if (scope !== 'main' && scope !== 'both') {
        throw new Error('真实 payload 离线对比测试的是主聊天最终 messages；请把“生效范围”切到“仅主聊天实验锚点”或“两者都启用”。');
    }
    const testMode = config.anthropicCacheTestMode || 'recommend';
    let round1Messages = Array.isArray(lastMainPromptCacheSnapshot) && lastMainPromptCacheSnapshot.length ? cloneChatMessages(lastMainPromptCacheSnapshot) : null;
    let round2Messages = round1Messages ? buildPayloadOfflineRound2(round1Messages) : null;
    let metaSource = { ...(lastMainPromptCacheSnapshotMeta || {}), fallback: false };
    if (!round1Messages) {
        if (config.fakeChatHistory) {
            throw new Error('当前启用了“伪造成聊天历史/删除原生上下文 regex”。为了避免绕过 ST regex 后误判，推荐/检测测试需要先捕获一次真实 payload；请点一次生成/预览让 CHAT_COMPLETION_PROMPT_READY 产生快照后再测。');
        }
        const fallback = buildHistoryFallbackProbeMessages();
        if (!fallback) throw new Error('没有捕获到真实 payload，且当前聊天历史不足两轮，无法自动回退测试。请至少保留最近两条对话。');
        round1Messages = fallback.round1Messages;
        round2Messages = fallback.round2Messages;
        metaSource = fallback.meta;
    }

    const placement = recommendCacheControlPlacementFromPayload(round1Messages, round2Messages, testMode);
    const simulation = simulateAnthropicCacheBilling(round1Messages, round2Messages, placement.recommended ? placement.block : null);
    const diffHtml = renderCachePayloadDiff(round1Messages, round2Messages, placement.block);
    const parsedControl = parseAnthropicCacheControlJson();
    const blocks = inspectCacheableBlocks(round1Messages);
    const hasCacheControl = testMode === 'recommend' ? !!placement.block : blocks.length > 0;
    const meta = { ...metaSource, cacheBlockCount: blocks.length, firstCacheBlockHash: blocks[0]?.hash || '', testMode };
    console.info(`${LOG_PREFIX} CacheControl 1:1 payload offline probe: messages=${round1Messages.length}, cacheBlocks=${blocks.length}, matched=${simulation.matched}, stableTokens≈${simulation.stableTokens}, round1Creation≈${simulation.round1.simulated_cache_creation_input_tokens}, round2Read≈${simulation.round2.simulated_cache_read_input_tokens}.`);
    return {
        profileName: '当前主聊天 payload 快照',
        hasCacheControl,
        stableChars: placement.stableChars,
        cacheControl: parsedControl,
        simulation,
        placement,
        diffHtml,
        mode: testMode === 'recommend' ? 'offline_recommend_best_cache_point' : 'offline_check_current_cache_point',
        source: meta.fallback ? '当前聊天历史回退 / 最近两轮' : 'CHAT_COMPLETION_PROMPT_READY / eventData.chat',
        snapshotMeta: meta,
    };
}

function applyMainPromptCacheControls(chat) {
    if (!anthropicCacheEnabledFor('main') || !Array.isArray(chat)) return;
    let applied = 0;
    if ((config.anthropicCacheMainMode || 'manual') === 'gateway') {
        // 网关文本标记模式：原生 Claude 源下 ST convertClaudeMessages 会剥掉内容块 cache_control 字段
        // （prompt-converters.js 重建 text 块只保留 text、丢 cache_control）。
        // 所以这里不注入 cache_control 字段，而是把 {{cache_anchor}} 替换成纯文本 [[CACHE_BREAK]]，
        // 它会原样穿过 convertClaudeMessages 到达本地反代网关，由网关 applyAnthropicCacheBreaks 转成 cache_control。
        chat.forEach((msg, i) => {
            if (!msg || typeof msg.content !== 'string' || !msg.content.includes('{{cache_anchor}}')) return;
            msg.content = msg.content.split('{{cache_anchor}}').join('[[CACHE_BREAK]]');
            applied += 1;
            if (config.anthropicCacheDebug) writeLog(`CacheControl main/gateway: message #${i} {{cache_anchor}} -> [[CACHE_BREAK]]（交本地网关转 cache_control）.`, 'INFO');
        });
        if (applied > 4) writeLog(`CacheControl main/gateway: ${applied} 个标记；Anthropic/网关最多 4 个 cache 断点，多余标记网关会移除不注入。`, 'WARNING');
    } else if ((config.anthropicCacheMainMode || 'manual') === 'manual') {
        chat.forEach((msg, i) => {
            if (!msg || typeof msg.content !== 'string' || !msg.content.includes('{{cache_anchor}}')) return;
            const res = applyManualCacheAnchorToText(msg.content);
            msg.content = res.content;
            let cached = !!res.cached;
            if (!cached && res.standalone) {
                const previousIndex = applyCacheToPreviousMessage(chat, i);
                cached = previousIndex >= 0;
                if (config.anthropicCacheDebug) writeLog(`CacheControl main/manual standalone anchor: marker message #${i}, previousCachedIndex=${previousIndex}.`, cached ? 'INFO' : 'WARNING');
            }
            if (cached) applied += 1;
            if (config.anthropicCacheDebug) writeLog(`CacheControl main/manual: message #${i}, cached=${cached}, standalone=${!!res.standalone}.`, cached ? 'INFO' : 'WARNING');
        });
    } else {
        const depth = Math.max(0, parseInt(config.anthropicCacheDepth) || 0);
        let passedPrefill = false;
        let roleSwitches = 0;
        let prevRole = '';
        for (let i = chat.length - 1; i >= 0; i--) {
            const msg = chat[i];
            if (!msg) continue;
            const role = msgOpenAiRole(msg);
            if (!passedPrefill && role === 'assistant') continue;
            passedPrefill = true;
            if (role !== prevRole) {
                if (roleSwitches === depth || roleSwitches === depth + 2) {
                    if (applyCacheToMessageContent(msg, `main/depth #${i}`)) applied += 1;
                }
                if (roleSwitches === depth + 2) break;
                roleSwitches += 1;
                prevRole = role;
            }
        }
        if (config.anthropicCacheDebug) writeLog(`CacheControl main/depth: applied ${applied} breakpoint(s), depth=${depth}.`, applied ? 'INFO' : 'WARNING');
    }
    if (applied > 4) writeLog(`CacheControl main: applied ${applied} breakpoints; Anthropic supports at most 4, consider reducing anchors.`, 'WARNING');
}

// ══════════════════════════════════════════════════════════════════════
// REGION: LLM 调用基建 / 后端日志（writeLog / profile 解析 / callLlmDirect）
// ══════════════════════════════════════════════════════════════════════
// Log message to backend file
async function writeLog(message, level = 'INFO') {
    console.log(`${LOG_PREFIX} [${level}] ${message}`);
    try {
        await fetch('/api/plugins/st-memory-wizzard/log', {
            method: 'POST',
            headers: getWizardHeaders(),
            body: JSON.stringify({ message, level })
        });
    } catch (e) {
        console.error(`${LOG_PREFIX} Failed to send log to backend`, e);
    }
}

// Get unmasked secret key and API details for a connection profile name
async function getProfileConfig(profileName) {
    if (!profileName) {
        throw new Error("No profile name specified.");
    }
    const connectionManager = window.SillyTavern?.getContext()?.extensionSettings?.connectionManager;
    if (!connectionManager || !connectionManager.profiles) {
        throw new Error("SillyTavern Connection Manager profiles not found.");
    }
    const profile = connectionManager.profiles.find(p => p.name === profileName);
    if (!profile) {
        throw new Error(`Connection profile "${profileName}" not found.`);
    }

    const apiUrl = profile['api-url'];
    const model = profile['model'];
    const secretId = profile['secret-id'];

    if (!secretId) {
        return { apiUrl, apiKey: "", model, apiType: profile.api };
    }

    // Load secret key
    const secretsModule = await import('/scripts/secrets.js');
    if (!secretsModule.secret_state || Object.keys(secretsModule.secret_state).length === 0) {
        await secretsModule.readSecretState();
    }

    let secretKey = null;
    for (const [key, secrets] of Object.entries(secretsModule.secret_state)) {
        if (Array.isArray(secrets) && secrets.some(s => s.id === secretId)) {
            secretKey = key;
            break;
        }
    }

    if (!secretKey) {
        throw new Error(`Could not find secret key for ID "${secretId}" in secret_state.`);
    }

    const apiKey = await secretsModule.findSecret(secretKey, secretId);
    return {
        apiUrl,
        apiKey,
        model,
        apiType: profile.api
    };
}

// Direct LLM Call handler (supporting OpenAI and Google formats)
async function callLlmDirect(profileConfig, messages, systemPrompt = "", temperature = 0.0, timeoutMs = 8000, abortSignal = null) {
    const { apiUrl, apiKey, model, apiType } = profileConfig;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    if (abortSignal) {
        if (abortSignal.aborted) {
            controller.abort();
        } else {
            abortSignal.addEventListener('abort', () => controller.abort());
        }
    }

    try {
        // Direct Google AI Studio format
        if (apiType === 'makersuite' || (apiUrl && apiUrl.includes('googleapis.com')) || (model && model.startsWith('gemini'))) {
            const googleMessages = messages.map(m => {
                let role = m.role === 'assistant' || m.role === 'model' ? 'model' : 'user';
                return {
                    role: role,
                    parts: [{ text: m.content || m.mes || "" }]
                };
            });

            let url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
            if (apiUrl && !apiUrl.includes('v1beta') && apiUrl.includes('googleapis.com')) {
                url = `${apiUrl.replace(/\/$/, '')}/models/${model}:generateContent?key=${apiKey}`;
            }

            const payload = {
                contents: googleMessages,
                generationConfig: {
                    temperature: temperature
                }
            };
            if (systemPrompt) {
                payload.systemInstruction = {
                    parts: [{ text: systemPrompt }]
                };
            }

            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                signal: controller.signal
            });
            clearTimeout(timeoutId);

            if (!res.ok) {
                throw new Error(`Google API returned ${res.status}: ${await res.text()}`);
            }
            const data = await res.json();
            return data.candidates?.[0]?.content?.parts?.[0]?.text || "";
        } else {
            // OpenAI compatible format
            let url = apiUrl;
            if (!url) {
                throw new Error("API URL is empty for OpenAI compatible request.");
            }
            if (!url.endsWith('/chat/completions')) {
                url = url.replace(/\/$/, '') + '/chat/completions';
            }
            const payloadMessages = [];
            if (systemPrompt) {
                const sysMsg = { role: 'system', content: systemPrompt };
                if (anthropicCacheEnabledFor('internal') && isAnthropicCacheCandidate(profileConfig)) {
                    const ok = applyCacheToMessageContent(sysMsg, 'direct/system');
                    if (config.anthropicCacheDebug) writeLog(`CacheControl internal/direct system: ${ok ? 'added' : 'skipped'} (${cacheableTextLength(systemPrompt)} chars).`, ok ? 'INFO' : 'DEBUG');
                }
                payloadMessages.push(sysMsg);
            }
            messages.forEach(m => {
                payloadMessages.push({
                    role: msgOpenAiRole(m),
                    content: m.content || m.mes || ""
                });
            });

            const res = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}`
                },
                body: JSON.stringify({
                    model: model,
                    messages: payloadMessages,
                    temperature: temperature
                }),
                signal: controller.signal
            });
            clearTimeout(timeoutId);

            if (!res.ok) {
                throw new Error(`OpenAI API returned ${res.status}: ${await res.text()}`);
            }
            const data = await res.json();
            return data.choices?.[0]?.message?.content || "";
        }
    } catch (e) {
        clearTimeout(timeoutId);
        throw e;
    }
}

// Memory tree recursive helpers
// Routing index for the flash router. To save tokens, sibling LEAF nodes (no
// children) under the same parent are coalesced onto ONE line that prints the
// shared parent prefix once: `母/子A (hintA), 子B (hintB)`. Each leaf keeps its
// own hint so routing accuracy is preserved. Nodes WITH children (intermediate
// "分类目录") still get their own line (their path prefix is reused by leaves).
// pinned/archived nodes are excluded everywhere (same as before).
// A node's path is sent in the routing index ({{memory_tree}} / {{memory_tree_header}})
// unless its sendPath flag is explicitly false. Missing/true = sent (back-compat).
function nodeSendsPath(n) {
    return n && n.sendPath !== false;
}

// World-info-style keyword trigger. Scan the latest user message and the latest AI
// message; any non-archived node whose comma-separated `keywords` appear in either
// message is force-included (path into the index, content into recall/fusion),
// regardless of routing. Case-insensitive substring match. Returns an array of nodes.
function getKeywordMatchedNodes(chatList) {
    if (!Array.isArray(chatList) || chatList.length === 0) return [];
    let lastUser = '', lastAi = '';
    for (let i = chatList.length - 1; i >= 0; i--) {
        const m = chatList[i];
        if (!m) continue;
        const isUser = m.role ? m.role === 'user' : !!m.is_user;
        const body = (m.content || m.mes || '');
        if (isUser && !lastUser) lastUser = body;
        else if (!isUser && !m.is_system && !lastAi) lastAi = body;
        if (lastUser && lastAi) break;
    }
    const haystack = `${lastUser}\n${lastAi}`.toLowerCase();
    if (!haystack.trim()) return [];
    const matched = [];
    getAllNodes(memoryTree).forEach(n => {
        if (!n || n.archived) return;
        const kwRaw = (n.keywords || '').trim();
        if (!kwRaw) return;
        const kws = kwRaw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
        if (kws.some(k => haystack.includes(k))) matched.push(n);
    });
    return matched;
}

function getRoutingIndex(nodes) {
    const index = [];
    const fmtLeaf = (n) => n.hint ? `${n.title} (${n.hint})` : n.title;
    function traverse(node) {
        const children = Array.isArray(node.children) ? node.children : [];
        // Eligible leaf children of THIS node (no further sub-paths).
        const leafKids = children.filter(c =>
            !c.pinned && !c.archived && nodeSendsPath(c) && (!Array.isArray(c.children) || c.children.length === 0));
        const branchKids = children.filter(c =>
            Array.isArray(c.children) && c.children.length > 0);

        if (leafKids.length > 1) {
            // Coalesce: print parent path once, then comma-joined leaves with hints.
            // Format: `母路径/{ 子A (hintA), 子B (hintB) }` — 路由模型把每个子项展开为「母路径/子X」。
            index.push(`${node.path}/{ ${leafKids.map(fmtLeaf).join(', ')} }`);
        } else if (leafKids.length === 1) {
            // Single leaf: keep the original full-path | hint form (no benefit to coalesce).
            const c = leafKids[0];
            index.push(`${c.path} | ${c.hint}`);
        }

        // Branch children (have sub-paths) recurse; each is itself indexed below.
        branchKids.forEach(c => {
            if (!c.pinned && !c.archived && nodeSendsPath(c)) index.push(`${c.path} | ${c.hint}`);
            traverse(c);
        });
    }
    // Root level: treat the virtual root specially — roots can themselves be leaves
    // or branches. Build a synthetic parent so root leaves coalesce too.
    const rootLeaves = nodes.filter(n =>
        !n.pinned && !n.archived && nodeSendsPath(n) && (!Array.isArray(n.children) || n.children.length === 0));
    const rootBranches = nodes.filter(n =>
        Array.isArray(n.children) && n.children.length > 0);
    // Root leaves have no shared parent prefix → list individually (path == title).
    rootLeaves.forEach(n => index.push(`${n.path} | ${n.hint}`));
    rootBranches.forEach(n => {
        if (!n.pinned && !n.archived && nodeSendsPath(n)) index.push(`${n.path} | ${n.hint}`);
        traverse(n);
    });
    return index;
}

// ══════════════════════════════════════════════════════════════════════
// REGION: 记忆树 — 查找 / 路径索引 / 节点收集
// ══════════════════════════════════════════════════════════════════════
function findNodeByPath(nodes, pathStr) {
    let found = null;
    function traverse(node) {
        if (node.path === pathStr) {
            found = node;
            return;
        }
        if (node.children) {
            node.children.forEach(traverse);
        }
    }
    nodes.forEach(traverse);
    return found;
}

function findNodeByTitle(nodes, titleStr) {
    let found = null;
    function traverse(node) {
        if (node.title === titleStr) {
            found = node;
            return;
        }
        if (node.children) {
            node.children.forEach(traverse);
        }
    }
    nodes.forEach(traverse);
    return found;
}

// Get node and all its children recursively
function collectNodeAndChildren(node) {
    const list = [];
    function traverse(n) {
        list.push(n);
        if (n.children) {
            n.children.forEach(traverse);
        }
    }
    traverse(node);
    return list;
}

// Collect all nodes in the tree
function getAllNodes(nodes) {
    const list = [];
    function traverse(n) {
        list.push(n);
        if (n.children) {
            n.children.forEach(traverse);
        }
    }
    nodes.forEach(traverse);
    return list;
}

// Find closest matching node in the tree based on title edit distance
function findClosestNodeByTitle(nodes, targetTitle) {
    const allNodes = getAllNodes(nodes);
    let bestMatch = null;
    let maxSim = 0;
    for (const n of allNodes) {
        const sim = getSimilarity(n.title, targetTitle);
        if (sim > maxSim) {
            maxSim = sim;
            bestMatch = n;
        }
    }
    if (maxSim > 0.8) {
        return bestMatch;
    }
    return null;
}

// Normalize LLM response shapes from ST ConnectionManager / ChatCompletionService /
// OpenAI-compatible routers. Some backends return raw strings, some {content}, and
// Pioneer/OpenAI-style routers may return {choices:[{message:{content}}]} even when
// extractData=true. Missing this shape made auto 周记/史记 fusion receive an empty
// string after the model had actually produced valid JSON.
function extractLlmText(resp) {
    if (typeof resp === 'string') return resp;
    if (!resp) return '';
    if (typeof resp.content === 'string') return resp.content;
    const choiceMsg = resp.choices?.[0]?.message?.content;
    if (typeof choiceMsg === 'string') return choiceMsg;
    const choiceText = resp.choices?.[0]?.text;
    if (typeof choiceText === 'string') return choiceText;
    const candidateText = resp.candidates?.[0]?.content?.parts?.[0]?.text;
    if (typeof candidateText === 'string') return candidateText;
    return '';
}

function extractLlmReasoning(resp) {
    if (!resp || typeof resp === 'string') return '';
    const fields = [
        resp.reasoning,
        resp.reasoning_content,
        resp.thinking,
        resp.thoughts,
        resp.choices?.[0]?.message?.reasoning,
        resp.choices?.[0]?.message?.reasoning_content,
        resp.choices?.[0]?.delta?.reasoning,
        resp.choices?.[0]?.delta?.reasoning_content,
    ];
    return fields.find(x => typeof x === 'string' && x.trim()) || '';
}

// Many reverse-proxies / models deliver the chain-of-thought INLINE in the body,
// wrapped in <thinking>…</thinking> (or) rather than via a
// dedicated reasoning stream field. extractLlmReasoning returns '' in that case,
// so the reasoning pane never fills and the user cannot see the thinking.
// splitInlineThinking extracts such inline blocks OUT of a full text and returns
// { body, thinking }: body has the thinking blocks removed + trimmed; thinking is
// the concatenated content of every matched block (in order). Works on streaming
// partials too (an unclosed <thinking> at the tail is captured to end-of-string).
function splitInlineThinking(fullText) {
    if (typeof fullText !== 'string' || !fullText) return { body: '', thinking: '' };
    const re = /<think(?:ing)?>\s*([\s\S]*?)(?:<\/think(?:ing)?>|$)/gi;
    let thinking = '';
    let body = '';
    let last = 0;
    let m;
    while ((m = re.exec(fullText)) !== null) {
        body += fullText.slice(last, m.index);
        thinking += m[1] || '';
        last = re.lastIndex;
        // If this match ran to end-of-string (no closing tag, $ branch), stop so we
        // don't loop.
        if (m.index + m[0].length >= fullText.length && !/<\/think(?:ing)?>/i.test(m[0])) break;
    }
    body += fullText.slice(last);
    body = body.replace(/<\/think(?:ing)?>/gi, '').trim();
    return { body, thinking: thinking.trim() };
}

// Estimate token count (Chinese characters + 1.2 * English words)
function estimateTokens(text) {
    if (!text) return 0;
    const chineseCount = (text.match(/[\u4e00-\u9fff]/g) || []).length;
    const englishWords = text.match(/\b\w+\b/g) || [];
    const englishCount = englishWords.length;
    return chineseCount + Math.floor(englishCount * 1.2);
}

// ══════════════════════════════════════════════════════════════════════
// REGION: 记忆树 — DOM 渲染（递归树视图 / 拖拽 / 徽章 / 行内操作）
// ══════════════════════════════════════════════════════════════════════
// Tree builder UI renderer
function renderTreeView(nodes, parentEl) {
    if (!parentEl || parentEl.length === 0) {
        writeLog('renderTreeView skipped: target element not in DOM.', 'DEBUG');
        return;
    }
    // Remember the last render target so checkbox cascades / selection toggles can
    // re-render the exact same view (full tree vs. filtered search results).
    currentRenderNodes = nodes;
    currentRenderParentEl = parentEl;
    parentEl.empty();

    if (!nodes || nodes.length === 0) {
        parentEl.append('<li style="color: #9ca3af; padding: 12px; text-align: center;"><i class="fa-solid fa-seedling" style="margin-right: 6px;"></i>记忆树为空。使用编辑器添加第一个节点吧！</li>');
        return;
    }

    parentEl.closest('.wizard-tree-list-col')
        .off('dragover.wizardTreeAutoScroll')
        .on('dragover.wizardTreeAutoScroll', function (e) {
            autoScrollTreeDuringDrag(e.originalEvent);
        });

    // On the first full-tree render after a (re)load, start fully collapsed:
    // every non-root folder goes into collapsedPaths so only the top-level
    // category titles show and the first chevron click is always an expand.
    // Root nodes (direct children of memoryTree) stay expanded so their titles
    // (现实事件, 知识, …) are always visible. Skipped for filtered search renders.
    if (!treeCollapseInitialized && nodes === memoryTree) {
        collapsedPaths.clear();
        allExpanded = false;
        getAllNodes(memoryTree).forEach(n => {
            const isRoot = memoryTree.indexOf(n) !== -1;
            if (!isRoot && n.children && n.children.length > 0) collapsedPaths.add(n.path);
        });
        treeCollapseInitialized = true;
    }

    function renderNode(node, container) {
        const li = $('<li class="wizard-tree-item"></li>');
        const header = $('<div class="wizard-tree-header"></div>');
        header.attr('data-path', node.path);
        header.attr('draggable', 'true');
        header.attr('title', (header.attr('title') || '') + '拖动到另一个节点上，可移动到该路径下');
        if (node.color) {
            // Mark as custom-colored and expose the color via a CSS variable.
            // The .has-custom-color rule (with !important) overrides the
            // hard-coded path-based category colors in index.css.
            header.addClass('has-custom-color');
            header.attr('data-custom-color', node.color);
            header[0].style.setProperty('--node-custom-color', node.color);
        }

        const info = $('<div class="wizard-node-info"></div>');
        const hasChildren = node.children && node.children.length > 0;
        const isCollapsed = collapsedPaths.has(node.path);

        // Selection checkbox (only in batch-edit mode). Checking a node cascades
        // to all of its descendants (by path).
        let checkbox = null;
        if (treeSelectionMode) {
            checkbox = $('<input type="checkbox" class="wizard-tree-checkbox" style="width: 15px; height: 15px; cursor: pointer; margin-right: 6px; flex: 0 0 auto;">');
            checkbox.prop('checked', selectedPaths.has(node.path));
            checkbox.on('click', function (e) {
                e.stopPropagation();
            });
            checkbox.on('change', function (e) {
                e.stopPropagation();
                const checked = $(this).prop('checked');
                // Cascade to this node + all descendants (by path).
                collectNodeAndChildren(node).forEach(n => {
                    if (checked) selectedPaths.add(n.path);
                    else selectedPaths.delete(n.path);
                });
                rerenderTree();
                updateTreeSelectionUI();
            });
            info.append(checkbox);
        }

        // Expand/Collapse Chevron
        let chevron = null;
        if (hasChildren) {
            chevron = $('<i class="fa-solid wizard-tree-chevron" style="cursor: pointer; margin-right: 4px; width: 12px; display: inline-block; text-align: center; color: var(--wizard-primary);"></i>');
            chevron.addClass(isCollapsed ? 'fa-chevron-right' : 'fa-chevron-down');
            info.append(chevron);
        } else {
            info.append($('<span style="width: 16px; display: inline-block;"></span>'));
        }

        const icon = hasChildren
            ? $('<i class="fa-solid fa-folder" style="color: var(--wizard-primary);"></i>')
            : $('<i class="fa-solid fa-file-lines" style="color: #9ca3af;"></i>');

        const titleSpan = $('<span class="wizard-node-title"></span>').text(node.title);
        info.append(icon).append(titleSpan);

        // Only show the hint (in parens) when it is non-empty — avoids "()" tails.
        const hintText = (node.hint || '').trim();
        if (hintText) {
            const hintSpan = $('<span class="wizard-node-hint"></span>').text(` (${hintText})`);
            info.append(hintSpan);
        }

        // Archived nodes render dimmed / semi-transparent.
        if (node.archived) {
            header.addClass('wizard-node-archived-row');
        }

        // Badges
        const badges = $('<div class="wizard-node-badges"></div>');
        if (isSharedPath(node.path)) {
            badges.append('<span class="wizard-badge wizard-badge-shared" title="共享枝条：所有角色/群组都能看见和编辑这里的记忆，独立于单个角色储存" style="background: #3b82f6; color: #fff;">共享</span>');
        }
        if (node.pinned) {
            badges.append('<span class="wizard-badge wizard-badge-pinned">Pinned</span>');
        }
        if (node.sendPath === false) {
            badges.append('<span class="wizard-badge wizard-badge-nopath" title="发送路径已关闭：此节点路径不进入 {{memory_tree}} 路由索引">No Path</span>');
        }
        if (node.archived) {
            badges.append('<span class="wizard-badge wizard-badge-archived">Archived</span>');
        }
        info.append(badges);

        // Actions
        const actions = $('<div class="wizard-node-actions"></div>');
        const sourceMeta = formatTreeSourceMeta(node);
        const isAiNewThisSession = aiNewNodePathsThisSession.has(node.path);
        let sourceInfoBtn = null;
        let newBadge = null;
        if (sourceMeta) {
            sourceInfoBtn = $('<button class="wizard-btn-icon wizard-node-source-info" title=""></button>');
            sourceInfoBtn.attr('title', sourceMeta.text + '\n点击右键可移除这段来源标记（点保存节点后写入）');
            sourceInfoBtn.append('<i class="fa-solid fa-circle-info"></i>');
        }
        if (isAiNewThisSession) {
            newBadge = $('<span class="wizard-node-new-badge">(新!)</span>');
        }
        const editBtn = $('<button class="wizard-btn-icon" title="编辑"><i class="fa-solid fa-pen"></i></button>');
        const addSubBtn = $('<button class="wizard-btn-icon" title="添加子节点"><i class="fa-solid fa-plus"></i></button>');
        const deleteBtn = $('<button class="wizard-btn-icon delete" title="删除"><i class="fa-solid fa-trash"></i></button>');

        if (sourceInfoBtn) actions.append(sourceInfoBtn);
        actions.append(editBtn).append(addSubBtn).append(deleteBtn);

        header.append(info);
        if (newBadge) header.append(newBadge);
        header.append(actions);
        li.append(header);

        let childUl = null;
        if (hasChildren) {
            childUl = $('<ul class="wizard-tree"></ul>');
            node.children.forEach(child => renderNode(child, childUl));
            li.append(childUl);

            if (isCollapsed) {
                childUl.hide();
            }

            // Toggle event
            chevron.on('click', function (e) {
                e.stopPropagation();
                if (collapsedPaths.has(node.path)) {
                    collapsedPaths.delete(node.path);
                    childUl.slideDown(150);
                    chevron.removeClass('fa-chevron-right').addClass('fa-chevron-down');
                } else {
                    collapsedPaths.add(node.path);
                    childUl.slideUp(150);
                    chevron.removeClass('fa-chevron-down').addClass('fa-chevron-right');
                }
            });
        }

        // Drag/drop: move a node under another node by dragging its row onto the
        // destination row. Dropping onto a node makes it the parent path.
        header.on('dragstart', function (e) {
            if ($(e.target).closest('.wizard-btn-icon, .wizard-tree-chevron, input, textarea, button').length > 0) {
                e.preventDefault();
                return;
            }
            const dt = e.originalEvent.dataTransfer;
            dt.effectAllowed = 'move';
            dt.setData('text/plain', header.attr('data-path') || node.path);
            header.addClass('wizard-tree-dragging');
        });
        header.on('dragend', function () {
            $('.wizard-tree-header').removeClass('wizard-tree-dragging wizard-tree-drop-target wizard-tree-drop-before wizard-tree-drop-after');
        });
        const calcDropMode = (ev) => {
            const rect = header[0].getBoundingClientRect();
            const y = ev.clientY - rect.top;
            const third = rect.height / 3;
            if (y < third) return 'before';
            if (y > third * 2) return 'after';
            return 'inside';
        };
        header.on('dragover', function (e) {
            autoScrollTreeDuringDrag(e.originalEvent);
            const dt = e.originalEvent.dataTransfer;
            const src = dt ? dt.getData('text/plain') : '';
            if (src && (src === node.path || node.path.startsWith(src + '/'))) return;
            e.preventDefault();
            if (dt) dt.dropEffect = 'move';
            const mode = calcDropMode(e.originalEvent);
            header.removeClass('wizard-tree-drop-target wizard-tree-drop-before wizard-tree-drop-after');
            if (mode === 'before') header.addClass('wizard-tree-drop-before');
            else if (mode === 'after') header.addClass('wizard-tree-drop-after');
            else header.addClass('wizard-tree-drop-target');
        });
        header.on('dragleave', function () {
            header.removeClass('wizard-tree-drop-target wizard-tree-drop-before wizard-tree-drop-after');
        });
        header.on('drop', async function (e) {
            e.preventDefault();
            e.stopPropagation();
            const src = e.originalEvent.dataTransfer?.getData('text/plain') || '';
            const mode = calcDropMode(e.originalEvent);
            $('.wizard-tree-header').removeClass('wizard-tree-dragging wizard-tree-drop-target wizard-tree-drop-before wizard-tree-drop-after');
            if (!src) return;
            // Read the target path live from the DOM rather than the render-time
            // closure: after any prior move the closure's node may be stale, but
            // the DOM's data-path always reflects the current tree.
            const tgt = $(this).attr('data-path') || node.path;
            if (mode === 'before' || mode === 'after') await moveNodeBesidePath(src, tgt, mode);
            else await moveNodeUnderPath(src, tgt);
        });

        // Event listeners
        header.on('click', function (e) {
            if ($(e.target).closest('.wizard-btn-icon, .wizard-tree-chevron').length > 0) return;
            $('.wizard-tree-header').removeClass('active-node');
            header.addClass('active-node');
            loadNodeIntoForm(node);
        });

        editBtn.on('click', function () {
            $('.wizard-tree-header').removeClass('active-node');
            header.addClass('active-node');
            loadNodeIntoForm(node);
        });

        addSubBtn.on('click', function () {
            $('#wizard-node-original-path').val('');
            $('#wizard-node-path').val(node.path + '/新节点');
            $('#wizard-node-title').val('新节点');
            $('#wizard-node-hint').val('');
            $('#wizard-node-keywords').val('');
            $('#wizard-node-content').val('');
            $('#wizard-node-send-path').prop('checked', true);
            $('#wizard-node-pinned').prop('checked', false);
            $('#wizard-node-archived').prop('checked', false);
            $('#wizard-node-editor-title').text(`在 [${node.title}] 下添加子节点`);
            $('#wizard-node-path').focus();
        });

        if (sourceInfoBtn) {
            sourceInfoBtn.on('contextmenu', function (e) {
                e.preventDefault();
                e.stopPropagation();
                const realNode = findNodeByPath(memoryTree, node.path) || node;
                if (!nodeEditDraftSnapshot || nodeEditDraftSnapshot.path !== realNode.path) {
                    beginNodeEditDraft(realNode);
                }
                delete realNode.provenance;
                delete node.provenance;
                $(this).remove();
                $('.wizard-tree-header').removeClass('active-node');
                header.addClass('active-node');
                loadNodeIntoForm(realNode, { keepDraft: true });
                toastr.info('已移除来源标记；点右下角「取消」可撤销，点「保存节点」后写入。');
            });
        }

        deleteBtn.on('click', async function () {
            const confirmDel = await window.SillyTavern.getContext().Popup.show.confirm(`确定删除节点 "${node.title}" 吗？`, '删除节点将会连带删除其所有子节点！此操作不可逆。');
            if (confirmDel) {
                deleteNodeFromTree(node);
            }
        });

        container.append(li);
    }

    nodes.forEach(node => renderNode(node, parentEl));

    // Re-inject any pending AI shrink suggestion rows (绿框) destroyed by the
    // rebuild above, so they survive tree re-renders and ST refreshes.
    reinjectAiSuggestionRows();
}

// Re-render whatever view is currently shown (full tree or search results),
// preserving the active node-array/container.
function rerenderTree() {
    const nodes = currentRenderNodes || memoryTree;
    const parentEl = currentRenderParentEl && currentRenderParentEl.length ? currentRenderParentEl : $('#wizard-tree-root');
    renderTreeView(nodes, parentEl);
}

// ─── AI shrink suggestion persistence ────────────────────────────────────────
// AI suggestion rows (绿框) are inserted directly into the tree DOM, so any tree
// re-render (or ST refresh) would normally wipe them. We persist the pending
// suggestions to localStorage (keyed by chat) and re-inject them after every
// renderTreeView so they survive refreshes and only disappear on overwrite/丢弃.

function aiShrinkStorageKey() {
    return `wizard-ai-shrink-pending::${activeChatId || 'default'}`;
}

function saveAiShrinkPending() {
    try {
        const obj = {};
        pendingAiShrinkEdits.forEach((v, k) => { obj[k] = v; });
        if (Object.keys(obj).length === 0) {
            localStorage.removeItem(aiShrinkStorageKey());
        } else {
            localStorage.setItem(aiShrinkStorageKey(), JSON.stringify(obj));
        }
    } catch (e) { /* localStorage may be unavailable; ignore */ }
}

function loadAiShrinkPending() {
    pendingAiShrinkEdits.clear();
    try {
        const raw = localStorage.getItem(aiShrinkStorageKey());
        if (raw) {
            const obj = JSON.parse(raw);
            Object.keys(obj).forEach(k => pendingAiShrinkEdits.set(k, obj[k]));
        }
    } catch (e) { /* ignore corrupt data */ }
}

function normalizeAiShrinkSuggestion(raw) {
    if (typeof raw === 'string') return { content: raw };
    if (!raw || typeof raw !== 'object') return {};
    const out = {};
    if (typeof raw.op === 'string') out.op = raw.op.toLowerCase().trim();
    if (typeof raw.action === 'string' && !out.op) out.op = raw.action.toLowerCase().trim();
    if (typeof raw.path === 'string') out.path = raw.path;
    if (typeof raw.content === 'string') out.content = raw.content;
    if (typeof raw.parent === 'string') out.parent = raw.parent;
    if (typeof raw.title === 'string') out.title = raw.title;
    if (typeof raw.hint === 'string') out.hint = raw.hint;
    if (raw.keywords !== undefined) out.keywords = normalizeOpKeywords(raw.keywords);
    if (typeof raw.newPath === 'string') out.newPath = raw.newPath;
    return out;
}

function buildAiShrinkTargetPath(path, node, suggestion) {
    const s = normalizeAiShrinkSuggestion(suggestion);
    if (s.newPath) return s.newPath.trim();
    const oldParts = (path || '').split('/').filter(Boolean);
    const oldParent = oldParts.slice(0, -1).join('/');
    const fallbackTitle = node?.title || oldParts[oldParts.length - 1] || '';
    const newTitle = (s.title || fallbackTitle).trim();
    const hasParent = Object.prototype.hasOwnProperty.call(s, 'parent');
    const newParent = hasParent ? (s.parent || '').trim() : oldParent;
    return newParent ? `${newParent}/${newTitle}` : newTitle;
}

function aiShrinkIsInsert(suggestion) {
    const s = normalizeAiShrinkSuggestion(suggestion);
    return s.op === 'insert' || s.op === 'add' || (!s.path && s.title && s.content !== undefined);
}

// Build (or rebuild) the green-frame suggestion row below the node at `path`.
function insertAiSuggestionRowImpl(path, suggestionRaw) {
    const suggestion = normalizeAiShrinkSuggestion(suggestionRaw);
    const isInsert = path.startsWith('__insert__') || aiShrinkIsInsert(suggestion);
    const node = isInsert ? null : findNodeByPath(memoryTree, path);
    const targetPath = isInsert ? buildAiShrinkTargetPath('', null, suggestion) : (node ? buildAiShrinkTargetPath(path, node, suggestion) : path);

    let host;
    if (isInsert) {
        const parentPath = (suggestion.parent || '').trim();
        const parentHeader = parentPath ? $(`.wizard-tree-header[data-path="${CSS.escape(parentPath)}"]`) : $();
        if (parentHeader.length) {
            host = parentHeader.closest('li.wizard-tree-item');
            host.find(`.wizard-ai-suggestion-row[data-path="${CSS.escape(path)}"]`).remove();
        } else {
            host = $(`<li class="wizard-tree-item wizard-ai-suggestion-insert-host" data-path="${escapeHtml(path)}"></li>`);
            $('#wizard-tree-root').prepend(host);
        }
    } else {
        const header = $(`.wizard-tree-header[data-path="${CSS.escape(path)}"]`);
        if (!header.length) return;
        host = header.closest('li.wizard-tree-item');
        host.find('.wizard-ai-suggestion-row').remove();
    }

    const originalText = isInsert ? '(新增节点)' : ((node && node.content) ? node.content.trim() : '(空)');
    const newContent = suggestion.content !== undefined ? suggestion.content : originalText;
    const metaParts = [];
    if (isInsert) metaParts.push(`新增 → ${targetPath}`);
    else if (targetPath && targetPath !== path) metaParts.push(`移动/改名 → ${targetPath}`);
    if (suggestion.op === 'move') metaParts.push('操作：移动节点');
    if (suggestion.hint !== undefined && (isInsert || (node && suggestion.hint !== (node.hint || '')))) metaParts.push(`hint → ${suggestion.hint || '(空)'}`);
    if (suggestion.keywords) metaParts.push(`关键词 + ${suggestion.keywords}`);
    const escapedMeta = $('<div>').text(metaParts.join('；')).html();
    const escapedOrig = $('<div>').text(originalText).html();
    const escapedNew = $('<div>').text(newContent).html();

    const row = $(`<div class="wizard-ai-suggestion-row" data-path="${escapeHtml(path)}"
        style="margin: 4px 0 4px 4px; padding: 8px 10px; background: rgba(52,211,153,0.06);
               border: 1.5px solid rgba(52,211,153,0.55); border-radius: 6px;
               font-size: 0.88em; display: flex; flex-direction: column; gap: 7px;">
        ${escapedMeta ? `<div style="color:#93c5fd; font-size:0.82em;"><i class="fa-solid fa-sitemap"></i> ${escapedMeta}</div>` : ''}
        <!-- Two-column diff: original left, AI version right -->
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 0; border: 1px solid rgba(255,255,255,0.07); border-radius: 5px; overflow: hidden;">
            <div style="padding: 7px 9px; background: rgba(0,0,0,0.18); border-right: 1px solid rgba(255,255,255,0.07); display: flex; flex-direction: column; gap: 4px;">
                <span style="font-size: 0.78em; font-weight: 600; color: #6b7280; letter-spacing: 0.03em;">原文</span>
                <span style="color: #9ca3af; white-space: pre-wrap; word-break: break-word; line-height: 1.5;">${escapedOrig}</span>
            </div>
            <div style="padding: 7px 9px; background: rgba(52,211,153,0.05); display: flex; flex-direction: column; gap: 4px;">
                <span style="font-size: 0.78em; font-weight: 600; color: #34d399; letter-spacing: 0.03em;">AI 新版</span>
                <span style="color: #d1fae5; white-space: pre-wrap; word-break: break-word; line-height: 1.5;">${escapedNew}</span>
            </div>
        </div>
        <!-- Action buttons -->
        <div style="display: flex; gap: 8px; justify-content: flex-end;">
            <button class="wizard-btn wizard-ai-suggestion-accept"
                data-path="${escapeHtml(path)}"
                style="padding: 3px 10px; font-size: 0.82em; background: rgba(52,211,153,0.18);
                       border: 1px solid rgba(52,211,153,0.6); color: #34d399; border-radius: 4px; cursor: pointer;">
                <i class="fa-solid fa-check"></i> 应用
            </button>
            <button class="wizard-btn wizard-ai-suggestion-reject"
                data-path="${escapeHtml(path)}"
                style="padding: 3px 10px; font-size: 0.82em; background: rgba(248,113,113,0.12);
                       border: 1px solid rgba(248,113,113,0.45); color: #f87171; border-radius: 4px; cursor: pointer;">
                <i class="fa-solid fa-xmark"></i> 丢弃
            </button>
        </div>
    </div>`);
    const anchor = host.find('> .wizard-tree-header').first();
    if (anchor.length) anchor.after(row);
    else host.append(row);
}

// Re-inject every pending AI suggestion row into the freshly-rendered tree.
function reinjectAiSuggestionRows() {
    if (!pendingAiShrinkEdits.size) return;
    pendingAiShrinkEdits.forEach((content, path) => {
        insertAiSuggestionRowImpl(path, content);
    });
    // Keep the bulk bar count in sync after a re-render.
    const bar = $('#wizard-ai-shrink-bulk-bar');
    if (pendingAiShrinkEdits.size > 0) {
        bar.css('display', 'inline-flex');
        $('#wizard-ai-shrink-pending-count').text(`${pendingAiShrinkEdits.size} 条建议`);
    } else {
        bar.css('display', 'none');
    }
}

// Refresh the batch-action bar: selected count + show/hide.
function updateTreeSelectionUI() {
    $('#wizard-tree-selected-count').text(`已选 ${selectedPaths.size} 个`);
    $('#wizard-tree-export-selected-btn').removeClass('wizard-btn-warning');
    const visibleNodes = getAllNodes(currentRenderNodes || memoryTree);
    const allVisibleSelected = visibleNodes.length > 0 && visibleNodes.every(n => selectedPaths.has(n.path));
    $('#wizard-tree-select-all-btn').toggleClass('wizard-btn-warning', allVisibleSelected);
    if (treeSelectionMode) {
        $('#wizard-tree-batch-bar').css('display', 'inline-flex');
    } else {
        $('#wizard-tree-batch-bar').css('display', 'none');
    }
}

// Collect the selected nodes from the REAL memoryTree (not clones), as a forest
// of top-level selected subtrees: if a parent is selected we take it with its
// whole subtree and skip its already-covered descendants.
function collectSelectedForest() {
    const result = [];
    function walk(list) {
        for (const node of list) {
            if (selectedPaths.has(node.path)) {
                // Deep-clone so the export is a snapshot independent of the tree.
                result.push(JSON.parse(JSON.stringify(node)));
                // Its descendants are included within this clone; don't recurse
                // into them again as separate top-level entries.
            } else if (node.children && node.children.length) {
                walk(node.children);
            }
        }
    }
    walk(memoryTree);
    return result;
}

// Build the export envelope for a given node forest.
function buildTreeExport(nodeForest) {
    return {
        format: 'memory-wizard-tree',
        version: 1,
        exportedAt: new Date().toISOString(),
        chatId: activeChatId || '',
        nodeCount: getAllNodes(nodeForest).length,
        nodes: nodeForest
    };
}

// Trigger a browser download of a JSON object as a .json file.
function downloadJson(obj, filename) {
    const text = JSON.stringify(obj, null, 2);
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Show a picker over server-side backup files of a given kind ('tree' |
// 'summaries'). Lists live per-key documents and timestamped history snapshots
// (newest first), lets the user choose one, fetches its content, and resolves to
// { name, data } — or null if cancelled / on error. Used by "从备份导入" so the
// user can recover memory from another branch or an earlier point in time when
// the automatic key migration didn't apply.
// When `metaOnly` is true, resolves to { name, location } WITHOUT fetching the file
// content — used for huge sandbox backups (hundreds of MB) that must be processed
// server-side rather than shipped to the browser.
async function showBackupPicker(kind, metaOnly = false) {
    const context = window.SillyTavern.getContext();
    let backups = [];
    try {
        const res = await fetch('/api/plugins/st-memory-wizzard/list-backups', {
            method: 'POST',
            headers: getWizardHeaders(),
            body: JSON.stringify({ kind })
        });
        const data = await res.json();
        backups = Array.isArray(data.backups) ? data.backups : [];
    } catch (e) {
        toastr.error('无法获取备份列表（服务端未响应）。');
        return null;
    }
    if (backups.length === 0) {
        toastr.info('没有找到任何备份文件。');
        return null;
    }

    const fmtSize = (n) => n < 1024 ? `${n} B` : (n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);
    const fmtTime = (ms) => {
        const d = new Date(ms);
        const p = (x) => String(x).padStart(2, '0');
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    };
    const locLabel = (l) => l === 'history' ? '<span style="color:#a78bfa;">历史快照</span>' : '<span style="color:#34d399;">当前</span>';

    // Build a radio-list of backups inside a popup.
    const rows = backups.map((b, i) => `
        <label style="display:flex; align-items:center; gap:8px; padding:6px 8px; border:1px solid rgba(255,255,255,0.08); border-radius:6px; cursor:pointer; margin-bottom:4px;">
            <input type="radio" name="wizard-backup-pick" value="${i}" ${i === 0 ? 'checked' : ''} style="flex:0 0 auto;">
            <span style="flex:1 1 auto; min-width:0;">
                <span style="display:block; font-family:monospace; font-size:0.82em; color:#d1d5db; word-break:break-all;">${escapeHtml(b.name)}</span>
                <span style="display:block; font-size:0.74em; color:#6b7280;">${locLabel(b.location)} · ${fmtTime(b.mtime)} · ${fmtSize(b.size)}</span>
            </span>
        </label>`).join('');
    const html = `
        <h3>选择要导入的备份</h3>
        <div style="text-align:left; max-height:50vh; overflow-y:auto; margin-top:8px;">${rows}</div>`;

    let chosenIdx = -1;
    try {
        const popup = new context.Popup(html, context.POPUP_TYPE.TEXT, '', {
            okButton: '导入', cancelButton: '取消', wide: true,
        });
        const res = await popup.show();
        if (!res) return null; // cancelled
        const sel = popup.dlg ? popup.dlg.querySelector('input[name="wizard-backup-pick"]:checked') : null;
        const checked = sel || document.querySelector('input[name="wizard-backup-pick"]:checked');
        chosenIdx = checked ? parseInt(checked.value) : -1;
    } catch (e) {
        toastr.error('备份选择弹窗加载失败。');
        return null;
    }
    if (isNaN(chosenIdx) || chosenIdx < 0 || chosenIdx >= backups.length) return null;

    const chosen = backups[chosenIdx];
    // Caller only needs the identity (e.g. server-side processing of a huge file).
    if (metaOnly) return { name: chosen.name, location: chosen.location };
    try {
        const res = await fetch('/api/plugins/st-memory-wizzard/read-backup', {
            method: 'POST',
            headers: getWizardHeaders(),
            body: JSON.stringify({ kind, name: chosen.name, location: chosen.location })
        });
        if (!res.ok) { toastr.error('读取备份失败。'); return null; }
        const data = await res.json();
        return { name: data.name || chosen.name, data: data.data };
    } catch (e) {
        toastr.error('读取备份内容失败。');
        return null;
    }
}

// Merge an imported node forest into memoryTree by path: existing path → overwrite
// its fields (keep position), new path → create (building parent folders).
function mergeImportedNodes(nodeForest) {
    function upsert(node) {
        const existing = findNodeByPath(memoryTree, node.path);
        if (existing) {
            existing.title = node.title;
            existing.hint = node.hint;
            existing.content = node.content;
            existing.pinned = !!node.pinned;
            existing.archived = !!node.archived;
            existing.updated = node.updated || new Date().toISOString().slice(0, 10);
        } else {
            // Build parent folders, then attach a childless copy of this node.
            const segments = node.path.split('/');
            let currentList = memoryTree;
            let runningPath = "";
            for (let i = 0; i < segments.length - 1; i++) {
                const segment = segments[i];
                runningPath = runningPath ? `${runningPath}/${segment}` : segment;
                let parent = currentList.find(n => n.path === runningPath);
                if (!parent) {
                    parent = { path: runningPath, title: segment, hint: "分类目录", pinned: false, content: "", updated: new Date().toISOString().slice(0, 10), children: [] };
                    currentList.push(parent);
                }
                if (!parent.children) parent.children = [];
                currentList = parent.children;
            }
            currentList.push({
                path: node.path,
                title: node.title,
                hint: node.hint || "",
                pinned: !!node.pinned,
                archived: !!node.archived,
                content: node.content || "",
                updated: node.updated || new Date().toISOString().slice(0, 10),
                children: []
            });
        }
        // Recurse into children so the whole subtree is merged.
        if (node.children && node.children.length) {
            node.children.forEach(upsert);
        }
    }
    nodeForest.forEach(upsert);
}

// Default category colors (mirror the hard-coded path rules in index.css). These
// apply to a node's left bar even when it has no explicit node.color, so the
// picker can reflect the effective color instead of falsely showing "无颜色".
const DEFAULT_CATEGORY_COLORS = {
    '身份核': '#ef4444',
    '知识': '#3b82f6',
    '关系与情感': '#ec4899',
    '现实事件': '#10b981',
    '项目': '#f59e0b',
    '挂账': '#8b5cf6',
};

// Resolve the color a node's left bar currently shows: explicit node.color wins,
// otherwise the category color implied by its root path segment, else ''.
function resolveEffectiveNodeColor(node) {
    if (node && node.color) return node.color;
    if (node && node.path) {
        const root = node.path.split('/')[0];
        if (DEFAULT_CATEGORY_COLORS[root]) return DEFAULT_CATEGORY_COLORS[root];
    }
    return '';
}

// Show/hide the little color chip beside the collapsed "节点配色" header so the
// chosen color is visible without expanding the palette.
function updateNodeColorPreview(color) {
    const preview = $('#wizard-node-color-preview');
    if (color) {
        preview.css({ display: 'inline-block', background: color });
    } else {
        preview.css('display', 'none');
    }
}

function treeSourceMetaForFloor(floor) {
    const context = window.SillyTavern?.getContext();
    const chatList = context?.chat;
    const f = parseInt(floor);
    const msg = Array.isArray(chatList) ? chatList[f] : null;
    if (!msg || isNaN(f)) return null;
    const t = msgTimestamp(msg);
    return { floor: f, time: isNaN(t) ? null : t };
}

function resolveTreeSourceFloor(meta) {
    if (!meta || typeof meta !== 'object') return null;
    const context = window.SillyTavern?.getContext();
    const chatList = context?.chat;
    if (!Array.isArray(chatList) || !chatList.length) return null;
    const t = typeof meta.time === 'number' ? meta.time : NaN;
    if (!isNaN(t)) {
        for (let i = 0; i < chatList.length; i++) {
            const mt = msgTimestamp(chatList[i]);
            if (!isNaN(mt) && mt === t) return i;
        }
        return null; // had a timestamp but no surviving message => deleted floor
    }
    const f = parseInt(meta.floor);
    return (!isNaN(f) && f >= 0 && f < chatList.length) ? f : null;
}

function formatTreeSourceMeta(node) {
    const prov = node && node.provenance;
    if (!prov) return null;
    const src = prov.modified || prov.created;
    const kind = prov.modified ? 'modified' : 'created';
    const curFloor = resolveTreeSourceFloor(src);
    if (curFloor === null) return null;
    const date = (src && typeof src.time === 'number' && !isNaN(src.time)) ? formatTimestamp(src.time) : '';
    return {
        kind,
        text: kind === 'modified'
            ? `由 ${curFloor} 楼进行过更改${date ? `，${date}` : ''}`
            : `由 ${curFloor} 楼创建${date ? `，${date}` : ''}`,
    };
}

function focusNodeEditorIfMobile() {
    const panel = document.getElementById('wizard-node-form-panel');
    if (!panel || !window.matchMedia('(max-width: 768px), (pointer: coarse)').matches) return;
    requestAnimationFrame(() => panel.scrollIntoView({ block: 'start', behavior: 'smooth' }));
}

function focusWbPanelIfMobile() {
    const panel = document.getElementById('wizard-wb-panel');
    if (!panel || !window.matchMedia('(max-width: 768px), (pointer: coarse)').matches) return;
    requestAnimationFrame(() => panel.scrollIntoView({ block: 'start', behavior: 'smooth' }));
}

function loadNodeIntoForm(node, opts = {}) {
    if (!opts.keepDraft) beginNodeEditDraft(node);
    $('#wizard-node-original-path').val(node.path);
    $('#wizard-node-path').val(node.path);
    $('#wizard-node-title').val(node.title);
    $('#wizard-node-hint').val(node.hint || "");
    $('#wizard-node-keywords').val(node.keywords || "");
    $('#wizard-node-content').val(node.content || "");
    $('#wizard-node-send-path').prop('checked', node.sendPath !== false);
    $('#wizard-node-pinned').prop('checked', !!node.pinned);
    $('#wizard-node-archived').prop('checked', !!node.archived);
    $('#wizard-node-editor-title').text(`编辑节点: ${node.title}`);
    // Show the EFFECTIVE color (explicit override, or the category default) so
    // the picker reflects what the node's left bar actually displays.
    const effectiveColor = resolveEffectiveNodeColor(node);
    $('#wizard-node-color').val(effectiveColor);
    // Highlight the active swatch
    $('#wizard-node-color-palette .wizard-color-swatch').removeClass('wizard-color-swatch-active');
    $(`#wizard-node-color-palette .wizard-color-swatch[data-color="${effectiveColor}"]`).addClass('wizard-color-swatch-active');
    updateNodeColorPreview(effectiveColor);
    focusNodeEditorIfMobile();
}

function treePathLeaf(path) {
    const s = String(path || '');
    const idx = s.lastIndexOf('/');
    return idx === -1 ? s : s.slice(idx + 1);
}

function beginNodeEditDraft(node) {
    if (!node || !node.path) {
        nodeEditDraftSnapshot = null;
        return;
    }
    nodeEditDraftSnapshot = {
        path: node.path,
        subtree: JSON.parse(JSON.stringify(node)),
    };
}

function restoreNodeDraftFields(live, snap) {
    if (!live || !snap) return;
    ['title', 'hint', 'content', 'sendPath', 'pinned', 'archived', 'updated', 'color', 'provenance'].forEach(k => {
        if (Object.prototype.hasOwnProperty.call(snap, k)) live[k] = JSON.parse(JSON.stringify(snap[k]));
        else delete live[k];
    });
    if (!Array.isArray(live.children)) live.children = [];
    const liveByPath = new Map(live.children.map(c => [c.path, c]));
    (snap.children || []).forEach(snapChild => {
        let liveChild = liveByPath.get(snapChild.path);
        if (!liveChild) {
            liveChild = JSON.parse(JSON.stringify(snapChild));
            live.children.push(liveChild);
        } else {
            restoreNodeDraftFields(liveChild, snapChild);
        }
    });
    // Do NOT remove live children absent from the snapshot: AI-created nodes during
    // this frontend session must survive Cancel.
}

function applyNodeEditorDraftToTree() {
    const originalPath = $('#wizard-node-original-path').val();
    if (!originalPath) return null;
    const node = findNodeByPath(memoryTree, originalPath);
    if (!node) return null;
    node.title = $('#wizard-node-title').val().trim() || node.title;
    node.hint = $('#wizard-node-hint').val().trim();
    node.content = $('#wizard-node-content').val().trim();
    node.sendPath = $('#wizard-node-send-path').prop('checked');
    node.pinned = $('#wizard-node-pinned').prop('checked');
    node.archived = $('#wizard-node-archived').prop('checked');
    const color = $('#wizard-node-color').val() || '';
    if (color) node.color = color; else delete node.color;
    if (!node.sendPath && node.children && node.children.length) {
        collectNodeAndChildren(node).forEach(n => { n.sendPath = false; });
    }
    if (node.archived && node.children && node.children.length) {
        collectNodeAndChildren(node).forEach(n => { n.archived = true; });
    }
    renderTreeView(memoryTree, $('#wizard-tree-root'));
    const freshNode = findNodeByPath(memoryTree, originalPath);
    if (freshNode) loadNodeIntoForm(freshNode, { keepDraft: true });
    return freshNode;
}

function autoScrollTreeDuringDrag(ev) {
    const list = document.querySelector('.wizard-tree-list-col');
    if (!list) return;
    const rect = list.getBoundingClientRect();
    const margin = 44;
    const maxSpeed = 18;
    let delta = 0;
    if (ev.clientY < rect.top + margin) {
        delta = -Math.ceil((1 - Math.max(0, ev.clientY - rect.top) / margin) * maxSpeed);
    } else if (ev.clientY > rect.bottom - margin) {
        delta = Math.ceil((1 - Math.max(0, rect.bottom - ev.clientY) / margin) * maxSpeed);
    }
    if (delta) list.scrollTop += delta;
}

// Re-prefix a node's path and all of its descendants' paths from oldPrefix to
// newPrefix, then move the node so it lives under the parent implied by newPath.
function reparentNode(node, oldPath, newPath) {
    // 1. Rewrite this subtree's paths.
    function rewrite(n, fromPrefix, toPrefix) {
        n.path = toPrefix + n.path.slice(fromPrefix.length);
        if (n.children) {
            n.children.forEach(c => rewrite(c, fromPrefix, toPrefix));
        }
    }
    rewrite(node, oldPath, newPath);

    // 2. Detach the node from its old parent list (located by the old path).
    function detach(list) {
        const idx = list.findIndex(n => n === node);
        if (idx !== -1) {
            list.splice(idx, 1);
            return true;
        }
        for (const n of list) {
            if (n.children && detach(n.children)) return true;
        }
        return false;
    }
    detach(memoryTree);

    // 3. Attach under the new parent path, creating folder nodes as needed.
    const segments = newPath.split('/');
    let currentList = memoryTree;
    let runningPath = "";
    for (let i = 0; i < segments.length - 1; i++) {
        const segment = segments[i];
        runningPath = runningPath ? `${runningPath}/${segment}` : segment;
        let parentNode = currentList.find(n => n.path === runningPath);
        if (!parentNode) {
            parentNode = {
                path: runningPath,
                title: segment,
                hint: "分类目录",
                pinned: false,
                content: "",
                updated: new Date().toISOString().slice(0, 10),
                children: []
            };
            currentList.push(parentNode);
        }
        if (!parentNode.children) parentNode.children = [];
        currentList = parentNode.children;
    }
    currentList.push(node);
}

function normalizeTreeHierarchyByPath() {
    const byPath = new Map();
    function collect(nodes) {
        if (!Array.isArray(nodes)) return;
        nodes.forEach(n => {
            if (!n || !n.path) return;
            if (!byPath.has(n.path)) {
                byPath.set(n.path, n);
            }
            collect(n.children);
        });
    }
    collect(memoryTree);

    const ensureFolder = (path) => {
        if (!path) return null;
        if (byPath.has(path)) return byPath.get(path);
        const title = path.split('/').pop();
        const folder = {
            path,
            title,
            hint: '分类目录',
            pinned: false,
            content: '',
            updated: new Date().toISOString().slice(0, 10),
            children: [],
        };
        byPath.set(path, folder);
        return folder;
    };

    // Ensure every intermediate folder exists.
    [...byPath.keys()].forEach(path => {
        const parts = path.split('/').filter(Boolean);
        let running = '';
        for (let i = 0; i < parts.length - 1; i++) {
            running = running ? `${running}/${parts[i]}` : parts[i];
            ensureFolder(running);
        }
    });

    byPath.forEach(n => { n.children = []; });
    const root = [];
    [...byPath.keys()]
        // Only ensure parents are attached before children. Do NOT alphabetically sort
        // siblings/root categories: user-defined top-level order (关系与情感 / 项目 / …)
        // must remain fixed across saves.
        .sort((a, b) => a.split('/').length - b.split('/').length)
        .forEach(path => {
            const node = byPath.get(path);
            const idx = path.lastIndexOf('/');
            if (idx === -1) {
                root.push(node);
            } else {
                const parent = ensureFolder(path.slice(0, idx));
                if (!parent.children.some(c => c.path === node.path)) parent.children.push(node);
            }
        });
    memoryTree = root;
}

function updateUndoMoveButton() {
    const btn = $('#wizard-tree-undo-move-btn');
    if (!btn.length) return;
    btn.css('display', lastTreeMoveUndoSnapshot ? 'inline-flex' : 'none');
}

function captureTreeMoveUndoSnapshot(activePath = '') {
    lastTreeMoveUndoSnapshot = {
        tree: JSON.parse(JSON.stringify(memoryTree)),
        collapsedPaths: [...collapsedPaths],
        newPaths: [...aiNewNodePathsThisSession],
        activePath,
    };
    writeLog(`Undo snapshot captured (${getAllNodes(lastTreeMoveUndoSnapshot.tree).length} nodes, activePath="${activePath}").`, 'DEBUG');
    updateUndoMoveButton();
}

function findNodeListAndIndexByPath(path) {
    function scan(list) {
        if (!Array.isArray(list)) return null;
        for (let i = 0; i < list.length; i++) {
            const n = list[i];
            if (n.path === path) return { list, index: i, node: n };
            const childHit = scan(n.children);
            if (childHit) return childHit;
        }
        return null;
    }
    return scan(memoryTree);
}

async function moveNodeBesidePath(sourcePath, targetPath, position) {
    if (!sourcePath || !targetPath || !['before', 'after'].includes(position)) return false;
    if (sourcePath === targetPath || targetPath.startsWith(sourcePath + '/')) {
        return false;
    }

    const sourceHit = findNodeListAndIndexByPath(sourcePath);
    const targetHit = findNodeListAndIndexByPath(targetPath);
    if (!sourceHit || !targetHit) {
        writeLog(`Move-beside failed: src="${sourcePath}" (${sourceHit ? 'ok' : 'MISSING'}) tgt="${targetPath}" (${targetHit ? 'ok' : 'MISSING'}).`, 'DEBUG');
        toastr.warning('移动失败：找不到来源或目标节点。');
        return false;
    }

    const targetParentPath = targetPath.includes('/') ? targetPath.slice(0, targetPath.lastIndexOf('/')) : '';
    const sourceLeaf = treePathLeaf(sourcePath);
    const newPath = targetParentPath ? `${targetParentPath}/${sourceLeaf}` : sourceLeaf;
    const existing = findNodeByPath(memoryTree, newPath);
    if (existing && existing !== sourceHit.node && existing.path !== sourcePath) {
        toastr.warning(`目标路径已存在：${newPath}`);
        return false;
    }

    captureTreeMoveUndoSnapshot(sourcePath);
    const oldNewMarkers = [...aiNewNodePathsThisSession].filter(p => p === sourcePath || p.startsWith(sourcePath + '/'));
    reparentNode(sourceHit.node, sourcePath, newPath);
    oldNewMarkers.forEach(p => {
        aiNewNodePathsThisSession.delete(p);
        aiNewNodePathsThisSession.add(newPath + p.slice(sourcePath.length));
    });

    const movedHit = findNodeListAndIndexByPath(newPath);
    const freshTargetHit = findNodeListAndIndexByPath(targetPath);
    if (!movedHit || !freshTargetHit) return false;
    const [moved] = movedHit.list.splice(movedHit.index, 1);
    let insertIndex = freshTargetHit.index + (position === 'after' ? 1 : 0);
    freshTargetHit.list.splice(insertIndex, 0, moved);

    if (targetParentPath) collapsedPaths.delete(targetParentPath);
    await saveTreeToServer();
    toastr.success(position === 'before' ? '已移动到目标节点之前。' : '已移动到目标节点之后。');
    writeLog(`Moved memory node "${sourcePath}" ${position} "${targetPath}" -> "${newPath}".`);
    return true;
}

async function moveNodeUnderPath(sourcePath, targetParentPath) {
    if (!sourcePath || !targetParentPath) return false;
    if (sourcePath === targetParentPath || targetParentPath.startsWith(sourcePath + '/')) {
        return false;
    }

    const sourceNode = findNodeByPath(memoryTree, sourcePath);
    const targetNode = findNodeByPath(memoryTree, targetParentPath);
    if (!sourceNode || !targetNode) {
        toastr.warning('移动失败：找不到来源或目标节点。');
        return false;
    }

    const newPath = `${targetParentPath}/${treePathLeaf(sourcePath)}`;
    const existing = findNodeByPath(memoryTree, newPath);
    if (existing && existing !== sourceNode) {
        toastr.warning(`目标路径已存在：${newPath}`);
        return false;
    }

    captureTreeMoveUndoSnapshot(sourcePath);
    const oldNewMarkers = [...aiNewNodePathsThisSession].filter(p => p === sourcePath || p.startsWith(sourcePath + '/'));
    reparentNode(sourceNode, sourcePath, newPath);
    oldNewMarkers.forEach(p => {
        aiNewNodePathsThisSession.delete(p);
        aiNewNodePathsThisSession.add(newPath + p.slice(sourcePath.length));
    });
    collapsedPaths.delete(targetParentPath);
    await saveTreeToServer();
    toastr.success(`已移动到：${targetParentPath}`);
    writeLog(`Moved memory node "${sourcePath}" under "${targetParentPath}" -> "${newPath}".`);
    return true;
}

// Delete a node. Accepts either a node object (deleted by reference — exact, even
// when paths are duplicated or empty) or a path string. Only ONE node is removed
// per call, so adjacent siblings are never wiped by accident.
function deleteNodeFromTree(target) {
    const targetPath = (target && typeof target === 'object') ? target.path : target;

    // First try exact reference match (precise even with duplicate paths).
    function removeByRef(list) {
        for (let i = 0; i < list.length; i++) {
            const n = list[i];
            if (n === target) {
                list.splice(i, 1);
                return true;
            }
            if (n.children && removeByRef(n.children)) return true;
        }
        return false;
    }

    // Fallback: remove the first node whose path matches (used in search mode,
    // where the rendered node is a clone of the real tree node).
    function removeByPath(list) {
        for (let i = 0; i < list.length; i++) {
            const n = list[i];
            if (n.path === targetPath) {
                list.splice(i, 1);
                return true;
            }
            if (n.children && removeByPath(n.children)) return true;
        }
        return false;
    }

    let removed = false;
    if (target && typeof target === 'object') {
        removed = removeByRef(memoryTree);
    }
    if (!removed && targetPath) {
        removeByPath(memoryTree);
    }

    saveTreeToServer();
}

// Save memory tree to server
// Fetch the global shared branch and merge it into memoryTree at the TOP, so every
// character/group sees and can edit the same "共有记忆" root. Any stale shared nodes
// already present (e.g. saved into a per-character file before this feature) are
// dropped first so the shared document is the single source of truth. Called after
// the per-character tree loads.
async function fetchAndMergeSharedTree() {
    let sharedForest = [];
    try {
        const res = await fetch('/api/plugins/st-memory-wizzard/get-shared-tree', {
            method: 'POST',
            headers: getWizardHeaders(),
            body: JSON.stringify({})
        });
        const data = await res.json();
        if (Array.isArray(data)) sharedForest = data;
    } catch (e) {
        console.error(`${LOG_PREFIX} Failed to load shared tree`, e);
        writeLog(`Failed to load shared tree: ${e.message}`, 'WARNING');
        return; // leave memoryTree as-is on failure
    }
    sharedTreeLoaded = true;
    // Mark every shared node so the UI and split logic can recognise the branch even
    // if it later moves; the root carries shared:true from the backend default.
    sharedForest.forEach(root => getAllNodes([root]).forEach(n => { n.shared = true; }));
    // Drop any pre-existing shared nodes from the per-character tree (stale copies).
    memoryTree = memoryTree.filter(n => !isSharedPath(n.path));
    // Prepend the shared root(s) so the shared branch sits at the top of the tree.
    memoryTree = [...sharedForest, ...memoryTree];
    writeLog(`Shared branch merged: ${getAllNodes(sharedForest).length} node(s).`);
}

// ══════════════════════════════════════════════════════════════════════
// REGION: 记忆树 — 持久化 / 分支共享存储（saveTreeToServer / 共有记忆合并）
// ══════════════════════════════════════════════════════════════════════
async function saveTreeToServer(skipNormalize = false) {
    if (!activeChatId) return;
    if (!skipNormalize) normalizeTreeHierarchyByPath();
    // Split the shared branch out: it is persisted to its own global document and must
    // NOT be written into the per-character file (which would duplicate it and break
    // cross-character sharing). Only save the shared document once it has been loaded
    // this session, so a failed/absent load never overwrites it with an empty branch.
    const { personal, shared } = splitSharedFromTree(memoryTree);
    if (sharedTreeLoaded && !treeLoadInProgress) {
        try {
            await fetch('/api/plugins/st-memory-wizzard/save-shared-tree', {
                method: 'POST',
                headers: getWizardHeaders(),
                body: JSON.stringify({ tree: shared })
            });
        } catch (e) {
            console.error(`${LOG_PREFIX} Failed to save shared tree`, e);
        }
    }
    try {
        const res = await fetch('/api/plugins/st-memory-wizzard/save-tree', {
            method: 'POST',
            headers: getWizardHeaders(),
            body: JSON.stringify({ chatId: activeChatId, tree: personal })
        });
        const data = await res.json();
        if (data.success) {
            const treeRoot = $('#wizard-tree-root');
            if (treeRoot.length > 0) {
                renderTreeView(memoryTree, treeRoot);
            }
            writeLog(`Memory tree saved successfully.`);
        } else {
            toastr.error('保存记忆树失败！');
        }
    } catch (e) {
        console.error(`${LOG_PREFIX} Failed to save memory tree`, e);
    }
}

function hexToRgb(hex) {
    const shorthandRegex = /^#?([a-f\d])([a-f\d])([a-f\d])$/i;
    hex = hex.replace(shorthandRegex, (m, r, g, b) => r + r + g + g + b + b);
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result ? {
        r: parseInt(result[1], 16),
        g: parseInt(result[2], 16),
        b: parseInt(result[3], 16)
    } : null;
}

function applyThemeColor() {
    const color = config.uiColor || '#a3842e';
    const rgb = hexToRgb(color) || { r: 163, g: 132, b: 46 };
    const primaryRgbStr = `${rgb.r}, ${rgb.g}, ${rgb.b}`;
    
    // Apply dynamic CSS variables globally to :root and the overlay
    document.documentElement.style.setProperty('--wizard-primary', color);
    document.documentElement.style.setProperty('--wizard-primary-rgb', primaryRgbStr);
    $('#wizard-modal-overlay').css({
        '--wizard-primary': color,
        '--wizard-primary-rgb': primaryRgbStr
    });
}

// Apply the user-configured modal width/height (as % of viewport) by setting the
// CSS variables the container reads. Clamped to a sane 30-100% range.
function applyModalSize() {
    let w = parseInt(config.uiWidth);
    let h = parseInt(config.uiHeight);
    if (isNaN(w)) w = 90;
    if (isNaN(h)) h = 95;
    w = Math.max(30, Math.min(100, w));
    h = Math.max(30, Math.min(100, h));
    const overlay = document.getElementById('wizard-modal-overlay');
    if (overlay) {
        overlay.style.setProperty('--wizard-modal-w', `${w}vw`);
        overlay.style.setProperty('--wizard-modal-h', `${h}vh`);
    }
}

// ---- Summary item model -------------------------------------------------------
// Summaries can be plain strings (legacy) or objects:
//   { text, archived?, source?, model?, name?, timespan?, realTimespan?, showRealTime? }
// where:
//   source       — provenance string (e.g. "楼层 0-9" for a recap, "周记 #1-#5" for a historical)
//   name         — user-editable display name (default ""); UI shows "史记#1" placeholder when empty
//   timespan     — RP/story time span (AI's <time> output, e.g. "Day 1 上午 ~ Day 3 傍晚")
//   realTimespan — real-world span computed from send_date at fusion time
// ══════════════════════════════════════════════════════════════════════
// REGION: 摘要数据模型（日记/周记/史记 记录的访问器，兼容旧字符串形态）
// ══════════════════════════════════════════════════════════════════════
//   showRealTime — whether realTimespan is injected into the record's first line (default false)
// These accessors tolerate both shapes.
function sumText(item) {
    if (item == null) return "";
    return typeof item === 'string' ? item : (item.text || "");
}
function sumIsArchived(item) {
    return typeof item === 'object' && item !== null && !!item.archived;
}
// 「始终保留最新X条」包含模式的标记：内容已经融进上层记录，但暂缓归档、继续留在本层
// 供近期参照。带此标记的条目不再参与后续融合（否则上层会出现重复内容），下一轮融合
// 成功后统一归档。
function sumIsFusedKeep(item) {
    return typeof item === 'object' && item !== null && !!item.fusedKeep;
}
function sumSource(item) {
    return (typeof item === 'object' && item !== null && item.source) ? item.source : "";
}
function sumName(item) {
    return (typeof item === 'object' && item !== null && item.name) ? item.name : "";
}
function sumTimespan(item) {
    return (typeof item === 'object' && item !== null && item.timespan) ? item.timespan : "";
}
function sumRealTimespan(item) {
    return (typeof item === 'object' && item !== null && item.realTimespan) ? item.realTimespan : "";
}
function sumShowRealTime(item) {
    return typeof item === 'object' && item !== null && !!item.showRealTime;
}
// The absolute floor range this record covers, as {lo, hi} (inclusive), or null.
// 日记 stores it at creation (from the archived block). 周记/史记 inherit it by
// merging their sources' ranges. Falls back to parsing "楼层 X-Y" from the source
// so older 日记 (created before coveredFloors existed) still resolve.
function sumStoredCoveredFloors(item) {
    if (typeof item === 'object' && item !== null && item.coveredFloors
        && typeof item.coveredFloors.lo === 'number' && typeof item.coveredFloors.hi === 'number') {
        return { lo: item.coveredFloors.lo, hi: item.coveredFloors.hi };
    }
    return null;
}

function sumCoveredFloors(item) {
    // If the user explicitly edited the source string to contain "楼层 X-Y", trust that
    // visible value first for DISPLAY / JUMP / CURRENT COVERAGE. Deletion-remap code
    // that needs the original stored range must call sumStoredCoveredFloors() instead.
    const m = String(sumSource(item) || '').match(/楼层\s*(\d+)\s*[-–]\s*(\d+)/);
    if (m) {
        const a = parseInt(m[1]), b = parseInt(m[2]);
        if (!isNaN(a) && !isNaN(b)) return { lo: Math.min(a, b), hi: Math.max(a, b) };
    }
    return sumStoredCoveredFloors(item);
}
// Mutate helpers that upgrade a plain string to an object in place within its array.
function sumSetText(arr, i, text) {
    if (typeof arr[i] === 'string') arr[i] = { text };
    else arr[i] = { ...arr[i], text };
}
function sumSetArchived(arr, i, archived) {
    if (typeof arr[i] === 'string') arr[i] = { text: arr[i], archived };
    else arr[i] = { ...arr[i], archived };
}
function sumSetFusedKeep(arr, i, fusedKeep) {
    if (typeof arr[i] === 'string') arr[i] = { text: arr[i], fusedKeep };
    else arr[i] = { ...arr[i], fusedKeep };
}
function sumSetName(arr, i, name) {
    if (typeof arr[i] === 'string') arr[i] = { text: arr[i], name };
    else arr[i] = { ...arr[i], name };
}
function sumSetTimespan(arr, i, timespan) {
    if (typeof arr[i] === 'string') arr[i] = { text: arr[i], timespan };
    else arr[i] = { ...arr[i], timespan };
}
function sumSetRealTimespan(arr, i, realTimespan) {
    if (typeof arr[i] === 'string') arr[i] = { text: arr[i], realTimespan };
    else arr[i] = { ...arr[i], realTimespan };
}
function sumSetShowRealTime(arr, i, showRealTime) {
    if (typeof arr[i] === 'string') arr[i] = { text: arr[i], showRealTime };
    else arr[i] = { ...arr[i], showRealTime };
}
function defaultSummaryShowRealTime() {
    return !!config.summaryDefaultShowRealTime;
}
// Set (or clear) the covered floor range. Writes the structured coveredFloors
// field AND keeps the human "来源: 楼层 X-Y" source string in sync so the jump
// button, token label, and dedupe logic all agree. Passing null/NaN clears both.
function sumSetCoveredFloors(arr, i, lo, hi) {
    const base = (typeof arr[i] === 'string') ? { text: arr[i] } : { ...arr[i] };
    const loNum = parseInt(lo), hiNum = parseInt(hi);
    if (isNaN(loNum) || isNaN(hiNum)) {
        // Clear range: drop coveredFloors and strip any "楼层 X-Y" from source.
        delete base.coveredFloors;
        const cleaned = String(base.source || '').replace(/楼层\s*\d+\s*-\s*\d+/g, '').replace(/来源:\s*$/, '').trim();
        if (cleaned) base.source = cleaned; else delete base.source;
    } else {
        const a = Math.min(loNum, hiNum), b = Math.max(loNum, hiNum);
        base.coveredFloors = { lo: a, hi: b };
        base.source = `楼层 ${a}-${b}`;
    }
    arr[i] = base;
}

// Manual "现存楼层" override. When set, the record's current-floor annotation /
// coverage badge / jump use this value verbatim (no time-based remap). Stored as
// { lo, hi }. Read returns {lo,hi} or null; set with NaN/blank clears it.
function sumNowFloors(item) {
    if (typeof item === 'object' && item !== null && item.nowFloors
        && typeof item.nowFloors.lo === 'number' && typeof item.nowFloors.hi === 'number') {
        return { lo: item.nowFloors.lo, hi: item.nowFloors.hi };
    }
    return null;
}
function sumSetNowFloors(arr, i, lo, hi) {
    const base = (typeof arr[i] === 'string') ? { text: arr[i] } : { ...arr[i] };
    const loNum = parseInt(lo), hiNum = parseInt(hi);
    if (isNaN(loNum) || isNaN(hiNum)) {
        delete base.nowFloors;
    } else {
        base.nowFloors = { lo: Math.min(loNum, hiNum), hi: Math.max(loNum, hiNum) };
        delete base.hideNowFloors;
    }
    arr[i] = base;
}
function sumHideNowFloors(item) {
    return !!(typeof item === 'object' && item !== null && item.hideNowFloors);
}
function sumSetHideNowFloors(arr, i, hide) {
    const base = (typeof arr[i] === 'string') ? { text: arr[i] } : { ...arr[i] };
    if (hide) {
        base.hideNowFloors = true;
        delete base.nowFloors;
    } else {
        delete base.hideNowFloors;
    }
    arr[i] = base;
}

// Per-type theme color: 史记 紫 / 周记 蓝 / 日记 绿 / 时记 白.
const SUMMARY_COLORS = {
    historical: '#a78bfa', // purple
    weekly: '#60a5fa',     // blue
    recap: '#34d399',      // green
    shiji: '#e5e7eb',      // white-ish
};
const SUMMARY_TYPE_NAMES = { historical: '史记', weekly: '周记', recap: '日记', shiji: '时记' };

// Convert a #rrggbb hex color to an rgba() string with the given alpha. Used to
// derive translucent borders/backgrounds from a type's solid theme color.
function hexToRgba(hex, alpha) {
    const m = /^#?([0-9a-fA-F]{6})$/.exec(String(hex || '').trim());
    if (!m) return hex; // not a hex color → return as-is (e.g. already rgba)
    const n = parseInt(m[1], 16);
    const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// Resolve the live summaries array for a type string.
function getSummaryArray(type) {
    if (type === 'historical') return summaries.historicalSummaries;
    if (type === 'weekly') return summaries.weeklySummaries;
    if (type === 'recap') return summaries.recaps;
    return null;
}

// Format a timestamp (ms) as "YYYY-MM-DD HH:mm". Shared by fusion storage and the
// source→realtime resolver below.
function formatTimestamp(ms) {
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// Build a real-world (send_date) span string from a record's `source` provenance.
// Only "楼层 X-Y" (chat-message ranges) can resolve to send_date; for record→record
// sources ("周记 #1, #2") there is no direct chat range, so "" is returned. Reads the
// live chat (context.chat), falling back to the loaded sandbox context.
function realTimespanFromSource(source) {
    if (!source) return "";
    const m = String(source).match(/楼层\s*(\d+)\s*-\s*(\d+)/);
    if (!m) return "";
    const a = parseInt(m[1]), b = parseInt(m[2]);
    if (isNaN(a) || isNaN(b)) return "";
    const lo = Math.min(a, b), hi = Math.max(a, b);
    let chat = null;
    try { chat = window.SillyTavern.getContext()?.chat; } catch (e) { chat = null; }
    if (!Array.isArray(chat) || !chat.length) chat = Array.isArray(sandboxChatContext) ? sandboxChatContext : null;
    if (!Array.isArray(chat)) return "";
    const tsList = [];
    for (let i = lo; i <= hi && i < chat.length; i++) {
        const t = msgTimestamp(chat[i]);
        if (!isNaN(t)) tsList.push(t);
    }
    if (!tsList.length) return "";
    const min = Math.min(...tsList), max = Math.max(...tsList);
    return min === max ? formatTimestamp(min) : `${formatTimestamp(min)} ~ ${formatTimestamp(max)}`;
}

// The effective real-world span for a record: prefer the stored realTimespan (computed
// at fusion time), else resolve on-the-fly from its source floors. Lets older records
// (created before realTimespan was stored) still show/inject a real-time span.
function effectiveRealTimespan(item) {
    return sumRealTimespan(item) || realTimespanFromSource(sumSource(item));
}

// Build a Map<floorNumber, {type, index, label, priority}> covering every floor that
// any summary record (史记/周记/日记) accounts for. Each record's covered floor range
// comes from sumCoveredFloors() — 日记 store it directly; 周记/史记 inherit the merged
// range of the lower records they were fused from. ARCHIVED records are INCLUDED: when
// a 日记 is folded up into a 周记 it gets archived, but those floors are still covered
// (now by the 周记), so they must keep counting. The map is rebuilt fresh on every
// render, so deleting a record drops its floors automatically; if another record still
// covers a floor it reappears under that record (per the priority rule below).
//
// Conflict rule ("永远显示最新条目名称"): across types historical > weekly > recap
// (the higher, more-aggregated layer wins); within a type the higher array index
// (newer) wins. So a floor folded into a 史记 shows "史记 · …" even though the original
// 日记 (now archived) also covers it.
//
// ══════════════════════════════════════════════════════════════════════
// REGION: 楼层覆盖映射（哪条记覆盖哪些楼层 / 删楼安全的时间映射 / 队尾未覆盖段）
// ══════════════════════════════════════════════════════════════════════
// The label is what appears in the purple badge: e.g. "史记 · 太空旅行第一章" or
// "日记#3" when the record has no custom name.
function buildFloorCoverageMap() {
    const map = new Map(); // floor -> { type, index, label, priority }
    const TYPE_PRIORITY = { recap: 1, weekly: 2, historical: 3 };
    const layers = [
        { type: 'historical', arr: summaries.historicalSummaries },
        { type: 'weekly',     arr: summaries.weeklySummaries },
        { type: 'recap',      arr: summaries.recaps },
    ];
    for (const { type, arr } of layers) {
        if (!Array.isArray(arr)) continue;
        const priority = TYPE_PRIORITY[type] || 0;
        arr.forEach((item, index) => {
            const range = sumCoveredFloors(item);
            if (!range) return;
            const typeName = SUMMARY_TYPE_NAMES[type] || type;
            const name = sumName(item) || `${typeName}#${index + 1}`;
            const label = `${typeName} · ${name}`;
            for (let f = range.lo; f <= range.hi; f++) {
                const existing = map.get(f);
                // Higher priority type wins; within same type, higher index (newer) wins.
                if (!existing || priority > existing.priority || (priority === existing.priority && index >= existing.index)) {
                    map.set(f, { type, index, label, priority });
                }
            }
        });
    }
    return map;
}

// Floor-coverage map keyed by CURRENT floor index, built from floorRemapState's
// remapped "现 A-B 楼" ranges instead of the original stored coveredFloors. This is
// the delete-safe version used by the 上下文融合 list: after a front-delete, a record's
// stored floors (e.g. 0-390) overlap unrelated current floors, so buildFloorCoverageMap()
// would mislabel current floor 0 as the deleted "前苏格拉底" record. Here we use the
// remap result directly:
//   - deleted  → record contributes nothing (its floors are gone)
//   - present  → covers current floors [newLo, newHi]
//   - partial  → covers current floors [surviveLo, surviveHi]
// Falls back to buildFloorCoverageMap() when no remap state is available.
function buildRemappedCoverageMap() {
    const map = new Map(); // current floor -> { type, index, label, priority }
    const TYPE_PRIORITY = { recap: 1, weekly: 2, historical: 3 };
    const layers = [
        { type: 'historical', arr: summaries.historicalSummaries },
        { type: 'weekly',     arr: summaries.weeklySummaries },
        { type: 'recap',      arr: summaries.recaps },
    ];
    for (const { type, arr } of layers) {
        if (!Array.isArray(arr)) continue;
        const priority = TYPE_PRIORITY[type] || 0;
        arr.forEach((item, index) => {
            let lo, hi;
            // Priority: deleted verdict (time-based) wins over everything, including
            // manual nowFloors. "是否已删" is decided ONLY by realTimespan vs current chat.
            const remap = floorRemapState ? floorRemapState.get(`${type}:${index}`) : null;
            if (remap && remap.status === 'deleted') return; // gone → no current coverage
            if (remap && remap.status === 'unknown') return; // can't prove → don't cover

            const manual = sumNowFloors(item);
            if (manual && remap && (remap.status === 'present' || remap.status === 'partial')) {
                // Time proved the record still survives → nowFloors overrides the range.
                lo = manual.lo;
                hi = manual.hi;
            } else if (remap && remap.status === 'present') {
                lo = remap.newLo; hi = remap.newHi;
            } else if (remap && remap.status === 'partial') {
                lo = remap.surviveLo; hi = remap.surviveHi;
            } else if (!floorRemapState) {
                // No remap computed yet. Do NOT fall back to stale stored coveredFloors
                // for CURRENT-floor coverage — that's how an old {0,16000} painted #16850.
                // Contribute nothing; the badge map is refreshed once floorRemapState exists.
                return;
            } else {
                return;
            }
            if (typeof lo !== 'number' || typeof hi !== 'number') return;
            const typeName = SUMMARY_TYPE_NAMES[type] || type;
            const name = sumName(item) || `${typeName}#${index + 1}`;
            const label = `${typeName} · ${name}`;
            for (let f = lo; f <= hi; f++) {
                const existing = map.get(f);
                if (!existing || priority > existing.priority || (priority === existing.priority && index >= existing.index)) {
                    map.set(f, { type, index, label, priority });
                }
            }
        });
    }

    // Fill small gaps between adjacent covered ranges. Because each record matches
    // floors by its own send-time window, a boundary floor whose send_date falls in
    // NObody's window (a 1-2 floor seam between two records) gets left uncovered even
    // though it clearly belongs to the surrounding story. Bridge any gap of ≤ GAP_MAX
    // floors by extending the record on the LEFT of the gap across it.
    const GAP_MAX = 2;
    const coveredFloors = Array.from(map.keys()).sort((a, b) => a - b);
    for (let k = 0; k + 1 < coveredFloors.length; k++) {
        const left = coveredFloors[k];
        const right = coveredFloors[k + 1];
        const gap = right - left - 1;
        if (gap >= 1 && gap <= GAP_MAX) {
            const fill = map.get(left); // inherit the left record's label/type
            for (let f = left + 1; f < right; f++) {
                if (!map.has(f)) map.set(f, fill);
            }
        }
    }
    return map;
}

// Build a Set of CURRENT floor indices that are genuinely covered by some summary
// record, matched by SEND-TIME rather than original floor number. This is the
// delete-safe / truncation-safe replacement for buildFloorCoverageMap() when judging
// "how many recent floors are still un-summarized". Why send-time: coveredFloors hold
// ORIGINAL absolute indices (e.g. 0–8917); after the chat is truncated to its last
// 884 floors, those numbers overlap NEW June floors and would falsely mark fresh,
// un-summarized messages as covered. A current floor is covered only when its send_date
// falls inside some record's stored send-time range. Records without a usable
// realTimespan contribute nothing (can't be matched by time) — which is correct: we
// must not claim a recent floor is summarized when we can't prove it.
function buildCurrentCoverageSet(chatList) {
    const covered = new Set();
    const list = Array.isArray(chatList) ? chatList : [];
    if (!list.length) return covered;

    // Coverage for CURRENT chat floors must come from the current/remapped floor map.
    // Time is only a way to derive that remap after deletion; once we have a current
    // floor range (nowFloors / floorRemapState / visible source range), it has priority.
    // This prevents a stale broad realTimespan from marking all later floors as covered.
    const currentMap = buildRemappedCoverageMap();
    currentMap.forEach((_, f) => {
        if (f >= 0 && f < list.length) covered.add(f);
    });
    return covered;
}

// 队尾连续未覆盖段：从最后一层往前数，连续「未被日/周/史覆盖」(send-time 判定，时记不算)的
// 楼层，遇到第一个已覆盖楼即停。这是日记自动融合的触发判据 —— 即「那条消息后面再无任何记」。
// 返回 { floors:[...升序], lo, hi }；空段时 floors=[]、lo/hi=-1。
function tailUncoveredRun(chatList) {
    const list = Array.isArray(chatList) ? chatList : [];
    if (!list.length) return { floors: [], lo: -1, hi: -1 };
    const covered = buildCurrentCoverageSet(list);
    const floors = [];
    for (let f = list.length - 1; f >= 0; f--) {
        if (covered.has(f)) break;       // 遇到已被记覆盖的楼 → 队尾段到此为止
        floors.push(f);
    }
    floors.reverse();                    // 升序
    if (!floors.length) return { floors: [], lo: -1, hi: -1 };
    return { floors, lo: floors[0], hi: floors[floors.length - 1] };
}

// 预测「本轮回复结束后是否会触发日记自动写入」（普通 N_RECAP 路径 + 晨间 morning recap 路径）。
// 用在 injectMemoryAsHistory（GENERATION_AFTER_COMMANDS）阶段——此时 chat 里已有这一轮的 user 新楼，
// 但 AI 回复那一楼还没生成。命中 → 调用方跳过时记滚动断点（那批最老时记楼即将被归档，缓存它们等于浪费）。
// 误判无害：误报=这轮少缓存一次时记（下轮自动恢复）；漏报=退回原行为（继续浪费但不出错）。
function willWriteRecapThisTurn(chatList) {
    if (config.autoRecap === false) return false;
    const list = Array.isArray(chatList) ? chatList : [];
    if (!list.length) return false;

    // ⓪ 直融旁路（优先级高于日记）：史记直融 > 周记直融。
    //    触发处用 tailUncoveredRun(chat).floors.length >= directMin 且对应 auto 开关开启。
    //    回复后队尾未覆盖楼数 +1，故用 (当前队尾未覆盖数 + 1) 预判。
    {
        const histMin = Math.max(0, parseInt(config.directHistoricalMin) || 0);
        const weekMin = Math.max(0, parseInt(config.directWeeklyMin) || 0);
        const tailNow = tailUncoveredRun(list).floors.length;
        if (histMin > 0 && config.autoHistorical !== false && (tailNow + 1) >= histMin) return true;
        if (weekMin > 0 && config.autoWeekly !== false && (tailNow + 1) >= weekMin) return true;
    }

    // ① 普通队尾日记路径（onMessageReceived 尾部）：
    //    config.autoRecap !== false && tailUncoveredRun(chat).floors.length >= morningMinFloors
    //    回复后队尾未覆盖楼数 +1（AI 这条回复），故用 (当前队尾未覆盖数 + 1) 预判。
    //    注意 morningMinFloors 在普通路径用 ||30 兜底（见触发处 Math.max(1, parseInt||30)）。
    {
        const minUncovered = Math.max(1, parseInt(config.morningMinFloors) || 30);
        const tailNow = tailUncoveredRun(list).floors.length;
        if ((tailNow + 1) >= minUncovered) return true;
    }

    // ② 晨间 morning recap 路径（maybeRunMorningRecap）：仅在 enableMorningRecap 时考虑。
    //    回复后以「即将生成的 AI 回复楼」为 triggerFloor。在 inject 阶段该楼还没有，
    //    用「现在时间」近似它的时间戳、用「当前最后一条非系统楼」当 prevFloor 测间隔，
    //    覆盖统计用 buildRemappedCoverageMap（与触发处一致），未覆盖楼数门槛同样 ||1 兜底。
    if (config.enableMorningRecap) {
        try {
            // prevFloor：当前最后一条非系统楼（回复生成后它就是 triggerFloor 的前一条）。
            let prevFloor = -1;
            for (let i = list.length - 1; i >= 0; i--) {
                const m = list[i];
                if (!m || m.is_system) continue;
                prevFloor = i;
                break;
            }
            if (prevFloor >= 0) {
                const tNow = Date.now();              // 近似即将生成的回复时间
                const tPrev = msgTimestamp(list[prevFloor]);
                if (!isNaN(tNow) && !isNaN(tPrev)) {
                    const gapMinutes = (tNow - tPrev) / 60000;
                    const gapThreshold = Math.max(1, parseInt(config.morningGapMinutes) || 360);
                    if (gapMinutes >= gapThreshold
                        && isInMorningWindow(new Date(tNow), config.morningWindowStart, config.morningWindowEnd)) {
                        // triggerFloor 将是 list.length（新回复追加在末尾）→ 未覆盖统计含当前所有楼。
                        const coverageMap = buildRemappedCoverageMap();
                        let uncovered = 0;
                        for (let f = 0; f < list.length; f++) {
                            if (!coverageMap.has(f)) uncovered++;
                        }
                        const minFloors = Math.max(1, parseInt(config.morningMinFloors) || 1);
                        if (uncovered >= minFloors) return true;
                    }
                }
            }
        } catch (e) { /* 预测失败按未命中处理，退回原行为 */ }
    }

    return false;
}

// Format one record for INJECTION (macro output / fusion payload): prepend a
// "【名字 | RP时间跨度 | 现实时间跨度】" header line built from the record's metadata,
// then the body. The real-time span is only included when the per-record showRealTime
// toggle is on. Fields that are empty are omitted; if all are empty there is no header.
function formatRecordForInject(item) {
    const parts = [];
    const name = sumName(item);
    const ts = sumTimespan(item);
    const realTs = sumShowRealTime(item) ? effectiveRealTimespan(item) : "";
    if (name) parts.push(name);
    if (ts) parts.push(ts);
    if (realTs) parts.push(realTs);
    const body = sumText(item);
    if (!parts.length) return body;
    return `【${parts.join(' | ')}】\n${body}`;
}

// Compiled (non-archived) text for each layer, used by the individual macros.
function compileHistoricalText() {
    return (summaries.historicalSummaries || []).filter(x => !sumIsArchived(x)).map(formatRecordForInject).join('\n\n');
}
function compileWeeklyText() {
    return (summaries.weeklySummaries || []).filter(x => !sumIsArchived(x)).map(formatRecordForInject).join('\n\n');
}
function compileRecapText() {
    return (summaries.recaps || []).filter(x => !sumIsArchived(x)).map(formatRecordForInject).join('\n');
}

// Core: compile the existing (non-archived) layered summaries — 史记 / 周记 / 日记 —
// into labeled sections. `excludeType` (e.g. the layer being generated) is skipped;
// pass null/undefined to include all three. Returns "" when nothing applies. This
// is the shared body for both the {{records}} macro (bare content) and fusion's
// prior-context block (which adds a guiding instruction header).
function buildRecordsSections(excludeType) {
    const sections = [];
    const layers = [
        { type: 'historical', label: '史记 (宏观历史总结)', arr: summaries.historicalSummaries, sep: '\n\n' },
        { type: 'weekly', label: '周记 (阶段性总结)', arr: summaries.weeklySummaries, sep: '\n\n' },
        { type: 'recap', label: '日记 (近期故事线)', arr: summaries.recaps, sep: '\n' },
    ];
    for (const L of layers) {
        if (excludeType && L.type === excludeType) continue;
        const items = (L.arr || []).filter(x => !sumIsArchived(x)).map(formatRecordForInject).filter(t => t && t.trim());
        if (!items.length) continue;
        sections.push(`【${L.label}】\n${items.join(L.sep)}`);
    }
    return sections.length ? sections.join('\n\n') : "";
}

// The {{records}} macro / slash command: ALL existing layered summaries as bare,
// labeled content (no instruction wrapper). Zero-arg callback for ST macro use.
function compileAllRecords() {
    return buildRecordsSections(null);
}

// Fusion prior-context: the OTHER existing records (all layers except the one being
// generated) wrapped with an instruction telling the AI not to rewrite them and to
// avoid duplication. Returns "" when nothing applies.
function compileOtherRecords(excludeType) {
    const body = buildRecordsSections(excludeType);
    if (!body) return "";
    return `以下是已经存在的记忆记录，仅供你参考前文与避免重复记录，不要改写它们：\n\n${body}`;
}

function getTreePathIndex(nodes, opts = {}) {
    const lines = [];
    const indentUnit = '  ';
    const showPath = opts.showPath !== false;
    const showHint = opts.showHint !== false;
    const maxDepth = (typeof opts.maxDepth === 'number' && opts.maxDepth > 0) ? opts.maxDepth : 0;
    const maxChildren = (typeof opts.maxChildren === 'number' && opts.maxChildren > 0) ? opts.maxChildren : 0;
    const includeNode = (n) => {
        if (!n || n.archived) return false;
        if (opts.excludePinned && n.pinned) return false;
        if (!opts.ignoreSendPath && !nodeSendsPath(n)) return false;
        return true;
    };
    const countVisibleChildren = (node) => {
        const ch = Array.isArray(node.children) ? node.children : [];
        let c = 0;
        for (const k of ch) { if (includeNode(k)) c++; }
        return c;
    };
    function walk(list, depth) {
        (list || []).forEach(node => {
            const children = Array.isArray(node.children) ? node.children : [];
            const visible = includeNode(node);
            if (visible) {
                const hint = (node.hint || '').trim();
                const parts = [];
                if (showPath) parts.push(node.title);
                if (showHint && hint) parts.push(hint);
                if (!parts.length) {
                    // 两个 header 开关都关 → 本节点无可显示内容；仍按层级限制向下走
                    if (!maxDepth || depth + 1 < maxDepth) walk(children, depth + 1);
                    return;
                }
                const line = `${indentUnit.repeat(depth)}- ${parts.join(' | ')}`;
                const visChildCount = countVisibleChildren(node);
                const widthCut = maxChildren && visChildCount > maxChildren;        // 子项过多 → 折叠
                const depthCut = maxDepth && depth + 1 >= maxDepth && visChildCount > 0; // 下一层超限 → 砍断
                if (widthCut) {
                    lines.push(`${line}（${visChildCount} 项）`);
                } else if (depthCut) {
                    lines.push(`${line} …`);
                } else {
                    lines.push(line);
                    walk(children, depth + 1);
                }
            } else {
                // Archived / sendPath-off branches are hidden with their subtree; pinned
                // branches in routing mode are skipped as nodes but their children remain
                // routable, matching the old flat-index behavior.
                if (opts.excludePinned && node?.pinned && !node.archived && (opts.ignoreSendPath || nodeSendsPath(node))) {
                    walk(children, depth);
                }
            }
        });
    }
    walk(nodes || [], 0);
    return lines.join('\n');
}

// ══════════════════════════════════════════════════════════════════════
// REGION: 宏编译（{{memory_tree}} / header / 史记·周记·日记·时记 文本拼装）
// ══════════════════════════════════════════════════════════════════════
function compileMemoryTreeNames() {
    // 纯静态路径索引——逐轮稳定，可安全进入 prompt cache 前缀。
    // world-info 式关键词触发已移至 {{memory_tree}} 正文宏（compileMemoryTreeMacroValue 的
    // mtKeywordTrigger 来源）：命中即注入节点正文，而非这里塞路径，语义更贴近「召回正文」。
    return getTreePathIndex(memoryTree, {
        showPath: config.mthIncludePath,
        showHint: config.mthIncludeHint,
        maxDepth: config.mthMaxDepth || 0,
        maxChildren: config.mthMaxChildren || 0,
    });
}

function compilePinnedMemoryContent() {
    const allTreeNodes = getAllNodes(memoryTree).filter(n => n.pinned && !n.archived);
    const blocks = [];
    let tokenCount = 0;
    const cap = config.PIN_BUDGET || config.TOKEN_CAP || 8000;
    for (const node of allTreeNodes) {
        const block = formatNodeUnified(node);
        if (!block) continue;
        const tokens = estimateTokens(block);
        if (tokenCount + tokens > cap) break;
        blocks.push(block);
        tokenCount += tokens;
    }
    return blocks.join('\n\n') || "无";
}

function compileMemoryTreeMacroValue() {
    // {{memory_tree}} is the RECALL-BODY macro: replaced with this turn's recalled + pinned
    // node CONTENT, fused per-node via formatNodeUnifiedSwitched (【path】/hint/body 按开关取舍) —
    // NOT the path index (that is {{memory_tree_header}} / compileMemoryTreeNames).
    //
    // 内容来源（5 个 mtInclude* 开关，可任意组合；全关 → 返回 ""，使宏可被「空着」）：
    //   1. pin 正文（mtIncludePinBody）：钉死节点，PIN_BUDGET 预算，不受路由/sendPath 影响。
    //   2. 路由召回正文（mtIncludeRoutedBody）：本轮路由召回的非 pin 节点。
    //      没召回（路由没跑 / 路由召回为空）→ 不发任何内容（不回退全树）。
    //      想要全量 dump 的人请改用「全部节点正文」开关（mtIncludeAllBody）。
    //   3. 全部节点正文（mtIncludeAllBody）：字面全树非 pin 节点，绕过路由，TOKEN_CAP 预算。
    //   + 路径/节点名称(mtIncludePath)、hint(mtIncludeHint) 是「每节点块内」的格式开关。
    // 按 path 去重；pin 优先、再 routed、再 all（all 是 routed 超集，同开时去重后等同 all）。
    const blocks = [];
    const seen = new Set();
    // 每个来源各自独立预算（pin→PIN_BUDGET，routed/all→TOKEN_CAP），通过共享 seen 按 path 去重。
    const addSrc = (nodes, cap) => {
        let tokenCount = 0;
        for (const node of nodes) {
            if (!node || node.archived || seen.has(node.path)) continue;
            const block = formatNodeUnifiedSwitched(node);
            if (!block) continue;
            const t = estimateTokens(block);
            if (tokenCount + t > cap) break;
            seen.add(node.path);
            blocks.push(block);
            tokenCount += t;
        }
    };
    if (config.mtIncludePinBody) {
        addSrc(getAllNodes(memoryTree).filter(n => n.pinned && !n.archived), config.PIN_BUDGET || 3000);
    }
    // world-info 式关键词硬触发：keywords 命中最近一轮 user/ai 楼的节点（含 sendPath-off 隐藏节点），
    // 命中即直接注入正文、绕过路由。放在 pin 之后、routed 之前，让显式命中优先占预算；与 routed/all
    // 经共享 seen 去重，已被其它来源收录的不重复。仅当本轮真有命中才产生内容，无命中→不影响缓存。
    if (config.mtKeywordTrigger) {
        try {
            const ctx = window.SillyTavern?.getContext();
            const matched = getKeywordMatchedNodes(ctx?.chat).filter(n => n && !n.pinned && !n.archived);
            addSrc(matched, config.TOKEN_CAP || 8000);
        } catch (e) { /* ignore */ }
    }
    if (config.mtIncludeRoutedBody) {
        // 没召回就发空——只取本轮路由实际召回的节点，不回退全树。
        const routed = (lastCompiledNodes && Array.isArray(lastCompiledNodes.recalled))
            ? lastCompiledNodes.recalled
            : [];
        addSrc(routed, config.TOKEN_CAP || 8000);
    }
    if (config.mtIncludeAllBody) {
        addSrc(getAllNodes(memoryTree).filter(n => !n.pinned && !n.archived), config.TOKEN_CAP || 8000);
    }
    return blocks.join('\n\n');
}

// Determine which floors the 时记 (recent-messages) block should cover.
// Two modes (config.shijiMode), both capped to N_SHIJI:
//   'fixed'     — the newest N floors, regardless of whether they're already
//                 covered by a 日记/周记/史记. Simple "last N messages".
//   'uncovered' — (default) walk backwards from newest, collect the contiguous
//                 run of floors NOT yet covered by any record; stop at the first
//                 already-covered floor. Fills exactly the gap since the last
//                 archive. N_SHIJI is an UPPER BOUND on that run.
// Returns an array of 0-based floor ids, ascending.
function computeShijiFloors(chatList) {
    if (!Array.isArray(chatList) || chatList.length === 0) return [];
    const cap = Math.max(1, parseInt(config.N_SHIJI) || 20);
    const L = chatList.length;

    // 始终保持X楼：始终至少保留最近 X 楼的正文。即使最新楼层刚被日记/周记/史记覆盖
    // （uncovered 段塌缩为 0），也强制把最近 X 楼补进时记，让 AI 永远有近期正文参照，
    // 防止「刚总结完→无正文→角色偏移」。在两种发送模式下都生效（始终）。
    const keep = Math.max(0, parseInt(config.shijiKeepFloors) || 0);
    const withKeepFloor = (floors) => {
        if (keep <= 0) return floors;
        const minStart = Math.max(0, L - keep);          // 最近 keep 楼的起点
        const start = floors.length ? Math.min(floors[0], minStart) : minStart;
        const out = [];
        for (let f = start; f < L; f++) out.push(f);
        return out; // ascending, 连续
    };

    if (config.shijiMode === 'fixed') {
        const start = Math.max(0, L - cap);
        const floors = [];
        for (let f = start; f < L; f++) floors.push(f);
        return withKeepFloor(floors); // already ascending
    }

    // 'uncovered' (default). Coverage is matched by SEND-TIME, not original floor
    // number: after the chat is truncated, old records' original indices (e.g. 0-8917)
    // numerically overlap the current 0-883 floors, so a floor-number coverage map
    // would falsely flag the newest floors as covered → 时记 collapses to 0. The
    // send-time coverage set only marks a current floor covered when its send_date
    // actually falls inside some record's stored time range.
    const coveredNow = buildCurrentCoverageSet(chatList);
    const floors = [];
    for (let f = L - 1; f >= 0; f--) {
        if (coveredNow.has(f)) break;      // hit archived material — stop
        floors.push(f);
        if (floors.length >= cap) break;   // upper-bound reached
    }
    return withKeepFloor(floors.reverse()); // ascending order for display/injection
}

// Format one 时记 floor into its injectable text line: `[prefix] [Name]: text`.
// Shared by compileShiji() (merged block) and injectMemoryAsHistory() (per-floor
// fake chat-history injection) so the rule-chain + prefix logic stays in one place.
// pos = L - floorId (newest floor = 1).
function formatShijiFloor(m, floorId, pos) {
    if (!m) return '';
    const role = msgRoleSide(m); // system grouped with AI side
    const contentKey = m.content !== undefined ? 'content' : 'mes';
    const name = msgName(m);
    const { text } = applyShijiRules(m[contentKey] || "", role, pos);
    const showDate = m.is_user ? config.shijiShowDateUser : config.shijiShowDateAi;
    // 模型名只对 AI 楼有意义（user 楼没有 model 字段）。
    const modelLabel = (config.shijiShowModel && !m.is_user) ? msgModel(m) : '';
    const prefix = [
        config.shijiShowFloor ? `[楼层 ${floorId}]` : '',
        showDate ? (() => { const _t = msgTimestamp(m); return `[${isNaN(_t) ? (m.send_date || '') : formatTimestamp(_t)}]`; })() : '',
        modelLabel ? `[${modelLabel}]` : '',
    ].filter(Boolean).join(' ');
    return `${prefix ? prefix + ' ' : ''}[${name}]: ${text}`;
}

// Compile the 时记 block: the selected floors (see computeShijiFloors), each
// transformed by the multi-rule regex chain (applyShijiRules). Counted by
// individual message (楼层 / mesid) — the same unit used by 史记/周记/日记.
function compileShiji() {
    const context = window.SillyTavern?.getContext();
    const chatList = context?.chat;
    if (!Array.isArray(chatList) || chatList.length === 0) {
        return "";
    }
    const L = chatList.length;
    const floors = computeShijiFloors(chatList);
    return floors.map((floorId) => {
        const m = chatList[floorId];
        if (!m) return '';
        return formatShijiFloor(m, floorId, L - floorId);
    }).filter(Boolean).join('\n');
}

// ── 伪造聊天历史注入 (fakeChatHistory) ───────────────────────────────────────
// ST 注入枚举（不经 getContext 暴露，值稳定，见 public/script.js:484/494）。
// 用 IN_CHAT depth：ST 会把每个 depth 的注入按 role 拆成独立 {role,content} 消息，splice 进
// chatHistory 集合（openai.js: populationInjectionPrompts → populateChatHistory）。这样记忆
// 就以「真实对话轮次」(user/assistant/system 交替) 发给模型，并归到 Itemization 的 Chat History。
// 前提：Chat History 提示词必须「启用」(可被 regex 砍到只剩一条，但不能在 prompt manager 禁用)，
// 否则 populateChatHistory 直接 return、丢弃所有 IN_CHAT 注入。用户用 regex 过滤 → chatHistory
// 仍启用 → 本方案可用。每楼一个唯一 key + 独立 depth（最新楼=depth 0），还原成连续独立轮次。
const EP_TYPE_IN_CHAT = 1;          // extension_prompt_types.IN_CHAT
const EP_ROLE_SYSTEM = 0;           // extension_prompt_roles.SYSTEM
const EP_ROLE_USER = 1;             // extension_prompt_roles.USER
const EP_ROLE_ASSISTANT = 2;        // extension_prompt_roles.ASSISTANT
// 上一轮通过 setExtensionPrompt 注册的所有 key，下轮开始前需逐个清空，避免切角色/楼层变化后残留。
const registeredInjectKeys = new Set();

// 伪造模式 ST regex 脚本名（按名字去重；用户也能在 ST 全局 regex 列表里看见这一条，
// 名字带「插件自动管理」字样以便识别。注意 ID 不参与去重 —— 用户重启/数据迁移后 id 可能变）。
const STMW_FAKE_REGEX_NAME = 'STMW 伪造历史屏蔽原生楼层（插件自动管理·勿手动改）';

// 同步 ST 全局 regex 列表：fakeChatHistory 开启时按名字检查/创建并启用一条把原生
// user/ai 楼层正文清空的脚本；关闭时不删除，只把这条脚本 disabled=true。这样用户能在
// ST 全局 regex 列表里稳定看见它，重新打开功能时也只是把同一条 regex 重新启用。
// 这是「让 ST 在 itemization 之前就清空原生楼层」的唯一可行做法 —— 因为 ST 的
// itemization 在我们能拿到的事件之前算（promptManager.render → openai.js:1611），任何在
// CHAT_COMPLETION_PROMPT_READY 里的删除对 Itemization 都是「太晚」。
// ST regex 引擎（engine.js:334 getRegexedString）走 USER_INPUT/AI_OUTPUT 两个 placement，
// 由 script.js:4480 在 coreChat 构建阶段调用 —— 早于 itemization，所以 Chat History 桶
// 的 token 才会真正反映「楼层被清空」。
// ══════════════════════════════════════════════════════════════════════
// REGION: 伪造聊天历史注入（时记/摘要经 setExtensionPrompt(IN_CHAT) 注入 + ST regex 管理）
// ══════════════════════════════════════════════════════════════════════
// 伪造历史本身是经 setExtensionPrompt(IN_CHAT) 注入的（openai.js:854 getExtensionPrompt），
// 不走 getRegexedString → 不会被这条 regex 清掉。互不干扰。
function syncFakeChatRegex() {
    try {
        const ctx = window.SillyTavern?.getContext();
        if (!ctx) return;
        const settings = ctx.extensionSettings;
        if (!settings) return;
        if (!Array.isArray(settings.regex)) settings.regex = [];
        const list = settings.regex;

        const syncVisibleRegexRow = (item) => {
            try {
                if (!item || !item.id) return;
                const row = document.getElementById(item.id);
                if (!row) return;
                // ST Regex UI: .disable_regex checked=true means the script is disabled.
                $(row).find('.disable_regex').prop('checked', !!item.disabled);
            } catch (e) { /* UI may not be mounted; data sync is still enough */ }
        };

        // 按名字去重定位现有项（避免重复插入；id 不可靠）。
        const idx = list.findIndex(s => s && s.scriptName === STMW_FAKE_REGEX_NAME);

        const desired = {
            findRegex: '/[\\s\\S]+/',  // raw form ST 解析；engine 会用 regexFromString
            replaceString: '',
            trimStrings: [],
            placement: [1, 2],          // USER_INPUT + AI_OUTPUT
            markdownOnly: false,
            promptOnly: true,           // 只在 prompt 时跑，不动 UI 显示
            runOnEdit: false,
            substituteRegex: 0,
            // minDepth=0：跳过 depth<0 的楼层——只有 continue 模式下「最后一条被续写的 AI
            // 消息」会得到 depth=-1（见 script.js depth = coreChat.length - i - (isContinue?2:1)）。
            // 这条是原生 ST 保留下来当「正文前缀」给模型接着写的，绝不能被本 regex 清空成空串，
            // 否则 promptReasoning.addToMessage 在 isPrefix && !content 分支只会返回 reasoning，
            // 于是「Continue 续写」就退化成只发思考内容、不发正文。minDepth=0 对正常/swipe/
            // regenerate 无副作用（那些模式下最小 depth 是 0，不会被跳过）。
            minDepth: 0,
            maxDepth: null,
        };

        if (config.fakeChatHistory) {
            if (idx === -1) {
                // 不存在 → 插入。findRegex 匹配任意非空字符（多行），replaceString="" 清空正文。
                const item = {
                    id: `stmw-fake-${Math.random().toString(36).slice(2, 10)}`,
                    scriptName: STMW_FAKE_REGEX_NAME,
                    ...desired,
                    disabled: false,
                };
                list.push(item);
                syncVisibleRegexRow(item);
                writeLog('已向 ST 全局 regex 注入「' + STMW_FAKE_REGEX_NAME + '」(itemization 现在会正确反映砍楼后的 token)。');
                ctx.saveSettingsDebounced?.();
            } else {
                // 存在 → 确保内容正确并启用。按名字管理，不依赖 id。
                const item = list[idx];
                let changed = false;
                for (const [k, v] of Object.entries(desired)) {
                    if (JSON.stringify(item[k]) !== JSON.stringify(v)) { item[k] = v; changed = true; }
                }
                if (item.disabled) { item.disabled = false; changed = true; }
                if (changed) {
                    syncVisibleRegexRow(item);
                    writeLog('已按名字检查并启用「' + STMW_FAKE_REGEX_NAME + '」。');
                    ctx.saveSettingsDebounced?.();
                }
            }
        } else {
            if (idx !== -1) {
                const wasEnabled = !list[idx].disabled;
                list[idx].disabled = true;
                syncVisibleRegexRow(list[idx]);
                if (wasEnabled) {
                    writeLog('已关闭 ST 全局 regex「' + STMW_FAKE_REGEX_NAME + '」(伪造模式已关闭；保留条目以便下次重新启用)。');
                    ctx.saveSettingsDebounced?.();
                }
            }
        }
    } catch (e) {
        writeLog('syncFakeChatRegex 失败: ' + e.message, 'WARNING');
    }
}

// 在 GENERATION_AFTER_COMMANDS 触发：把时记（可选再加一条合并的分层摘要）用
// setExtensionPrompt(IN_CHAT) 注入成「真实对话历史」——插在当前 user 消息之前，归入 Itemization 的 Chat History 桶。
function injectMemoryAsHistory(type) {
    const ctx = window.SillyTavern?.getContext();
    const setEP = ctx?.setExtensionPrompt;
    if (typeof setEP !== 'function') return;

    // 1) 清空上一轮注入（无论开关开关都先清，保证关掉开关后立即不再注入）。
    for (const k of registeredInjectKeys) {
        try { setEP(k, '', EP_TYPE_IN_CHAT, 0); } catch (e) { /* ignore */ }
    }
    registeredInjectKeys.clear();

    if (!config.fakeChatHistory) return;
    // 保险：每次生成前都确保 ST regex 屏蔽脚本还在（用户手动删了的话会自动补回）。
    syncFakeChatRegex();
    // 跳过 quiet/impersonate 等后台生成（含插件自身的归档 LLM 调用）；正常对话 / continue / swipe / regenerate 照常注入。
    if (type === 'quiet' || type === 'impersonate') return;

    const chatList = ctx?.chat;
    if (!Array.isArray(chatList) || chatList.length === 0) return;

    const L = chatList.length;
    // depth 从 0（最贴近当前 user 消息）开始递增。同 depth 同 role 会被合并成一条，所以每楼独占一个 depth。
    let depth = 0;

    // swipe / continue：原生 ST 在 coreChat 阶段单独处理「最后一条 AI 消息」——
    //   • swipe：coreChat.pop() 把被 swipe 的那条丢掉再重新生成（见 script.js:4471）；
    //   • continue：保留它作为「正文前缀」（reasoning + body）让模型接着写（见 script.js:4506）。
    // 注意原生 ST 只从 coreChat（用于拼 prompt 的副本）里 pop，ctx.chat 仍保留这条。所以本插件
    // computeShijiFloors(ctx.chat) 默认会把这条最后一楼也选中并当成「假对话轮次」注入回去——
    // swipe 时就会把原回复正文再喂给模型（无法重新生成新回复）；continue 时则会把同一楼重复注入、
    // 扰乱前缀。因此这两种模式下跳过最后一楼，与原生 ST 的 coreChat 语义对齐。
    // （regenerate 不需要：原生 ST 在 Generate 早期就 chat.length-- 删掉了那条，ctx.chat 已没有它。）
    const lastIdx = L - 1;
    const excludeLastFloor =
        (type === 'swipe' || type === 'continue') && !chatList[lastIdx]?.is_user;

    // 2) 时记：升序楼层 → 反转为「最新在前」，逐楼一个独立 depth + 独立 key + 真实 role（AI 楼→
    //    assistant、用户楼→user、系统楼→system），还原成连续的交替对话轮次。
    const floors = computeShijiFloors(chatList);
    const usableFloors = excludeLastFloor ? floors.filter(f => f !== lastIdx) : floors;
    const ordered = usableFloors.slice().reverse(); // newest floor first → depth 0（倒数第一）

    // 滚动缓存断点：gateway 模式下，解析 anthropicCacheRollingDepths（倒数索引集合，0=最新时记楼），
    // 在这些楼的正文末尾追加 [[CACHE_BREAK]]，网关据此在对应 message 处注入 cache_control。
    // 时记楼是真实 role、各自独立 message（不被合并），所以每个标记精确落在一条 message 末尾。
    // 固定点（史记后）占 1 个，这里最多再放 3 个 → 总 ≤4（Anthropic 上限）。
    //
    // 「写日记轮」跳过滚动断点（防无效缓存）：本轮回复结束后若会触发日记写入
    // （tailUncoveredRun 攒够 morningMinFloors），那批最老的时记楼会被归档、时记窗口整体位移，
    // 滚动断点（落在较老时记楼）缓存的大前缀下一轮必然作废——花 1.25x 写了个读不到的缓存。
    // 此时只保留 preset 里 周记/日记 之间的 system 固定锚点（日记在锚点之后，史记+周记前缀仍命中），
    // 时记楼本轮按 1x 普通输入发送，省掉无效写入。预测见 willWriteRecapThisTurn()。
    const rollingSet = new Set();
    // 开关受 config.skipRollingOnRecapTurn 门控（默认开；关掉=不预测、永远照常放滚动断点，用于调试对比）。
    const skipRolling = (config.skipRollingOnRecapTurn !== false) && willWriteRecapThisTurn(chatList);
    if (skipRolling && config.anthropicCacheDebug) {
        writeLog('滚动缓存：本轮回复后预测将写日记/晨间归档（队尾或晨间未覆盖将达阈值），跳过时记滚动断点以免写入无效缓存。', 'INFO');
    }
    if (!skipRolling
        && anthropicCacheEnabledFor('main')
        && (config.anthropicCacheMainMode || 'manual') === 'gateway'
        && ordered.length > 0) {
        const raw = String(config.anthropicCacheRollingDepths ?? '').trim();
        if (raw) {
            raw.split(/[,，\s]+/).filter(Boolean).forEach((tok) => {
                let idx = parseInt(tok, 10);
                if (!Number.isInteger(idx) || idx < 0) return;
                // 时记楼数量不足（如日记刚归档、窗口塌缩）时退化到最深可用楼，
                // 而不是无声丢弃——否则滚动断点会静默消失，请求里只剩固定锚点。
                if (idx >= ordered.length) {
                    const fallback = ordered.length - 1;
                    writeLog(`滚动缓存：配置深度 ${idx}（倒数第 ${idx + 1} 楼）超出当前时记楼数量 ${ordered.length}，退化为最深可用楼（倒数第 ${fallback + 1} 楼）。`, 'WARN');
                    idx = fallback;
                }
                if (rollingSet.size < 3) {
                    rollingSet.add(idx);
                }
            });
        }
    }

    ordered.forEach((floorId, idx) => {
        const m = chatList[floorId];
        if (!m) return;
        let content = formatShijiFloor(m, floorId, L - floorId);
        if (!content || !content.trim()) return;
        // 滚动断点：在选中楼层正文末尾追加纯文本标记，交本地网关转 cache_control。
        if (rollingSet.has(idx)) {
            content = `${content}\n[[CACHE_BREAK]]`;
            if (config.anthropicCacheDebug) writeLog(`滚动缓存：倒数第 ${idx + 1} 条时记楼（floor ${floorId}）末尾追加 [[CACHE_BREAK]]。`, 'INFO');
        }
        const role = m.is_user ? EP_ROLE_USER : (m.is_system ? EP_ROLE_SYSTEM : EP_ROLE_ASSISTANT);
        const key = `stmw_shiji_${floorId}`;
        try {
            setEP(key, content, EP_TYPE_IN_CHAT, depth, false, role);
            registeredInjectKeys.add(key);
        } catch (e) { /* ignore */ }
        depth++;
    });

    // 3) 可选：将全部未归档的史记/周记/日记合成一条更早的 assistant 消息。
    // depth 必须在时记之后，保证这条总览位于时记之前而不是贴着当前 user 消息。
    if (config.fakeChatHistoryIncludeSummaries) {
        const content = compileAllRecords();
        if (content) {
            const key = 'stmw_layered_summaries';
            try {
                setEP(key, content, EP_TYPE_IN_CHAT, depth, false, EP_ROLE_ASSISTANT);
                registeredInjectKeys.add(key);
                depth++;
            } catch (e) { /* ignore */ }
        }
    }

    if (registeredInjectKeys.size) {
        writeLog(`伪造聊天历史(IN_CHAT)：注入 ${ordered.length} 段时记楼${config.fakeChatHistoryIncludeSummaries ? '，并将史记/周记/日记合并为 1 条 assistant 消息' : ''}。`);
    }
}

// Render the 时记 section in the summaries tab with real-time chat messages.
function renderShijiList() {
    const listEl = $('#wizard-shiji-list');
    const countEl = $('#wizard-shiji-count');
    if (listEl.length === 0) return;

    const context = window.SillyTavern?.getContext();
    const chatList = context?.chat;
    if (!Array.isArray(chatList) || chatList.length === 0) {
        listEl.html('<span style="color: #6b7280;">（请先打开一个聊天）</span>');
        countEl.text('');
        return;
    }

    const L = chatList.length;
    const floors = computeShijiFloors(chatList);
    const cap = Math.max(1, parseInt(config.N_SHIJI) || 20);
    const fixedMode = config.shijiMode === 'fixed';

    if (floors.length === 0) {
        listEl.html('<span style="color: #6b7280;">（最新楼层都已被日记/周记/史记覆盖，时记为空）</span>');
        countEl.text(fixedMode ? `固定 0 条 / 上限 ${cap} · 共 ${L} 条` : `未归类 0 条 / 上限 ${cap} · 共 ${L} 条`);
        return;
    }
    const capped = floors.length >= cap;

    // Render each floor entry first so we can accumulate total tokens.
    const color = '#34d399'; // 时记 accent — green
    const $list = listEl;
    $list.empty();
    let totalShijiTokens = 0;
    floors.forEach((floorId) => {
        const m = chatList[floorId];
        if (!m) return;
        const contentKey = m.content !== undefined ? 'content' : 'mes';
        const text = m[contentKey] || '';
        const name = msgName(m);
        const role = msgRoleSide(m);
        const pos = L - floorId;

        let roleLabel = 'AI';
        let headerColor = '#f472b6';
        if (m.is_system) { roleLabel = '系统'; headerColor = '#9ca3af'; }
        else if (m.is_user) { roleLabel = '用户'; headerColor = '#60a5fa'; }

        // Rule-chain preview line. extracted = what actually gets injected.
        const { text: extracted, appliedRuleIndices } = applyShijiRules(text, role, pos);
        const hit = appliedRuleIndices.length > 0;
        const ruleStr = hit ? appliedRuleIndices.map(i => `#${i + 1}`).join(',') : '';
        const injectedText = hit ? extracted : text;
        const showDatePfx = m.is_user ? config.shijiShowDateUser : config.shijiShowDateAi;
        const injPrefix = [
            config.shijiShowFloor ? `[楼层 ${floorId}]` : '',
            showDatePfx ? (() => { const _t = msgTimestamp(m); return `[${isNaN(_t) ? (m.send_date || '') : formatTimestamp(_t)}]`; })() : '',
        ].filter(Boolean).join(' ');
        const itemTokens = estimateTokens(`${injPrefix ? injPrefix + ' ' : ''}[${name}]: ${injectedText}`);
        totalShijiTokens += itemTokens;

        const matchLineHtml = (Array.isArray(config.shijiRules) && config.shijiRules.length)
            ? `<div style="font-size:0.8em;color:${hit?'#34d399':'#9ca3af'};background:rgba(0,0,0,0.25);border-left:2px solid ${hit?'#34d399':'rgba(255,255,255,0.15)'};padding:4px 8px;border-radius:3px;white-space:pre-wrap;word-break:break-word;"><i class="fa-solid fa-filter"></i> ${hit?`规则 ${ruleStr} 命中 (将注入此内容)`:'无规则命中 (将注入完整正文)'}: ${escapeHtml(hit?extracted:'')}</div>`
            : '';

        const item = $(`
            <div class="wizard-summary-item" style="display:flex;flex-direction:column;gap:6px;margin-bottom:10px;border-bottom:1px dashed rgba(255,255,255,0.06);padding-bottom:8px;">
                <div style="display:flex;justify-content:space-between;align-items:center;font-size:0.85em;color:${headerColor};font-weight:500;">
                    <span style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                        <span style="color:${color};font-weight:600;">#${floorId}</span>
                        <span style="color:#6b7280;font-size:0.9em;">楼 · 倒数第${pos}</span>
                        <span style="color:${headerColor};">${escapeHtml(name)}</span>
                        <span style="font-size:0.78em;color:#6b7280;">(${roleLabel})</span>
                        ${(() => {
                            const ts = msgTimestamp(m);
                            const label = isNaN(ts) ? (m.send_date || '') : formatTimestamp(ts);
                            return label ? `<span style="font-size:0.78em;color:#9ca3af;">· ${escapeHtml(label)}</span>` : '';
                        })()}
                        <span style="font-size:0.78em;color:#6b7280;">· ${itemTokens.toLocaleString()} tokens</span>
                    </span>
                </div>
                <textarea class="wizard-summary-textarea wizard-input" readonly style="width:100%;min-height:45px;height:auto;font-size:0.9em;padding:6px 8px;resize:vertical;line-height:1.4;font-family:inherit;margin:0;box-sizing:border-box;background:rgba(0,0,0,0.15)!important;border:1px solid rgba(255,255,255,0.06)!important;cursor:default;"></textarea>
                ${matchLineHtml ? `<div class="wizard-shiji-match-line">${matchLineHtml}</div>` : ''}
                <div class="wizard-sum-expand-row" style="display:flex;justify-content:center;margin-top:-2px;">
                    <i class="fa-solid fa-chevron-down wizard-sum-expand-btn" style="cursor:pointer;color:#6b7280;font-size:0.85em;padding:2px 14px;border-radius:4px;" title="展开/收起"></i>
                </div>
            </div>
        `);
        item.find('textarea').val(text);
        $list.append(item);
    });
    if (floors.length === 0) $list.html('<span style="color:#6b7280;">暂无消息</span>');

    // Update count label with total token tally.
    if (fixedMode) {
        countEl.text(`固定取最新 ${floors.length} 条 / 上限 ${cap} · 共 ${L} 条 · 合计 ${totalShijiTokens.toLocaleString()} tokens`);
    } else {
        countEl.text(`未归类${capped ? ' 取最新' : ''} ${floors.length} 条 / 上限 ${cap} · 共 ${L} 条 · 合计 ${totalShijiTokens.toLocaleString()} tokens`);
    }
}

// Render the 时记 regex rule list (stacked read-only rows + remove buttons) into
// #wizard-shiji-rules. Each rule shows its role, backward-position window, and
// pattern. Editing = remove + re-add (keeps the handler surface minimal).
function renderShijiRules() {
    const wrap = $('#wizard-shiji-rules');
    if (wrap.length === 0) return;
    const rules = Array.isArray(config.shijiRules) ? config.shijiRules : [];
    if (rules.length === 0) {
        wrap.html('<span style="color:#6b7280; font-size:0.82em;">（暂无规则，注入完整正文。添加规则可按角色 / 楼层位置提取部分内容。）</span>');
        return;
    }
    const roleLabel = (r) => r === 'ai' ? 'AI' : (r === 'user' ? 'User' : '两者');
    const roleColor = (r) => r === 'ai' ? '#f472b6' : (r === 'user' ? '#60a5fa' : '#a78bfa');
    let html = '';
    rules.forEach((rule, i) => {
        const min = (rule.posMin == null || rule.posMin === '') ? null : rule.posMin;
        const max = (rule.posMax == null || rule.posMax === '') ? null : rule.posMax;
        let posStr;
        if (min == null && max == null) posStr = '全部楼层';
        else if (min != null && max != null) posStr = `第${min}-${max}新`;
        else if (max != null) posStr = `最新${max}楼内`;
        else posStr = `第${min}新及更早`;
        const mode = rule.mode === 'remove' ? 'remove' : 'keep';
        const ctrlStyle = 'font-size:0.8em; padding:2px 4px !important; flex:0 0 auto;';
        // All fields are now inline-editable (change = validate + save). The row
        // wraps: role / posMin / posMax / mode controls, then the regex input, then
        // the remove button. posMin/posMax empty = 不限.
        html += `
            <div class="wizard-shiji-rule-row" style="flex-wrap:wrap;">
                <select class="wizard-select wizard-shiji-rule-role-edit" data-index="${i}" title="作用角色" style="${ctrlStyle} color:${roleColor(rule.role)}; font-weight:600;">
                    <option value="ai" ${rule.role === 'ai' ? 'selected' : ''}>AI</option>
                    <option value="user" ${rule.role === 'user' ? 'selected' : ''}>User</option>
                    <option value="both" ${(rule.role !== 'ai' && rule.role !== 'user') ? 'selected' : ''}>两者</option>
                </select>
                <span style="color:#6b7280; flex:0 0 auto; font-size:0.78em;">第</span>
                <input type="number" min="1" class="wizard-input wizard-shiji-rule-posmin-edit" data-index="${i}" value="${min == null ? '' : min}" placeholder="不限" title="起始位（从最新倒数，最新=1；空=不限）" style="${ctrlStyle} width:56px;">
                <span style="color:#6b7280; flex:0 0 auto; font-size:0.78em;">-</span>
                <input type="number" min="1" class="wizard-input wizard-shiji-rule-posmax-edit" data-index="${i}" value="${max == null ? '' : max}" placeholder="不限" title="结束位（从最新倒数；空=不限）" style="${ctrlStyle} width:56px;">
                <span style="color:#6b7280; flex:0 0 auto; font-size:0.78em;">新</span>
                <select class="wizard-select wizard-shiji-rule-mode-edit" data-index="${i}" title="匹配模式" style="${ctrlStyle} color:${mode === 'remove' ? '#f87171' : '#34d399'};">
                    <option value="keep" ${mode === 'keep' ? 'selected' : ''}>只保留匹配</option>
                    <option value="remove" ${mode === 'remove' ? 'selected' : ''}>移除匹配</option>
                </select>
                <input type="text" class="wizard-input wizard-shiji-rule-edit" data-index="${i}" value="${escapeHtml(rule.regex)}" title="直接编辑此 regex（失焦保存）" style="flex:1 1 120px; min-width:0; font-family:monospace; font-size:0.85em; padding:2px 6px !important; color:#d1d5db;">
                <i class="fa-solid fa-xmark wizard-shiji-rule-remove" data-index="${i}" style="cursor:pointer; color:#f87171; flex:0 0 auto; padding:2px 4px;" title="移除此规则"></i>
            </div>`;
    });
    wrap.html(html);
}

// Render the 融合前正则 (recap pre-regex) rule rows into #wizard-recap-pre-regex-rules.
// Mirrors the 时记 rules editor: per-row role + position window + mode + regex + remove.
// All fields are inline-editable (change = validate + save).
function renderRecapPreRegexRules() {
    const wrap = $('#wizard-recap-pre-regex-rules');
    if (wrap.length === 0) return;
    const rules = Array.isArray(config.recapPreRegexRules) ? config.recapPreRegexRules : [];
    if (rules.length === 0) {
        wrap.html('<span style="color:#6b7280; font-size:0.82em;">（暂无规则，发给融合模型完整楼层正文。）</span>');
        return;
    }
    const roleColor = (r) => r === 'ai' ? '#f472b6' : (r === 'user' ? '#60a5fa' : '#a78bfa');
    const ctrlStyle = 'font-size:0.8em; padding:2px 4px !important; flex:0 0 auto;';
    let html = '';
    rules.forEach((rule, i) => {
        const min = (rule.posMin == null || rule.posMin === '') ? null : rule.posMin;
        const max = (rule.posMax == null || rule.posMax === '') ? null : rule.posMax;
        const mode = rule.mode === 'remove' ? 'remove' : 'keep';
        html += `
            <div class="wizard-recap-rule-row" style="display:flex; gap:6px; align-items:center; flex-wrap:wrap;">
                <select class="wizard-select wizard-recap-rule-role-edit" data-index="${i}" title="作用角色" style="${ctrlStyle} color:${roleColor(rule.role)}; font-weight:600;">
                    <option value="ai" ${rule.role === 'ai' ? 'selected' : ''}>AI</option>
                    <option value="user" ${rule.role === 'user' ? 'selected' : ''}>User</option>
                    <option value="both" ${(rule.role !== 'ai' && rule.role !== 'user') ? 'selected' : ''}>两者</option>
                </select>
                <span style="color:#6b7280; flex:0 0 auto; font-size:0.78em;">第</span>
                <input type="number" min="1" class="wizard-input wizard-recap-rule-posmin-edit" data-index="${i}" value="${min == null ? '' : min}" placeholder="不限" title="起始位（从最新倒数，最新=1；空=不限）" style="${ctrlStyle} width:56px;">
                <span style="color:#6b7280; flex:0 0 auto; font-size:0.78em;">-</span>
                <input type="number" min="1" class="wizard-input wizard-recap-rule-posmax-edit" data-index="${i}" value="${max == null ? '' : max}" placeholder="不限" title="结束位（从最新倒数；空=不限）" style="${ctrlStyle} width:56px;">
                <span style="color:#6b7280; flex:0 0 auto; font-size:0.78em;">新</span>
                <select class="wizard-select wizard-recap-rule-mode-edit" data-index="${i}" title="匹配模式" style="${ctrlStyle} color:${mode === 'remove' ? '#f87171' : '#34d399'};">
                    <option value="keep" ${mode === 'keep' ? 'selected' : ''}>只保留匹配</option>
                    <option value="remove" ${mode === 'remove' ? 'selected' : ''}>移除匹配</option>
                </select>
                <input type="text" class="wizard-input wizard-recap-rule-edit" data-index="${i}" value="${escapeHtml(rule.regex)}" title="直接编辑此 regex（失焦保存）" style="flex:1 1 160px; min-width:0; font-family:monospace; font-size:0.85em; padding:2px 6px !important; color:#d1d5db;">
                <i class="fa-solid fa-xmark wizard-recap-rule-remove" data-index="${i}" style="cursor:pointer; color:#f87171; flex:0 0 auto; padding:2px 4px;" title="移除此规则"></i>
            </div>`;
    });
    wrap.html(html);
}

// Write the current editor row values back into config.recapPreRegexRules.
function commitRecapPreRegexRules() {
    if (!Array.isArray(config.recapPreRegexRules)) config.recapPreRegexRules = [];
    const rows = $('#wizard-recap-pre-regex-rules .wizard-recap-rule-row');
    const next = [];
    rows.each(function () {
        const $row = $(this);
        const regex = ($row.find('.wizard-recap-rule-edit').val() || '').trim();
        if (!regex) return;
        const mode = $row.find('.wizard-recap-rule-mode-edit').val() === 'remove' ? 'remove' : 'keep';
        const roleRaw = $row.find('.wizard-recap-rule-role-edit').val() || 'both';
        const role = (roleRaw === 'ai' || roleRaw === 'user') ? roleRaw : 'both';
        const minRaw = ($row.find('.wizard-recap-rule-posmin-edit').val() || '').trim();
        const maxRaw = ($row.find('.wizard-recap-rule-posmax-edit').val() || '').trim();
        const posMin = minRaw === '' ? null : Math.max(1, parseInt(minRaw));
        const posMax = maxRaw === '' ? null : Math.max(1, parseInt(maxRaw));
        next.push({ regex, posMin, posMax, role, mode });
    });
    config.recapPreRegexRules = next;
    // Clear the legacy single-pattern field so the rule list is the single source.
    config.recapPreRegex = '';
}

// Compile the fusion memory block: takes the user-defined fusion template and
// substitutes the inner sub-macros ({{memory_historical}}, {{memory_weekly}},
// {{memory_daily}}, {{memory_tree_header}}, {{memory_tree}}) with live content.
// Free-form text in the template (cache markers, captions, etc.) is preserved.
// omitShiji=true：把 {{memory_hourly}}（时记）宏置空。用于伪造聊天历史模式——
// 那里时记已由 injectMemoryAsHistory 逐楼注入成独立对话轮次，若模板里还含时记宏
// 会导致时记在这一整段 system 里重复出现，所以置空避免双重注入。
function compileFusionMemory(omitShiji = false, omitLayeredSummaries = false) {
    let template = config.fusionTemplate;
    if (template === undefined || template === null) {
        template = `{{${config.macroHistorical || 'memory_historical'}}}\n\n{{${config.macroTreeHeader || 'memory_tree_header'}}}`;
    }

    // Archived summary items are excluded from injection. Each record carries its
    // 【名字 | RP时间 | 现实时间】 header via formatRecordForInject.
    const activeText = (arr) => (arr || []).filter(x => !sumIsArchived(x)).map(formatRecordForInject);
    const historicalVal = omitLayeredSummaries ? '' : activeText(summaries.historicalSummaries).join('\n\n');
    const weeklyVal = omitLayeredSummaries ? '' : activeText(summaries.weeklySummaries).join('\n\n');
    const recapVal = omitLayeredSummaries ? '' : activeText(summaries.recaps).join('\n');
    const treeHeaderVal = compileMemoryTreeNames();
    const treeVal = compileMemoryTreeMacroValue();
    const shijiVal = omitShiji ? "" : compileShiji();

    // Map of macro-name -> resolved value. Include both the configurable names
    // and the canonical default names so a custom template keeps working
    // regardless of which the user typed.
    const substitutions = {
        [config.macroHistorical || 'memory_historical']: historicalVal,
        'memory_historical': historicalVal,
        [config.macroWeekly || 'memory_weekly']: weeklyVal,
        'memory_weekly': weeklyVal,
        [config.macroRecap || 'memory_daily']: recapVal,
        'memory_daily': recapVal,
        [config.macroTreeHeader || 'memory_tree_header']: treeHeaderVal,
        'memory_tree_header': treeHeaderVal,
        [config.macroShiji || 'memory_hourly']: shijiVal,
        'memory_hourly': shijiVal,
        [config.macroMemory || 'memory_tree']: treeVal,
        'memory_tree': treeVal,
    };

    let result = template;
    for (const [name, value] of Object.entries(substitutions)) {
        const re = new RegExp(`\\{\\{\\s*${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\}\\}`, 'g');
        result = result.replace(re, value);
    }
    return result;
}

// Format a single node into the unified "path + content fused" form used by
// {{memory_tree}}. Path name and body are merged into one block, e.g.:
//   【知识/分析哲学/摹状词理论】
//   罗素的摹状词理论认为……
// No "=== Pinned ===" headers, no "Path:/Content:" labels, and never the tree
// index — just path-titled bodies, fused.
function formatNodeUnified(node) {
    const body = (node.content || "").trim();
    if (!body) return "";
    return `【${node.path}】\n${body}`;
}

// 开关版节点格式化：按 config.mtInclude* 决定是否输出【path】/hint/正文。
// 仅当节点有正文时才产出块（无正文的节点一律跳过，避免出现只有【path】的空块）。
// 全关 → 返回 ""，使 {{memory_tree}} 能被「空着」。
function formatNodeUnifiedSwitched(node) {
    const body = (node.content || "").trim();
    if (!body) return "";
    const lines = [];
    if (config.mtIncludePath) lines.push(`【${node.path}】`);
    if (config.mtIncludeHint) {
        const h = (node.hint || '').trim();
        if (h) lines.push(h);
    }
    lines.push(body);
    return lines.join('\n');
}

// Direct {{memory_tree}} fallback: when routing hasn't run this turn (e.g. the
// macro is called standalone), produce the COMPLETE unified view — every
// pinned and non-archived node that has content — so the output is never the
// "only pinned" stub. Counted against TOKEN_CAP so it can't blow up the prompt.
function compileCurrentMemoryBasic() {
    const allTreeNodes = getAllNodes(memoryTree);
    // pin_only 模式：只取钉死节点；默认('all')：pinned 优先，再补其余节点
    const ordered = config.treeInjectionMode === 'pin_only'
        ? allTreeNodes.filter(n => n.pinned && !n.archived)
        : [
            ...allTreeNodes.filter(n => n.pinned && !n.archived),
            ...allTreeNodes.filter(n => !n.pinned && !n.archived),
          ];

    const blocks = [];
    let tokenCount = 0;
    const cap = config.TOKEN_CAP || 8000;
    for (const node of ordered) {
        const block = formatNodeUnified(node);
        if (!block) continue;
        const tokens = estimateTokens(block);
        if (tokenCount + tokens > cap) break;
        blocks.push(block);
        tokenCount += tokens;
    }

    return blocks.join('\n\n') || "无";
}

// ══════════════════════════════════════════════════════════════════════
// REGION: 宏注册（向 ST 注册全部记忆宏 + slash 命令）
// ══════════════════════════════════════════════════════════════════════
function registerCustomMacros() {
    const context = window.SillyTavern?.getContext();
    if (!context) return;
    
    const registerMacroFn = context.registerMacro;
    const unregisterMacroFn = context.unregisterMacro;
    const SlashCommandParser = context.SlashCommandParser;
    const SlashCommand = context.SlashCommand;

    // Helper to unregister old slash commands and window properties
    if (SlashCommandParser && SlashCommandParser.commands) {
        if (registeredMacroMemory && registeredMacroMemory !== config.macroMemory) {
            delete SlashCommandParser.commands[registeredMacroMemory];
            try { delete window[registeredMacroMemory]; } catch (e) {}
        }
        if (registeredMacroTreeHeader && registeredMacroTreeHeader !== config.macroTreeHeader) {
            delete SlashCommandParser.commands[registeredMacroTreeHeader];
            try { delete window[registeredMacroTreeHeader]; } catch (e) {}
        }
        if (registeredMacroHistorical && registeredMacroHistorical !== config.macroHistorical) {
            delete SlashCommandParser.commands[registeredMacroHistorical];
            try { delete window[registeredMacroHistorical]; } catch (e) {}
        }
        if (registeredMacroWeekly && registeredMacroWeekly !== config.macroWeekly) {
            delete SlashCommandParser.commands[registeredMacroWeekly];
            try { delete window[registeredMacroWeekly]; } catch (e) {}
        }
        if (registeredMacroRecap && registeredMacroRecap !== config.macroRecap) {
            delete SlashCommandParser.commands[registeredMacroRecap];
            try { delete window[registeredMacroRecap]; } catch (e) {}
        }
        if (registeredMacroShiji && registeredMacroShiji !== config.macroShiji) {
            delete SlashCommandParser.commands[registeredMacroShiji];
            try { delete window[registeredMacroShiji]; } catch (e) {}
        }
        if (registeredMacroFusion && registeredMacroFusion !== config.macroFusion) {
            delete SlashCommandParser.commands[registeredMacroFusion];
            try { delete window[registeredMacroFusion]; } catch (e) {}
        }
    }

    if (unregisterMacroFn) {
        // Unregister old ones
        if (registeredMacroMemory && registeredMacroMemory !== config.macroMemory) {
            try { unregisterMacroFn(registeredMacroMemory); } catch (e) {}
        }
        if (registeredMacroTreeHeader && registeredMacroTreeHeader !== config.macroTreeHeader) {
            try { unregisterMacroFn(registeredMacroTreeHeader); } catch (e) {}
        }
        if (registeredMacroHistorical && registeredMacroHistorical !== config.macroHistorical) {
            try { unregisterMacroFn(registeredMacroHistorical); } catch (e) {}
        }
        if (registeredMacroWeekly && registeredMacroWeekly !== config.macroWeekly) {
            try { unregisterMacroFn(registeredMacroWeekly); } catch (e) {}
        }
        if (registeredMacroRecap && registeredMacroRecap !== config.macroRecap) {
            try { unregisterMacroFn(registeredMacroRecap); } catch (e) {}
        }
        if (registeredMacroShiji && registeredMacroShiji !== config.macroShiji) {
            try { unregisterMacroFn(registeredMacroShiji); } catch (e) {}
        }
        if (registeredMacroFusion && registeredMacroFusion !== config.macroFusion) {
            try { unregisterMacroFn(registeredMacroFusion); } catch (e) {}
        }
    }

    // Register new ones
    if (config.macroMemory) {
        try {
            // compileMemoryTreeMacroValue composes {{memory_tree}} from the mtInclude* switches
            // (path/hint/pin正文/路由召回正文/全部正文). Routing may still run independently.
            const getMemoryVal = () => compileMemoryTreeMacroValue();
            if (registerMacroFn) {
                registerMacroFn(config.macroMemory, getMemoryVal, 'Memory Wizard: 记忆树召回及摘要');
            }
            if (SlashCommand && SlashCommandParser) {
                SlashCommandParser.addCommandObject(SlashCommand.fromProps({
                    name: config.macroMemory,
                    helpString: '获取记忆树召回及摘要',
                    callback: getMemoryVal,
                    returns: context.ARGUMENT_TYPE?.STRING
                }));
            }
            window[config.macroMemory] = getMemoryVal;
            registeredMacroMemory = config.macroMemory;
        } catch (e) {
            console.error(`${LOG_PREFIX} Failed to register macro/function: ${config.macroMemory}`, e);
        }
    }
    // Register memory_tree_header macro (configurable name)
    if (config.macroTreeHeader) {
        try {
            if (registerMacroFn) {
                registerMacroFn(config.macroTreeHeader, compileMemoryTreeNames, 'Memory Wizard: 记忆树路由索引路径列表');
            }
            if (SlashCommand && SlashCommandParser) {
                if (SlashCommandParser.commands[config.macroTreeHeader]) {
                    delete SlashCommandParser.commands[config.macroTreeHeader];
                }
                SlashCommandParser.addCommandObject(SlashCommand.fromProps({
                    name: config.macroTreeHeader,
                    helpString: '获取记忆树路由索引路径列表',
                    callback: compileMemoryTreeNames,
                    returns: context.ARGUMENT_TYPE?.STRING
                }));
            }
            window[config.macroTreeHeader] = compileMemoryTreeNames;
            registeredMacroTreeHeader = config.macroTreeHeader;
        } catch (e) {
            console.error(`${LOG_PREFIX} Failed to register macro/function: ${config.macroTreeHeader}`, e);
        }
    }
    if (config.macroHistorical) {
        try {
            if (registerMacroFn) {
                registerMacroFn(config.macroHistorical, compileHistoricalText, 'Memory Wizard: 史记分层摘要');
            }
            if (SlashCommand && SlashCommandParser) {
                SlashCommandParser.addCommandObject(SlashCommand.fromProps({
                    name: config.macroHistorical,
                    helpString: '获取史记分层摘要',
                    callback: compileHistoricalText,
                    returns: context.ARGUMENT_TYPE?.STRING
                }));
            }
            window[config.macroHistorical] = compileHistoricalText;
            registeredMacroHistorical = config.macroHistorical;
        } catch (e) {
            console.error(`${LOG_PREFIX} Failed to register macro/function: ${config.macroHistorical}`, e);
        }
    }
    if (config.macroWeekly) {
        try {
            if (registerMacroFn) {
                registerMacroFn(config.macroWeekly, compileWeeklyText, 'Memory Wizard: 周记分层摘要');
            }
            if (SlashCommand && SlashCommandParser) {
                SlashCommandParser.addCommandObject(SlashCommand.fromProps({
                    name: config.macroWeekly,
                    helpString: '获取周记分层摘要',
                    callback: compileWeeklyText,
                    returns: context.ARGUMENT_TYPE?.STRING
                }));
            }
            window[config.macroWeekly] = compileWeeklyText;
            registeredMacroWeekly = config.macroWeekly;
        } catch (e) {
            console.error(`${LOG_PREFIX} Failed to register macro/function: ${config.macroWeekly}`, e);
        }
    }
    if (config.macroRecap) {
        try {
            if (registerMacroFn) {
                registerMacroFn(config.macroRecap, compileRecapText, 'Memory Wizard: 日记摘要');
            }
            if (SlashCommand && SlashCommandParser) {
                SlashCommandParser.addCommandObject(SlashCommand.fromProps({
                    name: config.macroRecap,
                    helpString: '获取日记摘要',
                    callback: compileRecapText,
                    returns: context.ARGUMENT_TYPE?.STRING
                }));
            }
            window[config.macroRecap] = compileRecapText;
            registeredMacroRecap = config.macroRecap;
        } catch (e) {
            console.error(`${LOG_PREFIX} Failed to register macro/function: ${config.macroRecap}`, e);
        }
    }
    // Register 时记 macro (configurable name, default {{memory_hourly}}): the last
    // N_SHIJI messages of the active chat, counted backwards from the latest.
    if (config.macroShiji) {
        try {
            if (registerMacroFn) {
                registerMacroFn(config.macroShiji, compileShiji, 'Memory Wizard: 时记 (最新若干条消息倒序)');
            }
            if (SlashCommand && SlashCommandParser) {
                if (SlashCommandParser.commands[config.macroShiji]) {
                    delete SlashCommandParser.commands[config.macroShiji];
                }
                SlashCommandParser.addCommandObject(SlashCommand.fromProps({
                    name: config.macroShiji,
                    helpString: '获取时记 (最新往前数 N_SHIJI 条消息)',
                    callback: compileShiji,
                    returns: context.ARGUMENT_TYPE?.STRING
                }));
            }
            window[config.macroShiji] = compileShiji;
            registeredMacroShiji = config.macroShiji;
        } catch (e) {
            console.error(`${LOG_PREFIX} Failed to register macro/function: ${config.macroShiji}`, e);
        }
    }
    // Register fusion memory macro (configurable name, default {{memory}})
    if (config.macroFusion) {
        try {
            if (registerMacroFn) {
                // 关键时序：ST 在 preparePrompt（PromptManager.js:1277）阶段就用 substituteParams
                // 把 preset 里的 {{memory}} 展开掉了——远早于本插件的 CHAT_COMPLETION_PROMPT_READY。
                // 所以「是否省略时记」必须在「这里」就决定，不能留到 prompt-ready 再判。
                //   • 伪造历史开：时记由 injectMemoryAsHistory 逐楼注入 → 这里 omitShiji=true，
                //     {{memory}} 只出史记/周记/日记，避免时记被注入两遍。
                //   • 伪造历史关：无逐楼注入 → omitShiji=false，{{memory}} 含时记（传统行为）。
                // 包一层箭头函数，忽略宏引擎传入的任何参数，只读 config.fakeChatHistory。
                registerMacroFn(config.macroFusion, () => compileFusionMemory(!!config.fakeChatHistory, !!(config.fakeChatHistory && config.fakeChatHistoryIncludeSummaries)), 'Memory Wizard: 融合记忆 (伪造历史开时省略时记；分层摘要合并开时也省略史记/周记/日记)');
            }
            if (SlashCommand && SlashCommandParser) {
                if (SlashCommandParser.commands[config.macroFusion]) {
                    delete SlashCommandParser.commands[config.macroFusion];
                }
                SlashCommandParser.addCommandObject(SlashCommand.fromProps({
                    name: config.macroFusion,
                    helpString: '获取融合记忆 (按模板拼合所有分层摘要与记忆树索引)',
                    callback: compileFusionMemory,
                    returns: context.ARGUMENT_TYPE?.STRING
                }));
            }
            window[config.macroFusion] = compileFusionMemory;
            registeredMacroFusion = config.macroFusion;
        } catch (e) {
            console.error(`${LOG_PREFIX} Failed to register macro/function: ${config.macroFusion}`, e);
        }
    }
    // Register the {{history}} macro: the full matched context window from the
    // context-fusion browser (filtered + regex-extracted). Fixed name 'history'.
    try {
        if (registerMacroFn) {
            registerMacroFn('history', compileHistory, 'Memory Wizard: 上下文融合-匹配到的完整上下文窗口');
        }
        if (SlashCommand && SlashCommandParser) {
            if (SlashCommandParser.commands['history']) {
                delete SlashCommandParser.commands['history'];
            }
            SlashCommandParser.addCommandObject(SlashCommand.fromProps({
                name: 'history',
                helpString: '获取上下文融合中按当前匹配条件筛选到的完整上下文',
                callback: compileHistory,
                returns: context.ARGUMENT_TYPE?.STRING
            }));
        }
        window['history_memory'] = compileHistory; // avoid clobbering window.history
    } catch (e) {
        console.error(`${LOG_PREFIX} Failed to register macro/function: history`, e);
    }

    // Register the {{records}} macro: ALL existing (non-archived) layered summaries
    // — 史记 / 周记 / 日记 — compiled into one labeled "已有记忆" block. Fixed name
    // 'records'. Used as prior-context so generation knows what is already summarized.
    try {
        if (registerMacroFn) {
            registerMacroFn('records', compileAllRecords, 'Memory Wizard: 已有的分层摘要 (史记/周记/日记)');
        }
        if (SlashCommand && SlashCommandParser) {
            if (SlashCommandParser.commands['records']) {
                delete SlashCommandParser.commands['records'];
            }
            SlashCommandParser.addCommandObject(SlashCommand.fromProps({
                name: 'records',
                helpString: '获取已有的全部分层摘要（史记/周记/日记）',
                callback: compileAllRecords,
                returns: context.ARGUMENT_TYPE?.STRING
            }));
        }
        window['records_memory'] = compileAllRecords;
    } catch (e) {
        console.error(`${LOG_PREFIX} Failed to register macro/function: records`, e);
    }
}

// Load configurations & connection profiles
// True while loadConfig() is populating the UI. Any change.* listener that fires
// during this window (e.g. the fusion-source change trigger) must NOT call back into
// saveConfig — otherwise it persists a half-filled form and wipes real settings.
// ══════════════════════════════════════════════════════════════════════
// REGION: 配置 load / save（UI 控件 ↔ config 双向绑定 + 旧字段迁移）
// ══════════════════════════════════════════════════════════════════════
let wizardLoadingConfig = false;

// ── 世界书面板（World Book）顶层状态与内置默认 Prompt ──
// 放在顶层作用域，使 loadConfig/saveConfig（顶层函数）与 WB 事件处理函数
// （registerNodeFormListeners 内的嵌套函数）都能访问。
const DEFAULT_WB_PROMPT_REDUCE = `你是世界书条目精简器。请精简下方条目的正文，保留核心设定/事实，删除冗余、重复与不必要细节，不编造新事实。
条目标题: {{entry_title}}
触发关键词: {{entry_keys}}
当前正文:
{{entry_content}}
只输出精简后的新正文，不要解释、不要 markdown、不要 JSON。`;

const DEFAULT_WB_PROMPT_COMPLETE = `你是世界书条目补全器。请根据下方条目现有正文与上下文，补全/扩写缺失的设定细节，使其更完整、更自洽，不与已有事实矛盾、不编造与角色卡冲突的设定。
条目标题: {{entry_title}}
触发关键词: {{entry_keys}}
当前正文:
{{entry_content}}
只输出补全后的新正文，不要解释、不要 markdown、不要 JSON。`;

const DEFAULT_WB_PROMPT_REWRITE = `你是世界书条目重构器。请用更高级、更细腻、更具文学性的方式重写下方条目的正文，保留全部核心事实与设定不变，提升表达质感与可读性，不编造新事实。
条目标题: {{entry_title}}
触发关键词: {{entry_keys}}
当前正文:
{{entry_content}}
只输出重构后的新正文，不要解释、不要 markdown、不要 JSON。`;

const DEFAULT_WB_PROMPT_MULTI = `请整理下方世界书：合并重复/相似的条目、补充明显缺失的设定细节、删除冗余或矛盾条目，使世界书更精炼自洽，不编造与角色卡冲突的事实。

当前世界书（含正文）:
{{world_book_full}}

只输出可由插件执行的 JSON 操作数组，不要 markdown，不要解释，不要代码块。每个元素一条操作：
[
  {"op":"update","uid":0,"fields":{"content":"新正文","comment":"可选新标题","key":["关键词"]}},
  {"op":"add","fields":{"comment":"新条目标题","content":"新正文","key":["触发词"],"constant":false,"selective":true,"order":100,"position":0,"disable":false}},
  {"op":"delete","uid":1},
  {"op":"merge","sourceUid":2,"targetUid":3}
]
操作规则：
- update：修改已有条目。uid 必须存在。fields 里只放需要改的字段（content/comment/key/keysecondary/constant/selective/order/position/disable 等），未列出的字段保留原值。
- add：新增条目。必须有 comment 与 content；key 默认 []、constant 默认 false、selective 默认 true、order 默认 100、position 默认 0、disable 默认 false。
- delete：删除已有条目。uid 必须存在。
- merge：把 sourceUid 条目并入 targetUid 条目（正文拼接、关键词合并），然后删除 sourceUid。两者必须都存在且不同。
- 仅输出确实需要的操作；未授权的操作会被插件丢弃，不要输出。`;

const WB_SINGLE_SYSTEM_PROMPT = `你是世界书条目编辑器。根据用户指令与给定的条目内容，输出该条目修改后的结果。
输出规则：
- 默认只输出修改后的新正文（纯文本，不要 markdown、不要解释、不要 JSON）。
- 若需要同时修改标题/关键词等字段，可输出一个 JSON 对象，如 {"content":"新正文","comment":"新标题","key":["词1","词2"]}，插件会据此合并字段。
- 不要编造用户没有给出的事实；保留核心设定。`;

const WB_MULTI_SYSTEM_PROMPT = `你是世界书整理器。只输出 JSON 操作数组，不要 markdown、不要解释、不要代码块。严格按用户指令与授权开关操作；未授权的操作不要输出。`;

const WB_OP_FIELDS = ['content','comment','key','keysecondary','constant','selective','selectiveLogic','order','position','disable','vectorized','addMemo','probability','useProbability','depth','role','group','groupWeight','groupOverride','sticky','cooldown','delay','triggers','automationId','preventRecursion','excludeRecursion','delayUntilRecursion','matchPersonaDescription','matchCharacterDescription','matchCharacterPersonality','matchCharacterDepthPrompt','matchScenario','matchCreatorNotes','scanDepth','caseSensitive','matchWholeWords','useGroupScoring','ignoreBudget'];

let wbCache = null;            // { name, data, ts }
let wbSelectedBook = "";       // 当前选择的世界书名
let wbSelectedUid = null;      // 单条模式当前目标 uid
let wbMultiSelectedUids = new Set(); // 多条模式勾选的 uid
let wbLastSnapshot = null;     // { name, data } 应用前快照，用于一键撤回
let wbAbortController = null;  // AI 请求中止器
let wbStreamMode = 'single';   // 当前流式输出归属：'single' | 'multi'
let wbPendingOps = new Map();  // multi 模式待确认操作：key -> op
let wbLastSingleMode = 'reduce'; // 单条模式当前预设
let wbOverflowObserver = null; // 世界书面板溢出监听器
let _wbTokenSeq = 0;           // token 统计序号，防过期覆盖

async function loadConfig() {
    wizardLoadingConfig = true;
    try {
        // Fetch config from backend
        try {
            const res = await fetch('/api/plugins/st-memory-wizzard/get-config', {
                method: 'POST',
                headers: getWizardHeaders(),
                body: JSON.stringify({})
            });
            if (res.ok) {
                const serverConfig = await res.json();
                config = { ...config, ...serverConfig };
                // 迁移旧的二档 treeInjectionMode → 新的 mtInclude* 开关。
                // 判据：存档里没有新的 mtInclude* 字段（说明是旧版本保存的配置）。
                // 'all' 默认值已对齐（mtIncludeRoutedBody=true, mtIncludeAllBody=false）；
                // 'pin_only' 用户：把路由召回正文关掉，使其只出 pin 正文，复刻旧行为。
                if (serverConfig.mtIncludeRoutedBody === undefined && config.treeInjectionMode === 'pin_only') {
                    config.mtIncludeRoutedBody = false;
                }
            }
        } catch (e) {
            console.error(`${LOG_PREFIX} Failed to fetch config from server`, e);
        }

        // Load profiles into settings dropdowns. Each task has its own selector;
        // legacy fable/flash IDs are no longer in the DOM (kept in config only as
        // a back-compat fallback at the call sites — see getProfileFor()).
        const connectionManager = window.SillyTavern?.getContext()?.extensionSettings?.connectionManager;
        const profileSelectorIds = [
            '#wizard-routing-profile',
            '#wizard-tree-fill-profile',
            '#wizard-recap-profile',
            '#wizard-weekly-profile',
            '#wizard-historical-profile',
            '#wizard-fallback-profile',
            '#wizard-fusion-profile',
            '#wizard-ai-shrink-profile',
            '#wizard-scene-teaching-profile',
            '#wizard-scene-plot-profile',
            '#wizard-scene-intimate-profile',
            '#wizard-gateway-profile',
            '#wizard-wb-profile',
            '#wizard-wb-multi-profile',
        ];
        profileSelectorIds.forEach(sel => {
            const $sel = $(sel);
            $sel.empty();
            $sel.append('<option value="">-- 使用当前酒馆配置 (默认) --</option>');
        });

        if (connectionManager && connectionManager.profiles) {
            connectionManager.profiles.forEach(p => {
                profileSelectorIds.forEach(sel => {
                    $(sel).append($('<option></option>').val(p.name).text(p.name));
                });
            });
        }

        // Bind config values to UI input fields
        $('#wizard-routing-profile').val(config.routingProfile || "");
        $('#wizard-routing-keywords').val(config.routingKeywords || "");
        // Scene-based main-reply profile switch.
        $('#wizard-scene-switch-enabled').prop('checked', config.sceneSwitchEnabled === true);
        $('#wizard-scene-teaching-profile').val(config.sceneTeachingProfile || "");
        $('#wizard-scene-plot-profile').val(config.scenePlotProfile || "");
        $('#wizard-scene-intimate-profile').val(config.sceneIntimateProfile || "");
        $('#wizard-gateway-profile').val(config.gatewayProfile || "");
        $('#wizard-prompt-scene-select').val(config.promptSceneSelect || DEFAULT_SCENE_SELECT_PROMPT);
        // UI switch removed — record tag is always enabled.
        $('#wizard-record-tag-name').val(config.recordTagName || "record");
        $('#wizard-recall-tag-name').val(config.recallTagName || "recall");
        // Pre-fill with the real built-in defaults when the user hasn't customized
        // them, so the boxes are never blank and can be edited in place. Saving the
        // unchanged default text behaves identically to leaving it empty (the call
        // sites fall back to the same constants).
        $('#wizard-prompt-routing').val(config.promptRouting || DEFAULT_ROUTING_PROMPT);
        $('#wizard-prompt-recall').val(config.promptRecall || DEFAULT_RECALL_TEMPLATE);
        $('#wizard-prompt-treefill').val(config.promptTreeFill || DEFAULT_TREEFILL_PROMPT);
        $('#wizard-prompt-record-fill').val(config.promptRecordFill || DEFAULT_RECORDFILL_PROMPT);
        $('#wizard-prompt-treefill-method').val(config.promptTreeFillMethod || DEFAULT_TREEFILL_METHOD);
        $('#wizard-tree-fill-profile').val(config.treeFillProfile || "");
        $('#wizard-recap-profile').val(config.recapProfile || "");
        $('#wizard-weekly-profile').val(config.weeklyProfile || "");
        $('#wizard-historical-profile').val(config.historicalProfile || "");
        $('#wizard-fallback-profile').val(config.fallbackProfile || "");
        $('#wizard-fusion-profile').val(config.fusionProfile !== undefined ? config.fusionProfile : "");
        // Restore sticky fusion-panel settings, then sync the source-dependent
        // visibility (floors-only vs records-only) via a change trigger.
        $('#wizard-fusion-source').val(config.fusionSource || "floors");
        $('#wizard-fusion-type').val(config.fusionType || "historical");
        $('#wizard-fusion-record-from').val(config.fusionRecordFrom || "weekly");
        // 勾选态由 renderRecordPicker 在 summaries 加载后重渲染；此处仅作配置回填（容错）
        if (config.fusionRecordPicks && typeof config.fusionRecordPicks === 'object') {
            // shallow copy for safe mutation by renderRecordPicker
        }
        const fusionRange = (config.fusionRangesByChat && activeChatId) ? config.fusionRangesByChat[activeChatId] : null;
        $('#wizard-fusion-start').val(fusionRange?.start ?? config.fusionStart ?? "");
        $('#wizard-fusion-end').val(fusionRange?.end ?? config.fusionEnd ?? "");
        $('#wizard-fusion-source').trigger('change');
        $('#wizard-n-recap').val(config.N_RECAP);
        $('#wizard-direct-weekly-min').val(config.directWeeklyMin || 0);
        $('#wizard-direct-historical-min').val(config.directHistoricalMin || 0);
        $('#wizard-n-treefill').val(config.N_TREEFILL ?? config.N_RECAP ?? 10);
        $('#wizard-morning-recap-enable').prop('checked', !!config.enableMorningRecap);
        $('#wizard-morning-gap-minutes').val(config.morningGapMinutes ?? 360);
        $('#wizard-morning-window-start').val(config.morningWindowStart || "05:00");
        $('#wizard-morning-window-end').val(config.morningWindowEnd || "10:00");
        $('#wizard-morning-min-floors').val(config.morningMinFloors ?? 1);
        $('#wizard-morning-max-floors').val(config.morningMaxFloors ?? 50);
        $('#wizard-sum-default-realtime').attr('data-active', config.summaryDefaultShowRealTime ? 'true' : 'false');
        // These inputs now represent record-count fusion thresholds.
        $('#wizard-n-merge').val(config.RECAP_TO_WEEKLY !== undefined ? config.RECAP_TO_WEEKLY : 10);
        $('#wizard-n-melon').val(config.WEEKLY_TO_HISTORICAL !== undefined ? config.WEEKLY_TO_HISTORICAL : 5);
        $('#wizard-recap-keep-latest').val(Math.max(0, parseInt(config.recapKeepLatest) || 0));
        $('#wizard-weekly-keep-latest').val(Math.max(0, parseInt(config.weeklyKeepLatest) || 0));
        renderKeepLatestToggle();
        $('#wizard-n-shiji').val(config.N_SHIJI);
        $('#wizard-k-recall').val(config.K_RECALL);
        $('#wizard-token-cap').val(config.TOKEN_CAP);
        $('#wizard-pin-budget').val(config.PIN_BUDGET);
        // {{memory_tree}} / {{memory_tree_header}} 注入内容开关
        $('#wizard-mt-path').prop('checked', !!config.mtIncludePath);
        $('#wizard-mt-hint').prop('checked', !!config.mtIncludeHint);
        $('#wizard-mt-pin').prop('checked', !!config.mtIncludePinBody);
        $('#wizard-mt-routed').prop('checked', !!config.mtIncludeRoutedBody);
        $('#wizard-mt-all').prop('checked', !!config.mtIncludeAllBody);
        $('#wizard-mt-keyword-trigger').prop('checked', !!config.mtKeywordTrigger);
        $('#wizard-mth-path').prop('checked', !!config.mthIncludePath);
        $('#wizard-mth-hint').prop('checked', !!config.mthIncludeHint);
        $('#wizard-mth-max-depth').val(config.mthMaxDepth || 0);
        $('#wizard-mth-max-children').val(config.mthMaxChildren || 0);
        $('#wizard-timeout-ms').val(config.TIMEOUT_MS);
        $('#wizard-supp-read').val(config.SUPP_READ);

        $('#wizard-macro-memory').val(config.macroMemory || "memory_tree");
        $('#wizard-macro-tree-header').val(config.macroTreeHeader || "memory_tree_header");
        $('#wizard-macro-historical').val(config.macroHistorical || "memory_historical");
        $('#wizard-macro-weekly').val(config.macroWeekly || "memory_weekly");
        $('#wizard-macro-recap').val(config.macroRecap || "memory_daily");
        $('#wizard-macro-shiji').val(config.macroShiji || "memory_hourly");
        $('#wizard-macro-fusion').val(config.macroFusion || "memory");

        const themeColor = config.uiColor || "#a3842e";
        $('#wizard-ui-color').val(themeColor);
        $('#wizard-ui-color-picker').val(themeColor);

        $('#wizard-ui-width').val(config.uiWidth !== undefined ? config.uiWidth : 90);
        $('#wizard-ui-height').val(config.uiHeight !== undefined ? config.uiHeight : 95);

        $('#wizard-sandbox-page-size').val(config.sandboxPageSize !== undefined ? config.sandboxPageSize : 100);
        $('#wizard-sandbox-regex').val(config.sandboxRegex || '');
        $('#wizard-sandbox-keyword').val(config.sandboxKeyword || '');
        $('#wizard-sandbox-keyword-logic').val(liveKeywordMode());
        $('#wizard-sandbox-match-mode').val(config.sandboxMatchMode || 'keyword');
        if (!$('#wizard-sandbox-match-mode').val()) $('#wizard-sandbox-match-mode').val('keyword');
        $('#wizard-sandbox-match-mode').trigger('change');
        // 时记 multi-rule migration: seed a single 'both' rule from the legacy
        // single regex if no rules exist yet, then bind the mode + rule list UI.
        if (!Array.isArray(config.shijiRules)) config.shijiRules = [];
        if (config.shijiRules.length === 0 && (config.shijiRegex || '').trim()) {
            config.shijiRules = [{ regex: config.shijiRegex.trim(), posMin: null, posMax: null, role: 'both' }];
        }
        // 融合前正则 multi-rule migration: seed from the legacy single-pattern field.
        if (!Array.isArray(config.recapPreRegexRules)) config.recapPreRegexRules = [];
        if (config.recapPreRegexRules.length === 0 && (config.recapPreRegex || '').trim()) {
            config.recapPreRegexRules = [{ regex: config.recapPreRegex.trim(), mode: config.recapPreRegexMode === 'keep' ? 'keep' : 'remove' }];
            config.recapPreRegex = '';
        }
        if (!config.shijiMode) config.shijiMode = 'uncovered';
        $('#wizard-shiji-mode').val(config.shijiMode);
        $('#wizard-shiji-keep-floors').val(parseInt(config.shijiKeepFloors) || 0);
        $('#wizard-shiji-show-floor').prop('checked', !!config.shijiShowFloor);
        // Migrate legacy shijiShowRealDate → shijiShowDateAi + shijiShowDateUser
        if (config.shijiShowRealDate && !config.shijiShowDateAi && !config.shijiShowDateUser) {
            config.shijiShowDateAi = true;
            config.shijiShowDateUser = true;
            config.shijiShowRealDate = false;
        }
        $('#wizard-shiji-show-date-ai').prop('checked', !!config.shijiShowDateAi);
        $('#wizard-shiji-show-date-user').prop('checked', !!config.shijiShowDateUser);
        $('#wizard-shiji-show-model').prop('checked', !!config.shijiShowModel);
        $('#wizard-fake-chat-history').prop('checked', !!config.fakeChatHistory);
        $('#wizard-fake-chat-history-summaries').prop('checked', !!config.fakeChatHistoryIncludeSummaries);
        renderShijiRules();
        $('#wizard-fusion-include-preset').attr('data-active', config.fusionIncludePreset ? 'true' : 'false');

        $('#wizard-anthropic-cache-enabled').prop('checked', !!config.anthropicCacheEnabled);
        $('#wizard-anthropic-cache-scope').val(config.anthropicCacheScope || 'internal');
        $('#wizard-anthropic-cache-provider-mode').val(config.anthropicCacheProviderMode || 'auto');
        $('#wizard-anthropic-cache-ttl').val(config.anthropicCacheTTL || '5m');
        if (!config.anthropicCacheControlJson) config.anthropicCacheControlJson = defaultAnthropicCacheControlJson();
        $('#wizard-anthropic-cache-control-json').val(config.anthropicCacheControlJson);
        updateAnthropicCacheControlPreview();
        $('#wizard-anthropic-cache-main-mode').val(config.anthropicCacheMainMode || 'manual');
        $('#wizard-anthropic-cache-rolling-depths').val(config.anthropicCacheRollingDepths ?? '0,1');
        $('#wizard-skip-rolling-on-recap-turn').prop('checked', config.skipRollingOnRecapTurn !== false);
        $('#wizard-anthropic-cache-depth').val(config.anthropicCacheDepth ?? 4);
        $('#wizard-anthropic-cache-min-chars').val(config.anthropicCacheMinChars ?? 1200);
        $('#wizard-anthropic-cache-debug').prop('checked', !!config.anthropicCacheDebug);
        $('#wizard-anthropic-cache-ai-explain').prop('checked', !!config.anthropicCacheAiExplain);
        $('#wizard-anthropic-cache-test-mode').val(config.anthropicCacheTestMode || 'recommend');

        $('#wizard-ai-shrink-profile').val(config.aiShrinkProfile || "");
        if (!$('#wizard-ai-shrink-prompt').val()) {
            $('#wizard-ai-shrink-prompt').val(config.aiShrinkPrompt || "");
        }

        // 世界书面板：恢复选择/配置到 UI（不触发 change，避免递归保存）。
        $('#wizard-wb-profile').val(config.wbProfile || "");
        $('#wizard-wb-multi-profile').val(config.wbMultiProfile || "");
        $('#wizard-wb-follow-char').prop('checked', config.wbFollowCharBook !== false);
        wbSelectedBook = config.wbSelectedBook || "";
        wbLastSingleMode = config.wbLastSingleMode || 'reduce';
        $('.wizard-wb-preset').removeClass('wizard-wb-preset-active');
        $(`.wizard-wb-preset[data-mode="${wbLastSingleMode}"]`).addClass('wizard-wb-preset-active');
        $('#wizard-wb-allow-change').attr('data-active', String(!!config.wbAllowChangeExisting));
        $('#wizard-wb-allow-add').attr('data-active', String(!!config.wbAllowAddNew));
        $('#wizard-wb-allow-delete-merge').attr('data-active', String(!!config.wbAllowDeleteMerge));
        {
            const m = wbLastSingleMode;
            const def = m === 'reduce' ? DEFAULT_WB_PROMPT_REDUCE : m === 'complete' ? DEFAULT_WB_PROMPT_COMPLETE : DEFAULT_WB_PROMPT_REWRITE;
            const saved = config[`wbPrompt${m.charAt(0).toUpperCase() + m.slice(1)}`] || "";
            $('#wizard-wb-single-prompt').val(saved || def);
        }
        $('#wizard-wb-multi-prompt').val(config.wbPromptMulti || DEFAULT_WB_PROMPT_MULTI);

        // Apply theme, modal size, and custom macros
        applyThemeColor();
        applyModalSize();
        registerCustomMacros();

        // Update fusion type option labels and summaries tab section titles to match user settings
        const fusionTypeSelect = $('#wizard-fusion-type');
        if (fusionTypeSelect.length > 0) {
            fusionTypeSelect.find('option[value="historical"]').text(`史记 (Historical Summary) [${config.N_MELON}条]`);
            fusionTypeSelect.find('option[value="weekly"]').text(`周记 (Weekly Summary) [${config.N_MERGE}条]`);
            fusionTypeSelect.find('option[value="recap"]').text(`日记 (Recap) [${config.N_RECAP}条]`);
        }
        // Section titles are kept up-to-date by updateSummaryProgress() (which also
        // renders the mini progress bar). Preserve data-base-title for renderSummaryList.
        $('#wizard-title-historical').attr('data-base-title', '史记');
        $('#wizard-title-weekly').attr('data-base-title', '周记');
        $('#wizard-title-recap').attr('data-base-title', '日记');

        // Update fusion macro name display
        $('#wizard-fusion-macro-name-display').text(`{{${config.macroFusion || 'memory'}}}`);
        $('#wizard-fusion-template-macro-label').text(`{{${config.macroFusion || 'memory'}}}`);

        // Bind switches (defaults to true if undefined)
        $('#wizard-is-enabled').prop('checked', config.isEnabled !== false);
        $('#wizard-enable-pre-flash').prop('checked', config.enablePreFlash !== false);
        $('#wizard-enable-post-flash').prop('checked', config.enablePostFlash !== false);
        $('#wizard-auto-recap').prop('checked', config.autoRecap !== false);
        $('#wizard-auto-weekly').prop('checked', config.autoWeekly !== false);
        $('#wizard-auto-historical').prop('checked', config.autoHistorical !== false);
        applyMasterToggleState();

        // Update diagnostic hook status indicator
        if (config.isEnabled !== false) {
            $('#wizard-status-hook').html('<span style="color: #10b981;"><i class="fa-solid fa-circle-check"></i> 已挂载 (发消息时自动触发记忆路由)</span>');
        } else {
            $('#wizard-status-hook').html('<span style="color: #f59e0b;"><i class="fa-solid fa-circle-minus"></i> 已禁用 (不进行记忆注入和结构更新)</span>');
        }

        writeLog(`Configuration loaded.`);
    } catch (e) {
        console.error(`${LOG_PREFIX} Failed to load config`, e);
    } finally {
        wizardLoadingConfig = false;
    }
}

// When the master switch is off, visually disable every dependent control so
// the user can see they have no effect. The runtime gates already hard-skip
// everything when config.isEnabled === false — this is a UI affordance only.
// Gated regions: #wizard-sub-toggles (the 5 checkboxes inside 功能运行控制)
// plus anything tagged with .wizard-master-gated (e.g. the 早晨日记触发 block
// in the trigger-params section).
function applyMasterToggleState() {
    const masterOn = $('#wizard-is-enabled').prop('checked');
    const $gated = $('#wizard-sub-toggles, .wizard-master-gated');
    $gated.find('input, select, textarea, button').prop('disabled', !masterOn);
    $gated.css({
        opacity: masterOn ? '' : '0.45',
        'pointer-events': masterOn ? '' : 'none',
    });
}

// Save config
async function saveConfig(silent = false) {
    // Guard: never read the form back into config while loadConfig() is still
    // populating it — a mid-load listener firing here would persist blank fields
    // and wipe genuine settings.
    if (wizardLoadingConfig) return;
    // Legacy fable/flash selectors no longer exist in the UI; preserve whatever
    // is already in config so old setups still resolve via getProfileFor().
    config.fusionProfile = $('#wizard-fusion-profile').val() || "";
    // Sticky fusion-panel settings (remembered across refresh). Number fields are
    // stored as their raw string value so empty ("全部"/auto) survives round-trips.
    config.fusionSource = $('#wizard-fusion-source').val() || "floors";
    config.fusionType = $('#wizard-fusion-type').val() || "historical";
    config.fusionRecordFrom = $('#wizard-fusion-record-from').val() || "weekly";
    // fusionRecordPicks is mutated in-place by renderRecordPicker checkbox handlers;
    // saveConfig just persists whatever is there. No explicit DOM read needed.
    const curFusionStart = $('#wizard-fusion-start').val() || "";
    const curFusionEnd = $('#wizard-fusion-end').val() || "";
    // 上下文融合楼层范围按角色/群组稳定 key 保存；切换角色后恢复各自上次输入。
    // 同时保留 legacy/global 字段作为没有 activeChatId 时的 fallback。
    config.fusionStart = curFusionStart;
    config.fusionEnd = curFusionEnd;
    if (!config.fusionRangesByChat || typeof config.fusionRangesByChat !== 'object') config.fusionRangesByChat = {};
    if (activeChatId) config.fusionRangesByChat[activeChatId] = { start: curFusionStart, end: curFusionEnd };
    config.routingProfile = $('#wizard-routing-profile').val() || "";
    config.routingKeywords = $('#wizard-routing-keywords').val() || "";
    config.gatewayProfile = $('#wizard-gateway-profile').val() || "";
    // UI switch removed — record tag is always enabled now.
    config.recordTagEnabled = true;
    config.recordTagName = ($('#wizard-record-tag-name').val() || '').trim() || "record";
    config.recallTagName = ($('#wizard-recall-tag-name').val() || '').trim() || "recall";
    // Normalize back to "" when the box still holds the unchanged built-in default,
    // so "empty = default" stays the canonical state and future default tweaks
    // propagate to users who never customized the prompt.
    const normPrompt = (v, def) => {
        const s = (v || '').trim();
        return (!s || s === def.trim()) ? "" : s;
    };
    config.promptRouting = normPrompt($('#wizard-prompt-routing').val(), DEFAULT_ROUTING_PROMPT);
    config.promptRecall = normPrompt($('#wizard-prompt-recall').val(), DEFAULT_RECALL_TEMPLATE);
    config.promptTreeFill = normPrompt($('#wizard-prompt-treefill').val(), DEFAULT_TREEFILL_PROMPT);
    config.promptRecordFill = normPrompt($('#wizard-prompt-record-fill').val(), DEFAULT_RECORDFILL_PROMPT);
    config.promptTreeFillMethod = normPrompt($('#wizard-prompt-treefill-method').val(), DEFAULT_TREEFILL_METHOD);
    config.treeFillProfile = $('#wizard-tree-fill-profile').val() || "";
    config.recapProfile = $('#wizard-recap-profile').val() || "";
    config.weeklyProfile = $('#wizard-weekly-profile').val() || "";
    config.historicalProfile = $('#wizard-historical-profile').val() || "";
    config.fallbackProfile = $('#wizard-fallback-profile').val() || "";
    // Scene-based main-reply profile switch.
    config.sceneSwitchEnabled = $('#wizard-scene-switch-enabled').prop('checked');
    config.sceneTeachingProfile = $('#wizard-scene-teaching-profile').val() || "";
    config.scenePlotProfile = $('#wizard-scene-plot-profile').val() || "";
    config.sceneIntimateProfile = $('#wizard-scene-intimate-profile').val() || "";
    config.promptSceneSelect = normPrompt($('#wizard-prompt-scene-select').val(), DEFAULT_SCENE_SELECT_PROMPT);
    config.N_RECAP = parseInt($('#wizard-n-recap').val()) || 10;
    config.directWeeklyMin = Math.max(0, parseInt($('#wizard-direct-weekly-min').val()) || 0);
    config.directHistoricalMin = Math.max(0, parseInt($('#wizard-direct-historical-min').val()) || 0);
    config.N_TREEFILL = parseInt($('#wizard-n-treefill').val()) || 10;
    config.enableMorningRecap = $('#wizard-morning-recap-enable').prop('checked');
    config.morningGapMinutes = Math.max(1, parseInt($('#wizard-morning-gap-minutes').val()) || 360);
    // Validate HH:MM 24-hour strings. Reject malformed input and fall back to
    // the prior value so users don't end up with a silently-broken window.
    const validHhMm = (s) => /^([01]?[0-9]|2[0-3]):[0-5][0-9]$/.test(String(s || '').trim());
    const rawStart = ($('#wizard-morning-window-start').val() || '').trim();
    const rawEnd   = ($('#wizard-morning-window-end').val()   || '').trim();
    if (validHhMm(rawStart)) {
        // Normalise "5:00" → "05:00" for consistent display next time.
        const [h, m] = rawStart.split(':');
        config.morningWindowStart = `${h.padStart(2, '0')}:${m}`;
    } else if (rawStart) {
        toastr.warning(`「窗口开始」格式错误（应为 24h HH:MM，例如 05:00 或 22:00）。已保留旧值 ${config.morningWindowStart || '05:00'}。`);
    }
    if (validHhMm(rawEnd)) {
        const [h, m] = rawEnd.split(':');
        config.morningWindowEnd = `${h.padStart(2, '0')}:${m}`;
    } else if (rawEnd) {
        toastr.warning(`「窗口结束」格式错误（应为 24h HH:MM，例如 10:00 或 06:00）。已保留旧值 ${config.morningWindowEnd || '10:00'}。`);
    }
    config.morningMinFloors = Math.max(1, parseInt($('#wizard-morning-min-floors').val()) || 1);
    config.morningMaxFloors = Math.max(1, parseInt($('#wizard-morning-max-floors').val()) || 50);
    config.summaryDefaultShowRealTime = $('#wizard-sum-default-realtime').attr('data-active') === 'true';
    config.N_MERGE = parseInt($('#wizard-n-merge').val()) || 100;
    config.N_MELON = parseInt($('#wizard-n-melon').val()) || 500;
    // The 周记/史记 inputs now drive the record-count fusion thresholds.
    config.RECAP_TO_WEEKLY = Math.max(2, parseInt($('#wizard-n-merge').val()) || 10);
    config.WEEKLY_TO_HISTORICAL = Math.max(2, parseInt($('#wizard-n-melon').val()) || 5);
    config.recapKeepLatest = Math.max(0, parseInt($('#wizard-recap-keep-latest').val()) || 0);
    config.weeklyKeepLatest = Math.max(0, parseInt($('#wizard-weekly-keep-latest').val()) || 0);
    config.keepLatestInclusive = $('#wizard-keep-latest-inclusive').attr('data-active') === 'true';
    config.N_SHIJI = parseInt($('#wizard-n-shiji').val()) || 20;
    config.K_RECALL = parseInt($('#wizard-k-recall').val()) || 5;
    config.TOKEN_CAP = parseInt($('#wizard-token-cap').val()) || 8000;
    config.PIN_BUDGET = parseInt($('#wizard-pin-budget').val()) || 3000;
    // {{memory_tree}} / {{memory_tree_header}} 注入内容开关（旧 treeInjectionMode 已废弃，不再回写）
    config.mtIncludePath = $('#wizard-mt-path').prop('checked');
    config.mtIncludeHint = $('#wizard-mt-hint').prop('checked');
    config.mtIncludePinBody = $('#wizard-mt-pin').prop('checked');
    config.mtIncludeRoutedBody = $('#wizard-mt-routed').prop('checked');
    config.mtIncludeAllBody = $('#wizard-mt-all').prop('checked');
    config.mtKeywordTrigger = $('#wizard-mt-keyword-trigger').prop('checked');
    config.mthIncludePath = $('#wizard-mth-path').prop('checked');
    config.mthIncludeHint = $('#wizard-mth-hint').prop('checked');
    config.mthMaxDepth = Math.max(0, parseInt($('#wizard-mth-max-depth').val()) || 0);
    config.mthMaxChildren = Math.max(0, parseInt($('#wizard-mth-max-children').val()) || 0);
    config.TIMEOUT_MS = parseInt($('#wizard-timeout-ms').val()) || 8000;
    // Allow 0 to mean "disable supplementary reads entirely". parseInt(...) || 1
    // would have coerced 0 → 1, so use an explicit NaN check instead.
    {
        const suppVal = parseInt($('#wizard-supp-read').val());
        config.SUPP_READ = isNaN(suppVal) ? 1 : Math.max(0, suppVal);
    }

    config.macroMemory = $('#wizard-macro-memory').val().trim() || "memory_tree";
    config.macroTreeHeader = $('#wizard-macro-tree-header').val().trim() || "memory_tree_header";
    config.macroHistorical = $('#wizard-macro-historical').val().trim() || "memory_historical";
    config.macroWeekly = $('#wizard-macro-weekly').val().trim() || "memory_weekly";
    config.macroRecap = $('#wizard-macro-recap').val().trim() || "memory_daily";
    config.macroShiji = $('#wizard-macro-shiji').val().trim() || "memory_hourly";
    config.macroFusion = $('#wizard-macro-fusion').val().trim() || "memory";
    config.uiColor = $('#wizard-ui-color').val().trim() || "#a3842e";
    config.uiWidth = Math.max(30, Math.min(100, parseInt($('#wizard-ui-width').val()) || 90));
    config.uiHeight = Math.max(30, Math.min(100, parseInt($('#wizard-ui-height').val()) || 95));
    config.sandboxPageSize = Math.max(10, Math.min(1000, parseInt($('#wizard-sandbox-page-size').val()) || 100));
    config.sandboxRegex = $('#wizard-sandbox-regex').val() || "";
    config.sandboxKeyword = $('#wizard-sandbox-keyword').val() || "";
    config.sandboxKeywordMode = $('#wizard-sandbox-keyword-logic').val() || "phrase";
    config.sandboxMatchMode = $('#wizard-sandbox-match-mode').val() || 'keyword';
    // config.shijiRules / config.shijiMode are mutated live by the rule handlers
    // (same pattern as sandboxFilters), so no DOM read is needed here. The legacy
    // config.shijiRegex is kept untouched as a migration source.

    config.aiShrinkProfile = $('#wizard-ai-shrink-profile').val() || "";
    config.aiShrinkPrompt = $('#wizard-ai-shrink-prompt').val() || "";
    // 世界书面板：读回表单到 config。
    config.wbProfile = $('#wizard-wb-profile').val() || "";
    config.wbMultiProfile = $('#wizard-wb-multi-profile').val() || "";
    config.wbFollowCharBook = $('#wizard-wb-follow-char').prop('checked');
    config.wbSelectedBook = wbSelectedBook || "";
    config.wbLastSingleMode = wbLastSingleMode || 'reduce';
    const _wbNorm = (v, def) => { const s = (v || '').trim(); return (!s || s === def.trim()) ? "" : s; };
    // 单条 prompt 文本框只承载当前预设的模板，仅对当前预设做 norm。
    {
        const m = wbLastSingleMode;
        const def = m === 'reduce' ? DEFAULT_WB_PROMPT_REDUCE : m === 'complete' ? DEFAULT_WB_PROMPT_COMPLETE : DEFAULT_WB_PROMPT_REWRITE;
        config[`wbPrompt${m.charAt(0).toUpperCase() + m.slice(1)}`] = _wbNorm($('#wizard-wb-single-prompt').val(), def);
    }
    config.wbPromptMulti = _wbNorm($('#wizard-wb-multi-prompt').val(), DEFAULT_WB_PROMPT_MULTI);
    config.wbAllowChangeExisting = $('#wizard-wb-allow-change').attr('data-active') === 'true';
    config.wbAllowAddNew = $('#wizard-wb-allow-add').attr('data-active') === 'true';
    config.wbAllowDeleteMerge = $('#wizard-wb-allow-delete-merge').attr('data-active') === 'true';
    config.anthropicCacheEnabled = $('#wizard-anthropic-cache-enabled').prop('checked');
    config.anthropicCacheScope = $('#wizard-anthropic-cache-scope').val() || 'internal';
    config.anthropicCacheProviderMode = $('#wizard-anthropic-cache-provider-mode').val() || 'auto';
    config.anthropicCacheTTL = $('#wizard-anthropic-cache-ttl').val() || '5m';
    config.anthropicCacheControlJson = $('#wizard-anthropic-cache-control-json').val() || defaultAnthropicCacheControlJson();
    config.anthropicCacheMainMode = $('#wizard-anthropic-cache-main-mode').val() || 'manual';
    config.anthropicCacheRollingDepths = ($('#wizard-anthropic-cache-rolling-depths').val() ?? '').trim();
    config.skipRollingOnRecapTurn = $('#wizard-skip-rolling-on-recap-turn').prop('checked');
    config.anthropicCacheDepth = Math.max(0, parseInt($('#wizard-anthropic-cache-depth').val()) || 0);
    config.anthropicCacheMinChars = Math.max(0, parseInt($('#wizard-anthropic-cache-min-chars').val()) || 0);
    config.anthropicCacheDebug = $('#wizard-anthropic-cache-debug').prop('checked');
    config.anthropicCacheAiExplain = $('#wizard-anthropic-cache-ai-explain').prop('checked');
    config.anthropicCacheTestMode = $('#wizard-anthropic-cache-test-mode').val() || 'recommend';

    // Save switches
    config.isEnabled = $('#wizard-is-enabled').prop('checked');
    config.enablePreFlash = $('#wizard-enable-pre-flash').prop('checked');
    config.enablePostFlash = $('#wizard-enable-post-flash').prop('checked');
    config.autoRecap = $('#wizard-auto-recap').prop('checked');
    config.autoWeekly = $('#wizard-auto-weekly').prop('checked');
    config.autoHistorical = $('#wizard-auto-historical').prop('checked');

    // Re-apply theme color, modal size, and update custom macros
    applyThemeColor();
    applyModalSize();
    registerCustomMacros();

    // Update dynamic labels in real time
    const fusionTypeSelect = $('#wizard-fusion-type');
    if (fusionTypeSelect.length > 0) {
        fusionTypeSelect.find('option[value="historical"]').text(`史记 (Historical Summary) [${config.N_MELON}条]`);
        fusionTypeSelect.find('option[value="weekly"]').text(`周记 (Weekly Summary) [${config.N_MERGE}条]`);
        fusionTypeSelect.find('option[value="recap"]').text(`日记 (Recap) [${config.N_RECAP}条]`);
    }
    // Section titles show dynamic counts via updateSummaryProgress(); preserve base attrs.
    $('#wizard-title-historical').attr('data-base-title', '史记');
    $('#wizard-title-weekly').attr('data-base-title', '周记');
    $('#wizard-title-recap').attr('data-base-title', '日记');

    // Update fusion macro name display
    $('#wizard-fusion-macro-name-display').text(`{{${config.macroFusion || 'memory'}}}`);
    $('#wizard-fusion-template-macro-label').text(`{{${config.macroFusion || 'memory'}}}`);

    try {
        const res = await fetch('/api/plugins/st-memory-wizzard/save-config', {
            method: 'POST',
            headers: getWizardHeaders(),
            body: JSON.stringify({ config })
        });
        const data = await res.json();
        if (data.success) {
            if (!silent) {
                toastr.success('Memory Wizard 配置已保存');
            }
            writeLog(`Configuration updated.`);
            // Update hook status indicator immediately
            if (config.isEnabled !== false) {
                $('#wizard-status-hook').html('<span style="color: #10b981;"><i class="fa-solid fa-circle-check"></i> 已挂载 (发消息时自动触发记忆路由)</span>');
            } else {
                $('#wizard-status-hook').html('<span style="color: #f59e0b;"><i class="fa-solid fa-circle-minus"></i> 已禁用 (不进行记忆注入和结构更新)</span>');
            }
        } else {
            if (!silent) {
                toastr.error('保存配置失败！');
            }
        }
    } catch (e) {
        console.error(`${LOG_PREFIX} Failed to save config`, e);
    }
}

// ══════════════════════════════════════════════════════════════════════
// REGION: 摘要 load / 渲染（三层列表渲染 + 重映射标注）
// ══════════════════════════════════════════════════════════════════════
// Load summaries & weekly/historical digests
async function loadSummaries() {
    if (!activeChatId) return;
    try {
        const res = await fetch('/api/plugins/st-memory-wizzard/get-summaries', {
            method: 'POST',
            headers: getWizardHeaders(),
            body: JSON.stringify({ chatId: activeChatId })
        });
        summaries = await res.json();
        normalizeSummaries();

        // Recompute floor remap BEFORE rendering so annotation is current.
        const _autoRemapChat = window.SillyTavern?.getContext()?.chat;
        if (Array.isArray(_autoRemapChat) && _autoRemapChat.length) {
            floorRemapState = computeFloorRemap(_autoRemapChat);
        } else {
            floorRemapState = null;
        }
        renderSummaryList('recap', summaries.recaps, $('#wizard-recaps'), '暂无故事线日记。');
        renderSummaryList('weekly', summaries.weeklySummaries, $('#wizard-weekly-summaries'), '暂无周记记录。');
        renderSummaryList('historical', summaries.historicalSummaries, $('#wizard-historical-summaries'), '暂无史记记录。');
        updateSummaryProgress();
        updateSummarySelectionUI(); // keep the batch toolbar count/visibility in sync
    } catch (e) {
        console.error(`${LOG_PREFIX} Failed to load summaries`, e);
    }
    // Always refresh the 时记 realtime section
    renderShijiList();
    // Also redraw the 上下文融合 floor list so its 📖 coverage badges follow the freshly
    // recomputed floorRemapState (e.g. after editing a record's 现存楼层). renderSandboxChat
    // self-guards when its list isn't in the DOM or no context is loaded, so this is a no-op
    // when the fusion tab was never opened.
    renderSandboxChat();
}

// Redraw all three summary lists from the in-memory `summaries` (no server fetch).
// Used to refresh the UI after an inline edit cancel without a round-trip.
function renderAllSummaryLists() {
    // Always recompute the floor remap against the live chat so the annotation
    // stays current (it's permanently on). Fall back to sandboxChatContext when
    // the live ST chat isn't reachable.
    let _chat = null;
    try { _chat = window.SillyTavern?.getContext()?.chat; } catch (e) { _chat = null; }
    if (!Array.isArray(_chat) || !_chat.length) {
        _chat = Array.isArray(sandboxChatContext) ? sandboxChatContext : null;
    }
    if (Array.isArray(_chat) && _chat.length) {
        floorRemapState = computeFloorRemap(_chat);
    } else {
        floorRemapState = null;
    }
    renderSummaryList('recap', summaries.recaps, $('#wizard-recaps'), '暂无故事线日记。');
    renderSummaryList('weekly', summaries.weeklySummaries, $('#wizard-weekly-summaries'), '暂无周记记录。');
    renderSummaryList('historical', summaries.historicalSummaries, $('#wizard-historical-summaries'), '暂无史记记录。');
    updateSummarySelectionUI();
    try { renderRecordPicker(); } catch (e) { /* renderRecordPicker may not be defined if called before DOM init */ }
}

// ---- Layered-summary batch edit / import-export helpers -----------------------
// The three summary layers, in display order, with their array key for export.
const SUMMARY_LAYERS = [
    { type: 'historical', key: 'historicalSummaries' },
    { type: 'weekly', key: 'weeklySummaries' },
    { type: 'recap', key: 'recaps' },
];
function summaryKey(type, i) { return `${type}:${i}`; }
function parseSummaryKey(k) {
    const idx = k.lastIndexOf(':');
    return { type: k.slice(0, idx), index: parseInt(k.slice(idx + 1)) };
}

// Collect the currently-selected items grouped back into the three layer arrays,
// preserving each layer's order. Used by "导出所选".
function collectSelectedSummaries() {
    const out = { historicalSummaries: [], weeklySummaries: [], recaps: [] };
    SUMMARY_LAYERS.forEach(({ type, key }) => {
        const arr = getSummaryArray(type) || [];
        arr.forEach((item, i) => {
            if (selectedSummaries.has(summaryKey(type, i))) out[key].push(item);
        });
    });
    return out;
}

// Build the export envelope for a {historicalSummaries, weeklySummaries, recaps} subset.
function buildSummariesExport(subset) {
    const count = (subset.historicalSummaries || []).length
        + (subset.weeklySummaries || []).length
        + (subset.recaps || []).length;
    return {
        format: 'memory-wizard-summaries',
        version: 1,
        exportedAt: new Date().toISOString(),
        chatId: activeChatId || '',
        count,
        summaries: {
            historicalSummaries: subset.historicalSummaries || [],
            weeklySummaries: subset.weeklySummaries || [],
            recaps: subset.recaps || [],
        },
    };
}

// Refresh the batch toolbar: selected-count text + show/hide the batch bar.
function updateSummarySelectionUI() {
    const bar = $('#wizard-sum-batch-bar');
    if (bar.length) bar.css('display', summarySelectionMode ? 'inline-flex' : 'none');
    $('#wizard-sum-selected-count').text(`已选 ${selectedSummaries.size} 个`);
    $('#wizard-sum-select-mode-btn').toggleClass('wizard-btn-warning', summarySelectionMode).removeClass('wizard-btn-primary');
    const allKeys = [];
    SUMMARY_LAYERS.forEach(({ type }) => (getSummaryArray(type) || []).forEach((_, i) => allKeys.push(summaryKey(type, i))));
    const allSelected = allKeys.length > 0 && allKeys.every(k => selectedSummaries.has(k));
    $('#wizard-sum-select-all-btn').toggleClass('wizard-btn-warning', allSelected);
    $('#wizard-sum-export-selected-btn').removeClass('wizard-btn-warning wizard-btn-primary');
}

// Shared renderer for a summary list (recap / weekly / historical). Handles the
// per-type color, archived (greyed) display + restore, source provenance, and the
// per-section "一键清理archived" + archived count badge in the section title.
function renderSummaryList(type, arr, container, emptyText) {
    if (container.length === 0) return;
    container.empty();
    const color = SUMMARY_COLORS[type];
    const typeName = SUMMARY_TYPE_NAMES[type];
    const list = Array.isArray(arr) ? arr : [];

    // Section title: type-colored, with live active count + archived cleanup button.
    const archivedCount = list.filter(sumIsArchived).length;
    const activeCount = list.length - archivedCount;
    // Total tokens across all ACTIVE (non-archived) items of this type. Uses the
    // CJK heuristic in estimateTokens — fast and sync. Archived items are
    // excluded because they aren't injected anywhere.
    const activeTotalTokens = list.reduce((acc, item) => {
        if (sumIsArchived(item)) return acc;
        return acc + estimateTokens(sumText(item) || '');
    }, 0);
    const titleEl = $(`#wizard-title-${type}`);
    if (titleEl.length) {
        titleEl.css('color', color);
        let cleanBtn = '';
        if (archivedCount > 0) {
            cleanBtn = `<button class="wizard-btn wizard-btn-secondary wizard-clean-archived-btn" data-type="${type}" style="padding: 3px 10px; font-size: 0.75em; margin-left: 8px; background: rgba(107,114,128,0.18); border: 1px solid rgba(107,114,128,0.4); color: #9ca3af;"><i class="fa-solid fa-broom"></i> 一键清理已归档 (${archivedCount})</button>`;
        }
        // Keep data-base-title as the static root ("史记") so external updates work cleanly.
        if (!titleEl.attr('data-base-title')) titleEl.attr('data-base-title', typeName);
        const tokenBadge = activeCount > 0
            ? `<span style="font-size: 0.72em; color: #9ca3af; font-weight: 400; margin-left: 6px;" title="本类型现存条目正文的合计 token 数（估算）">· 合计 ${activeTotalTokens.toLocaleString()} tokens</span>`
            : '';
        const baseLabel = `${titleEl.attr('data-base-title') || typeName} (现存 ${activeCount})${tokenBadge}`;
        let sectionCb = '';
        if (summarySelectionMode) {
            const allKeys = list.map((_, i) => summaryKey(type, i));
            const allChecked = allKeys.length > 0 && allKeys.every(k => selectedSummaries.has(k));
            sectionCb = `<input type="checkbox" class="wizard-sum-section-cb" data-type="${type}" ${allChecked ? 'checked' : ''} style="width:15px;height:15px;cursor:pointer;margin-right:6px;" title="勾选本区全部条目">`;
        }
        titleEl.html(`<span style="display:flex;align-items:center;flex-wrap:wrap;">${sectionCb}${baseLabel} ${cleanBtn}</span>`);
    }

    if (list.length === 0) {
        container.text(emptyText);
        return;
    }

    // 显示顺序：未归档（现存）在上、最新在最上；已归档沉到本区最下方、最新归档的在归档堆最上。
    // 仅改变渲染顺序，不改动底层数组（保持写入顺序→注入/覆盖率/move 仍用真实数组下标，
    // 通过 data-index 传入）。所以注入顺序、coveredFloors、saveSummariesToServer 全不受影响。
    const activeIdx = [];
    const archivedIdx = [];
    list.forEach((_, i) => { (sumIsArchived(list[i]) ? archivedIdx : activeIdx).push(i); });
    activeIdx.reverse();    // 最高下标（最新）→ 显示最上
    archivedIdx.reverse();  // 最新归档 → 归档堆最上
    const displayOrder = activeIdx.concat(archivedIdx);

    displayOrder.forEach((i, k) => {
        const raw = list[i];
        const text = sumText(raw);
        const archived = sumIsArchived(raw);
        const source = sumSource(raw);
        const name = sumName(raw);
        const rpSpan = sumTimespan(raw);
        // Real-world span: stored value, or resolved on-the-fly from "楼层 X-Y" source.
        const realSpan = effectiveRealTimespan(raw);
        // The STORED real-time span (may be empty even when realSpan resolved a
        // fallback) — this is what the pencil editor reads/writes.
        const storedRealSpan = sumRealTimespan(raw);
        const showReal = sumShowRealTime(raw);
        // 上/下箭头只在自己同状态分组内移动：active 顶到 active 堆首、archived 顶到归档堆首
        // 才隐藏上箭头；同理分组尾隐藏下箭头。跨 active/archived 边界不允许上下移（见 move 处理）。
        const groupStart = archived ? activeIdx.length : 0;
        const groupEnd = archived ? displayOrder.length - 1 : (activeIdx.length - 1);
        const upStyle = k <= groupStart ? 'display: none;' : 'cursor: pointer; color: #34d399; font-size: 0.9em;';
        const downStyle = k >= groupEnd ? 'display: none;' : 'cursor: pointer; color: #34d399; font-size: 0.9em;';
        // Archived items render greyed + semi-transparent (mirrors archived tree nodes).
        const archStyle = archived ? 'opacity: 0.45; filter: grayscale(0.85);' : '';
        const archBadge = archived ? '<span style="font-size:0.78em; background:rgba(107,114,128,0.2); color:#9ca3af; border:1px solid rgba(107,114,128,0.35); border-radius:4px; padding:1px 5px; margin-left:6px;">已归档</span>' : '';
        // Per-item token count (estimated). Always shown — even when there's no
        // source label — so the user can see the token cost of each record.
        const itemTokens = estimateTokens(text || '');
        const tokenInline = `<span style="font-size:0.78em; color:#6b7280; font-weight:400;" title="本条目正文的 token 估算">${itemTokens.toLocaleString()} tokens</span>`;
        // Remap annotation (only after the user clicks 重新映射楼层). Determined by
        // comparing the record's stored send-time range to the current chat — display
        // only, never mutates data. There are NO bordered badges: the remap state is
        // folded into the gray "来源" line as a parenthetical suffix:
        //   deleted → "（已删）"
        //   partial → "（部分删除，现 A-B 楼）"
        //   present → "（现 A-B 楼）" ONLY when the floors actually moved; if the current
        //             floors equal the original (no change), keep the source line clean.
        let remap = floorRemapState ? floorRemapState.get(summaryKey(type, i)) : null;
        const manualNowFloors = sumNowFloors(raw);
        if (manualNowFloors) {
            const origFloorsForManual = sumCoveredFloors(raw);
            remap = {
                status: 'present',
                origLabel: origFloorsForManual ? `${origFloorsForManual.lo}-${origFloorsForManual.hi}` : '',
                newLo: manualNowFloors.lo,
                newHi: manualNowFloors.hi,
            };
        }
        const remapTag = ''; // bordered tags removed entirely
        let remapSuffix = '';
        let remapTitle = '来源';
        // hideNowFloors = 用户点 × 清空「现楼层」框后设的标记，意思是「别再给我显示
        // 现楼层括号（present 状态下『楼层移动』那种）」。它只压制 present 的现楼层
        // 标注；deleted / partial 是**删除状态标记**，必须照常显示，否则用户会看到
        // 「原楼层被盖了却没有任何提示」的来源行。重新填写现楼层会在 sumSetNowFloors()
        // 里自动取消 hideNowFloors。
        const hideNow = sumHideNowFloors(raw);
        if (remap) {
            if (remap.status === 'deleted') {
                remapSuffix = '（已删）';
                remapTitle = '本记对应楼层已被删除（记内容保留，无法跳转）';
            } else if (remap.status === 'partial') {
                // 'partial' = 记的发送时间窗口跨越了删除边界：前部被删、后部仍存活。
                // 必须同时显示「部分删除」标记 + 存活部分对应的现存楼层（现覆盖楼层）。
                const hasSurvRange = typeof remap.surviveLo === 'number'
                    && typeof remap.surviveHi === 'number'
                    && remap.surviveLo <= remap.surviveHi;
                if (hasSurvRange) {
                    const survLabel = `${remap.surviveLo}-${remap.surviveHi}`;
                    const origFloorsP = sumCoveredFloors(raw);
                    const origCoverLabelP = origFloorsP ? `${origFloorsP.lo}-${origFloorsP.hi}` : null;
                    const srcMatchP = source ? source.match(/(\d+)-(\d+)/) : null;
                    const srcLabelP = srcMatchP ? `${srcMatchP[1]}-${srcMatchP[2]}` : null;
                    const unchangedP = (origCoverLabelP && origCoverLabelP === survLabel)
                        || (remap.origLabel && remap.origLabel === survLabel)
                        || (srcLabelP && srcLabelP === survLabel);
                    if (!unchangedP) {
                        remapSuffix = `（部分删除，现 ${survLabel} 楼）`;
                        remapTitle = '本记发送时间跨越删除边界；仅存留部分对应现存楼层';
                    } else {
                        // 存活楼层与原楼层标签一致 → 没真正发生前部删除，保持来源干净。
                    }
                } else {
                    // 部分删除但无法按 send_date 匹配出精确存活楼层（窗口与存活聊天有
                    // 重叠但无 send_date 命中）→ 只显示「部分删除」，不带楼号。
                    remapSuffix = '（部分删除）';
                    remapTitle = '本记发送时间跨越删除边界；仅存留部分对应现存楼层';
                }
            } else if (remap.status === 'present' && !hideNow) {
                // Annotate only when the current floors differ from what "来源" shows.
                // Compare newLo-newHi against:
                //   1. The stored coveredFloors range (most reliable)
                //   2. origLabel from the remap (derived at remap-build time from coveredFloors)
                //   3. The first lo-hi digits in the source string (fallback for legacy records)
                const newLabel = `${remap.newLo}-${remap.newHi}`;
                const origFloors = sumCoveredFloors(raw);
                const origCoverLabel = origFloors ? `${origFloors.lo}-${origFloors.hi}` : null;
                // Extract first "lo-hi" from source string (e.g. "楼层 837-907" → "837-907").
                const sourceMatch = source ? source.match(/(\d+)-(\d+)/) : null;
                const sourceLabel = sourceMatch ? `${sourceMatch[1]}-${sourceMatch[2]}` : null;
                const unchanged = (origCoverLabel && origCoverLabel === newLabel)
                    || (remap.origLabel && remap.origLabel === newLabel)
                    || (sourceLabel && sourceLabel === newLabel);
                if (!unchanged) {
                    remapSuffix = `（现 ${newLabel} 楼）`;
                    remapTitle = '本记发送时间落在现存楼层范围内，但楼层号已变化（按发送时间匹配）';
                }
                // else: floors unchanged → no suffix, keep "来源: 楼层 X-Y" as-is.
            }
            // present + hideNow → 用户已明确表示不显示现楼层括号，保持来源干净。
        }
        // Floor-edit mode for the pen-edit dialog — mirrors exactly what the source
        // line shows, so the editable fields match the displayed state:
        //   'deleted'   → record's floors are gone; only 原楼层 (orig) is editable.
        //   'remapped'  → source shows a「（现 X-Y 楼）/（部分删除…）」suffix → both 原楼层
        //                 and 现楼层 are editable (and 现楼层 can be cleared).
        //   'orig-only' → no remap suffix (floors unchanged / no remap) → only 原楼层.
        let floorEditMode = 'orig-only';
        if (remap && remap.status === 'deleted') floorEditMode = 'deleted';
        else if (remapSuffix) floorEditMode = 'remapped'; // suffix present == floors differ
        const sourceLabel = source
            ? `<span style="font-size:0.78em; color:#6b7280; font-weight:400;" title="${remapTitle}">来源: ${escapeHtml(source)}${remapSuffix} · ${itemTokens.toLocaleString()} tokens</span>`
            : (remapSuffix
                ? `<span style="font-size:0.78em; color:#6b7280; font-weight:400;" title="${remapTitle}">${remapSuffix} · ${itemTokens.toLocaleString()} tokens</span>`
                : tokenInline);
        // Title shows the custom name, or a greyed "史记#1"-style placeholder when empty.
        const placeholderName = `${typeName}#${i + 1}`;
        const titleLabel = name
            ? `<span class="wizard-sum-name-label" title="名字">${escapeHtml(name)}</span>`
            : `<span class="wizard-sum-name-label" style="color:#6b7280;" title="未命名（点小笔编辑）">${escapeHtml(placeholderName)}</span>`;
        // RP time (purple) and real time (grey) tags, shown when present.
        const rpTag = rpSpan ? `<span class="wizard-sum-rp-label" style="font-size:0.74em; color:#c4b5fd; border:1px solid rgba(196,181,253,0.4); border-radius:8px; padding:0 6px;" title="RP/剧情时间跨度">🕮 ${escapeHtml(rpSpan)}</span>` : '';
        const realTag = realSpan ? `<span style="font-size:0.74em; color:#9ca3af; border:1px solid rgba(156,163,175,0.35); border-radius:8px; padding:0 6px;" title="现实时间跨度（${showReal ? '已注入记内容' : '仅显示，未注入'}）">🕒 ${escapeHtml(realSpan)}</span>` : '';
        // Archive vs restore toggle icon.
        const archiveIcon = archived
            ? `<i class="fa-solid fa-rotate-left wizard-restore-summary-btn" data-type="${type}" data-index="${i}" style="cursor: pointer; color: #34d399; font-size: 0.9em;" title="恢复"></i>`
            : `<i class="fa-solid fa-box-archive wizard-archive-summary-btn" data-type="${type}" data-index="${i}" style="cursor: pointer; color: #9ca3af; font-size: 0.9em;" title="归档"></i>`;
        // Per-record clock toggle: whether the real-world time span is injected into
        // the record's first line. Highlighted (blue) when on, dim when off.
        const clockStyle = showReal
            ? 'cursor: pointer; color: #60a5fa; font-size: 0.9em;'
            : 'cursor: pointer; color: #4b5563; font-size: 0.9em;';
        const clockIcon = `<i class="fa-solid fa-clock wizard-toggle-realtime-btn" data-type="${type}" data-index="${i}" style="${clockStyle}" title="第一行是否包含现实时间跨度（${showReal ? '开' : '关'}）"></i>`;
        // Batch-edit checkbox (only in selection mode).
        const selectCb = summarySelectionMode
            ? `<input type="checkbox" class="wizard-sum-select-cb" data-type="${type}" data-index="${i}" ${selectedSummaries.has(summaryKey(type, i)) ? 'checked' : ''} style="width:15px;height:15px;cursor:pointer;flex:0 0 auto;">`
            : '';
        // Jump-to-floor button: only shown when the item has coveredFloors data.
        // When a remap is active, the jump targets the SURVIVING floors (present /
        // partial); a fully-deleted record drops the button (nothing to jump to).
        const floorRange = sumCoveredFloors(raw);
        let jumpLo = floorRange ? floorRange.lo : null;
        let jumpHi = floorRange ? floorRange.hi : null;
        let jumpHidden = false;
        let jumpHasTarget = !!floorRange;
        const manualJump = sumNowFloors(raw);
        if (manualJump) {
            jumpLo = manualJump.lo;
            jumpHi = manualJump.hi;
            jumpHasTarget = true;
        } else if (remap) {
            if (remap.status === 'deleted') { jumpHidden = true; }
            else if (remap.status === 'present') { jumpLo = remap.newLo; jumpHi = remap.newHi; jumpHasTarget = true; }
            else if (remap.status === 'partial') { jumpLo = remap.surviveLo; jumpHi = remap.surviveHi; jumpHasTarget = true; }
        }
        const jumpBtn = (jumpHasTarget && !jumpHidden)
            ? `<i class="fa-solid fa-location-crosshairs wizard-sum-jump-btn" data-type="${type}" data-index="${i}" data-lo="${jumpLo}" data-hi="${jumpHi}" style="cursor: pointer; color: #34d399; font-size: 0.9em;" title="跳转到上下文融合 · 楼层 ${jumpLo}–${jumpHi}"></i>`
            : '';
        const item = $(`
            <div class="wizard-summary-item" style="display: flex; flex-direction: column; gap: 6px; margin-bottom: 10px; border-bottom: 1px dashed rgba(255,255,255,0.06); padding-bottom: 8px; ${archStyle}">
                <div style="display: flex; justify-content: space-between; align-items: center; font-size: 0.85em; color: ${color}; font-weight: 500;">
                    <span style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">${selectCb}<span class="wizard-sum-meta" data-type="${type}" data-index="${i}" data-name="${escapeHtml(name)}" data-rp="${escapeHtml(rpSpan)}" data-real="${escapeHtml(storedRealSpan)}" data-source="${escapeHtml(source || '')}" data-floor-lo="${floorRange ? floorRange.lo : ''}" data-floor-hi="${floorRange ? floorRange.hi : ''}" data-now-lo="${(jumpHasTarget && !jumpHidden && jumpLo !== null) ? jumpLo : ''}" data-now-hi="${(jumpHasTarget && !jumpHidden && jumpHi !== null) ? jumpHi : ''}" data-floor-edit-mode="${floorEditMode}" data-placeholder="${escapeHtml(placeholderName)}" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">${titleLabel}${archBadge} ${rpTag} ${realTag} ${remapTag} ${sourceLabel}</span></span>
                    <div style="display: flex; gap: 10px; align-items: center;">
                        <i class="fa-solid fa-arrow-up wizard-move-up-summary-btn" data-type="${type}" data-index="${i}" style="${upStyle}" title="上移"></i>
                        <i class="fa-solid fa-arrow-down wizard-move-down-summary-btn" data-type="${type}" data-index="${i}" style="${downStyle}" title="下移"></i>
                        ${clockIcon}
                        <i class="fa-solid fa-pen-to-square wizard-edit-summary-btn" data-type="${type}" data-index="${i}" style="cursor: pointer; color: ${color}; font-size: 0.9em;" title="编辑名字 / RP时间跨度 / 现实时间段 / 楼层范围"></i>
                        ${jumpBtn}
                        <i class="fa-solid fa-expand wizard-fullscreen-summary-btn" data-type="${type}" data-index="${i}" style="cursor: pointer; color: #60a5fa; font-size: 0.9em;" title="全屏编辑"></i>
                        ${archiveIcon}
                        <i class="fa-solid fa-trash wizard-delete-summary-btn" data-type="${type}" data-index="${i}" style="cursor: pointer; color: #f87171; font-size: 0.9em;" title="删除"></i>
                    </div>
                </div>
                <textarea class="wizard-summary-textarea wizard-input" data-type="${type}" data-index="${i}" style="width: 100%; min-height: 45px; height: auto; font-size: 0.9em; padding: 6px 8px; resize: vertical; line-height: 1.4; font-family: inherit; margin: 0; box-sizing: border-box; background: rgba(0,0,0,0.15) !important; border: 1px solid rgba(255,255,255,0.06) !important;"></textarea>
                <div class="wizard-sum-expand-row" style="display:flex; justify-content:center; margin-top:-2px;">
                    <i class="fa-solid fa-chevron-down wizard-sum-expand-btn" style="cursor:pointer; color:#6b7280; font-size:0.85em; padding:2px 14px; border-radius:4px;" title="点击拉低该记，完整显示内容（再点收起）"></i>
                </div>
            </div>
        `);
        item.find('textarea').val(text);
        container.append(item);
    });
}

// Count non-archived items in a summary array.
function countActive(arr) {
    return (Array.isArray(arr) ? arr : []).filter(x => !sumIsArchived(x)).length;
}

// Inject mini progress bars below each summary section title.
// Count labels are rendered by renderSummaryList (which reads data-base-title).
// This function only owns the thin progress bar + trigger distance text that
// lives in a .wizard-sum-title-progress sibling below the title element.
function updateSummaryProgress() {
    const context = window.SillyTavern?.getContext();
    const chatLen = Array.isArray(context?.chat) ? context.chat.length : 0;

    // 日记触发阈值用「最低未覆盖楼层数」(config.morningMinFloors),与下方队尾日记
    // 真实触发条件一致;N_RECAP 只决定一次融多少(批量),不参与触发门槛。
    const nRecap = Math.max(1, parseInt(config.morningMinFloors) || 30);
    // 进度条终点 = keepLatestPlan 算出的实际触发门槛，与 runCascadeFusionOnce 保持一致。
    const r2w = keepLatestPlan(parseInt(config.RECAP_TO_WEEKLY) || 10, parseInt(config.recapKeepLatest) || 0).trigger;
    const w2h = keepLatestPlan(parseInt(config.WEEKLY_TO_HISTORICAL) || 5, parseInt(config.weeklyKeepLatest) || 0).trigger;

    // 进度条计数用「可融条目」而非全部未归档条目：包含模式下 fusedKeep 条目虽然还显示在
    // 本层，但内容已进上层、不再参与融合，计入进度条会让进度虚高、与真实触发点错位。
    const recapCount = fusableSummaryIndices(summaries.recaps).length;
    const weeklyCount = fusableSummaryIndices(summaries.weeklySummaries).length;
    const historicalCount = countActive(summaries.historicalSummaries);

    // 日记触发计数 = 「队尾连续未覆盖段」长度(tailUncoveredRun),与真实触发条件一致:
    // 从最新楼往前数、连续未被日/周/史覆盖(时记不算)的消息;遇到已覆盖楼即停。攒够
    // morningMinFloors 就融成一条日记。注意这不是全局未覆盖总数(那含中间空洞),
    // 而是「后面再无记」的尾部段。
    const sinceArchive = tailUncoveredRun(context?.chat).floors.length;

    function injectProgress(titleId, cur, target, unit, color) {
        const el = $(`#${titleId}`);
        if (!el.length) return;
        const pct = target > 0 ? Math.min(100, Math.round((cur / target) * 100)) : 0;
        const html = `<div class="wizard-sum-title-progress" style="margin-top:2px; padding: 0 2px; display:flex; flex-direction:column; gap:2px; font-weight:400; line-height:1;">
            <div style="height:4px; background:rgba(255,255,255,0.07); border-radius:3px; overflow:hidden;">
                <div style="height:100%; width:${pct}%; background:${color}; border-radius:3px; transition:width .3s;"></div>
            </div>
            <span style="font-size:0.72em; color:#6b7280;">距下一次触发: ${cur} / ${target} ${unit}</span>
        </div>`;
        el.next('.wizard-sum-title-progress').remove();
        el.after(html);
    }

    injectProgress('wizard-title-recap', sinceArchive, nRecap, '楼对话', SUMMARY_COLORS.recap);
    injectProgress('wizard-title-weekly', recapCount, r2w, '条日记', SUMMARY_COLORS.weekly);
    injectProgress('wizard-title-historical', weeklyCount, w2h, '条周记', SUMMARY_COLORS.historical);
}

// Load logs from backend
async function loadLogs() {
    try {
        // Since we are in the browser, let's fetch the log file directly via server asset path
        // We know it is written to the extension storage directory which is served by ST as a static asset!
        // The URL path for files in extension folder is:
        // /scripts/extensions/third-party/st-memory-wizzard/wizzard.log
        const res = await fetch('/scripts/extensions/third-party/st-memory-wizzard/wizzard.log');
        const viewer = $('#wizard-log-viewer');
        if (res.ok) {
            const logsText = await res.text();
            // Show last 50 lines
            const lines = logsText.split('\n').filter(l => l.trim());
            const lastLines = lines.slice(Math.max(0, lines.length - 50)).join('\n');
            viewer.text(lastLines || '日志文件为空。');
        } else {
            viewer.text('暂无日志记录。');
        }
        // Pin the view to the newest entry at the bottom and keep it there.
        if (viewer.length) {
            viewer.scrollTop(viewer[0].scrollHeight);
        }
    } catch (e) {
        $('#wizard-log-viewer').text('加载日志失败。');
    }
}

// Resolve which connection profile to use for a given task. Each task has its
// own dedicated config field (set in the UI's 5 per-task selectors). If the
// per-task field is empty, fall back to the legacy fable/flash setting so old
// configurations still work without changes; an empty string from this function
// means "use ST's currently-active connection (no preset/profile override)".
//
//   'routing'    — 回复前·记忆树检索 (was flashProfile)
//   'treeFill'   — 回复后·填记忆树 (was flashProfile)
//   'recap'      — 日记自动生成 (was flashProfile)
//   'weekly'     — 周记自动 fuse (was fableProfile)
//   'historical' — 史记自动 fuse (was fableProfile)
function getProfileFor(taskKey) {
    switch (taskKey) {
        case 'routing':    return config.routingProfile    || config.flashProfile || "";
        case 'treeFill':   return config.treeFillProfile   || config.flashProfile || "";
        case 'recap':      return config.recapProfile      || config.flashProfile || "";
        case 'weekly':     return config.weeklyProfile     || config.fableProfile || "";
        case 'historical': return config.historicalProfile || config.fableProfile || "";
        default:           return "";
    }
}

// Perform LLM call by connection profile configured name.
// `disableThinking` (used by the routing call) sends reasoning-off fields so the
// small model doesn't spend a thinking budget on a simple JSON path-selection task —
// faster routing, and opus is reached sooner.
async function runProfileLlmCall(profileName, messages, systemPrompt = "", temperature = 0.0, timeoutMs = 8000, abortSignal = null, disableThinking = false, noFallback = false, skipCache = false) {
    // Cross-provider "no thinking" payload. reasoning_effort:'min' covers OpenAI/DeepSeek
    // reasoning models; the explicit thinking/enable_thinking/reasoning fields cover
    // Claude, Qwen, and OpenRouter-style passthrough. Unknown providers ignore extras.
    const noThinkPayload = disableThinking ? {
        reasoning_effort: 'min',
        enable_thinking: false,
        thinking: { type: 'disabled' },
        reasoning: { enabled: false },
    } : {};
    // Some Claude reverse-proxies reject "bare" requests with no tools:
    //   "empty tools are only allowed for verified side-query shapes".
    // Attaching ONE harmless dummy tool with tool_choice:'auto' makes the request a
    // valid "chat-with-tools" shape WITHOUT forcing the model to call it (auto = the
    // model is free to just answer / output JSON). ST only forwards tools when the
    // array is non-empty, and it expects OpenAI function format. Controlled by
    // config.routingDummyTool (default ON) so it can be turned off if a provider rejects
    // tools entirely.
    const wantDummyTool = config.routingDummyTool !== false;
    const dummyToolPayload = wantDummyTool ? {
        tools: [{
            type: 'function',
            function: {
                name: 'noop',
                description: 'A placeholder tool. Do NOT call it; answer the user directly.',
                parameters: { type: 'object', properties: {} },
            },
        }],
        tool_choice: 'auto',
    } : {};
    const overridePayload = { ...noThinkPayload, ...dummyToolPayload };
    // Path 0 (preferred): route through SillyTavern's Connection Manager, which sends
    // the request via the ST BACKEND proxy. This is the ONLY path that reliably works
    // for routing/fusion against third-party endpoints — a browser-side direct fetch
    // (callLlmDirect) hits CORS / mixed-content and dies with "Failed to fetch", then
    // silently falls back to the ACTIVE model (e.g. opus) with the full preset, which
    // is exactly the bug where the routing call ran on the wrong model. Using the
    // profile here keeps the routing on the user's chosen小模型 (e.g. deepseek-flash).
    try {
        const context = window.SillyTavern?.getContext();
        const cmProfiles = context?.extensionSettings?.connectionManager?.profiles || [];
        const profile = profileName ? cmProfiles.find(p => p.name === profileName) : null;
        if (profile && context?.ConnectionManagerRequestService) {
            const cleanMessages = [];
            if (systemPrompt && systemPrompt.trim()) {
                const sysMsg = { role: 'system', content: systemPrompt };
                // skipCache: 一次性融合调用把源记/楼层正文嵌进 system，每次内容都不同 →
                // cache_control 永远只写不读，且会触发部分上游在 23KB+ system 块上挂起到固定
                // 超时（API request failed）。这类调用直接跳过 cache。
                if (!skipCache && anthropicCacheEnabledFor('internal') && isAnthropicCacheCandidate({}, profile)) {
                    const ok = applyCacheToMessageContent(sysMsg, 'profile/system');
                    if (config.anthropicCacheDebug) writeLog(`CacheControl internal/profile "${profileName}" system: ${ok ? 'added' : 'skipped'} (${cacheableTextLength(systemPrompt)} chars).`, ok ? 'INFO' : 'DEBUG');
                } else if (config.anthropicCacheDebug && skipCache) {
                    writeLog(`CacheControl internal/profile "${profileName}" system: skipped by caller (one-shot fusion, ${cacheableTextLength(systemPrompt)} chars).`, 'DEBUG');
                }
                cleanMessages.push(sysMsg);
            }
            messages.forEach(m => cleanMessages.push({ role: m.role || 'user', content: m.content || m.mes || "" }));
            writeLog(`Profile "${profileName}" via ConnectionManager (ST backend proxy, no preset${disableThinking ? ', thinking off' : ''}).`);
            const resp = await context.ConnectionManagerRequestService.sendRequest(
                profile.id,
                cleanMessages,
                15000,
                { stream: false, signal: abortSignal, extractData: true, includePreset: false, includeInstruct: false },
                overridePayload,
            );
            const text = extractLlmText(resp);
            if (text) return text;
            if (noFallback) throw new Error(`Profile "${profileName}" ConnectionManager returned empty response.`);
            writeLog(`Profile "${profileName}" ConnectionManager returned empty; trying direct fetch.`, 'WARNING');
        }
    } catch (e) {
        if (e.name === 'AbortError' || (abortSignal && abortSignal.aborted)) throw e;
        if (noFallback) throw e;
        writeLog(`Profile "${profileName}" ConnectionManager call failed: ${e.message}. Trying direct fetch.`, 'WARNING');
    }

    try {
        const config = await getProfileConfig(profileName);
        return await callLlmDirect(config, messages, systemPrompt, temperature, timeoutMs, abortSignal);
    } catch (e) {
        if (e.name === 'AbortError' || (abortSignal && abortSignal.aborted)) {
            throw e; // Propagate abort directly without falling back
        }
        if (noFallback) throw e;

        // 兜底优先级：配置的回退 profile > 酒馆激活 API。激活 API 通常是主力大模型，
        // 一次日记调用能把十万 token 的上下文按原价打进去（见 usages id=184）。回退 profile
        // 用 noFallback=true 调用，保证最多下探一层，不会递归。
        const fallbackName = (config.fallbackProfile || "").trim();
        if (fallbackName && fallbackName !== profileName) {
            try {
                writeLog(`Profile "${profileName}" fetch failed (${e.message}). Retrying with fallback profile "${fallbackName}".`, 'WARNING');
                return await runProfileLlmCall(fallbackName, messages, systemPrompt, temperature, timeoutMs, abortSignal, disableThinking, true, skipCache);
            } catch (fe) {
                if (fe.name === 'AbortError' || (abortSignal && abortSignal.aborted)) throw fe;
                writeLog(`Fallback profile "${fallbackName}" also failed: ${fe.message}. Falling back to SillyTavern active API.`, 'WARNING');
            }
        }

        // Fallback: If profile config fails, use the active LLM of SillyTavern itself
        writeLog(`Profile "${profileName}" fetch failed. Falling back to SillyTavern active API. Error: ${e.message}`, 'WARNING');

        // Fallback uses SillyTavern's active connection, but it MUST stay isolated:
        // no chat history, no character card, no preset — only our systemPrompt +
        // messages. The old `ordered_prompts`-only call let ST merge in the normal
        // chat context, which is why fusion looked identical to a normal reply.
        const context = window.SillyTavern.getContext();
        if (!context.generateRaw) {
            throw new Error(`SillyTavern generateRaw not available, and profile "${profileName}" failed.`);
        }

        // Build a single raw prompt string from our messages so nothing else is
        // injected. generateRaw with a string `prompt` + isolation flags sends ONLY
        // this text.
        const userText = messages.map(m => (m.content || m.mes || "")).join('\n\n');
        const rawPrompt = systemPrompt ? `${systemPrompt}\n\n${userText}` : userText;

        // Pass isolation flags across ST versions: prefer the options-object form,
        // and explicitly skip chat (`prompt` string), WIAN, examples, and char card.
        try {
            return await context.generateRaw({
                prompt: rawPrompt,
                systemPrompt: systemPrompt || '',
                prefill: '',
                jsonSchema: null,
                // Newer ST honours these to keep the call clean:
                skipWIAN: true,
                quietToLoud: false,
                temperature: temperature,
            });
        } catch (inner) {
            // Older positional signature: generateRaw(prompt, api, instructOverride, quietToLoud, systemPrompt)
            return await context.generateRaw(rawPrompt, '', false, false, systemPrompt || '');
        }
    }
}

/**
 * TRUE isolated LLM call for manual fusion. Sends ONLY the given systemPrompt +
 * messages — no active preset, no character card, no chat history, no World Info.
 *
 * Why this exists: `generateRaw` / `generateQuietPrompt` ALWAYS pull in the active
 * Chat Completion preset (its system prompt, prompt-manager entries, etc.), and
 * `ConnectionManagerRequestService.sendRequest` defaults to `includePreset:true`.
 * That preset is exactly what was leaking into the console during fusion.
 *
 * Strategy (most-isolated first):
 *   1. A connection profile is selected -> ConnectionManagerRequestService.sendRequest
 *      with includePreset:false + includeInstruct:false (strips the preset).
 *   2. No profile -> ChatCompletionService.processRequest with NO presetName, using
 *      the currently-active Chat Completion source/model. processRequest only applies
 *      a preset when you pass presetName, so omitting it sends a clean message array.
 *   3. Last resort -> our own callLlmDirect (raw fetch) if a profile config resolves.
 *
 * @returns {Promise<string>} the generated text
 */
async function runIsolatedFusionCall(profileName, messages, systemPrompt = "", temperature = 0.2, timeoutMs = 60000, abortSignal = null, onStreamChunk = null) {
    const context = window.SillyTavern.getContext();
    const useStream = typeof onStreamChunk === 'function';

    // Consume a ST stream generator: yields {text, ...} where `text` is the full
    // accumulated output. We forward each tick to onStreamChunk and return the
    // last full text.
    async function consumeStream(streamFactory) {
        let lastText = '';
        let lastReasoning = '';
        try {
            for await (const chunk of streamFactory()) {
                let text = '';
                if (typeof chunk === 'string') {
                    text = chunk;
                } else if (chunk && typeof chunk.text === 'string') {
                    text = chunk.text;
                } else if (chunk) {
                    text = extractLlmText(chunk) || '';
                }
                const reasoning = extractLlmReasoning(chunk);
                if (reasoning) lastReasoning = reasoning;
                if (text) lastText = text;
                if (text || reasoning) {
                    try { onStreamChunk(lastText, lastReasoning); } catch (_) {}
                }
            }
        } catch (e) {
            if (e?.name === 'AbortError' || (abortSignal && abortSignal.aborted)) throw e;
            throw e;
        }
        return lastText;
    }

    // Some Claude reverse-proxies reject "bare" requests (no system, no tools) with
    // errors like "empty tools are only allowed for verified side-query shapes".
    // Always include a non-empty system prompt so the request matches the proxy's
    // expected "chat-style" shape, even if the caller passed nothing.
    if (!systemPrompt || !systemPrompt.trim()) {
        systemPrompt = 'You are a helpful assistant that summarizes and organizes memory for a roleplay session. Follow the user\'s instructions precisely.';
    }

    // Build the clean message array: system turn + the caller's messages.
    const cleanMessages = [];
    const systemMsg = { role: 'system', content: systemPrompt };
    cleanMessages.push(systemMsg);
    messages.forEach(m => {
        cleanMessages.push({
            role: msgOpenAiRole(m),
            content: m.content || m.mes || "",
        });
    });

    const maxTokens = 15000;

    // --- Path 1: named connection profile, preset explicitly stripped ----------
    if (profileName && context.ConnectionManagerRequestService) {
        try {
            const cmProfiles =
                context.extensionSettings?.connectionManager?.profiles || [];
            const profile = cmProfiles.find(p => p.name === profileName);
            if (profile) {
                if (anthropicCacheEnabledFor('internal') && isAnthropicCacheCandidate({}, profile)) {
                    const ok = applyCacheToMessageContent(systemMsg, 'fusion/profile-system');
                    if (config.anthropicCacheDebug) writeLog(`CacheControl internal/fusion profile "${profileName}" system: ${ok ? 'added' : 'skipped'} (${cacheableTextLength(systemPrompt)} chars).`, ok ? 'INFO' : 'DEBUG');
                }
                writeLog(`Fusion (isolated): ConnectionManagerRequestService via profile "${profileName}", includePreset=false, stream=${useStream}.`);
                const resp = await context.ConnectionManagerRequestService.sendRequest(
                    profile.id,
                    cleanMessages,
                    maxTokens,
                    {
                        stream: useStream,
                        signal: abortSignal,
                        extractData: true,
                        includePreset: false,   // <-- the fix: NO preset
                        includeInstruct: false, // <-- NO instruct template
                    },
                );
                if (useStream && typeof resp === 'function') {
                    // Streaming request already happened. Return its final text even if
                    // empty; do NOT fall through to another backend path and send twice.
                    return await consumeStream(resp);
                } else {
                    const text = extractLlmText(resp);
                    if (text || useStream) return text;
                }
                systemMsg.content = systemPrompt;
                writeLog('Fusion (isolated): sendRequest returned empty, falling through.', 'WARNING');
            }
        } catch (e) {
            systemMsg.content = systemPrompt;
            if (e.name === 'AbortError' || (abortSignal && abortSignal.aborted)) throw e;
            if (useStream) throw e; // avoid retrying a streaming request and sending twice
            writeLog(`Fusion (isolated) sendRequest failed: ${e.message}. Falling through.`, 'WARNING');
        }
    }

    // --- Path 2: no profile -> raw ChatCompletionService, NO presetName ---------
    if (context.ChatCompletionService && context.chatCompletionSettings) {
        try {
            const cc = context.chatCompletionSettings;
            const source = cc.chat_completion_source;
            const model = (typeof context.getChatCompletionModel === 'function')
                ? context.getChatCompletionModel()
                : cc.custom_model || cc.openai_model || '';
            writeLog(`Fusion (isolated): ChatCompletionService.processRequest, source="${source}", model="${model}", NO preset, stream=${useStream}.`);
            const resp = await context.ChatCompletionService.processRequest(
                {
                    stream: useStream,
                    messages: cleanMessages,
                    model,
                    chat_completion_source: source,
                    max_tokens: maxTokens,
                    temperature,
                    custom_url: cc.custom_url,
                    reverse_proxy: cc.reverse_proxy,
                    proxy_password: cc.proxy_password,
                },
                {},          // <-- NO presetName => preset is NOT applied
                true,        // extractData
                abortSignal,
            );
            if (useStream && typeof resp === 'function') {
                // Streaming request already happened. Return its final text even if
                // empty; do NOT fall through to another backend path and send twice.
                return await consumeStream(resp);
            } else {
                const text = extractLlmText(resp);
                if (text || useStream) return text;
            }
            writeLog('Fusion (isolated): processRequest returned empty, falling through.', 'WARNING');
        } catch (e) {
            if (e.name === 'AbortError' || (abortSignal && abortSignal.aborted)) throw e;
            if (useStream) throw e; // avoid retrying a streaming request and sending twice
            writeLog(`Fusion (isolated) processRequest failed: ${e.message}. Falling through.`, 'WARNING');
        }
    }

    // --- Path 3: last resort -> our own raw fetch via profile config ------------
    writeLog('Fusion (isolated): falling back to raw callLlmDirect / generateRaw.', 'WARNING');
    return await runProfileLlmCall(profileName, messages, systemPrompt, temperature, timeoutMs, abortSignal);
}

// Apply operation list (insert, update, archive) to the tree
// Normalize a tree-op `keywords` value (string "a, b" or array ["a","b"]) into a
// clean comma-joined string, or "" if empty/absent. Matches the per-node keywords
// field format used by getKeywordMatchedNodes() and the node form.
function normalizeOpKeywords(raw) {
    if (!raw) return "";
    let parts;
    if (Array.isArray(raw)) parts = raw;
    else if (typeof raw === 'string') parts = raw.split(',');
    else return "";
    const cleaned = parts.map(s => String(s).trim()).filter(Boolean);
    // De-dupe while preserving order.
    return [...new Set(cleaned)].join(', ');
}

// Merge new keywords into an existing comma-separated keyword string (union, order
// preserved, case-insensitive de-dupe). Used when an op writes keywords onto a node
// that already has some.
function mergeKeywords(existing, incoming) {
    const ex = (existing || '').split(',').map(s => s.trim()).filter(Boolean);
    const inc = (incoming || '').split(',').map(s => s.trim()).filter(Boolean);
    const seen = new Set(ex.map(s => s.toLowerCase()));
    const out = [...ex];
    inc.forEach(k => { if (!seen.has(k.toLowerCase())) { seen.add(k.toLowerCase()); out.push(k); } });
    return out.join(', ');
}

// Resolve a (possibly multi-segment) parent path, creating any missing intermediate
// 母节点 along the way so the new node truly lives as a tree branch instead of a
// slash-named orphan pushed to the root. Returns the deepest parent node, or null
// when parentPath is empty (caller treats null as "top level"). stampCreated, when
// provided, is called on each freshly-created intermediate node for provenance.
function ensureParentPath(parentPath, stampCreated) {
    const clean = (parentPath || '').trim();
    if (!clean) return null;
    const segments = clean.split('/').map(s => s.trim()).filter(Boolean);
    let parentNode = null;            // current parent (null = root level)
    let runningPath = '';
    for (const seg of segments) {
        runningPath = runningPath ? `${runningPath}/${seg}` : seg;
        let node = findNodeByPath(memoryTree, runningPath);
        if (!node) {
            // Try a sibling title match at this level before creating, so we reuse an
            // existing 母节点 that merely differs in path casing/whitespace.
            const siblings = parentNode ? (parentNode.children || []) : memoryTree.filter(n => n.path.indexOf('/') === -1);
            node = siblings.find(s => s.title === seg) || null;
        }
        if (!node) {
            node = {
                path: runningPath,
                title: seg,
                hint: '',
                pinned: false,
                content: '',
                children: [],
                updated: new Date().toISOString().slice(0, 10),
            };
            if (typeof stampCreated === 'function') stampCreated(node);
            aiNewNodePathsThisSession.add(node.path);
            if (parentNode) {
                if (!Array.isArray(parentNode.children)) parentNode.children = [];
                parentNode.children.push(node);
            } else {
                memoryTree.push(node);
            }
            writeLog(`自动创建母节点：「${runningPath}」。`, 'INFO');
        }
        parentNode = node;
    }
    return parentNode;
}

function applyTreeOperations(ops, sourceMeta = null) {
    if (!Array.isArray(ops)) return;

    const stampCreated = (node) => {
        if (!sourceMeta || !node) return;
        if (!node.provenance) node.provenance = {};
        node.provenance.created = { ...sourceMeta };
    };
    const stampModified = (node) => {
        if (!sourceMeta || !node) return;
        if (!node.provenance) node.provenance = {};
        node.provenance.modified = { ...sourceMeta };
    };

    ops.forEach(op => {
        const opType = String(op.op).toLowerCase();

        if (opType === 'insert') {
            const parentPath = op.parent || "";
            const title = op.title;
            const hint = op.hint || "点击阅读";
            const content = op.content || "";
            // Optional world-info-style trigger keywords (comma-separated). The model
            // may emit either a string ("天气, 下雨") or an array (["天气","下雨"]).
            const keywords = normalizeOpKeywords(op.keywords);

            if (!title) {
                writeLog(`Insert operation missing title: ${JSON.stringify(op)}`, 'WARNING');
                return;
            }

            // Resolve the parent, creating any missing intermediate母节点 so a brand-new
            // category path (e.g. parent="知识/新分类" when neither exists) is built as a
            // real tree branch rather than a slash-named orphan at the root.
            const parentNode = parentPath ? ensureParentPath(parentPath, stampCreated) : null;

            const siblingNodes = parentNode ? parentNode.children : memoryTree.filter(n => n.path.indexOf('/') === -1);
            let similarNode = null;
            if (siblingNodes) {
                for (const node of siblingNodes) {
                    if (getSimilarity(node.title, title) > 0.8) {
                        similarNode = node;
                        break;
                    }
                }
            }

            if (similarNode) {
                // Similarity > 0.8: Convert insert to update
                writeLog(`Duplicate node found: "${similarNode.path}" (similarity with "${title}" > 0.8). Converting insert to update.`, 'INFO');
                similarNode.content = similarNode.content ? (similarNode.content + "\n" + content) : content;
                if (keywords) similarNode.keywords = mergeKeywords(similarNode.keywords, keywords);
                similarNode.updated = new Date().toISOString().slice(0, 10);
                stampModified(similarNode);
            } else {
                // Construct new node. Derive its path from the resolved parentNode so it
                // matches the (possibly newly-created) parent branch exactly.
                const newNode = {
                    path: parentNode ? `${parentNode.path}/${title}` : title,
                    title: title,
                    hint: hint,
                    pinned: false,
                    content: content,
                    ...(keywords ? { keywords } : {}),
                    updated: new Date().toISOString().slice(0, 10),
                    children: []
                };

                stampCreated(newNode);
                aiNewNodePathsThisSession.add(newNode.path);
                if (parentNode) {
                    if (!Array.isArray(parentNode.children)) parentNode.children = [];
                    parentNode.children.push(newNode);
                } else {
                    memoryTree.push(newNode);
                }
                writeLog(`Inserted node: "${newNode.path}"`, 'INFO');
            }

        } else if (opType === 'update') {
            const pathStr = op.path;
            const appendText = op.append || op.content || "";
            const upKeywords = normalizeOpKeywords(op.keywords);
            if (!pathStr) return;

            let node = findNodeByPath(memoryTree, pathStr);
            if (!node) {
                // Fuzzy title match
                node = findClosestNodeByTitle(memoryTree, pathStr);
            }

            if (node) {
                if (appendText) node.content = node.content ? (node.content + "\n" + appendText) : appendText;
                if (upKeywords) node.keywords = mergeKeywords(node.keywords, upKeywords);
                node.updated = new Date().toISOString().slice(0, 10);
                stampModified(node);
                writeLog(`Updated node: "${node.path}"`, 'INFO');
            } else {
                writeLog(`Update target "${pathStr}" not found in tree. Operation ignored.`, 'WARNING');
            }

        } else if (opType === 'archive') {
            const pathStr = op.path;
            if (!pathStr) return;

            let node = findNodeByPath(memoryTree, pathStr);
            if (!node) {
                node = findClosestNodeByTitle(memoryTree, pathStr);
            }

            if (node) {
                node.archived = true;
                writeLog(`Archived node: "${node.path}"`, 'INFO');
            } else {
                writeLog(`Archive target "${pathStr}" not found in tree. Operation ignored.`, 'WARNING');
            }
        }
    });
}

// ----------------------------------------------------
// HOOK 0: GENERATION_STARTED — scene-based main-reply profile switch
// ----------------------------------------------------
// When enabled, BEFORE the main reply is built/sent, ask the front fast model which
// scene (teaching / plot / intimate) the next reply belongs to, then switch SillyTavern's
// active connection profile to the user-mapped profile for that scene via the /profile
// slash command. Because GENERATION_STARTED is awaited by ST and fires before the prompt
// is assembled, the switch takes effect for THE CURRENT reply.
let isSceneSwitchInProgress = false;

async function switchConnectionProfile(profileName) {
    const context = window.SillyTavern?.getContext();
    if (!context) return false;
    const cm = context.extensionSettings?.connectionManager;
    const target = (profileName || '').trim();
    if (!target) return false;
    // Already active? Skip the (potentially slow) re-apply.
    try {
        const profiles = cm?.profiles || [];
        const current = profiles.find(p => p.id === cm?.selectedProfile);
        if (current && current.name === target) {
            writeLog(`场景切换：主回复配置已是「${target}」，无需切换。`);
            return true;
        }
    } catch (e) { /* fall through to switch */ }
    // Prefer the /profile slash command (handles the full apply + await internally).
    try {
        if (typeof context.executeSlashCommandsWithOptions === 'function') {
            const cmd = `/profile await=true ${target.replace(/\|/g, '')}`;
            await context.executeSlashCommandsWithOptions(cmd, { handleExecutionErrors: true, source: 'st-memory-wizzard-scene' });
            writeLog(`场景切换：已切换主回复连接配置 → 「${target}」。`);
            return true;
        }
    } catch (e) {
        writeLog(`场景切换：/profile 命令执行失败：${e.message}`, 'WARNING');
    }
    return false;
}

async function onGenerationStartedSceneSwitch(type, options, dryRun) {
    if (config.isEnabled === false) return;
    if (config.sceneSwitchEnabled !== true) return;
    if (dryRun === true) return;
    // Skip ST's internal "quiet" generations (impersonate, regenerate-quiet, etc.) so we
    // only switch on a real user-driven reply. 'normal'/'continue'/'swipe' are user replies.
    const realTypes = [undefined, null, '', 'normal', 'continue', 'swipe', 'regenerate'];
    if (type && !realTypes.includes(type)) {
        writeLog(`场景切换：跳过非常规生成类型 "${type}"。`, 'DEBUG');
        return;
    }
    if (isSceneSwitchInProgress) return;

    // Map scene id -> user-configured profile name.
    const sceneProfiles = {
        teaching: (config.sceneTeachingProfile || '').trim(),
        plot: (config.scenePlotProfile || '').trim(),
        intimate: (config.sceneIntimateProfile || '').trim(),
    };
    if (!sceneProfiles.teaching && !sceneProfiles.plot && !sceneProfiles.intimate) {
        writeLog('场景切换：三种场景均未配置连接配置，跳过。', 'WARNING');
        return;
    }

    isSceneSwitchInProgress = true;
    try {
        const context = window.SillyTavern?.getContext();
        const chatList = context?.chat;
        if (!Array.isArray(chatList) || !chatList.length) return;

        const recentMessages = chatList.slice(Math.max(0, chatList.length - 6));
        const recentText = recentMessages.map(m => {
            const isUser = m.role ? m.role === 'user' : !!m.is_user;
            return `${isUser ? 'User' : 'Assistant'}: ${m.mes || m.content || ""}`;
        }).join('\n');
        if (!recentText.trim()) return;

        const sceneProfile = getProfileFor('routing'); // reuse the front fast model
        if (!sceneProfile) {
            writeLog('场景切换：未配置前快模型（回复前检索模型），无法决策场景，跳过。', 'WARNING');
            return;
        }

        const header = (config.promptSceneSelect || '').trim() || DEFAULT_SCENE_SELECT_PROMPT;
        const systemPrompt = `${header}

可用场景（仅这些已配置了连接配置的场景可被选择）：
${sceneProfiles.teaching ? '- teaching（教学）\n' : ''}${sceneProfiles.plot ? '- plot（剧情）\n' : ''}${sceneProfiles.intimate ? '- intimate（亲密）\n' : ''}`;
        const messagesPayload = [{ role: 'user', content: `最近对话：\n${recentText}` }];

        let scene = '';
        try {
            writeLog(`场景切换：调用前快模型「${sceneProfile}」判断场景...`);
            const resp = await runProfileLlmCall(sceneProfile, messagesPayload, systemPrompt, 0.0, config.TIMEOUT_MS, null, true);
            writeLog(`场景切换：模型返回：${resp}`);
            const clean = resp.replace(/```json/gi, '').replace(/```/g, '').trim();
            try {
                const parsed = JSON.parse(clean);
                scene = String(parsed.scene || '').toLowerCase().trim();
            } catch (e) {
                // Regex fallback: find the first scene keyword in the raw text.
                const m = resp.toLowerCase().match(/teaching|plot|intimate/);
                scene = m ? m[0] : '';
            }
        } catch (err) {
            writeLog(`场景切换：场景决策调用失败，保持当前配置。错误：${err.message}`, 'WARNING');
            return;
        }

        const targetProfile = sceneProfiles[scene];
        if (!targetProfile) {
            writeLog(`场景切换：模型选择的场景 "${scene}" 无对应配置或为空，保持当前配置。`, 'WARNING');
            return;
        }
        writeLog(`场景切换：判定场景 = ${scene} → 目标配置「${targetProfile}」。`);
        await switchConnectionProfile(targetProfile);
    } finally {
        isSceneSwitchInProgress = false;
    }
}

// ----------------------------------------------------
// ══════════════════════════════════════════════════════════════════════
// REGION: 路由与生成钩子（CHAT_COMPLETION_PROMPT_READY：路由召回 + 宏替换 + 缓存控制）
// ══════════════════════════════════════════════════════════════════════
// HOOK 1: CHAT_COMPLETION_PROMPT_READY
// ----------------------------------------------------
async function onChatCompletionPromptReady(eventData) {
    if (config.isEnabled === false) {
        writeLog("Memory Wizard is disabled. Skipping memory injection.");
        return;
    }
    // CHAT_COMPLETION_PROMPT_READY fires for BOTH token-counting dry runs and the real
    // send. Skip dry runs: (1) routing on a dry run wastes a DS call, and worse (2) the
    // dry run would set isRoutingInProgress=true and start a slow DS call, so when the
    // REAL emit arrives the re-entrancy guard returns immediately and opus is sent
    // WITHOUT waiting for DS to finish. By only handling the real (non-dry) emit, ST's
    // `await eventSource.emit(...)` blocks the main generation until routing completes —
    // i.e. opus is only called AFTER DS has fully replied.
    if (eventData && eventData.dryRun === true) {
        return;
    }
    if (isRoutingInProgress || isArchivingInProgress) {
        return;
    }
    isRoutingInProgress = true;
    try {
        writeLog("Prompt ready hook triggered. Running routing call...");
        injectedPathsThisTurn = [];
        suppReadCountThisTurn = 0;
        // Clear last turn's recalled body so the {{memory_tree}} macro can't leak a
        // previous turn's recall when this turn's routing is skipped (keyword gate /
        // enablePreFlash off / empty index). compileMemoryTreeMacroValue() then sees an
        // empty lastCompiledNodes.recalled and sends nothing for the routed-body source.
        lastCompiledMemory = "";
        lastCompiledNodes = { pinned: [], recalled: [] };

        if (!activeChatId) {
            writeLog('No active chat. Skipping routing.', 'DEBUG');
            return;
        }

        // 1. Gather all non-pinned, non-archived nodes for the indented routing tree.
        const routingIndex = getTreePathIndex(memoryTree, { excludePinned: true });
        const context = window.SillyTavern.getContext();
        const chatHistory = eventData.chat; // raw message array

        // Get last 3 turns of conversation (6 messages)
        const recentMessages = chatHistory.slice(Math.max(0, chatHistory.length - 6));
        const recentText = recentMessages.map(m => {
            const role = m.role === 'assistant' ? 'Assistant' : 'User';
            return `${role}: ${m.content || m.mes || ""}`;
        }).join('\n');

        let recalledPaths = [];

        // Keyword gate (优先级最高的跳过判定): when 检索关键词 is non-empty, only run
        // the routing LLM if the latest user message OR the previous AI reply contains
        // any of the comma-separated keywords. Empty keywords = run every turn.
        const kwRaw = (config.routingKeywords || '').trim();
        let keywordGatePassed = true;
        if (kwRaw) {
            const keywords = kwRaw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
            // Latest user message and the most recent AI message from the raw history.
            let lastUserText = '', lastAiText = '';
            for (let i = chatHistory.length - 1; i >= 0; i--) {
                const m = chatHistory[i];
                const isUser = m.role ? m.role === 'user' : !!m.is_user;
                const body = (m.content || m.mes || '');
                if (isUser && !lastUserText) lastUserText = body;
                else if (!isUser && !lastAiText) lastAiText = body;
                if (lastUserText && lastAiText) break;
            }
            const haystack = `${lastUserText}\n${lastAiText}`.toLowerCase();
            keywordGatePassed = keywords.some(k => haystack.includes(k));
            if (!keywordGatePassed) {
                writeLog(`Routing keyword gate: none of [${keywords.join(', ')}] matched latest user/AI message. Skipping routing.`);
            }
        }

        if (config.enablePreFlash === false) {
            writeLog("Pre-processing Flash routing is disabled. Skipping routing LLM call.");
        } else if (!keywordGatePassed) {
            // gate already logged; fall through to the no-routing path
        } else if (routingIndex.length > 0) {
            // Build routing request prompt. The HEADER instruction is user-customizable
            // (config.promptRouting); empty = built-in default. The live memory-tree
            // index + the strict-JSON output rules are ALWAYS appended after it, since
            // they are structural and the parser depends on them.
            const routingHeader = (config.promptRouting || '').trim() || DEFAULT_ROUTING_PROMPT;
            const systemPrompt = `${routingHeader}

Memory Tree Index:
${routingIndex}

Instructions:
1. Pinned paths are automatically included and are NOT in the index above.
2. The index is an indented tree. Each line is one node: "- title | optional hint".
3. To recall a node, return its FULL path by joining that node's title with all ancestor titles using "/".
4. Select at most ${config.K_RECALL} paths.
5. You must format your response as a STRICT JSON object containing exactly two keys: "reason" and "recall".
6. The "reason" key must come FIRST. Write a brief explanation of why these paths are selected.
7. The "recall" key must be a list of FULL string paths.
8. Do NOT include any markdown formatting, code block ticks, or extra text. Output ONLY the JSON.

Example:
Index tree:
- 知识
  - 德国观念论
    - 康德 | 批判哲学
Return "知识/德国观念论/康德".
{"reason": "User is asking about Kant's concept of synthetic a priori, which relates to German idealism.", "recall": ["知识/德国观念论/康德"]}`;

            const messagesPayload = [
                { role: 'user', content: `Conversation Context:\n${recentText}` }
            ];

            try {
                const routingProfile = getProfileFor('routing');
                if (!routingProfile) {
                    writeLog('Routing profile not configured. Skipping routing LLM call. Set 「回复前·记忆树检索模型」 in Memory Wizard settings.', 'WARNING');
                    throw new Error('Routing profile not configured');
                }
                writeLog(`Sending routing call to profile "${routingProfile}"...`);
                const responseText = await runProfileLlmCall(routingProfile, messagesPayload, systemPrompt, 0.0, config.TIMEOUT_MS, null, true);
                writeLog(`Flash response: ${responseText}`);

                // Parse response (strict JSON fallback to regex)
                let result = null;
                try {
                    // Trim potential markdown wrappers
                    const cleanJson = responseText.replace(/```json/gi, '').replace(/```/g, '').trim();
                    result = JSON.parse(cleanJson);
                } catch (e) {
                    writeLog(`JSON parse failed. Running regex fallback...`, 'WARNING');
                    const paths = [];
                    const regex = /"([^"]*\/[^"]*)"/g;
                    let match;
                    while ((match = regex.exec(responseText)) !== null) {
                        paths.push(match[1]);
                    }
                    result = { recall: paths };
                }

                if (result && Array.isArray(result.recall)) {
                    recalledPaths = result.recall.slice(0, config.K_RECALL);
                }
            } catch (err) {
                writeLog(`Routing call timed out or failed. Downgrading to pinned memories. Error: ${err.message}`, 'WARNING');
            }
        } else {
            writeLog("Routing index is empty. Skipping routing call.");
        }

        // 1.5 World-info-style keyword trigger: force-include nodes whose keywords
        // appear in the latest user/AI message, regardless of routing outcome.
        const keywordNodes = getKeywordMatchedNodes(eventData.chat);
        if (keywordNodes.length) {
            keywordNodes.forEach(n => {
                if (!recalledPaths.includes(n.path)) recalledPaths.push(n.path);
            });
            writeLog(`关键词触发：命中 ${keywordNodes.length} 个记忆树节点 → 强制纳入召回 (${keywordNodes.map(n => n.path).join(', ')}).`);
        }

        // 2. Resolve recalled paths (including children)
        const recalledNodes = [];
        recalledPaths.forEach(pathStr => {
            let node = findNodeByPath(memoryTree, pathStr);
            if (!node) {
                // Edit distance matching on title
                const lastSegment = pathStr.split('/').pop();
                node = findClosestNodeByTitle(memoryTree, lastSegment);
                if (node) {
                    writeLog(`Fuzzy matched path "${pathStr}" to existing node "${node.path}"`, 'INFO');
                }
            }
            if (node) {
                const list = collectNodeAndChildren(node);
                list.forEach(n => {
                    if (!recalledNodes.some(x => x.path === n.path)) {
                        recalledNodes.push(n);
                    }
                });
            }
        });

        // 3. Filter and restrict token budget for recalled content. Each node is
        //    rendered in the unified "【path】\n正文" form (see formatNodeUnified).
        const recalledBlocks = [];
        let recalledTokenCount = 0;
        for (const node of recalledNodes) {
            if (node.archived) continue;
            const block = formatNodeUnified(node);
            if (!block) continue;
            const nodeTokens = estimateTokens(block);
            if (recalledTokenCount + nodeTokens <= config.TOKEN_CAP) {
                recalledBlocks.push(block);
                recalledTokenCount += nodeTokens;
                injectedPathsThisTurn.push(node.path);
            } else {
                writeLog(`Recall context token cap exceeded (${config.TOKEN_CAP}). Truncated from: ${node.path}`, 'WARNING');
                break;
            }
        }

        // 4. Gather pinned nodes and filter by PIN_BUDGET (same unified form).
        const allTreeNodes = getAllNodes(memoryTree);
        const pinnedNodes = allTreeNodes.filter(n => n.pinned && !n.archived);
        const pinnedBlocks = [];
        let pinnedTokenCount = 0;
        for (const node of pinnedNodes) {
            const block = formatNodeUnified(node);
            if (!block) continue;
            const nodeTokens = estimateTokens(block);
            if (pinnedTokenCount + nodeTokens <= config.PIN_BUDGET) {
                pinnedBlocks.push(block);
                pinnedTokenCount += nodeTokens;
                injectedPathsThisTurn.push(node.path);
            } else {
                writeLog(`Pinned context budget exceeded (${config.PIN_BUDGET}). Truncated: ${node.path}`, 'WARNING');
                break;
            }
        }

        // 5. Structure compiled memory text block — unified per-node form only.
        //    Pinned blocks first, then recalled, deduped by path. No section
        //    headers and no tree-index header content.
        const allBlocks = [];
        [...pinnedBlocks, ...recalledBlocks].forEach(block => {
            // Cheap dedup: a node may be both pinned and recalled.
            if (!allBlocks.includes(block)) allBlocks.push(block);
        });
        const compiledMemory = allBlocks.join('\n\n') || "无";

        // Save to cache for macro function callbacks
        lastCompiledMemory = compiledMemory;
        // 存节点对象数组，供 {{memory_tree}} 按 mtInclude* 开关重新拼装（recalled 去 pin 避免与 pin 源重复）。
        lastCompiledNodes = {
            pinned: pinnedNodes.slice(),
            recalled: recalledNodes.filter(n => !n.pinned).slice(),
        };

        // 6. Inject compiled memory into the prompt.
        // We look for the configured placeholder first, fallback to {{memory_tree}} and {{memory}} if different.
        let placeholderSubstituted = false;
        let shijiPlaceholderFound = false;
        let fusionPlaceholderFound = false;
        const placeholder = config.macroMemory || 'memory_tree';
        const placeholders = [placeholder];
        if (placeholder !== 'memory_tree') {
            placeholders.push('memory_tree');
        }
        // {{memory}} is the fusion macro's default name. Only treat bare 'memory'
        // as a basic-recall fallback when it isn't being used as the fusion macro,
        // otherwise the fusion template injection below would be overwritten.
        const fusionMacroName = config.macroFusion || 'memory';
        if (!placeholders.includes('memory') && fusionMacroName !== 'memory') {
            placeholders.push('memory');
        }

        eventData.chat.forEach(msg => {
            const contentKey = msg.content !== undefined ? 'content' : 'mes';
            if (msg[contentKey] && typeof msg[contentKey] === 'string') {
                placeholders.forEach(ph => {
                    if (msg[contentKey].includes(`{{${ph}}}`)) {
                        const phRegex = new RegExp(`\\{\\{${ph}\\}\\}`, 'g');
                        msg[contentKey] = msg[contentKey].replace(phRegex, compileMemoryTreeMacroValue());
                        placeholderSubstituted = true;
                        writeLog(`Substituted {{${ph}}} placeholder inside a chat message.`);
                    }
                });

                const treeHeaderMacro = config.macroTreeHeader || 'memory_tree_header';
                if (msg[contentKey].includes(`{{${treeHeaderMacro}}}`)) {
                    const phRegex = new RegExp(`\\{\\{${treeHeaderMacro}\\}\\}`, 'g');
                    msg[contentKey] = msg[contentKey].replace(phRegex, compileMemoryTreeNames());
                    writeLog(`Substituted {{${treeHeaderMacro}}} placeholder inside a chat message.`);
                }
                // Backward-compat: also substitute old {{memory_tree_name}} if it appears
                if (treeHeaderMacro !== 'memory_tree_name' && msg[contentKey].includes('{{memory_tree_name}}')) {
                    const phRegex = /\{\{memory_tree_name\}\}/g;
                    msg[contentKey] = msg[contentKey].replace(phRegex, compileMemoryTreeNames());
                    writeLog(`Substituted {{memory_tree_name}} placeholder (legacy) inside a chat message.`);
                }

                // 时记 macro: the last N_SHIJI messages of the active chat.
                const shijiMacro = config.macroShiji || 'memory_hourly';
                if (msg[contentKey].includes(`{{${shijiMacro}}}`)) {
                    const phRegex = new RegExp(`\\{\\{${shijiMacro}\\}\\}`, 'g');
                    if (config.fakeChatHistory) {
                        // 伪造聊天历史模式：时记由 injectMemoryAsHistory (GENERATION_AFTER_COMMANDS)
                        // 经 setExtensionPrompt 注入，这里只清掉占位符，避免双重注入 / 残留字面量。
                        msg[contentKey] = msg[contentKey].replace(phRegex, '');
                        shijiPlaceholderFound = true;
                        writeLog(`Cleared {{${shijiMacro}}} placeholder (fakeChatHistory mode).`);
                    } else {
                        msg[contentKey] = msg[contentKey].replace(phRegex, compileShiji());
                        placeholderSubstituted = true;
                        shijiPlaceholderFound = true;
                        writeLog(`Substituted {{${shijiMacro}}} 时记 placeholder inside a chat message.`);
                    }
                }

                // Fusion memory macro: expands the user's fusion template (all layered
                // summaries + tree index assembled into one block).
                //   伪造历史模式下，史记/周记/日记不再由 injectMemoryAsHistory 注入（已移除），
                //   改由用户在 preset 里用 {{memory}} 作 system prompt 调用 —— 所以这里要正常展开，
                //   只是用 omitShiji=true 省略时记（时记仍由伪造历史逐楼注入，避免双重注入）。
                //   非伪造模式下 omitShiji=false，时记随融合段一起展开（{{memory}} 含时记，传统行为）。
                const fusionMacro = config.macroFusion || 'memory';
                if (msg[contentKey].includes(`{{${fusionMacro}}}`)) {
                    const phRegex = new RegExp(`\\{\\{${fusionMacro}\\}\\}`, 'g');
                    const fusionOut = compileFusionMemory(!!config.fakeChatHistory, !!(config.fakeChatHistory && config.fakeChatHistoryIncludeSummaries));
                    msg[contentKey] = msg[contentKey].replace(phRegex, fusionOut);
                    placeholderSubstituted = true;
                    fusionPlaceholderFound = true;
                    writeLog(`Substituted {{${fusionMacro}}} fusion placeholder${config.fakeChatHistory ? '（伪造模式：含史记/周记/日记，省略时记）' : ''}.`);
                }
            }
        });

        if (!placeholderSubstituted) {
            writeLog(`Memory placeholders ${JSON.stringify(placeholders)} not found in preset/cards; nothing injected this turn.`);
        }

        // 注：fakeChatHistory 下原生楼层的屏蔽已交给 ST 全局 regex（syncFakeChatRegex 注入的
        // 「STMW 伪造历史屏蔽原生楼层」脚本），ST 在 itemization 之前就把原生 mes 清空，
        // 所以 preset 显示和实际发送都对。这里不再做 prompt-ready 阶段的二次删除。

        applyMainPromptCacheControls(eventData.chat);
        captureMainPromptCacheSnapshot(eventData);

        writeLog(`Prompt construction finalized. Injected ${injectedPathsThisTurn.length} memory paths.`);
    } finally {
        isRoutingInProgress = false;
    }
}

// ----------------------------------------------------
// HOOK 2: CHARACTER_MESSAGE_RENDERED / MESSAGE_RECEIVED
// ----------------------------------------------------
async function onMessageReceived(chat_id) {
    if (config.isEnabled === false) {
        return;
    }
    if (!activeChatId) return;
    const context = window.SillyTavern.getContext();
    const chatList = context.chat;
    const message = chatList[chat_id];
    if (!message || message.is_user) return;

    // Check for supplementary reading channel tag <recall>path</recall> (tag name is
    // user-configurable via config.recallTagName, default "recall").
    // Re-entrancy guard: if we are already inside a recall-triggered continuation,
    // the continue generates a fresh CHARACTER_MESSAGE_RENDERED; skip the recall
    // branch entirely so we never loop back into another splice/continue cycle.
    if (!isHandlingRecall) {
        const recallTag = (config.recallTagName || 'recall').trim() || 'recall';
        const rEsc = recallTag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const recallFindRe = new RegExp(`<${rEsc}>(.+?)<\\/${rEsc}>`, 'i');
        const recallStripRe = new RegExp(`<${rEsc}>.*?<\\/${rEsc}>`, 'gi');
        const stripRecall = () => {
            message.mes = message.mes.replace(recallStripRe, '').trim();
            if (message.swipes && message.swipe_id !== undefined) {
                message.swipes[message.swipe_id] = message.swipes[message.swipe_id].replace(recallStripRe, '').trim();
            }
        };
        const match = recallFindRe.exec(message.mes);
        if (match) {
            const path = match[1].trim();
            writeLog(`Detected recall request in assistant response: "${path}"`);

            // 0 = supplementary reads disabled. Honour the exact configured value
            // (no Math.max(1,...) floor), defaulting to 1 only when unset/NaN.
            const suppParsed = parseInt(config.SUPP_READ);
            const suppLimit = isNaN(suppParsed) ? 1 : Math.max(0, suppParsed);
            if (suppReadCountThisTurn >= suppLimit) {
                writeLog(suppLimit === 0
                    ? `Supplementary read ignored: feature disabled (SUPP_READ = 0).`
                    : `Supplementary read ignored: Turn limit exceeded (${suppReadCountThisTurn}/${suppLimit}).`, 'WARNING');
                stripRecall();
                await context.saveChat();
            } else if (injectedPathsThisTurn.includes(path)) {
                writeLog(`Supplementary read ignored: Path "${path}" already injected this turn.`, 'WARNING');
                stripRecall();
                await context.saveChat();
            } else {
                const node = findNodeByPath(memoryTree, path) || findClosestNodeByTitle(memoryTree, path);
                if (node) {
                    suppReadCountThisTurn++;
                    writeLog(`Fulfill recall (${suppReadCountThisTurn}/${suppLimit}): retrieving "${node.path}"`);

                    stripRecall();

                    // Append the recalled content as a system-note block directly into
                    // the current message, then continue. This avoids splice/reload
                    // which would change chat_id indices and risk re-triggering the hook.
                    // The wrapper text is user-customizable (config.promptRecall) with
                    // {path}/{content} placeholders; empty = built-in default.
                    const recallTpl = (config.promptRecall || '').trim() || DEFAULT_RECALL_TEMPLATE;
                    const recallBlock = '\n\n' + recallTpl
                        .replace(/\{path\}/g, node.path)
                        .replace(/\{content\}/g, node.content || "");
                    message.mes += recallBlock;
                    if (message.swipes && message.swipe_id !== undefined) {
                        message.swipes[message.swipe_id] += recallBlock;
                    }

                    await context.saveChat();

                    // Set the guard BEFORE triggering continue, clear it after.
                    isHandlingRecall = true;
                    try {
                        writeLog(`Triggering continuation of assistant message after recall injection...`);
                        await context.generate('continue');
                    } finally {
                        isHandlingRecall = false;
                    }
                    return;
                } else {
                    writeLog(`Fulfill recall: Path "${path}" not found in memory tree.`, 'WARNING');
                    stripRecall();
                    await context.saveChat();
                }
            }
        }
    }

    // On-demand tree fill via <tag>…</tag> in the assistant reply, where the tag
    // name is user-configurable (config.recordTagName, default "record"). This is an
    // INDEPENDENT channel from the every-N-turns auto archiving: whenever the main
    // model emits this tag, the treeFill model is invoked once to write the requested
    // facts into the memory tree. The tag's inner text is the instruction; the AI
    // reply body (tags stripped) is attached as the factual source. The tag is then
    // removed from the visible message. Runs regardless of the post-flash auto toggle.
    if (config.recordTagEnabled !== false) {
        const tagName = (config.recordTagName || 'record').trim() || 'record';
        const esc = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // escape for regex
        const findRe = new RegExp(`<${esc}>([\\s\\S]*?)<\\/${esc}>`, 'gi');
        const stripRe = new RegExp(`<${esc}>[\\s\\S]*?<\\/${esc}>`, 'gi');
        const recordMatches = [...(message.mes || '').matchAll(findRe)];
        if (recordMatches.length > 0) {
            const instructions = recordMatches.map(m => m[1].trim()).filter(Boolean).join('\n');
            // Strip the tags from the visible message + active swipe.
            message.mes = message.mes.replace(stripRe, '').trim();
            if (message.swipes && message.swipe_id !== undefined) {
                message.swipes[message.swipe_id] = message.swipes[message.swipe_id].replace(stripRe, '').trim();
            }
            const sourceText = message.mes; // tags already stripped
            writeLog(`Detected <${tagName}> tag(s) in assistant reply. Running on-demand tree fill: "${instructions.slice(0, 120)}"`);
            try {
                await fillTreeFromRecord(instructions, sourceText, chat_id);
            } catch (e) {
                writeLog(`On-demand <${tagName}> tree fill failed: ${e.message}`, 'WARNING');
            }
            await context.saveChat();
        }
    }

    // NOTE: Automatic floor realignment was removed by design — floor pointers are
    // never auto-shifted. coveredFloors always hold ORIGINAL (pre-delete) numbers, and
    // the user maps them to current floors on demand via the "重新映射楼层" button.

    // Skip floors already covered by an existing summary record, matched by
    // SEND-TIME (truncation-safe). buildFloorCoverageMap() uses stored absolute
    // coveredFloors which become wrong after front-deletes (old indices like 0-800
    // overlap fresh floors), so it falsely marks current uncovered floors as
    // covered and the trigger never fires. buildCurrentCoverageSet matches each
    // current floor's send_date against record realTimespan ranges.
    {
        const coveredNow = buildCurrentCoverageSet(chatList);
        let idx = summaries.lastArchivedIndex || 0;
        const moved0 = idx;
        while (idx < chatList.length && coveredNow.has(idx)) idx++;
        if (idx !== moved0) {
            summaries.lastArchivedIndex = idx;
            writeLog(`Skipped ${idx - moved0} pre-covered floors (send-time match); lastArchivedIndex -> ${idx}.`);
            await saveSummariesToServer();
        }
    }

    // Morning-recap trigger: if the latest reply landed after a long pause AND
    // the local clock matches the user's morning window, archive uncovered
    // earlier floors as a single 日记 (the new reply itself is excluded — it's
    // the wake-up message). This runs BEFORE the regular N_RECAP check; the two
    // are OR-conditions. Returns true if it fired so we skip the regular check.
    if (config.enableMorningRecap && !isArchivingInProgress) {
        try {
            if (await maybeRunMorningRecap(chat_id)) return;
        } catch (e) {
            writeLog(`Morning recap check failed: ${e.message}`, 'WARNING');
        }
    }

    // ── Post-flash tree-fill trigger (DECOUPLED from 日记 archiving) ──
    // Fires on its own count (config.N_TREEFILL) tracked by its own cursor
    // (summaries.lastTreeFillIndex). Only fills the memory tree; never writes a
    // 日记 / runs cascade fusion. Gated by the master post-flash switch.
    if (typeof summaries.lastTreeFillIndex !== 'number') {
        summaries.lastTreeFillIndex = summaries.lastArchivedIndex || 0;
    }
    const newSinceTreeFill = chatList.length - summaries.lastTreeFillIndex;
    if (newSinceTreeFill >= config.N_TREEFILL && !isArchivingInProgress) {
        if (config.enablePostFlash === false) {
            // Post-flash disabled: advance the cursor so we don't pile up a backlog
            // that floods the tree the moment it's re-enabled.
            summaries.lastTreeFillIndex = chatList.length;
            await saveSummariesToServer();
        } else {
            isArchivingInProgress = true;
            writeLog(`Tree-fill triggered: ${newSinceTreeFill} messages since last tree fill.`);
            try {
                await runTreeFillPipeline();
            } catch (e) {
                console.error(`${LOG_PREFIX} Tree-fill pipeline failed`, e);
                writeLog(`Tree-fill pipeline failed: ${e.message}`, 'ERROR');
            } finally {
                isArchivingInProgress = false;
            }
        }
    }

    // ── 日记/周记/史记自动融合触发(与 post-flash/填树完全解耦)──
    // 仅受 config.autoRecap 门控,不再依赖 enablePostFlash(那只管填树)。
    // 计量基准与日记相同：tailUncoveredRun 的「队尾连续未覆盖段」长度。
    // 优先级：史记直融 > 周记直融 > 日记。阈值 0 = 该路关闭。
    //   - 史记直融(directHistoricalMin，且 autoHistorical 开)：未覆盖楼 ≥ 阈值 → 一次融阈值条楼成 1 条史记。
    //   - 周记直融(directWeeklyMin，且 autoWeekly 开)：同上，融成 1 条周记。
    //   - 日记：未覆盖楼 ≥ morningMinFloors → 取最早 N_RECAP 条融 1 条日记。
    // 直融与日记都是「一次融 1 条、吞最早一批(批量=阈值/批量)」，覆盖后这批退出未覆盖集合，
    // 剩余积压留后续回复逐批消化，所以不会每轮狂融。
    if (config.autoRecap !== false && !isArchivingInProgress) {
        const run = tailUncoveredRun(chatList);
        if (run.floors.length) {
            const histMin = Math.max(0, parseInt(config.directHistoricalMin) || 0);
            const weekMin = Math.max(0, parseInt(config.directWeeklyMin) || 0);
            const minUncovered = Math.max(1, parseInt(config.morningMinFloors) || 30);
            const batchSize = Math.max(1, parseInt(config.N_RECAP) || 10);

            // 优先级 史记 > 周记 > 日记。直融受对应 auto 开关门控（autoHistorical/autoWeekly 关则该直融路关闭）。
            let directType = null, directCap = 0;
            if (histMin > 0 && config.autoHistorical !== false && run.floors.length >= histMin) {
                directType = 'historical'; directCap = histMin;
            } else if (weekMin > 0 && config.autoWeekly !== false && run.floors.length >= weekMin) {
                directType = 'weekly'; directCap = weekMin;
            }

            if (directType) {
                const batch = run.floors.slice(0, directCap);
                const slice = { floors: batch, lo: batch[0], hi: batch[batch.length - 1] };
                isArchivingInProgress = true;
                try {
                    await runDirectChatFusion(directType, slice);
                } catch (e) {
                    console.error(`${LOG_PREFIX} Direct ${directType} fusion failed`, e);
                    writeLog(`直融${directType === 'historical' ? '史记' : '周记'}失败: ${e.message}`, 'ERROR');
                } finally {
                    isArchivingInProgress = false;
                }
            } else if (run.floors.length >= minUncovered) {
                // 原日记路径：阈值(morningMinFloors)与批量(N_RECAP)分离。
                const batch = run.floors.slice(0, batchSize);
                const slice = { floors: batch, lo: batch[0], hi: batch[batch.length - 1] };
                isArchivingInProgress = true;
                try {
                    await runTailRecap(slice);
                } catch (e) {
                    console.error(`${LOG_PREFIX} Tail recap failed`, e);
                    writeLog(`队尾日记融合失败: ${e.message}`, 'ERROR');
                } finally {
                    isArchivingInProgress = false;
                }
            }
        }
    }
}

// On-demand tree fill driven by a main-model record tag (name = config.recordTagName,
// default "record"). `instruction` is the tag's inner text (what to write);
// `sourceText` is the AI reply body (tags
// stripped) used as the factual source. Calls the treeFill model to produce
// insert/update/archive ops and applies them. Reuses the same op schema + helpers
// (applyTreeOperations / saveTreeToServer) as the auto tree-fill pipeline.
async function fillTreeFromRecord(instruction, sourceText, sourceFloor = null) {
    const treeFillProfile = getProfileFor('treeFill');
    if (!treeFillProfile) {
        writeLog('On-demand <record> fill skipped: treeFill profile not configured (设置「回复后·填记忆树模型」).', 'WARNING');
        return;
    }
    // Call type 2: record-tag triggered fill. HEADER = config.promptRecordFill (empty
    // = default). The shared method block + strict-JSON op schema are appended via
    // buildTreeFillTail(), because applyTreeOperations() depends on that exact shape.
    const recordFillHeader = (config.promptRecordFill || '').trim() || DEFAULT_RECORDFILL_PROMPT;
    const systemPrompt = `${recordFillHeader}${buildTreeFillTail()}`;

    const userContent = `<record 指令>\n${instruction}\n</record 指令>\n\n来源正文（AI 本条回复）:\n${sourceText || '(空)'}`;
    const resp = await runProfileLlmCall(treeFillProfile, [{ role: 'user', content: userContent }], systemPrompt, 0.1);
    const cleanJson = (resp || '').replace(/```json/gi, '').replace(/```/g, '').trim();
    const opsResult = JSON.parse(cleanJson);
    if (opsResult && Array.isArray(opsResult.ops) && opsResult.ops.length) {
        applyTreeOperations(opsResult.ops, treeSourceMetaForFloor(sourceFloor));
        await saveTreeToServer();
        writeLog(`On-demand <record> fill applied ${opsResult.ops.length} tree op(s).`);
    } else {
        writeLog('On-demand <record> fill: model returned no ops.');
    }
}

// Post-flash Tree-Fill Pipeline (事实提取/写树 ONLY — decoupled from 日记 archiving).
// Packs floors since summaries.lastTreeFillIndex and asks the treeFill model for
// ══════════════════════════════════════════════════════════════════════
// REGION: 填树管线（回复后事实抽取写树 — 与日记归档解耦）
// ══════════════════════════════════════════════════════════════════════
// insert/update/archive ops, then advances its own cursor. Does NOT write a recap
// or run cascade fusion (日记/周记/史记 归档由队尾日记 runTailRecap + runCascadeFusionOnce 负责).
async function runTreeFillPipeline() {
    const context = window.SillyTavern.getContext();
    const chatList = context.chat;
    const startIndex = summaries.lastTreeFillIndex || 0;
    const endIndex = chatList.length - 1;
    if (endIndex < startIndex) return;

    const messagesToFill = chatList.slice(startIndex, endIndex + 1);
    const textContext = messagesToFill.map(m => {
        const role = msgRoleLabel(m);
        return `${role}: ${m.mes || m.content || ""}`;
    }).join('\n');

    writeLog(`Tree-fill block ${startIndex} to ${endIndex} (${messagesToFill.length} floors)...`);

    // System prompt = (custom header or built-in default header) + structural tail.
    // The tail (live node-path reference + strict-JSON schema) is always appended.
    const treeHeader = (config.promptTreeFill || '').trim() || DEFAULT_TREEFILL_PROMPT;
    const treePrompt = `${treeHeader}${buildTreeFillTail()}`;

    try {
        const treeOpsResponse = await runProfileLlmCall(getProfileFor('treeFill'), [{ role: 'user', content: textContext }], treePrompt, 0.1);
        const cleanJson = treeOpsResponse.replace(/```json/gi, '').replace(/```/g, '').trim();
        const opsResult = JSON.parse(cleanJson);
        if (opsResult && Array.isArray(opsResult.ops)) {
            applyTreeOperations(opsResult.ops);
            await saveTreeToServer();
        }
    } catch (e) {
        writeLog(`Tree-fill failed: ${e.message}`, 'WARNING');
    }

    // Advance the tree-fill cursor to the end of what we just processed.
    summaries.lastTreeFillIndex = endIndex + 1;
    await saveSummariesToServer();
}

// 队尾日记融合：把「队尾连续未覆盖段」(tailUncoveredRun) 融成一条日记。这是与 post-flash
// ══════════════════════════════════════════════════════════════════════
// REGION: 日记 / 周记 / 史记 融合（队尾日记 / 晨间日记 / cascade / 同层融合）
// ══════════════════════════════════════════════════════════════════════
// (填树) 解耦后的日记自动触发路径 —— 只受 config.autoRecap 门控,不受 enablePostFlash 影响。
// 逻辑照搬 maybeRunMorningRecap 的融合段,但触发来自队尾段而非晨间 gap/window。
async function runTailRecap(run, options = {}) {
    const context = window.SillyTavern.getContext();
    const chatList = context.chat;
    if (!run || !Array.isArray(run.floors) || !run.floors.length) return;
    const picked = run.floors;
    const lo = run.lo, hi = run.hi;

    const textContext = picked.map(f => {
        const m = chatList[f];
        if (!m) return '';
        const role = msgRoleLabel(m);
        return `#${f} ${role}: ${applyRecapPreRegex(m.mes || m.content || '', msgRoleSide(m), chatList.length - f)}`;
    }).filter(Boolean).join('\n');

    writeLog(`队尾日记触发:融合楼层 ${lo}-${hi}(${picked.length} 条未覆盖队尾消息)...`);

    // 使用用户自定义的 recap prompt(设置→提示词→日记),为空则回落到 FUSION_DEFAULT_PROMPTS.recap。
    // 与手动 AI 融合(buildFusionPayload / 5569 / 6805)走同一份模板,保持一致性。
    const recapPrompt = (config.promptRecap || '').trim() || FUSION_DEFAULT_PROMPTS.recap;
    let newRecap = '';
    try {
        newRecap = (await runProfileLlmCall(getProfileFor('recap'), [{ role: 'user', content: textContext }], recapPrompt, 0.3)).trim();
    } catch (e) {
        writeLog(`队尾日记生成失败: ${e.message}`, 'WARNING');
    }
    if (!newRecap) {
        writeLog('队尾日记:LLM 返回空 — 不写记录。', 'WARNING');
        return;
    }

    if (!Array.isArray(summaries.recaps)) summaries.recaps = [];
    const tsList = picked.map(f => msgTimestamp(chatList[f])).filter(t => !isNaN(t));
    let realTimespan = '';
    if (tsList.length) {
        const min = Math.min(...tsList);
        const max = Math.max(...tsList);
        realTimespan = min === max ? formatTimestamp(min) : `${formatTimestamp(min)} ~ ${formatTimestamp(max)}`;
    }
    let parsedName = '';
    let parsedTime = '';
    const nameMatch = newRecap.match(/<name>([\s\S]*?)<\/name>/i);
    if (nameMatch) parsedName = nameMatch[1].trim();
    const timeMatch = newRecap.match(/<time>([\s\S]*?)<\/time>/i);
    if (timeMatch) parsedTime = timeMatch[1].trim();
    const body = newRecap
        .replace(/<name>[\s\S]*?<\/name>/ig, '')
        .replace(/<time>[\s\S]*?<\/time>/ig, '')
        .trim() || newRecap;

    summaries.recaps.push({
        text: body,
        source: `楼层 ${lo}-${hi}`,
        name: parsedName,
        timespan: parsedTime,
        realTimespan,
        showRealTime: defaultSummaryShowRealTime(),
        coveredFloors: { lo, hi },
    });
    writeLog(`队尾日记已存:"${body.slice(0, 60)}..." 覆盖 ${picked.length} 楼 (${lo}-${hi})。`);

    refreshFloorAnchors(chatList);
    if (options.cascade !== false) await runCascadeFusionOnce();
    if (options.save !== false) await saveSummariesToServer();
}

// 直融旁路：把一批原始未覆盖聊天楼直接融成 1 条 周记/史记，跳过日记中间层。
// 复用 fuseSummaries 的 JSON 返回形状与填树 ops 逻辑，但源是原始楼（不是已存记录），
// 因此不归档任何源、不读 fromArr。coveredFloors = slice.lo/hi，源标签「直融楼层 X-Y」。
async function runDirectChatFusion(toType, slice) {
    if (!slice || !Array.isArray(slice.floors) || !slice.floors.length) return false;
    const context = window.SillyTavern.getContext();
    const chatList = context.chat;
    const toArr = getSummaryArray(toType);
    if (!toArr) return false;
    const toName = SUMMARY_TYPE_NAMES[toType];
    const lo = slice.lo, hi = slice.hi;
    const picked = slice.floors;

    const textContext = picked.map(f => {
        const m = chatList[f];
        if (!m) return '';
        const role = msgRoleLabel(m);
        return `#${f} ${role}: ${applyRecapPreRegex(m.mes || m.content || '', msgRoleSide(m), chatList.length - f)}`;
    }).filter(Boolean).join('\n');

    writeLog(`直融${toName}触发:融合楼层 ${lo}-${hi}(${picked.length} 条未覆盖队尾消息)...`);

    const userPrompt = toType === 'historical'
        ? ((config.promptHistorical || '').trim() || FUSION_DEFAULT_PROMPTS.historical)
        : ((config.promptWeekly || '').trim() || FUSION_DEFAULT_PROMPTS.weekly);
    const allowTreeOps = !!config.autoFusionTreeOps;
    const opSourceMeta = treeSourceMetaForFloor(hi);
    const treeOpsBlock = allowTreeOps ? `

记忆树路径索引（ops.parent 必须从这些路径中选择，或选择其合理父路径）：
${compileMemoryTreeNames() || '（当前记忆树为空）'}

自动级联融合额外填树要求：
- 严格检查具体事实（日期、数字、承诺、设定、关系变化等）。
- 如果某个事实还不在记忆树中，请在 ops 中输出 insert 操作。
- insert.parent 优先使用上方记忆树路径索引中的现有路径；若没有合适的现有分类，可以自行新建母路径（直接写出想要的完整斜杠路径，如「知识/新分类」），缺失的母节点会被自动创建。不要为了避免新建分类而把不相关的事实硬塞进不合适的现有母路径。
- 可为节点附带可选的 "keywords"（逗号分隔的触发词，模拟世界书）：当最近一条 user 或 AI 消息包含其中任意词时，该节点会被强制纳入记忆，无论路由是否召回。为有明确触发词（专有名词、人物/地点/物品名、复现话题）的节点添加；无明显触发词则省略。update 时 keywords 会并入现有关键词（取并集，不覆盖）。` : '';
    const returnShape = allowTreeOps
        ? `{
  "ops": [ {"op": "insert", "parent": "...", "title": "...", "hint": "...", "content": "...", "keywords": "可选,逗号分隔触发词"} ],
  "summary": "融合后的${toName}正文"
}`
        : `{
  "summary": "融合后的${toName}正文"
}`;
    const prompt = `${userPrompt}

以下是 ${picked.length} 条尚未被任何日记/周记/史记覆盖的原始聊天楼层，请根据上面的融合要求生成一条新的${toName}：
${textContext}${treeOpsBlock}

直融额外要求：
1. 最终回复必须是严格 JSON 对象，不要使用 markdown 代码块，不要输出 JSON 以外的文字。
2. summary 字段里的文本必须遵守上方用户自定义的${toName}融合 prompt。
${allowTreeOps ? '3. 如需写入记忆树，只能通过 ops 字段输出操作。' : '3. 当前未开启自动融合填树：不要输出 ops，不要插入/更新记忆树，只输出 summary。'}

返回格式：
${returnShape}`;

    let merged = '';
    try {
        const resp = await runProfileLlmCall(getProfileFor(toType), [{ role: 'user', content: `Perform ${toName} direct merge` }], prompt, 0.1, 8000, null, false, true, true);
        const cleanJson = (resp || '').replace(/```json/gi, '').replace(/```/g, '').trim();
        let parsed = null;
        try {
            parsed = JSON.parse(cleanJson);
        } catch (e) {
            throw new Error(`${toName} 直融: model response was not valid JSON. Raw: ${cleanJson.slice(0, 200)}`);
        }
        if (allowTreeOps && parsed && Array.isArray(parsed.ops)) {
            applyTreeOperations(parsed.ops, opSourceMeta);
            await saveTreeToServer();
        }
        merged = (parsed && (parsed.summary || parsed.historicalSummary || parsed.weeklySummary)) || '';
    } catch (e) {
        writeLog(`${toName} 直融失败: ${e.message}`, 'ERROR');
        return false;
    }
    merged = (merged || '').trim();
    if (!merged) {
        writeLog(`${toName} 直融:LLM 返回空 — 不写记录。`, 'WARNING');
        return false;
    }

    // Parse <name>/<time> the model may have emitted in summary, same as 级联融合 /
    // 队尾日记。抽成标题/时间跨度并从正文剥离，避免 <name> 明晃晃留在正文里。
    let parsedName = '';
    let parsedTime = '';
    const nameMatch = merged.match(/<name>([\s\S]*?)<\/name>/i);
    if (nameMatch) parsedName = nameMatch[1].trim();
    const timeMatch = merged.match(/<time>([\s\S]*?)<\/time>/i);
    if (timeMatch) parsedTime = timeMatch[1].trim();
    const body = merged
        .replace(/<name>[\s\S]*?<\/name>/ig, '')
        .replace(/<time>[\s\S]*?<\/time>/ig, '')
        .trim() || merged;

    const tsList = picked.map(f => msgTimestamp(chatList[f])).filter(t => !isNaN(t));
    let realTimespan = '';
    if (tsList.length) {
        const min = Math.min(...tsList);
        const max = Math.max(...tsList);
        realTimespan = min === max ? formatTimestamp(min) : `${formatTimestamp(min)} ~ ${formatTimestamp(max)}`;
    }

    toArr.push({
        text: body,
        source: `直融楼层 ${lo}-${hi}`,
        name: parsedName,
        timespan: parsedTime,
        realTimespan,
        showRealTime: defaultSummaryShowRealTime(),
        coveredFloors: { lo, hi },
    });
    writeLog(`直融${toName}已存:"${(parsedName ? `[${parsedName}] ` : '')}${body.slice(0, 60)}..." 覆盖 ${picked.length} 楼 (${lo}-${hi})。`);

    refreshFloorAnchors(chatList);
    // 直融产物可能让上层 cascade 触发（如直融出多条周记后周记数达 w2h → cascade 融史记）。
    await runCascadeFusionOnce();
    await saveSummariesToServer();
    return true;
}

// Parse "HH:MM" into minutes-since-midnight. Returns NaN on malformed input.
function parseHhMm(s) {
    const m = String(s || '').match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return NaN;
    const h = parseInt(m[1], 10);
    const mn = parseInt(m[2], 10);
    if (isNaN(h) || isNaN(mn) || h < 0 || h > 23 || mn < 0 || mn > 59) return NaN;
    return h * 60 + mn;
}

// True iff the given Date's local hour:minute falls inside the user-defined
// morning window. Supports cross-midnight windows (e.g. 22:00 → 06:00).
function isInMorningWindow(date, startStr, endStr) {
    const s = parseHhMm(startStr);
    const e = parseHhMm(endStr);
    if (isNaN(s) || isNaN(e)) return false;
    const now = date.getHours() * 60 + date.getMinutes();
    if (s === e) return false;             // empty window
    if (s < e) return now >= s && now < e; // normal: start <= now < end
    return now >= s || now < e;            // crosses midnight
}

// Morning-recap trigger logic. When the conditions match, summarize uncovered
// earlier floors (capped at morningMaxFloors) into a 日记 and return true.
// Otherwise return false so the regular N_RECAP path can still consider firing.
async function maybeRunMorningRecap(triggerFloor) {
    // Morning recap is a 日记-writing path; if 日记 auto-summarize is off, skip
    // it entirely. The regular N_RECAP path is also gated by autoRecap.
    if (config.autoRecap === false) return false;
    const context = window.SillyTavern.getContext();
    const chatList = context.chat;
    if (!Array.isArray(chatList) || typeof triggerFloor !== 'number' || triggerFloor < 0) return false;

    // Need a previous non-system, non-empty assistant or user reply to measure
    // the gap against. Find the most recent one before triggerFloor.
    let prevFloor = -1;
    for (let i = triggerFloor - 1; i >= 0; i--) {
        const m = chatList[i];
        if (!m || m.is_system) continue;
        prevFloor = i;
        break;
    }
    if (prevFloor < 0) return false; // brand-new chat — no gap reference

    const tNow = msgTimestamp(chatList[triggerFloor]);
    const tPrev = msgTimestamp(chatList[prevFloor]);
    if (isNaN(tNow) || isNaN(tPrev)) return false;

    const gapMinutes = (tNow - tPrev) / 60000;
    const gapThreshold = Math.max(1, parseInt(config.morningGapMinutes) || 360);
    if (gapMinutes < gapThreshold) return false;

    const triggerDate = new Date(tNow);
    if (!isInMorningWindow(triggerDate, config.morningWindowStart, config.morningWindowEnd)) return false;

    // Conditions met. Collect uncovered floors that are STRICTLY BEFORE the
    // trigger (the wake-up message itself is excluded).
    const coverageMap = buildRemappedCoverageMap();
    const uncovered = [];
    for (let f = 0; f < triggerFloor; f++) {
        if (!coverageMap.has(f)) uncovered.push(f);
    }
    if (uncovered.length === 0) {
        writeLog(`Morning recap: conditions matched (gap=${gapMinutes.toFixed(1)}min) but no uncovered floors before #${triggerFloor}. Skipping.`);
        return true; // suppress the regular check too — nothing to do this reply
    }
    const minFloors = Math.max(1, parseInt(config.morningMinFloors) || 1);
    if (uncovered.length < minFloors) {
        writeLog(`Morning recap: conditions matched (gap=${gapMinutes.toFixed(1)}min) but uncovered floors ${uncovered.length} < minimum ${minFloors}. Skipping morning recap.`);
        return false;
    }

    const maxFloors = Math.max(1, parseInt(config.morningMaxFloors) || 50);
    // Take the LAST `maxFloors` uncovered floors (closest to the trigger).
    const picked = uncovered.length > maxFloors ? uncovered.slice(-maxFloors) : uncovered;
    const lo = picked[0];
    const hi = picked[picked.length - 1];

    writeLog(`Morning recap triggered: gap=${gapMinutes.toFixed(1)}min (>= ${gapThreshold}), local=${triggerDate.toTimeString().slice(0, 5)}, summarizing floors ${lo}-${hi} (${picked.length} of ${uncovered.length} uncovered).`);

    if (config.enablePostFlash === false) {
        writeLog('Post-processing Flash disabled; morning recap will only mark the range covered and skip the LLM call.');
        if (!Array.isArray(summaries.recaps)) summaries.recaps = [];
        summaries.recaps.push({
            text: '(自动总结已禁用 · 仅占位)',
            source: `楼层 ${lo}-${hi} (晨间)`,
            showRealTime: defaultSummaryShowRealTime(),
            coveredFloors: { lo, hi },
        });
        await saveSummariesToServer();
        return true;
    }

    isArchivingInProgress = true;
    try {
        // Build the textContext from the picked floors (may be non-contiguous if
        // some intermediate floors were covered by prior records).
        const textContext = picked.map(f => {
            const m = chatList[f];
            const role = msgRoleLabel(m);
            return `#${f} ${role}: ${applyRecapPreRegex(m.mes || m.content || '', msgRoleSide(m), chatList.length - f)}`;
        }).join('\n');

        // Tree-fill is now a separate pipeline (runTreeFillPipeline) on its own
        // config.N_TREEFILL count, so morning recap only writes the 日记 here —
        // the tree-fill cursor will sweep these floors independently.

        // 使用用户自定义的 recap prompt,与队尾日记 / 手动融合保持一致。
        const recapPrompt = (config.promptRecap || '').trim() || FUSION_DEFAULT_PROMPTS.recap;
        let newRecap = '';
        try {
            newRecap = (await runProfileLlmCall(getProfileFor('recap'), [{ role: 'user', content: textContext }], recapPrompt, 0.3)).trim();
        } catch (e) {
            writeLog(`Morning recap generate failed: ${e.message}`, 'WARNING');
        }
        if (!newRecap) {
            writeLog('Morning recap: LLM returned empty — aborting without writing a record.', 'WARNING');
            return true;
        }

        if (!Array.isArray(summaries.recaps)) summaries.recaps = [];
        // Compute a real-time span from the actual picked floors' send_dates.
        const tsList = picked.map(f => msgTimestamp(chatList[f])).filter(t => !isNaN(t));
        let realTimespan = '';
        if (tsList.length) {
            const min = Math.min(...tsList);
            const max = Math.max(...tsList);
            realTimespan = min === max ? formatTimestamp(min) : `${formatTimestamp(min)} ~ ${formatTimestamp(max)}`;
        }
        // Parse <name>/<time> exactly like manual fusion does.
        let parsedName = '';
        let parsedTime = '';
        const nameMatch = newRecap.match(/<name>([\s\S]*?)<\/name>/i);
        if (nameMatch) parsedName = nameMatch[1].trim();
        const timeMatch = newRecap.match(/<time>([\s\S]*?)<\/time>/i);
        if (timeMatch) parsedTime = timeMatch[1].trim();
        const body = newRecap
            .replace(/<name>[\s\S]*?<\/name>/ig, '')
            .replace(/<time>[\s\S]*?<\/time>/ig, '')
            .trim() || newRecap;

        summaries.recaps.push({
            text: body,
            source: `楼层 ${lo}-${hi} (晨间)`,
            name: parsedName,
            timespan: parsedTime,
            realTimespan,
            showRealTime: defaultSummaryShowRealTime(),
            coveredFloors: { lo, hi },
        });
        writeLog(`Morning recap stored: "${body.slice(0, 60)}..." covers ${picked.length} floors (${lo}-${hi}).`);

        // The morning recap covers an arbitrary, possibly non-contiguous range.
        // Don't advance lastArchivedIndex here — coveredFloors handles dedupe.
        // But DO bump it past any leading run of now-covered floors so the
        // regular N_RECAP counter doesn't double-count them next reply.
        {
            const newCoverage = buildRemappedCoverageMap();
            let idx = summaries.lastArchivedIndex || 0;
            while (idx < chatList.length && newCoverage.has(idx)) idx++;
            if (idx !== (summaries.lastArchivedIndex || 0)) {
                summaries.lastArchivedIndex = idx;
            }
        }
        // Re-anchor after the morning recap shifted coverage / lastArchivedIndex.
        refreshFloorAnchors(chatList);

        await runCascadeFusionOnce();
        await saveSummariesToServer();
    } finally {
        isArchivingInProgress = false;
    }

    return true;
}

// 可参与融合的条目：未归档、且不是「包含模式」留下的 fusedKeep 条目（那些内容已经在
// 上层了，再融一次会让上层出现重复内容）。外加模式下从不产生 fusedKeep，等价于「未归档」。
function fusableSummaryIndices(arr) {
    return (arr || []).map((x, i) => ({ x, i }))
        .filter(o => !sumIsArchived(o.x) && !sumIsFusedKeep(o.x)).map(o => o.i);
}

// 「始终保留最新X条」的两种语义，由 config.keepLatestInclusive 切换。
// 返回 { trigger, take, keepActive }：可融条目攒够 trigger 条时触发，融最早的 take 条，
// 其中最新的 keepActive 条融完后暂不归档、以 fusedKeep 身份继续留在本层。
//   外加 (false, 默认)：保留的 keep 条不参与总结 → 攒 threshold+keep 条，只融最早 threshold 条，
//     最新 keep 条压根没进过融合，原样留着，等下一轮再融。keep=0 时与改动前行为完全一致。
//   包含 (true)：保留的 keep 条参与总结但暂缓归档 → 攒 threshold 条、融这 threshold 条
//     (内容全部进入上层)，只归档最早的 threshold-keep 条；最新 keep 条标记 fusedKeep 继续
//     显示/注入，但不再参与后续融合，下一轮融合成功后统一归档。两种模式都不会重复融合。
function keepLatestPlan(threshold, keep) {
    const k = Math.max(0, keep) || 0;
    return config.keepLatestInclusive === true
        ? { trigger: threshold, take: threshold, keepActive: k }
        : { trigger: threshold + k, take: threshold, keepActive: 0 };
}

// Sync the 外加/包含 toggle button's state, icon and label from config.
function renderKeepLatestToggle() {
    const on = config.keepLatestInclusive === true;
    $('#wizard-keep-latest-inclusive').attr('data-active', on ? 'true' : 'false');
    $('#wizard-keep-latest-inclusive-icon').attr('class', on ? 'fa-solid fa-layer-group' : 'fa-solid fa-plus');
    $('#wizard-keep-latest-inclusive-label').text(on ? '包含：攒 5 融 5，最新 2 延后归档' : '外加：攒 5+2=7 融最早 5');
}

// Run AT MOST ONE auto-fusion this reply, in priority order 史记 → 周记 → 日记.
// "记数量超出融合时机" -> merge the EARLIEST X active items of the lower layer into
// one higher record. Sources are archived (kept, greyed, restorable), not deleted.
async function runCascadeFusionOnce() {
    const r2w = parseInt(config.RECAP_TO_WEEKLY) || 10;
    const w2h = parseInt(config.WEEKLY_TO_HISTORICAL) || 5;
    // "始终保留最新X条"缓冲：最近的 keep 条日记/周记始终留在原层不被融合，防止刚融合完
    // 近期细节骤减("记忆突然变弱")。keep=0 时行为与之前完全一致。
    // trigger=触发门槛条数, take=本次融合取用的最早条数（两种语义见 keepLatestPlan）。
    const recapPlan = keepLatestPlan(r2w, parseInt(config.recapKeepLatest) || 0);
    const weeklyPlan = keepLatestPlan(w2h, parseInt(config.weeklyKeepLatest) || 0);

    // 可融条目（未归档且未被 fusedKeep 标记），oldest-first.
    const fusableIdx = fusableSummaryIndices;

    // 1) 史记: when fusable 周记 >= trigger, merge earliest `take` 周记 -> 1 史记.
    // Gated by autoHistorical — if 史记 auto-fuse is off, threshold can still
    // be crossed but cascade waits for manual fusion.
    const weeklyFusable = fusableIdx(summaries.weeklySummaries);
    if (config.autoHistorical !== false && weeklyFusable.length >= weeklyPlan.trigger) {
        const pick = weeklyFusable.slice(0, weeklyPlan.take);
        const ok = await fuseSummaries('weekly', 'historical', pick, weeklyPlan.keepActive);
        if (ok) { writeLog(`Cascade: merged ${weeklyPlan.take} 周记 -> 1 史记 (${weeklyPlan.keepActive} newest 周记 kept visible, not re-fused).`); return; }
    } else if (config.autoHistorical === false && weeklyFusable.length >= weeklyPlan.trigger) {
        writeLog(`Cascade skipped: 史记 auto-fuse disabled (${weeklyFusable.length} 周记 ready but waiting for manual fusion).`);
    }

    // 2) 周记: when fusable 日记 >= trigger, merge earliest `take` 日记 -> 1 周记.
    const recapFusable = fusableIdx(summaries.recaps);
    if (config.autoWeekly !== false && recapFusable.length >= recapPlan.trigger) {
        const pick = recapFusable.slice(0, recapPlan.take);
        const ok = await fuseSummaries('recap', 'weekly', pick, recapPlan.keepActive);
        if (ok) { writeLog(`Cascade: merged ${recapPlan.take} 日记 -> 1 周记 (${recapPlan.keepActive} newest 日记 kept visible, not re-fused).`); return; }
    } else if (config.autoWeekly === false && recapFusable.length >= recapPlan.trigger) {
        writeLog(`Cascade skipped: 周记 auto-fuse disabled (${recapFusable.length} 日记 ready but waiting for manual fusion).`);
    }
    // 3) 日记 itself is produced by the recap step above; nothing lower to fuse.
}

// Merge the given source indices of `fromType` into one `toType` record via the
// fable model, archive the sources, attach provenance, and run any tree ops.
// Returns true on success.
async function runManualLayerFusion(type) {
    if (isArchivingInProgress) {
        toastr.warning('已有融合/归档任务正在运行，请稍后再试。');
        return false;
    }
    const context = window.SillyTavern?.getContext();
    try {
        isArchivingInProgress = true;
        if (type === 'recap') {
            const run = tailUncoveredRun(context?.chat);
            if (!run.floors.length) {
                toastr.warning('日记进度条为空：当前队尾没有未覆盖楼层。');
                return false;
            }
            await runTailRecap(run, { cascade: false, save: false });
            await saveSummariesToServer();
            toastr.success(`已将当前日记进度条的 ${run.floors.length} 楼 AI 融合为一条日记。`);
            return true;
        }

        if (type === 'weekly') {
            const threshold = parseInt(config.RECAP_TO_WEEKLY) || 10;
            // 用可融池而非全部未归档：跳过「延后归档」的 fusedKeep 条目，它们的内容已在周记里，
            // 再融一次会让周记之间出现重复内容。
            const active = fusableSummaryIndices(summaries.recaps);
            if (!active.length) {
                toastr.warning('周记进度条为空：没有可融合的日记。');
                return false;
            }
            const pick = active.slice(0, Math.min(active.length, threshold));
            const ok = await fuseSummaries('recap', 'weekly', pick);
            if (!ok) throw new Error('周记融合失败或模型返回空。');
            await saveSummariesToServer();
            toastr.success(`已将当前周记进度条中的 ${pick.length} 条日记 AI 融合为一条周记。`);
            return true;
        }

        if (type === 'historical') {
            const threshold = parseInt(config.WEEKLY_TO_HISTORICAL) || 5;
            // 同上：跳过「延后归档」的 fusedKeep 周记，避免史记之间重复内容。
            const active = fusableSummaryIndices(summaries.weeklySummaries);
            if (!active.length) {
                toastr.warning('史记进度条为空：没有可融合的周记。');
                return false;
            }
            const pick = active.slice(0, Math.min(active.length, threshold));
            const ok = await fuseSummaries('weekly', 'historical', pick);
            if (!ok) throw new Error('史记融合失败或模型返回空。');
            await saveSummariesToServer();
            toastr.success(`已将当前史记进度条中的 ${pick.length} 条周记 AI 融合为一条史记。`);
            return true;
        }
        return false;
    } catch (e) {
        writeLog(`手动 AI 一键融合失败: ${e.message}`, 'ERROR');
        toastr.error(`AI 一键融合失败：${e.message}`);
        return false;
    } finally {
        isArchivingInProgress = false;
    }
}

// keepActive: 融合后不归档的「最新 N 条源」数量（「始终保留最新X条」的包含模式）。
// 这些源的内容已经进入上层记录，但它们继续以本层身份存在，防止刚融合完近期细节骤减。
// 0 = 全部归档（默认，与改动前一致）。
async function fuseSummaries(fromType, toType, indices, keepActive = 0) {
    const fromArr = getSummaryArray(fromType);
    if (!fromArr) return false;
    const toArr = getSummaryArray(toType);
    const fromName = SUMMARY_TYPE_NAMES[fromType];
    const toName = SUMMARY_TYPE_NAMES[toType];
    const srcTexts = indices.map(i => sumText(fromArr[i])).filter(Boolean);
    if (!srcTexts.length) return false;

    // Provenance for tree ops produced by auto 周记/史记 fusion: use the newest
    // covered floor among the merged source records. This is a real chat floor and
    // can later be remapped by send_date after front-deletes, same as summary floors.
    let opSourceFloor = null;
    for (const i of indices) {
        const r = sumCoveredFloors(fromArr[i]);
        if (!r) continue;
        opSourceFloor = opSourceFloor === null ? r.hi : Math.max(opSourceFloor, r.hi);
    }
    const opSourceMeta = opSourceFloor === null ? null : treeSourceMetaForFloor(opSourceFloor);

    // Auto cascade fusion must use the user's custom target-layer prompt too:
    //   日记 -> 周记 uses promptWeekly
    //   周记 -> 史记 uses promptHistorical
    // The parser still needs JSON so we append a strict output wrapper after the
    // user's style/content instructions. Tree insert ops are controlled by
    // config.autoFusionTreeOps: off = summary only; on = send tree path header + ops.
    const userPrompt = toType === 'historical'
        ? ((config.promptHistorical || '').trim() || FUSION_DEFAULT_PROMPTS.historical)
        : toType === 'weekly'
            ? ((config.promptWeekly || '').trim() || FUSION_DEFAULT_PROMPTS.weekly)
            : ((config.promptRecap || '').trim() || FUSION_DEFAULT_PROMPTS.recap);
    const allowTreeOps = !!config.autoFusionTreeOps;
    const treeOpsBlock = allowTreeOps ? `

记忆树路径索引（ops.parent 必须从这些路径中选择，或选择其合理父路径）：
${compileMemoryTreeNames() || '（当前记忆树为空）'}

自动级联融合额外填树要求：
- 严格检查具体事实（日期、数字、承诺、设定、关系变化等）。
- 如果某个事实还不在记忆树中，请在 ops 中输出 insert 操作。
- insert.parent 优先使用上方记忆树路径索引中的现有路径；若没有合适的现有分类，可以自行新建母路径（直接写出想要的完整斜杠路径，如「知识/新分类」），缺失的母节点会被自动创建。不要为了避免新建分类而把不相关的事实硬塞进不合适的现有母路径。
- 可为节点附带可选的 "keywords"（逗号分隔的触发词，模拟世界书）：当最近一条 user 或 AI 消息包含其中任意词时，该节点会被强制纳入记忆，无论路由是否召回。为有明确触发词（专有名词、人物/地点/物品名、复现话题）的节点添加；无明显触发词则省略。update 时 keywords 会并入现有关键词（取并集，不覆盖）。` : '';
    const returnShape = allowTreeOps
        ? `{
  "ops": [ {"op": "insert", "parent": "...", "title": "...", "hint": "...", "content": "...", "keywords": "可选,逗号分隔触发词"} ],
  "summary": "融合后的${toName}正文"
}`
        : `{
  "summary": "融合后的${toName}正文"
}`;
    const prompt = `${userPrompt}

以下是需要融合的 ${fromName} 条目，请根据上面的融合要求生成一条新的${toName}：
${srcTexts.map((t, i) => `${i + 1}. ${t}`).join('\n')}${treeOpsBlock}

自动级联融合额外要求：
1. 最终回复必须是严格 JSON 对象，不要使用 markdown 代码块，不要输出 JSON 以外的文字。
2. summary 字段里的文本必须遵守上方用户自定义的${toName}融合 prompt。
${allowTreeOps ? '3. 如需写入记忆树，只能通过 ops 字段输出操作。' : '3. 当前未开启自动融合填树：不要输出 ops，不要插入/更新记忆树，只输出 summary。'}

返回格式：
${returnShape}`;

    try {
        const resp = await runProfileLlmCall(getProfileFor(toType), [{ role: 'user', content: `Perform ${toName} merge` }], prompt, 0.1, 8000, null, false, true, true);
        const cleanJson = resp.replace(/```json/gi, '').replace(/```/g, '').trim();
        let merged = "";
        try {
            const parsed = JSON.parse(cleanJson);
            if (allowTreeOps && parsed && Array.isArray(parsed.ops)) {
                applyTreeOperations(parsed.ops, opSourceMeta);
                await saveTreeToServer();
            }
            merged = (parsed && (parsed.summary || parsed.historicalSummary || parsed.weeklySummary)) || "";
        } catch (e) {
            throw new Error(`${toName} merge: model response was not valid JSON. Raw: ${cleanJson.slice(0, 200)}`);
        }
        merged = (merged || "").trim();
        if (!merged) return false;

        // Parse <name>/<time> the model may have emitted in summary, same as 队尾日记
        // / 晨间日记 / 手动流式融合 (parseFusionRecord). 周记/史记 级联之前硬编码
        // name:"" 并把 <name> 原样留在正文里 → 标题丢失且正文带标签。这里抽成标题、
        // 从正文剥离。<time> 若模型给出则覆盖从源继承的 RP 时间跨度（与日记一致）。
        let parsedName = '';
        let parsedTime = '';
        const nameMatch = merged.match(/<name>([\s\S]*?)<\/name>/i);
        if (nameMatch) parsedName = nameMatch[1].trim();
        const timeMatch = merged.match(/<time>([\s\S]*?)<\/time>/i);
        if (timeMatch) parsedTime = timeMatch[1].trim();
        const body = merged
            .replace(/<name>[\s\S]*?<\/name>/ig, '')
            .replace(/<time>[\s\S]*?<\/time>/ig, '')
            .trim() || merged;

        // Source provenance: which source #s were merged (1-based, display order).
        const srcLabel = `${fromName} #${indices.map(i => i + 1).join(', #')}`;
        // Inherit time spans from the merged sources: take the earliest source's
        // start and the latest source's end for each of RP-time and real-time.
        const sorted = indices.slice().sort((a, b) => a - b);
        const spanFrom = (getter) => {
            const first = sorted.map(i => getter(fromArr[i])).find(Boolean) || "";
            const last = sorted.slice().reverse().map(i => getter(fromArr[i])).find(Boolean) || "";
            if (!first && !last) return "";
            const left = first.split('~')[0].trim();
            const right = (last.includes('~') ? last.split('~').pop() : last).trim();
            return left === right ? left : `${left} ~ ${right}`;
        };
        const mergedTimespan = spanFrom(sumTimespan);
        const mergedRealTimespan = spanFrom(sumRealTimespan);
        // Inherit the absolute floor coverage by unioning every merged source's range,
        // so a 周记/史记 transitively accounts for all the chat floors its sources did.
        let coveredFloors = null;
        for (const i of indices) {
            const r = sumCoveredFloors(fromArr[i]);
            if (!r) continue;
            coveredFloors = coveredFloors
                ? { lo: Math.min(coveredFloors.lo, r.lo), hi: Math.max(coveredFloors.hi, r.hi) }
                : { lo: r.lo, hi: r.hi };
        }
        toArr.push({
            text: body,
            source: srcLabel,
            name: parsedName,
            timespan: parsedTime || mergedTimespan,
            realTimespan: mergedRealTimespan,
            showRealTime: defaultSummaryShowRealTime(),
            ...(coveredFloors ? { coveredFloors } : {}),
        });
        // Archive the sources (keep on disk, greyed, restorable).
        // 先收掉上一轮「包含模式」留下的 fusedKeep 条目：它们的内容早已进入上层，只是多留了
        // 一轮供近期参照，现在新一轮融合已产出，可以归档了。
        for (let i = 0; i < fromArr.length; i++) {
            if (sumIsFusedKeep(fromArr[i]) && !indices.includes(i)) sumSetArchived(fromArr, i, true);
        }
        // 本批：最早的 take-keepActive 条直接归档，最新 keepActive 条标记 fusedKeep 留在本层。
        // 它们已被算进上层记录，所以下轮不会再参与融合 —— 上层不会出现重复内容。
        const cut = keepActive > 0 ? Math.max(0, sorted.length - keepActive) : sorted.length;
        sorted.slice(0, cut).forEach(i => sumSetArchived(fromArr, i, true));
        sorted.slice(cut).forEach(i => sumSetFusedKeep(fromArr, i, true));
        return true;
    } catch (e) {
        writeLog(`${toName} merge failed: ${e.message}`, 'ERROR');
        return false;
    }
}

// Extract merged time spans and floor coverage from source records. Shared by
// fuseSummaries (auto cascade) and the save callback (manual 同层 fusion) so the
// stored result always inherits the union of its sources.
function mergeSourceSpans(fromArr, indices) {
    const sorted = indices.slice().sort((a, b) => a - b);
    const spanFrom = (getter) => {
        const first = sorted.map(i => getter(fromArr[i])).find(Boolean) || "";
        const last = sorted.slice().reverse().map(i => getter(fromArr[i])).find(Boolean) || "";
        if (!first && !last) return "";
        const left = first.split('~')[0].trim();
        const right = (last.includes('~') ? last.split('~').pop() : last).trim();
        return left === right ? left : `${left} ~ ${right}`;
    };
    const mergedTimespan = spanFrom(sumTimespan);
    const mergedRealTimespan = spanFrom(sumRealTimespan);
    let coveredFloors = null;
    for (const i of indices) {
        const r = sumCoveredFloors(fromArr[i]);
        if (!r) continue;
        coveredFloors = coveredFloors
            ? { lo: Math.min(coveredFloors.lo, r.lo), hi: Math.max(coveredFloors.hi, r.hi) }
            : { lo: r.lo, hi: r.hi };
    }
    return { mergedTimespan, mergedRealTimespan, coveredFloors };
}

// 同层融合：把多条史记合并为一条更宏观的史记（史记→史记）。
// 走流式窗口（可编辑/继续/Revert），生成完成后先不落库不归档——
// 等用户在流式窗口里确认（保存）时才落地并归档源。
async function fuseSummariesSelf(type, indices) {
    const fromArr = getSummaryArray(type);
    const fromName = SUMMARY_TYPE_NAMES[type] || '记';
    const toName = '史记';
    if (!fromArr || indices.length < 2) return false;

    // Build system prompt: 复用主模板的史记融合 Prompt（空=回落 historical 默认）。
    const systemPrompt = (config.promptHistorical || '').trim() || FUSION_DEFAULT_PROMPTS.historical;

    // Build user content: each selected 史记 body with context header.
    const srcTexts = [];
    for (const i of indices) {
        const item = fromArr[i];
        if (!item || sumIsArchived(item)) continue;
        const text = sumText(item);
        if (!text) continue;
        const ts = sumTimespan(item) || '';
        const rt = sumRealTimespan(item) || '';
        const cf = sumCoveredFloors(item);
        const floorStr = cf ? `楼层 ${cf.lo}-${cf.hi}` : '';
        const meta = [ts, rt, floorStr].filter(Boolean).join(' · ');
        srcTexts.push(`史记 #${i + 1}${meta ? ` (${meta})` : ''}:\n${text}`);
    }
    if (srcTexts.length < 2) {
        toastr.warning(`可融合的未归档${fromName}不足 2 条。`);
        return false;
    }

    let finalSystemPrompt = systemPrompt;
    // {{records}} expansion
    const hasRecordsToken = /\{\{\s*records\s*\}\}/i.test(finalSystemPrompt);
    if (hasRecordsToken) {
        finalSystemPrompt = finalSystemPrompt.replace(/\{\{\s*records\s*\}\}/gi, compileOtherRecords(type));
    } else if (config.fusionIncludeRecords) {
        const block = compileOtherRecords(type);
        if (block) finalSystemPrompt = `${block}\n\n${finalSystemPrompt}`;
    }
    const userContent = srcTexts.join('\n\n---\n\n');
    let effectiveSystemPrompt = finalSystemPrompt;
    let effectiveUserContent = userContent;
    // {{history}} expansion (in this context history = selected 史记 bodies)
    if (/\{\{\s*history\s*\}\}/i.test(finalSystemPrompt)) {
        effectiveSystemPrompt = finalSystemPrompt.replace(/\{\{\s*history\s*\}\}/gi, userContent);
        effectiveUserContent = '请根据以上内容进行融合总结。';
    }
    // Manual tree fill for 同层 fusion: 复用主模板「手动融合时一并填记忆树」开关。
    if (config.manualFusionTreeOps) {
        effectiveSystemPrompt = `${effectiveSystemPrompt}${buildManualTreeOpsBlock()}`;
    }

    const profile = $('#wizard-fusion-profile').val() || '';
    const typeColor = SUMMARY_COLORS['historical'] || '#a78bfa';

    // Use the streaming overlay - existing floor fusion path already sets this up.
    // We just need to stream output into the overlay.
    const onStreamChunk = (fullText, reasoningText) => {
        const bodyEl = document.getElementById('wizard-fusion-stream-body');
        if (!bodyEl) return;
        const wasAtBottom = (bodyEl.scrollTop + bodyEl.clientHeight >= bodyEl.scrollHeight - 50);
        const { body: cleanBody, thinking: inlineThinking } = splitInlineThinking(fullText);
        bodyEl.value = cleanBody;
        const thinking = (reasoningText || '').trim() || inlineThinking;
        if (thinking) {
            $('#wizard-fusion-stream-reasoning').val(thinking);
            $('#wizard-fusion-stream-reasoning-wrap').show().prop('open', true);
        }
        $('#wizard-fusion-stream-stats').text(`${cleanBody.length} 字符 · ${estimateTokens(cleanBody).toLocaleString()} tokens`);
        if ($('#wizard-fusion-stream-status').text().startsWith('连接中')) {
            $('#wizard-fusion-stream-status').text(`生成中... (${toName})`);
        }
        if (wasAtBottom) bodyEl.scrollTop = bodyEl.scrollHeight;
    };

    try {
        const result = await runIsolatedFusionCall(profile, [{ role: 'user', content: effectiveUserContent }], effectiveSystemPrompt, 0.2, 60000, fusionAbortController.signal, onStreamChunk);
        return { result, indices, profile, systemPrompt: effectiveSystemPrompt, userContent: effectiveUserContent };
    } catch (e) {
        if (e.name === 'AbortError') return null; // caller handles abort
        throw e;
    }
}

// Save summaries to server
async function saveSummariesToServer() {
    if (!activeChatId) return;
    try {
        await fetch('/api/plugins/st-memory-wizzard/save-summaries', {
            method: 'POST',
            headers: getWizardHeaders(),
            body: JSON.stringify({ chatId: activeChatId, summaries })
        });
        await loadSummaries(); // Redraw UI (also recomputes floorRemapState + 上下文融合标记)
    } catch (e) {
        console.error(`${LOG_PREFIX} Failed to save summaries`, e);
    }
}

// Save sandbox chat context to server
async function saveSandboxChatToServer() {
    if (!activeChatId) return;
    try {
        await fetch('/api/plugins/st-memory-wizzard/save-sandbox-chat', {
            method: 'POST',
            headers: getWizardHeaders(),
            body: JSON.stringify({ chatId: activeChatId, chat: sandboxChatContext })
        });
    } catch (e) {
        console.error(`${LOG_PREFIX} Failed to save sandbox chat`, e);
    }
}

// Load sandbox chat context from server
async function loadSandboxChatFromServer() {
    if (!activeChatId) return;
    try {
        const res = await fetch('/api/plugins/st-memory-wizzard/get-sandbox-chat', {
            method: 'POST',
            headers: getWizardHeaders(),
            body: JSON.stringify({ chatId: activeChatId })
        });
        const data = await res.json();
        if (Array.isArray(data)) {
            sandboxChatContext = data;
        } else {
            sandboxChatContext = [];
        }
    } catch (e) {
        console.error(`${LOG_PREFIX} Failed to load sandbox chat`, e);
        sandboxChatContext = [];
    }
    // A reload discards any in-session floor edits: reset dirty + hide the button.
    sandboxEditsDirty = false;
    $('#wizard-context-apply-btn').css('display', 'none');
}

// Keep the 上下文融合 sandbox snapshot in step with the live chat. The sandbox is a
// deliberately decoupled copy (so floor edits aren't clobbered by every refresh),
// but when its floor count differs from the live chat — chat grew with new replies,
// or floors were deleted — the snapshot is stale and must be re-pulled, otherwise the
// panel shows fewer floors than ST actually has (e.g. #977 while ST is at #1011).
// Skips when there are pending unsaved floor edits (don't destroy the user's draft)
// or when counts already match (nothing to do). Returns true iff it re-synced.
async function syncSandboxIfStale() {
    const context = window.SillyTavern?.getContext();
    const live = Array.isArray(context?.chat) ? context.chat : null;
    if (!live || !live.length) return false;
    if (sandboxEditsDirty) return false; // preserve unsaved floor edits
    if (Array.isArray(sandboxChatContext) && sandboxChatContext.length === live.length) return false;
    const prev = Array.isArray(sandboxChatContext) ? sandboxChatContext.length : 0;
    sandboxChatContext = JSON.parse(JSON.stringify(live));
    sandboxPage = 0;
    sandboxEditsDirty = false;
    $('#wizard-context-apply-btn').css('display', 'none');
    await saveSandboxChatToServer();
    writeLog(`上下文融合沙盒楼层数 (${prev}) 与酒馆当前 (${live.length}) 不符，已自动同步。`);
    return true;
}

// How many floors to render per page. Rendering thousands of live <textarea>
// nodes at once locks the main thread (the 3000+ floor freeze); paging keeps the
// DOM small while still giving access to every floor.
// Page size is user-adjustable (default 100). Persisted in config.sandboxPageSize.
let SANDBOX_PAGE_SIZE = 100;
let sandboxPage = 0;

// Apply a regex (config.sandboxRegex / the 时记 filter) to a message body. With a
// capture group, returns group 1; otherwise the whole match. Concatenates all
// matches (so multiple <recap>…</recap> in one message all survive). On empty
// pattern or no match / invalid regex, returns the original text unchanged for
// no-match-passthrough so the editor never silently blanks a message.
function applyRegexFilter(text, pattern) {
    if (!pattern) return text;
    let re;
    try {
        re = new RegExp(pattern, 'g');
    } catch (e) {
        return text; // invalid regex: passthrough
    }
    const parts = [];
    let m;
    while ((m = re.exec(text)) !== null) {
        parts.push(m[1] !== undefined ? m[1] : m[0]);
        if (m.index === re.lastIndex) re.lastIndex++; // guard against zero-width loops
    }
    return parts.length ? parts.join('\n') : text;
}

// Inverse of applyRegexFilter: DELETE every match (the whole matched text) from
// the body, keeping everything else. Used by 时记 rules in "remove" mode. On empty
// pattern / invalid regex / no match, returns the original text unchanged.
function applyRegexRemove(text, pattern) {
    if (!pattern) return text;
    let re;
    try {
        re = new RegExp(pattern, 'g');
    } catch (e) {
        return text; // invalid regex: passthrough
    }
    if (!re.test(text)) return text; // no match → unchanged
    re.lastIndex = 0;
    return text.replace(re, '').trim();
}

// Apply the 时记 multi-rule regex chain to a single floor's body. Each rule in
// config.shijiRules carries { regex, posMin, posMax, role, mode }. A rule applies
// to this floor only when (a) its backward position window [posMin, posMax]
// contains `pos` (newest floor = pos 1; null bound = open) AND (b) its role matches
// the floor's role ('both' matches any). Matching rules chain LEFT→RIGHT on the
// previous rule's output. mode controls the operation:
//   'keep'   (default) — keep ONLY the matched text (extract; applyRegexFilter)
//   'remove'           — delete the matched text, keep the rest (applyRegexRemove)
// Rules whose role/position don't match are no-ops — they never drop the floor
// ══════════════════════════════════════════════════════════════════════
// REGION: 时记规则 / 融合前正则（按角色+楼层位置窗的 regex 链式提取）
// ══════════════════════════════════════════════════════════════════════
// (mirrors ST's per-regex "Affects" with no opposite-side handling).
// Returns { text, appliedRuleIndices }.
function applyShijiRules(text, floorRole, pos) {
    const rules = Array.isArray(config.shijiRules) ? config.shijiRules : [];
    let scope = text || '';
    const appliedRuleIndices = [];
    for (let i = 0; i < rules.length; i++) {
        const rule = rules[i];
        if (!rule || !rule.regex) continue;
        const min = (rule.posMin == null) ? null : parseInt(rule.posMin);
        const max = (rule.posMax == null) ? null : parseInt(rule.posMax);
        if (min != null && !isNaN(min) && pos < min) continue;
        if (max != null && !isNaN(max) && pos > max) continue;
        const role = rule.role || 'both';
        if (role !== 'both' && role !== floorRole) continue; // role mismatch → no-op
        const out = rule.mode === 'remove'
            ? applyRegexRemove(scope, rule.regex)
            : applyRegexFilter(scope, rule.regex);
        if (out !== scope) {
            scope = out;
            appliedRuleIndices.push(i);
        }
    }
    return { text: scope, appliedRuleIndices };
}

// Apply the user-configured pre-summarization regex chain to a single floor's body
// before it enters the 日记/晨间日记/直融 LLM context. Each row in
// config.recapPreRegexRules carries { regex, posMin, posMax, role, mode }:
//   'keep'   (default) — keep ONLY the matched text (extract; applyRegexFilter)
//   'remove'           — delete the matched text, keep the rest (applyRegexRemove)
// A rule applies to this floor only when (a) its backward position window [posMin,
// posMax] contains `pos` (newest floor = pos 1; null/undefined bound = open) AND
// (b) its role matches the floor's role ('both' matches any). Position/role fields
// absent on legacy {regex, mode} rows are treated as open/both (back-compat).
// Rules chain top→bottom (each operates on the previous one's output). Empty pattern
// / invalid regex → passthrough. This shrinks bloated floors (CoT, status panels…)
// so auto-summary requests fit the context window.
function applyRecapPreRegex(text, floorRole, pos) {
    const rules = Array.isArray(config.recapPreRegexRules) ? config.recapPreRegexRules : [];
    if (!rules.length) {
        // Legacy single-pattern migration: a non-empty recapPreRegex is still honoured.
        const pattern = String(config.recapPreRegex || '').trim();
        if (!pattern) return text || '';
        return config.recapPreRegexMode === 'keep'
            ? applyRegexFilter(text || '', pattern)
            : applyRegexRemove(text || '', pattern);
    }
    let out = text || '';
    for (const rule of rules) {
        if (!rule || !rule.regex || !String(rule.regex).trim()) continue;
        const min = (rule.posMin == null || rule.posMin === '') ? null : parseInt(rule.posMin);
        const max = (rule.posMax == null || rule.posMax === '') ? null : parseInt(rule.posMax);
        if (min != null && !isNaN(min) && pos != null && pos < min) continue;
        if (max != null && !isNaN(max) && pos != null && pos > max) continue;
        const role = rule.role || 'both';
        if (role !== 'both' && floorRole && role !== floorRole) continue; // role mismatch → no-op
        out = rule.mode === 'keep'
            ? applyRegexFilter(out, rule.regex)
            : applyRegexRemove(out, rule.regex);
    }
    return out;
}

// ---- Context-fusion match/filter tags ----------------------------------------
// Read a message's raw body regardless of which key it uses.
function msgBody(msg) {
    if (!msg) return "";
    const key = msg.content !== undefined ? 'content' : 'mes';
    return msg[key] || "";
}

// Parse a message's send_date into a comparable timestamp (ms). ST stores varied
// formats; Date.parse handles most. Returns NaN when unknown.
function msgTimestamp(msg) {
    if (!msg) return NaN;
    if (typeof msg.send_date === 'number') return msg.send_date;
    let raw = msg.send_date || '';
    if (!raw) return NaN;
    let t = Date.parse(raw);
    if (isNaN(t)) {
        // SillyTavern's default format is "January 12, 2026 4:17pm" — note there is
        // NO space before am/pm, which Date.parse rejects. Insert it and retry.
        const fixed = String(raw).replace(/(\d)\s*(am|pm)\b/i, '$1 $2');
        t = Date.parse(fixed);
    }
    return isNaN(t) ? NaN : t;
}

// ====================================================================
// DELETE-FLOOR RESILIENCE — realign absolute floor pointers via anchors
// --------------------------------------------------------------------
// summaries.lastArchivedIndex and every record's coveredFloors {lo,hi} are
// absolute chat array indices. When the user manually deletes the first N chat
// messages, the whole array shifts left by N and every pointer is off by N.
// We persist stable fingerprints ("anchors") of a few boundary messages; on each
// load / before each archive we relocate them in the current chat, compute the
// shift delta, and translate all pointers. Anything uncertain → leave untouched.
// ====================================================================

const ANCHOR_STRONG = 8;  // ts(4) + head(4) — high-confidence match
const ANCHOR_OK = 6;      // minimum score to trust a relocation

// Build a stable fingerprint of the message at `idx` in the current coordinate
// ══════════════════════════════════════════════════════════════════════
// REGION: 删楼重映射（锚点指纹 / 楼层指针重对齐 / 时间映射标注）
// ══════════════════════════════════════════════════════════════════════
// system. send_date is only minute-resolution, so we combine it with body
// head/tail fingerprints, role flags, name, and length.
function makeFloorAnchor(chatList, idx) {
    const m = chatList[idx];
    if (!m) return null;
    const body = msgBody(m);
    return {
        idx,
        ts: msgTimestamp(m),
        isUser: !!m.is_user,
        isSystem: !!m.is_system,
        name: m.name || "",
        len: body.length,
        head: body.slice(0, 64),
        tail: body.slice(-32),
        chatLen: chatList.length,
    };
}

// Score how well message `m` matches anchor `a`. Tolerates body edits: head and
// ts each carry strong weight; tail is the fallback when the head was edited.
function anchorScore(m, a) {
    if (!m || !a) return -1;
    let s = 0;
    const ts = msgTimestamp(m);
    if (!isNaN(ts) && !isNaN(a.ts) && ts === a.ts) s += 4;
    if (!!m.is_user === a.isUser) s += 1;
    if (!!m.is_system === a.isSystem) s += 1;
    if ((m.name || "") === a.name) s += 1;
    const body = msgBody(m);
    if (body.slice(0, 64) === a.head) s += 4;
    else if (body.slice(-32) === a.tail) s += 3;
    if (Math.abs(body.length - a.len) <= 8) s += 1;
    return s;
}

// Find anchor `a`'s new index in chatList. Front-deletion shifts indices left, so
// scan from the old index leftward first; fall back to the right side. Returns
// { idx, score, ambiguous } or null when no trustworthy match exists.
function relocateAnchor(chatList, a) {
    if (!a) return null;
    const L = chatList.length;
    let best = -1, bestScore = -1, second = -1;

    const upper = Math.min(a.idx, L - 1);
    for (let i = upper; i >= 0; i--) {
        const sc = anchorScore(chatList[i], a);
        if (sc > bestScore) { second = bestScore; bestScore = sc; best = i; }
        else if (sc > second) second = sc;
    }
    if (bestScore < ANCHOR_OK) {
        for (let i = a.idx + 1; i < L; i++) {
            const sc = anchorScore(chatList[i], a);
            if (sc > bestScore) { second = bestScore; bestScore = sc; best = i; }
            else if (sc > second) second = sc;
        }
    }
    if (best < 0 || bestScore < ANCHOR_OK) return null;
    // Ambiguous: top and runner-up scores are close (e.g. several similar
    // messages in the same minute) and not a strong match → don't trust it.
    const ambiguous = (bestScore - second) < 2 && bestScore < ANCHOR_STRONG;
    return { idx: best, score: bestScore, ambiguous };
}

// Majority vote over candidate deltas. With >=2 anchors require at least 2 in
// agreement; otherwise fall back to the boundary anchor's delta. Returns the
// consensus delta or null when anchors disagree with no boundary fallback.
function pickConsensusDelta(cands) {
    const counts = new Map();
    for (const c of cands) counts.set(c.delta, (counts.get(c.delta) || 0) + 1);
    let bestDelta = null, bestN = 0;
    for (const [d, n] of counts) if (n > bestN) { bestN = n; bestDelta = d; }
    if (cands.length >= 2 && bestN < 2) {
        const b = cands.find(c => c.key === 'boundary');
        return b ? b.delta : null;
    }
    return bestDelta;
}

// Translate every absolute floor pointer by `delta` (positive = floors removed
// from the front). Records whose entire covered range was deleted have their
// pointer cleared (text preserved; jump button auto-hides).
function shiftAllFloorPointers(delta) {
    const oldLAI = summaries.lastArchivedIndex || 0;
    summaries.lastArchivedIndex = Math.max(0, oldLAI - delta);

    for (const key of ['recaps', 'weeklySummaries', 'historicalSummaries']) {
        const arr = summaries[key];
        if (!Array.isArray(arr)) continue;
        arr.forEach((item, i) => {
            const r = sumCoveredFloors(item);
            if (!r) return;
            const lo = r.lo - delta, hi = r.hi - delta;
            if (hi < 0) {
                sumSetCoveredFloors(arr, i, NaN, NaN); // whole range deleted → clear
            } else {
                sumSetCoveredFloors(arr, i, Math.max(0, lo), hi);
            }
        });
    }
}

// Rebuild the anchor bundle in the current coordinate system. Boundary anchor =
// the last archived floor; firstCovered/lastCovered = global min lo / max hi of
// all covered ranges (useful cross-checks for the vote).
function refreshFloorAnchors(chatList) {
    if (!Array.isArray(chatList) || chatList.length === 0) return;
    const L = chatList.length;
    const lai = Math.min(L - 1, Math.max(0, (summaries.lastArchivedIndex || 0) - 1));
    let minLo = Infinity, maxHi = -Infinity;
    for (const key of ['recaps', 'weeklySummaries', 'historicalSummaries']) {
        for (const it of (summaries[key] || [])) {
            const r = sumCoveredFloors(it);
            if (!r) continue;
            minLo = Math.min(minLo, r.lo);
            maxHi = Math.max(maxHi, r.hi);
        }
    }
    summaries.floorAnchors = {
        version: 1,
        boundary: makeFloorAnchor(chatList, lai),
        firstCovered: isFinite(minLo) ? makeFloorAnchor(chatList, Math.min(L - 1, Math.max(0, minLo))) : null,
        lastCovered: isFinite(maxHi) ? makeFloorAnchor(chatList, Math.min(L - 1, Math.max(0, maxHi))) : null,
        chatLen: L,
        savedAt: new Date().toISOString(),
    };
}

// Detect a front-deletion and realign all floor pointers. Returns
// { realigned, delta, reason }. Only shifts when "chat shrank + anchors agree on
// delta>0"; every other case leaves data untouched (conservative).
async function detectAndRealignFloors(chatList) {
    if (!Array.isArray(chatList) || chatList.length === 0) {
        return { realigned: false, delta: 0, reason: 'no-chat' };
    }
    const A = summaries.floorAnchors;

    // First run / legacy data with no anchors: just initialize, don't shift.
    if (!A || !A.boundary) {
        refreshFloorAnchors(chatList);
        return { realigned: false, delta: 0, reason: 'init' };
    }

    // Chat didn't shrink → append / swipe / tail-delete. Refresh anchors, no shift.
    const lenDelta = (A.chatLen || 0) - chatList.length;
    if (lenDelta <= 0) {
        refreshFloorAnchors(chatList);
        return { realigned: false, delta: 0, reason: 'grew-or-same' };
    }

    // Relocate each anchor and collect candidate deltas (skip ambiguous ones).
    const cands = [];
    for (const k of ['boundary', 'firstCovered', 'lastCovered']) {
        const a = A[k];
        if (!a) continue;
        const r = relocateAnchor(chatList, a);
        if (r && !r.ambiguous) cands.push({ key: k, delta: a.idx - r.idx, score: r.score });
    }

    if (cands.length === 0) {
        writeLog('抗删楼: 无法可信重定位任何锚点, 保守不平移。', 'WARNING');
        return { realigned: false, delta: 0, reason: 'no-anchor-match' };
    }

    const delta = pickConsensusDelta(cands);
    if (delta === null) {
        writeLog('抗删楼: 各锚 delta 不一致, 保守不平移。', 'WARNING');
        return { realigned: false, delta: 0, reason: 'disagree' };
    }
    if (delta === 0) {
        refreshFloorAnchors(chatList);
        return { realigned: false, delta: 0, reason: 'zero' };
    }
    if (delta < 0) {
        writeLog(`抗删楼: 推断 delta=${delta}<0 (非删前部), 保守不平移。`, 'WARNING');
        refreshFloorAnchors(chatList);
        return { realigned: false, delta: 0, reason: 'negative' };
    }

    // High-confidence front-deletion: translate all pointers.
    shiftAllFloorPointers(delta);
    refreshFloorAnchors(chatList);
    writeLog(`抗删楼: 检测到前部删除 delta=${delta} (锚点投票 ${cands.map(c => c.key + ':' + c.delta).join(', ')}), 已平移所有楼层指针。`);
    await saveSummariesToServer();
    return { realigned: true, delta, reason: 'shifted' };
}

// Compute a read-only floor-remap annotation for every summary record and store it
// in floorRemapState (a Map keyed "type:index"). Does NOT mutate summaries data.
//
// Approach: HIT-BASED on send-time — for each record, ask whether the CURRENT chat
// still contains any message whose send_date falls inside the record's send-time
// range. This is index-independent and works regardless of total floor count (a
// record covering original floors 0-300 is "deleted" if no current message's time
// lands in its window, even when the chat now has 800 floors).
//
//   - f = current floors whose send_date ∈ [span.start, span.end]
//   - f === null (no hit)             → 'deleted'  → "原 X-Y 楼（已删）"
//   - f found, record starts within    → 'present'  → "现 A-B 楼"
//     surviving chat (span.start ≥ earliestChatTs)
//   - f found, but record begins BEFORE → 'partial' → "原 X-Y 楼 → 现 A-B 楼"
//     the earliest surviving message    (front part of the record was deleted)
//   - no usable send-time info          → 'unknown' (no annotation)
function computeFloorRemap(chatList) {
    const chatLen = Array.isArray(chatList) ? chatList.length : 0;

    // Earliest surviving send_date (scan from the front for the first parseable ts).
    let earliestChatTs = NaN;
    for (let i = 0; i < chatLen; i++) {
        const t = msgTimestamp(chatList[i]);
        if (!isNaN(t)) { earliestChatTs = t; break; }
    }

    // Find the current floor index range whose send_date falls in [tStart, tEnd].
    // Returns { lo, hi } of matching floors, or null when none match.
    // tEnd is expanded by 59 999 ms to cover the full minute of the end timestamp,
    // since send_date is minute-precision ("Jan 12, 2026 4:17pm") and messages
    // written within the same minute as the record boundary would otherwise be missed.
    const floorsInTimeRange = (tStart, tEnd) => {
        const tEndInclusive = tEnd + 59999;
        let lo = -1, hi = -1;
        for (let i = 0; i < chatLen; i++) {
            const t = msgTimestamp(chatList[i]);
            if (isNaN(t)) continue;
            if (t >= tStart && t <= tEndInclusive) {
                if (lo === -1) lo = i;
                hi = i;
            }
        }
        return lo === -1 ? null : { lo, hi };
    };

    const map = new Map();
    const layers = [
        { type: 'historical', arr: summaries.historicalSummaries },
        { type: 'weekly',     arr: summaries.weeklySummaries },
        { type: 'recap',      arr: summaries.recaps },
    ];
    for (const { type, arr } of layers) {
        if (!Array.isArray(arr)) continue;
        arr.forEach((item, i) => {
            const key = `${type}:${i}`;
            const orig = sumStoredCoveredFloors(item); // original stored floors (for deleted/partial label)
            const origLabel = orig ? `${orig.lo}-${orig.hi}` : '';

            // Manual "现存楼层" overrides the CURRENT range only after time proves the
            // record still has surviving messages. It must NOT bypass deletion detection:
            // whether to show 已删 is decided by realTimespan/send_date.
            const manual = sumNowFloors(item);

            const span = recordSendTimeRange(item); // {start, end} ms — index-independent
            // No usable time info → can't decide by time. Fall back to the original floor
            // range overlap with the current chat ONLY here (records with a frozen
            // realTimespan never reach this branch — time decides for them). When the
            // overlap is empty (original floors entirely past the current chat tail),
            // there is nothing surviving to show → deleted.
            if (!span || isNaN(span.start) || isNaN(span.end)) {
                if (orig) {
                    if (chatLen === 0 || orig.lo >= chatLen || orig.hi < 0) {
                        map.set(key, { status: 'deleted', origLabel });
                    } else if (orig.lo < 0 || orig.hi >= chatLen) {
                        const sLo = Math.max(0, orig.lo), sHi = Math.min(chatLen - 1, orig.hi);
                        if (sLo <= sHi) {
                            map.set(key, { status: 'partial', origLabel, surviveLo: sLo, surviveHi: sHi });
                        } else {
                            map.set(key, { status: 'deleted', origLabel });
                        }
                    } else {
                        map.set(key, { status: 'present', origLabel, newLo: orig.lo, newHi: orig.hi });
                    }
                } else {
                    map.set(key, { status: 'unknown' });
                }
                return;
            }
            // Empty chat → everything is deleted.
            if (chatLen === 0 || isNaN(earliestChatTs)) {
                map.set(key, { status: 'deleted', origLabel });
                return;
            }

            const f = floorsInTimeRange(span.start, span.end);
            if (!f) {
                // No current message's send_date landed in the window. But "no hit" can
                // happen due to send_date parsing/precision quirks, not true deletion.
                // Only declare deleted when the ENTIRE window precedes the earliest
                // surviving message; otherwise it's a partial (front deleted, tail alive
                // but its exact floors couldn't be matched by send_date).
                if (span.end < earliestChatTs) {
                    map.set(key, { status: 'deleted', origLabel });
                } else {
                    map.set(key, { status: 'partial', origLabel, surviveLo: 0, surviveHi: -1 });
                }
            } else if (manual) {
                map.set(key, { status: 'present', origLabel, newLo: manual.lo, newHi: manual.hi });
            } else if (span.start >= earliestChatTs) {
                // The record begins at or after the earliest surviving message → the
                // whole record still exists in the chat; show its current floors.
                // origLabel is needed by the renderer to decide whether the floors moved.
                map.set(key, { status: 'present', origLabel, newLo: f.lo, newHi: f.hi });
            } else {
                // The record begins before the earliest surviving message → its front
                // portion was deleted; only the tail survives → partial.
                map.set(key, { status: 'partial', origLabel, surviveLo: f.lo, surviveHi: f.hi });
            }
        });
    }
    return map;
}

// Make sure floorRemapState is computed against a real chat array, so coverage-badge
// maps never fall back to stale stored coveredFloors. Prefers the live ST chat, then
// the sandbox chat context. This is the gate that guarantees the remap verdict
// (deleted/present/partial) — and therefore "已删" — is decided by send-time.
function ensureFloorRemap() {
    let chat = null;
    try { chat = window.SillyTavern?.getContext()?.chat; } catch (e) { chat = null; }
    if (!Array.isArray(chat) || !chat.length) {
        chat = Array.isArray(sandboxChatContext) ? sandboxChatContext : null;
    }
    if (Array.isArray(chat) && chat.length) {
        floorRemapState = computeFloorRemap(chat);
    } else {
        floorRemapState = null;
    }
}
// MUST be independent of current chat indices: after a front-delete, coveredFloors
// (original indices) point at DIFFERENT surviving messages, so re-deriving timestamps
// from them would read the wrong messages and mislabel a deleted record as present.
// We therefore use ONLY the stored `realTimespan` string ("YYYY-MM-DD HH:mm" or
// "… ~ …"), which was frozen from the original messages' send_dates at creation /
// fusion time. Records created before realTimespan existed return null → 'unknown'.
function recordSendTimeRange(item /*, chatList unused by design */) {
    // Prefer the stored realTimespan (frozen at creation/fusion), but fall back to the
    // time window derived from the visible source "楼层 X-Y" against the current chat.
    // This keeps deletion detection correct even when the stored realTimespan is stale
    // or was never synced after the user manually corrected the floor range.
    let str = sumRealTimespan(item);
    if (!str) str = realTimespanFromSource(sumSource(item));
    if (!str) return null;
    const parts = String(str).split('~').map(s => s.trim()).filter(Boolean);
    const tsList = parts.map(p => Date.parse(p)).filter(t => !isNaN(t));
    if (!tsList.length) return null;
    return { start: Math.min(...tsList), end: Math.max(...tsList) };
}

// The AI model used for a message, mirroring how ST stores it on the chat entry.
function msgModel(msg) {
    if (!msg) return "";
    return (msg.extra && (msg.extra.model || msg.extra.api)) || msg.model || "";
}

// 关键词的三种匹配方式。只有用空格分词时三者才有区别（单个词下完全等价）。
// 以查询「A B」为例：
//   phrase — 整段匹配：只命中连在一起的「A B」（默认）
//   and    — 分开匹配：楼层同时含 A 和 B 即可，位置不必相连
//   or     — 任一匹配：楼层含 A 或 B 就命中
const KEYWORD_MODES = {
    phrase: '整段匹配',
    and: '分开匹配 (且)',
    or: '任一匹配 (或)',
};

// The live keyword box's mode, falling back to the phrase default for an
// unrecognised or missing config value.
function liveKeywordMode() {
    return KEYWORD_MODES[config.sandboxKeywordMode] ? config.sandboxKeywordMode : 'phrase';
}

// A keyword TAG's mode. Tags saved before this setting existed carry no kwMode and
// were AND-matched when they were built, so they keep meaning what they meant then
// rather than silently re-interpreting as the new phrase default.
function keywordModeOf(tag) {
    return KEYWORD_MODES[tag && tag.kwMode] ? tag.kwMode : 'and';
}

// Whitespace-separated terms of a keyword query.
function keywordTerms(keyword) {
    return String(keyword || '').trim().split(/\s+/).filter(Boolean);
}

// The keyword currently driving filtering/highlighting: the live box wins, otherwise
// the first keyword tag. Returns { kw, mode } so callers never pair a keyword with
// the wrong mode.
function activeKeywordQuery() {
    const live = (config.sandboxKeyword || '').trim();
    if (live) return { kw: live, mode: liveKeywordMode() };
    const tag = sandboxFilters.find(f => f.type === 'keyword' && f.value);
    return tag ? { kw: tag.value, mode: keywordModeOf(tag) } : { kw: '', mode: 'phrase' };
}

// HTML-escape `text`, then wrap every case-insensitive occurrence of `kw` in an
// orange <mark>. The FIRST match additionally carries class `wizard-kw-hit` so the
// caller can scroll it into the center of view. Returns { html, hits }.
// `mode` mirrors the matcher: phrase highlights the whole query (spaces included) as
// one unit, and/or highlight each term separately.
function highlightKeyword(text, kw, mode) {
    const safe = escapeHtml(text);
    if (!kw) return { html: safe, hits: 0 };
    const esc = (s) => escapeHtml(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const parts = mode === 'phrase'
        ? [esc(String(kw).trim())].filter(Boolean)
        : keywordTerms(kw).map(esc);
    if (!parts.length) return { html: safe, hits: 0 };
    let hits = 0;
    const html = safe.replace(new RegExp(parts.join('|'), 'gi'), (m) => {
        hits++;
        const cls = hits === 1 ? 'wizard-kw-hit' : '';
        return `<mark class="${cls}" style="background:#f97316; color:#1a1a1a; border-radius:2px; padding:0 1px;">${m}</mark>`;
    });
    return { html, hits };
}

// Does this floor's text satisfy the keyword query under `mode`? See KEYWORD_MODES.
function keywordMatches(text, keyword, mode) {
    const haystack = String(text || '').toLowerCase();
    const query = String(keyword || '').trim().toLowerCase();
    if (!query) return true;
    if (mode === 'phrase') return haystack.includes(query);
    const terms = keywordTerms(query);
    if (!terms.length) return true;
    return mode === 'or'
        ? terms.some(term => haystack.includes(term))
        : terms.every(term => haystack.includes(term));
}

// Does a regex tag's optional role/position window apply to this floor?
// A regex tag may carry { posMin, posMax, role } (same semantics as 时记 rules):
//   role: 'ai' | 'user' | 'both'(default) — System grouped with AI side.
//   posMin/posMax: backward position window (newest floor = pos 1; null = open).
// `pos` is computed from the floor's backward index. When `floor` is unknown
// (legacy callers passing no floor), position is treated as open. Tags with no
// role/position fields (legacy {type:'regex', value}) always apply (back-compat).
function sandboxRegexTagApplies(tag, msg, floor) {
    if (!tag) return false;
    const role = tag.role || 'both';
    if (role !== 'both') {
        const floorRole = msgRoleSide(msg); // system -> ai side
        if (role !== floorRole) return false;
    }
    const hasPos = (tag.posMin != null && tag.posMin !== '') || (tag.posMax != null && tag.posMax !== '');
    if (hasPos && typeof floor === 'number') {
        const L = (typeof sandboxChatContext !== 'undefined' && Array.isArray(sandboxChatContext)) ? sandboxChatContext.length : 0;
        const pos = L - floor; // newest floor (floor = L-1) -> pos 1
        const min = (tag.posMin == null || tag.posMin === '') ? null : parseInt(tag.posMin);
        const max = (tag.posMax == null || tag.posMax === '') ? null : parseInt(tag.posMax);
        if (min != null && !isNaN(min) && pos < min) return false;
        if (max != null && !isNaN(max) && pos > max) return false;
    }
    return true;
}

// The effective extraction for one message. Each regex tag carries a mode:
//   'keep'   (default) — keep ONLY the matched text (extract; applyRegexFilter)
//   'remove'           — delete the matched text, keep the rest (applyRegexRemove)
// Two-phase so the legacy all-keep behavior is preserved exactly:
//   1. Apply every REMOVE tag (in tag order) to the body → reduced body.
//   2. Concatenate every KEEP tag's extraction FROM the reduced body (tag order).
//      If no keep tag matched, fall back to the reduced body.
// When all tags are keep (the only case that existed before this feature), phase 1
// is a no-op and phase 2 == the old concatenation behavior — zero behavior change.
//
// Keyword tags do NOT alter extracted text, only whether a message is included.
// Role precedence: a message on the excluded-but-kept (greyed) side passes through
// UNCHANGED — regex extraction is for the kept side only. A regex tag whose own
// role/position window doesn't match this floor is a no-op (skipped entirely),
// mirroring 时记/融合前正则 rule semantics.
function extractFusionBody(msg, floor) {
    if (isRoleExcludedGreyed(msg)) return msgBody(msg);
    const regexTags = sandboxFilters.filter(f => f.type === 'regex' && f.value && sandboxRegexTagApplies(f, msg, floor));
    if (regexTags.length) {
        const body = msgBody(msg);
        // Phase 1: removes narrow the body in tag order.
        let reduced = body;
        for (const t of regexTags) {
            if (t.mode === 'remove') reduced = applyRegexRemove(reduced, t.value);
        }
        // Phase 2: keeps extract from the reduced body and concatenate.
        const keepTags = regexTags.filter(t => t.mode !== 'remove');
        if (keepTags.length) {
            const parts = keepTags
                .map(t => applyRegexFilter(reduced, t.value))
                // Drop tags that didn't actually extract anything (applyRegexFilter
                // returns the full text on no-match; treat that as "nothing from this tag").
                .filter(out => out && out !== reduced);
            if (parts.length) return parts.join('\n');
            return reduced; // no keep regex matched -> inject the reduced body
        }
        // Only remove tags present -> the reduced body is the result.
        return reduced;
    }
    // Backward-compat: the standalone Regex input (config.sandboxRegex) still works
    // when no regex tag is present.
    const legacy = (config.sandboxRegex || '').trim();
    if (legacy) return applyRegexFilter(msgBody(msg), legacy);
    return msgBody(msg);
}

// The text a keyword tag searches WITHIN, honoring left-to-right tag precedence:
// the further left a tag sits, the higher its weight. Every regex tag positioned
// BEFORE this keyword tag first narrows the scope (its extracted text), and the
// keyword then searches only inside that narrowed text. A keyword with no regex
// to its left searches the full body. `kwTagIndex` is the keyword tag's index in
// sandboxFilters; pass -1 for the live keyword box (treated as right-most, so it
// inherits every regex tag's narrowing).
function keywordScopeText(msg, kwTagIndex, floor) {
    let scope = msgBody(msg);
    const limit = kwTagIndex < 0 ? sandboxFilters.length : kwTagIndex;
    for (let i = 0; i < limit; i++) {
        const f = sandboxFilters[i];
        if (f.type === 'regex' && f.value && sandboxRegexTagApplies(f, msg, floor)) {
            if (f.mode === 'remove') {
                // A remove tag narrows the scope to "everything except the match".
                scope = applyRegexRemove(scope, f.value);
            } else {
                const out = applyRegexFilter(scope, f.value);
                // applyRegexFilter returns the full text on no-match; if nothing was
                // extracted, the regex narrowed to empty for keyword purposes.
                scope = (out && out !== scope) ? out : (() => {
                    let re; try { re = new RegExp(f.value); } catch (e) { re = null; }
                    return (re && re.test(scope)) ? scope : '';
                })();
            }
            if (!scope) break;
        }
    }
    return scope;
}

// Decide whether a message passes all active FILTER tags (regex / keyword / time).
// 'size' is a sort directive and never filters.
function messagePassesFilters(msg, floor, coverageMap) {
    // --- FLOOR-RANGE FILTER (needs the floor number) --------------------------
    // "按楼层范围筛选": only show floors whose absolute floor number falls in
    // [lo, hi] (inclusive). Driven by the dedicated 筛楼层 button next to the
    // pager, which reads the 上下文融合 起始/结束楼层 inputs. Multiple such tags
    // intersect (the strictest wins); usually there's just one.
    const floorRangeTags = sandboxFilters.filter(f => f.type === 'floorRange' && f.value);
    if (floorRangeTags.length) {
        if (typeof floor !== 'number') return false;
        for (const fr of floorRangeTags) {
            const { lo, hi } = fr.value;
            if (typeof lo === 'number' && floor < lo) return false;
            if (typeof hi === 'number' && floor > hi) return false;
        }
    }

    // --- RECORD-COVERAGE FILTER (needs the floor number) ----------------------
    // "按记筛选": only show floors marked by a specific record layer (史记/周记/日记).
    // Uses the per-floor coverage map (same source as the purple badges); the map's
    // winning type per floor follows historical > weekly > recap, so this matches what
    // the badge displays. Multiple record tags AND together (rarely useful, but
    // consistent). Floors with no coverage of the requested type are dropped.
    const recordTags = sandboxFilters.filter(f => f.type === 'record' && f.value);
    if (recordTags.length) {
        const map = coverageMap || buildRemappedCoverageMap();
        const cov = (typeof floor === 'number') ? map.get(floor) : null;
        for (const rt of recordTags) {
            if (!cov || cov.type !== rt.value) return false;
            // If the tag also specifies a record name, match the exact entry by index.
            if (rt.name) {
                const arr = getSummaryArray(cov.type) || [];
                const typeName = SUMMARY_TYPE_NAMES[cov.type] || cov.type;
                const entryName = sumName(arr[cov.index]) || `${typeName}#${cov.index + 1}`;
                if (entryName !== rt.name) return false;
            }
        }
    }

    // --- ROLE HAS THE HIGHEST PRIORITY ----------------------------------------
    // The role filter decides the OBJECT SET first: it determines which side
    // (AI / User) is in scope. All other filters (regex / keyword / time / model)
    // only narrow WITHIN the role-selected side.
    //
    //   keep side       -> subject to the other filters below.
    //   excluded side   -> 'remove': dropped outright (other filters irrelevant);
    //                      'keep'  : passes through UNCHANGED for fusion (regex/time/
    //                                model narrowing does NOT apply to it) — BUT a
    //                                keyword is a hard "must contain" inclusion filter:
    //                                a passthrough floor that lacks the keyword is still
    //                                excluded. The passthrough side has no regex
    //                                extraction, so the keyword searches its full body.
    const roleTag = sandboxFilters.find(f => f.type === 'role' && f.value);
    let passthroughSide = false;
    if (roleTag) {
        const keep = typeof roleTag.value === 'string' ? roleTag.value : roleTag.value.keep;
        const excluded = typeof roleTag.value === 'string' ? 'remove' : (roleTag.value.excluded || 'remove');
        const isUser = !!msg.is_user;
        const isExcludedSide = (keep === 'ai' && isUser) || (keep === 'user' && !isUser);
        if (isExcludedSide) {
            if (excluded === 'remove') return false; // drop the excluded side entirely
            passthroughSide = true;                  // kept as-is, but keyword still gates it
        }
        // else: this is the kept side -> fall through to the other filters.
    }

    // Keyword gate for the passthrough side: it skips regex/time/model narrowing, but
    // any active keyword (tag or live box) must still be present in its full body.
    if (passthroughSide) {
        const liveKwPT = (config.sandboxKeyword || '').trim();
        const body = msgBody(msg);
        if (liveKwPT && !keywordMatches(body, liveKwPT, liveKeywordMode())) return false;
        for (const f of sandboxFilters) {
            if (f.type === 'keyword' && f.value && !keywordMatches(body, f.value, keywordModeOf(f))) return false;
        }
        return true;
    }

    // --- Lower-priority filters apply only to the in-scope (kept) side ----------
    // Live keyword (typed in the keyword box, applies without a tag). It is treated
    // as right-most, so every regex tag narrows its search scope (left = stronger).
    const liveKw = (config.sandboxKeyword || '').trim();
    if (liveKw && !keywordMatches(keywordScopeText(msg, -1, floor), liveKw, liveKeywordMode())) return false;
    for (let fi = 0; fi < sandboxFilters.length; fi++) {
        const f = sandboxFilters[fi];
        if (f.type === 'keyword' && f.value) {
            // ctrl+F style: case-insensitive substring search, but ONLY within the
            // text left by regex tags positioned to this keyword's LEFT (higher
            // weight). With no regex to its left, it searches the full body.
            if (!keywordMatches(keywordScopeText(msg, fi, floor), f.value, keywordModeOf(f))) return false;
        } else if (f.type === 'regex' && f.value) {
            // A KEEP regex tag also acts as a filter (AND): the message must contain a
            // match for EVERY active keep tag. Multiple regex tags are allowed.
            // A regex tag whose role/position window doesn't match this floor is a
            // no-op here (doesn't filter the floor out) — mirrors extraction semantics.
            // A REMOVE tag never filters the floor out (it only shortens the body when
            // matched, and a no-match remove leaves the body intact) — so skip it here.
            if (f.mode === 'remove') continue;
            if (!sandboxRegexTagApplies(f, msg, floor)) continue;
            let re;
            try { re = new RegExp(f.value); } catch (e) { re = null; }
            if (re && !re.test(msgBody(msg))) return false;
        } else if (f.type === 'time' && f.value) {
            // value: { from, to } as ms timestamps (either may be null).
            const ts = msgTimestamp(msg);
            if (isNaN(ts)) return false;
            if (f.value.from != null && ts < f.value.from) return false;
            if (f.value.to != null && ts > f.value.to) return false;
        } else if (f.type === 'model' && f.value) {
            if (msgModel(msg) !== f.value) return false;
        }
        // role handled above (highest priority); skip here.
    }
    return true;
}

// True when a role filter is set to "原样保留" AND this message is on the EXCLUDED
// side — i.e. it is still sent/kept and passes through UNCHANGED (regex extraction
// does not apply to it). Returns false when the excluded side is being removed
// (those rows never reach the view) or no role tag is active.
function isRoleExcludedGreyed(msg) {
    const roleTag = sandboxFilters.find(f => f.type === 'role' && f.value);
    if (!roleTag) return false;
    const keep = typeof roleTag.value === 'string' ? roleTag.value : roleTag.value.keep;
    const excluded = typeof roleTag.value === 'string' ? 'remove' : (roleTag.value.excluded || 'remove');
    if (excluded !== 'keep') return false; // 'remove' side isn't in the list at all
    const isUser = !!msg.is_user;
    // The excluded side is the OPPOSITE of `keep`.
    return (keep === 'ai' && isUser) || (keep === 'user' && !isUser);
}

// Build the working set of {msg, floor} for the current sandbox, applying filter
// tags and the size-sort directive (if present). Floor = original mesid.
function getFilteredSandboxEntries() {
    let entries = sandboxChatContext.map((msg, floor) => ({ msg, floor }));
    // Precompute the coverage map once when a record filter is active (avoids
    // rebuilding it per message inside messagePassesFilters).
    const covMap = sandboxFilters.some(f => f.type === 'record' && f.value) ? buildRemappedCoverageMap() : null;
    entries = entries.filter(e => messagePassesFilters(e.msg, e.floor, covMap));
    const sizeTag = sandboxFilters.find(f => f.type === 'size');
    if (sizeTag) {
        const dir = sizeTag.value === 'asc' ? 1 : -1;
        entries.sort((a, b) => (msgBody(a.msg).length - msgBody(b.msg).length) * dir);
    }
    return entries;
}

// Compile the {{history}} block: the FULL matched context window — every message
// passing the active filters, in current order, each formatted "#floor [name]: body"
// where body is the regex-extracted portion when a regex/legacy filter is active.
// Used by the {{history}} macro and as the fusion history payload.
function compileHistory() {
    const entries = getFilteredSandboxEntries();
    const block = entries.map(({ msg, floor }) => {
        const name = msgName(msg);
        return `#${floor} [${name}]: ${extractFusionBody(msg, floor)}`;
    }).join('\n');
    lastCompiledHistory = block;
    return block;
}

// Short human label for a filter tag chip.
function filterTagLabel(f) {
    if (f.type === 'regex') {
        const modeStr = f.mode === 'remove' ? ' · 移除' : '';
        const role = f.role || 'both';
        const roleStr = role === 'ai' ? ' · AI' : (role === 'user' ? ' · User' : '');
        const min = (f.posMin == null || f.posMin === '') ? null : f.posMin;
        const max = (f.posMax == null || f.posMax === '') ? null : f.posMax;
        let posStr = '';
        if (min != null && max != null) posStr = ` · 第${min}-${max}新`;
        else if (max != null) posStr = ` · 最新${max}楼内`;
        else if (min != null) posStr = ` · 第${min}新及更早`;
        return `正则: ${f.value}${modeStr}${roleStr}${posStr}`;
    }
    // Only label the mode when the query has several terms — with one term all three
    // modes behave identically and the suffix would be noise on every tag.
    if (f.type === 'keyword') {
        const suffix = keywordTerms(f.value).length > 1 ? ` [${KEYWORD_MODES[keywordModeOf(f)]}]` : '';
        return `关键词: ${f.value}${suffix}`;
    }
    if (f.type === 'model') return `模型: ${f.value}`;
    if (f.type === 'role') {
        const keep = typeof f.value === 'string' ? f.value : f.value.keep;
        const excluded = typeof f.value === 'string' ? 'remove' : (f.value.excluded || 'remove');
        const keepLabel = keep === 'user' ? 'User' : 'AI';
        const exLabel = excluded === 'remove' ? '移除另一方' : '另一方原样保留';
        return `筛选角色: ${keepLabel} · ${exLabel}`;
    }
    if (f.type === 'record') {
        const typeName = SUMMARY_TYPE_NAMES[f.value] || f.value;
        return f.name ? `按记筛选: ${typeName} · ${f.name}` : `按记筛选: 仅${typeName}标注的楼层`;
    }
    if (f.type === 'floorRange') {
        const { lo, hi } = f.value || {};
        const loStr = (typeof lo === 'number') ? lo : '…';
        const hiStr = (typeof hi === 'number') ? hi : '…';
        return `楼层范围: ${loStr}-${hiStr}`;
    }
    if (f.type === 'size') return `按字数${f.value === 'asc' ? '升序' : '降序'}`;
    if (f.type === 'time') {
        const fmt = (ms) => ms == null ? '…' : new Date(ms).toLocaleDateString();
        return `时间: ${fmt(f.value.from)} ~ ${fmt(f.value.to)}`;
    }
    return '筛选';
}

// Escape so that message content containing </textarea>, <, & etc. can't break
// out of the textarea or inject markup. Critical at high floor counts.
function escapeHtml(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

// ══════════════════════════════════════════════════════════════════════
// REGION: 上下文融合沙盒 — 渲染（分页楼层栅格 / 关键词高亮）
// ══════════════════════════════════════════════════════════════════════
function renderSandboxChat() {
    const listEl = $('#wizard-context-editor-list');
    if (listEl.length === 0) return;
    listEl.empty();

    // Always (re)compute the time-based remap before building the badge map, so
    // coverage is never painted from stale stored coveredFloors.
    ensureFloorRemap();

    if (!sandboxChatContext || sandboxChatContext.length === 0) {
        listEl.html(`
            <div style="color: #9ca3af; text-align: center; padding: 40px 0; font-size: 0.9em;">
                <i class="fa-solid fa-file-import" style="font-size: 2em; margin-bottom: 10px; display: block; color: #4b5563;"></i>
                请点击上方按钮载入当前聊天上下文
            </div>
        `);
        $('#wizard-fusion-context-stats').hide().empty();
        return;
    }

    // Keep the live page size in sync with config (default 100, min 10).
    SANDBOX_PAGE_SIZE = Math.max(10, parseInt(config.sandboxPageSize) || 100);
    const regexPattern = (config.sandboxRegex || '').trim();

    // Apply active match/filter tags (regex / keyword / time / size). Each entry
    // is { msg, floor } where floor is the original mesid.
    const entries = getFilteredSandboxEntries();
    const total = entries.length;
    const grandTotal = sandboxChatContext.length;

    if (total === 0) {
        // Still show the filter tags message; nothing matched.
        listEl.html(`
            <div style="color: #9ca3af; text-align: center; padding: 40px 0; font-size: 0.9em;">
                <i class="fa-solid fa-filter-circle-xmark" style="font-size: 2em; margin-bottom: 10px; display: block; color: #4b5563;"></i>
                当前筛选条件下没有匹配的楼层 (共 ${grandTotal} 条)。
            </div>
        `);
        updateFusionTokenStats();
        return;
    }

    const pageCount = Math.ceil(total / SANDBOX_PAGE_SIZE);
    // Clamp the current page (it may be stale after a reload with fewer floors).
    if (sandboxPage < 0) sandboxPage = 0;
    if (sandboxPage > pageCount - 1) sandboxPage = pageCount - 1;

    const startIdx = sandboxPage * SANDBOX_PAGE_SIZE;
    const endIdx = Math.min(total, startIdx + SANDBOX_PAGE_SIZE);

    const filterNote = total !== grandTotal ? ` · 已筛选 ${total} / ${grandTotal} 条` : ` (共 ${grandTotal} 条)`;

    // Pagination bar (only shown when there is more than one page).
    if (pageCount > 1) {
        const pager = `
            <div class="wizard-sandbox-pager" style="display: flex; align-items:center; flex-wrap:wrap; gap: 8px 16px; background: rgba(0,0,0,0.2); padding: 6px 8px; border-radius: 6px; font-size: 0.82em; color: #d1d5db; position: sticky; top: 0; z-index: 2;">
                <span style="display:flex; gap:6px; flex:0 0 auto;">
                    <button class="wizard-btn wizard-btn-secondary wizard-sandbox-first" style="padding: 3px 8px; font-size: 0.85em;" ${sandboxPage <= 0 ? 'disabled' : ''} title="第一页"><i class="fa-solid fa-angles-left"></i></button>
                    <button class="wizard-btn wizard-btn-secondary wizard-sandbox-prev" style="padding: 3px 10px; font-size: 0.85em;" ${sandboxPage <= 0 ? 'disabled' : ''}><i class="fa-solid fa-chevron-left"></i> 上一页</button>
                    <button class="wizard-btn wizard-btn-secondary wizard-sandbox-filter-floorrange" style="padding: 3px 10px; font-size: 0.85em;" title="把上方「起始楼层 / 结束楼层」的数值作为筛选，只显示该楼层范围内的楼层"><i class="fa-solid fa-layer-group"></i> 筛楼层</button>
                </span>
                <span style="flex:1 1 auto; min-width:0; text-align:center; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">第 <strong>${sandboxPage + 1}</strong> / ${pageCount} 页${filterNote}</span>
                <span style="display:inline-flex; align-items:center; gap:5px; flex:0 0 auto; white-space:nowrap;">跳至第
                    <input type="number" class="wizard-sandbox-jump-page" min="1" max="${pageCount}" placeholder="页" style="width: 56px; padding: 3px 6px; font-size: 0.95em; color:#e5e7eb; background: rgba(0,0,0,0.35); border:1px solid rgba(255,255,255,0.18); border-radius:4px; box-sizing:border-box;"> 页
                </span>
                <span style="display:inline-flex; align-items:center; gap:5px; flex:0 0 auto; white-space:nowrap;">跳至第
                    <input type="number" class="wizard-sandbox-jump-floor" min="0" placeholder="楼" style="width: 64px; padding: 3px 6px; font-size: 0.95em; color:#e5e7eb; background: rgba(0,0,0,0.35); border:1px solid rgba(96,165,250,0.4); border-radius:4px; box-sizing:border-box;"> 楼
                </span>
                <span style="display:flex; gap:6px; flex:0 0 auto;">
                    <button class="wizard-btn wizard-btn-secondary wizard-sandbox-jump-unmarked" style="padding: 3px 8px; font-size: 0.85em;" title="跳转到未标记楼层"><i class="fa-solid fa-forward-step"></i></button>
                    <button class="wizard-btn wizard-btn-secondary wizard-sandbox-next" style="padding: 3px 10px; font-size: 0.85em;" ${sandboxPage >= pageCount - 1 ? 'disabled' : ''}>下一页 <i class="fa-solid fa-chevron-right"></i></button>
                    <button class="wizard-btn wizard-btn-secondary wizard-sandbox-last" style="padding: 3px 8px; font-size: 0.85em;" ${sandboxPage >= pageCount - 1 ? 'disabled' : ''} title="末尾页"><i class="fa-solid fa-angles-right"></i></button>
                </span>
            </div>
        `;
        listEl.append(pager);
    }

    // Build the floor-coverage map once per render (cheap: scans summary arrays).
    // Use the REMAPPED map so coverage badges follow each record's current "现 A-B 楼"
    // floors (delete-safe) instead of the stale original coveredFloors — otherwise a
    // deleted record whose stored floors start at 0 would mislabel current floor 0.
    const floorCoverageMap = buildRemappedCoverageMap();

    // Build the page's HTML as a single string, then insert once (one reflow
    // instead of one-per-message).
    let html = '';
    for (let ei = startIdx; ei < endIdx; ei++) {
        const index = entries[ei].floor;     // original mesid (for editing/data-index)
        const msg = entries[ei].msg;
        const contentKey = msg.content !== undefined ? 'content' : 'mes';
        const rawContent = msg[contentKey] || "";
        const name = msgName(msg);

        let roleLabel = '角色';
        let itemBg = 'rgba(255, 255, 255, 0.02)';
        let itemBorder = 'rgba(255, 255, 255, 0.05)';
        let headerColor = 'var(--wizard-primary)';

        if (msg.is_system) {
            roleLabel = '系统';
            itemBg = 'rgba(255, 255, 255, 0.01)';
            itemBorder = 'rgba(255, 255, 255, 0.04)';
            headerColor = '#9ca3af';
        } else if (msg.is_user) {
            roleLabel = '用户';
            itemBg = 'rgba(96, 165, 250, 0.04)';
            itemBorder = 'rgba(96, 165, 250, 0.15)';
            headerColor = '#60a5fa';
        } else {
            roleLabel = 'AI';
            itemBg = 'rgba(244, 114, 182, 0.04)';
            itemBorder = 'rgba(244, 114, 182, 0.15)';
            headerColor = '#f472b6';
        }

        // Floor number = SillyTavern's native message id (mesid) = absolute index.
        const floorId = index;
        const model = msgModel(msg);

        // Active keyword (tag or live box). The keyword is searched WITHIN its scoped
        // text (every regex tag to its LEFT narrows the scope — left = higher weight),
        // and that scoped text is what we orange-highlight below. When a regex tag is
        // present, the highlight lives inside the regex extraction preview; otherwise
        // it lives in a standalone orange preview box. Either way the first <mark> is
        // scrolled to the floor's center after render.
        const activeKwTag = sandboxFilters.find(f => f.type === 'keyword' && f.value);
        const { kw: activeKw, mode: activeKwMode } = activeKeywordQuery();
        const kwIdx = activeKwTag ? sandboxFilters.indexOf(activeKwTag) : -1;
        const kwScope = activeKw ? keywordScopeText(msg, kwIdx, floorId) : '';

        // Excluded-but-kept role row: it is still sent and passes through UNCHANGED
        // (regex extraction is for the kept side only). No grey styling — it renders
        // like any other row, but carries a small "原样保留" marker for clarity.
        const passthrough = isRoleExcludedGreyed(msg);
        const passBadge = passthrough ? '<span style="font-size:0.72em; color:#9ca3af; border:1px solid rgba(156,163,175,0.4); border-radius:8px; padding:0 6px; margin-left:6px;">原样保留</span>' : '';

        // Coverage badge: shown in the top-right corner when this floor has already
        // been captured by a summary record. Colored by record TYPE — 史记 紫 / 周记 蓝
        // / 日记 绿 — so the user can tell at a glance which layer owns the floor.
        const coverage = floorCoverageMap.get(floorId);
        const covColor = coverage ? (SUMMARY_COLORS[coverage.type] || '#a78bfa') : '#a78bfa';
        const coverageBadge = coverage
            ? `<span class="wizard-floor-coverage-badge" style="font-size:0.72em; color:${covColor}; border:1px solid ${hexToRgba(covColor, 0.55)}; border-radius:8px; padding:0 7px; background:${hexToRgba(covColor, 0.12)}; white-space:nowrap;" title="该楼层已被${coverage.label}覆盖">📖 ${escapeHtml(coverage.label)}</span>`
            : '';
        // When this floor is covered, add a subtle left-border in the record's type color.
        // If a summary jump is active, floors in the jumped record's range get a
        // thicker, brighter border in the record type's color.
        let coverageBorder = coverage ? `border-left: 2px solid ${hexToRgba(covColor, 0.7)};` : '';
        if (sandboxJumpHighlight && floorId >= sandboxJumpHighlight.lo && floorId <= sandboxJumpHighlight.hi) {
            const hlColor = SUMMARY_COLORS[sandboxJumpHighlight.type] || 'rgba(167,139,250,0.9)';
            coverageBorder = `border-left: 4px solid ${hlColor}; box-shadow: inset 2px 0 8px rgba(0,0,0,0.2);`;
        }

        // When regex extraction is active (one or more tags, or the legacy input),
        // show the COMBINED extraction so the user can verify what {{history}}/fusion
        // will inject. The textarea still edits full content. Passthrough rows are
        // injected as-is, so no extraction preview for them.
        const regexTagsActive = sandboxFilters.filter(f => f.type === 'regex' && f.value && sandboxRegexTagApplies(f, msg, floorId));
        const hasRegex = !passthrough && (regexTagsActive.length > 0 || !!regexPattern);
        let matchPreview = '';
        if (hasRegex) {
            const extracted = extractFusionBody(msg, floorId);
            const matched = extracted !== rawContent && extracted.trim() !== '';
            const cnt = regexTagsActive.length || (regexPattern ? 1 : 0);
            // Whether any active tag for this floor is a remove tag — drives the label
            // wording so "移除匹配" isn't shown as "匹配".
            const hasRemoveActive = regexTagsActive.some(t => t.mode === 'remove');
            const hasKeepActive = regexTagsActive.some(t => t.mode !== 'remove') || !!regexPattern;
            // Orange-highlight the keyword inside the extracted text so the user sees
            // exactly where it landed within the regex match (e.g. inside the recap).
            const shownText = matched ? extracted : '';
            const { html: extractedHtml } = activeKw
                ? highlightKeyword(shownText, activeKw, activeKwMode)
                : { html: escapeHtml(shownText) };
            // When the keyword is highlighted in this box, mark the box with an orange
            // left bar; otherwise keep the green/grey regex-match indicator.
            const kwInBox = activeKw && keywordMatches(shownText, activeKw, activeKwMode);
            const barColor = kwInBox ? '#f97316' : (matched ? '#34d399' : 'rgba(255,255,255,0.15)');
            // Label: keep-only → 匹配 / 无匹配；remove-only → 处理后 / 无匹配（未改动）；mixed → 处理后.
            let label;
            if (matched) label = (hasRemoveActive && !hasKeepActive) ? `处理后 (移除 ${cnt} 条正则)` : `匹配 (${cnt} 条正则)`;
            else label = (hasRemoveActive && !hasKeepActive) ? '无匹配 (未移除，注入完整正文)' : '无匹配 (将注入完整正文)';
            matchPreview = `
                <div class="wizard-match-preview" style="font-size: 0.78em; color: ${matched ? '#34d399' : '#9ca3af'}; background: rgba(0,0,0,0.25); border-left: 3px solid ${barColor}; padding: 4px 8px; border-radius: 3px; white-space: pre-wrap; word-break: break-word; max-height: 220px; overflow-y: auto;">
                    <i class="fa-solid fa-filter"></i> ${label}: ${extractedHtml}
                </div>`;
        }

        // Standalone keyword preview (orange) when there is NO regex extraction box to
        // carry the highlight — shows the floor body with the keyword marked, and lets
        // the first hit be scrolled to center just like the regex case.
        let kwPreview = '';
        if (activeKw && !hasRegex) {
            const { html: hl, hits } = highlightKeyword(kwScope || rawContent, activeKw, activeKwMode);
            if (hits > 0) {
                kwPreview = `<div class="wizard-kw-preview" style="font-size: 0.82em; color: #d1d5db; background: rgba(0,0,0,0.25); border-left: 3px solid #f97316; padding: 4px 8px; border-radius: 3px; white-space: pre-wrap; word-break: break-word; max-height: 220px; overflow-y: auto;">${hl}</div>`;
            }
        }

        html += `
            <div class="wizard-context-msg-item" data-floor="${floorId}" style="border: 1px solid ${itemBorder}; ${coverageBorder} padding: 8px; border-radius: 6px; background: ${itemBg}; display: flex; flex-direction: column; gap: 4px;">
                <div style="display: flex; justify-content: space-between; align-items: center; font-size: 0.85em; color: ${headerColor}; font-weight: 500;">
                    <span>#${floorId} (楼层) - ${escapeHtml(name)} (${roleLabel})${passBadge}</span>
                    <div style="display: flex; gap: 10px; align-items: center; flex-wrap: wrap; justify-content: flex-end;">
                        ${coverageBadge}
                        ${model ? `<span style="font-size: 0.78em; color: #e5e7eb;" title="生成此消息使用的模型"><i class="fa-solid fa-microchip"></i> ${escapeHtml(model)}</span>` : ''}
                        <span style="font-size: 0.8em; color: #6b7280;">${escapeHtml(msg.send_date || '')}</span>
                        <i class="fa-solid fa-arrow-up wizard-set-fusion-start-btn" data-floor="${floorId}" style="cursor: pointer; color: #34d399; font-size: 0.9em;" title="设为融合起始楼层"></i>
                        <i class="fa-solid fa-arrow-down wizard-set-fusion-end-btn" data-floor="${floorId}" style="cursor: pointer; color: #f97316; font-size: 0.9em;" title="设为融合结束楼层"></i>
                        <i class="fa-solid fa-expand wizard-msg-fullscreen-btn" data-index="${index}" style="cursor: pointer; color: #60a5fa; font-size: 0.9em;" title="全屏编辑这条消息"></i>
                    </div>
                </div>
                <textarea class="context-msg-textarea wizard-input" data-index="${index}" style="width: 100%; min-height: 45px; font-size: 0.9em; padding: 6px 8px; resize: vertical; line-height: 1.4; font-family: inherit; margin: 0; box-sizing: border-box; background: rgba(0,0,0,0.15) !important; border: 1px solid rgba(255,255,255,0.06) !important;">${escapeHtml(rawContent)}</textarea>
                ${kwPreview}
                ${matchPreview}
            </div>
        `;
    }
    listEl.append(html);

    // Keyword centering: for every floor that matched a keyword, the first orange
    // <mark> (.wizard-kw-hit) is scrolled to the vertical middle of its scrollable
    // preview box, so the highlighted line is immediately visible inside the floor.
    listEl.find('.wizard-kw-hit').each(function () {
        const mark = this;
        const box = mark.closest('.wizard-kw-preview, .wizard-match-preview');
        if (!box) return;
        // Position of the mark relative to the box's current scroll, then shift so the
        // mark sits in the box's vertical middle.
        const markRect = mark.getBoundingClientRect();
        const boxRect = box.getBoundingClientRect();
        const rel = (markRect.top - boxRect.top) + box.scrollTop;
        box.scrollTop = Math.max(0, rel - (box.clientHeight / 2) + (markRect.height / 2));
    });

    // Auto-fill ranges if they are empty. Ranges use floor numbers (mesid, 0-based),
    // so the default span is 0 .. (length - 1).
    if ($('#wizard-fusion-start').val() === '' || $('#wizard-fusion-start').val() === undefined) {
        $('#wizard-fusion-start').val(0);
    }
    if ($('#wizard-fusion-end').val() === '' || $('#wizard-fusion-end').val() === undefined) {
        $('#wizard-fusion-end').val(Math.max(0, sandboxChatContext.length - 1));
    }

    // Update context stats summary in the fusion status bar.
    updateFusionTokenStats();
}

// Scroll a floor element to the vertical centre of the floor list. Container-relative
// on purpose: scrollIntoView({block:'center'}) would also scroll the modal behind it.
function centerSandboxFloorEl(list, el) {
    const rel = (el.getBoundingClientRect().top - list.getBoundingClientRect().top) + list.scrollTop;
    list.scrollTop = Math.max(0, rel - (list.clientHeight / 2) + (el.offsetHeight / 2));
}

// Scroll the floor holding the MIDDLE keyword hit to the vertical centre of the floor
// list. Centring the middle match rather than the first leaves matched floors both
// above and below in view, so after a search you can walk the neighbouring floors for
// related context instead of being parked at the top of the list with nothing above.
function centerMiddleKeywordHit() {
    const list = document.getElementById('wizard-context-editor-list');
    if (!list) return;
    const hits = Array.from(list.querySelectorAll('.wizard-context-msg-item'))
        .filter(el => el.querySelector('.wizard-kw-hit'));
    if (!hits.length) return;
    centerSandboxFloorEl(list, hits[Math.floor((hits.length - 1) / 2)]);
}

// The floor number currently sitting closest to the vertical middle of the floor list,
// or null when nothing is rendered. Used to anchor the view across a re-render that
// changes the filter: the filtered and unfiltered lists have wildly different lengths,
// so keeping the raw scroll offset would land on a completely unrelated floor.
function centeredSandboxFloor() {
    const list = document.getElementById('wizard-context-editor-list');
    if (!list) return null;
    const mid = list.getBoundingClientRect().top + (list.clientHeight / 2);
    let best = null, bestDist = Infinity;
    for (const el of list.querySelectorAll('.wizard-context-msg-item')) {
        const r = el.getBoundingClientRect();
        const d = Math.abs((r.top + r.height / 2) - mid);
        if (d < bestDist) { bestDist = d; best = el; }
    }
    if (!best) return null;
    const floor = parseInt(best.dataset.floor);
    return isNaN(floor) ? null : floor;
}

// Switch to the page holding `floor` in the CURRENT filter set, re-render, then centre
// and briefly flash that floor. Returns false without rendering when the floor is not
// in the filtered set, so callers can fall back to a plain render.
// Shared by 跳至第 X 楼 and by clearing the keyword filter.
function jumpToSandboxFloor(floor) {
    const entries = getFilteredSandboxEntries();
    const pos = entries.findIndex(en => en.floor === floor);
    if (pos < 0) return false;
    sandboxPage = Math.floor(pos / SANDBOX_PAGE_SIZE);
    renderSandboxChat();
    const list = document.getElementById('wizard-context-editor-list');
    const item = list && list.querySelector(`.wizard-context-msg-item[data-floor="${floor}"]`);
    if (item) {
        centerSandboxFloorEl(list, item);
        const $row = $(item);
        const orig = $row.css('box-shadow');
        $row.css('box-shadow', '0 0 0 2px #60a5fa');
        setTimeout(() => $row.css('box-shadow', orig), 1200);
    }
    return true;
}

// Default fusion system prompts (shared by the generator and the token estimator so
// the counted payload matches exactly what is sent when config overrides are empty).
const FUSION_DEFAULT_PROMPTS = {
    historical: `You are a professional historian. Your task is to merge and summarize the following numbered chat messages into a single historical summary (史记) of about 300 words.
Focus on major character development, plot points, and the grand narrative arc. Output only the summarized text directly in Chinese, without any JSON format, codeblock markdown tags, or prefix/suffix.`,
    weekly: `You are a professional chronicler. Your task is to merge and summarize the following numbered chat messages into a weekly summary (周记) of about 150-200 words.
Focus on recent key interactions, character moods, and unresolved questions. Output only the summarized text directly in Chinese, without any JSON format, codeblock markdown tags, or prefix/suffix.`,
    recap: `Write a storyline recap of the following numbered chat messages.
Focus on the dramatic arc, conversation tone, and quick recap of recent events. Max 200 Chinese characters. Output only the recap text directly in Chinese, without any JSON format, codeblock markdown tags, or prefix/suffix.`,
};

// Build the EXACT payload an isolated fusion call will send: the resolved system
// prompt (with {{records}} / 已有记忆 block and {{history}} substituted) plus the
// user turn. Returns the pieces so both the generator and the token estimator can
// use identical text. `opts.formattedContext`/`opts.filteredEntries` let the caller
// reuse an already-computed context; otherwise it is recomputed from the range.
function buildFusionPayload(start, end, opts = {}) {
    const fusionType = $('#wizard-fusion-type').val();

    let filteredEntries = opts.filteredEntries;
    let formattedContext = opts.formattedContext;
    if (formattedContext === undefined || filteredEntries === undefined) {
        const inRange = sandboxChatContext
            .map((msg, floor) => ({ msg, floor }))
            .filter(e => e.floor >= start && e.floor <= end);
        const applyFilters = config.fusionApplyFilters !== false;
        const covMap = (applyFilters && sandboxFilters.some(f => f.type === 'record' && f.value)) ? buildRemappedCoverageMap() : null;
        filteredEntries = applyFilters ? inRange.filter(e => messagePassesFilters(e.msg, e.floor, covMap)) : inRange;
        const sizeTag = sandboxFilters.find(f => f.type === 'size');
        if (applyFilters && sizeTag) {
            const dir = sizeTag.value === 'asc' ? 1 : -1;
            filteredEntries = filteredEntries.slice().sort((a, b) => (msgBody(a.msg).length - msgBody(b.msg).length) * dir);
        }
        formattedContext = filteredEntries.map(({ msg, floor }) => {
            const name = msgName(msg);
            const body = applyFilters ? extractFusionBody(msg, floor) : msgBody(msg);
            return `#${floor} [${name}]: ${body}`;
        }).join('\n');
    }

    // System prompt: config override, else the shared default for this layer.
    let systemPrompt = '';
    if (fusionType === 'historical') systemPrompt = config.promptHistorical || FUSION_DEFAULT_PROMPTS.historical;
    else if (fusionType === 'weekly') systemPrompt = config.promptWeekly || FUSION_DEFAULT_PROMPTS.weekly;
    else if (fusionType === 'recap') systemPrompt = config.promptRecap || FUSION_DEFAULT_PROMPTS.recap;

    // {{records}} / 已有记忆 injection (same rules as the generator).
    const hasRecordsToken = /\{\{\s*records\s*\}\}/i.test(systemPrompt);
    if (hasRecordsToken) {
        systemPrompt = systemPrompt.replace(/\{\{\s*records\s*\}\}/gi, compileAllRecords());
    } else if (config.fusionIncludeRecords) {
        const recordsBlock = compileOtherRecords(fusionType);
        if (recordsBlock) systemPrompt = `${recordsBlock}\n\n${systemPrompt}`;
    }

    // {{history}} placement.
    const hasHistoryToken = /\{\{\s*history\s*\}\}/i.test(systemPrompt);
    let finalSystemPrompt, finalUserContent;
    if (hasHistoryToken) {
        finalSystemPrompt = systemPrompt.replace(/\{\{\s*history\s*\}\}/gi, formattedContext);
        finalUserContent = '请根据以上内容进行融合总结。';
    } else {
        finalSystemPrompt = systemPrompt;
        finalUserContent = formattedContext;
    }

    // Mirror buildFusionInvocation: when manual-fusion tree fill is on, the memory-tree
    // path index + op schema are appended to the system prompt and DO cost input tokens.
    // Include it here so the stats preview matches what is actually sent.
    if (config.manualFusionTreeOps) {
        finalSystemPrompt = `${finalSystemPrompt}${buildManualTreeOpsBlock()}`;
    }

    return { finalSystemPrompt, finalUserContent, formattedContext, filteredEntries };
}

// Compute and render the fusion-context stats (floor count + estimated tokens)
// using the SAME pipeline as the actual fusion generation: floor range ->
// match filters -> extractFusionBody. Anything that changes any of these inputs
// (filter tags, keyword/regex, OR the floor range fields) must call this so the
// displayed token count always reflects exactly what will be sent.
function updateFusionTokenStats() {
    const statsEl = $('#wizard-fusion-context-stats');
    if (!statsEl.length) return;

    if (!sandboxChatContext || sandboxChatContext.length === 0) {
        statsEl.hide().empty();
        return;
    }

    const grandTotal = sandboxChatContext.length;
    const maxFloor = grandTotal - 1;

    // Read the floor range exactly like the generation handler does. Empty/NaN
    // inputs default to the full span (0 .. maxFloor).
    let start = parseInt($('#wizard-fusion-start').val());
    let end = parseInt($('#wizard-fusion-end').val());
    if (isNaN(start)) start = 0;
    if (isNaN(end)) end = maxFloor;
    start = Math.max(0, start);
    end = Math.min(maxFloor, end);

    // Invalid range (start > end) -> nothing will be fused.
    if (start > end) {
        statsEl.html(
            `<i class="fa-solid fa-triangle-exclamation" style="color:#ef4444;"></i> ` +
            `<span style="color:#f87171;">楼层范围无效 (起始 ${start} > 结束 ${end})</span>`
        ).css('display', '');
        return;
    }

    // Mirror the generation pipeline EXACTLY: range -> messagePassesFilters ->
    // size sort -> "#floor [name]: body" formatting -> "\n" join. The token count
    // is computed from this final string (the real payload), not a sum of body
    // lengths, so it includes the floor-number prefix, names, and line breaks that
    // are actually sent to the LLM.
    const inRange = sandboxChatContext
        .map((msg, floor) => ({ msg, floor }))
        .filter(e => e.floor >= start && e.floor <= end);
    const applyFilters = config.fusionApplyFilters !== false;
    const covMapStats = (applyFilters && sandboxFilters.some(f => f.type === 'record' && f.value)) ? buildRemappedCoverageMap() : null;
    let filteredEntries = applyFilters ? inRange.filter(e => messagePassesFilters(e.msg, e.floor, covMapStats)) : inRange;
    const sizeTag = sandboxFilters.find(f => f.type === 'size');
    if (applyFilters && sizeTag) {
        const dir = sizeTag.value === 'asc' ? 1 : -1;
        filteredEntries = filteredEntries.slice().sort(
            (a, b) => (msgBody(a.msg).length - msgBody(b.msg).length) * dir);
    }

    const formattedContext = filteredEntries.map(({ msg, floor }) => {
        const name = msgName(msg);
        const body = applyFilters ? extractFusionBody(msg, floor) : msgBody(msg);
        return `#${floor} [${name}]: ${body}`;
    }).join('\n');

    const filteredCount = filteredEntries.length;
    const rangeCount = inRange.length;

    // Count the FULL payload that will actually be sent (system prompt + injected
    // {{records}}/已有记忆 + {{history}}/context + user turn), not just the floor
    // bodies — that is what the AI provider bills as input tokens. Reuse the already
    // computed context/entries so the numbers match the generator exactly.
    const { finalSystemPrompt, finalUserContent } = buildFusionPayload(start, end, { formattedContext, filteredEntries });
    const fullPayload = `${finalSystemPrompt}\n${finalUserContent}`;
    const charCount = fullPayload.length;
    const estTokens = estimateTokens(fullPayload);
    const passthroughCount = applyFilters
        ? filteredEntries.filter(e => isRoleExcludedGreyed(e.msg)).length : 0;
    const activeCount = filteredCount - passthroughCount;

    const rangeInfo = `<span style="color:rgba(255,255,255,0.55);">范围 ${start}–${end} 楼</span>`;
    const filterInfo = filteredCount !== rangeCount
        ? ` · <span style="color:#f59e0b;">筛选后 ${filteredCount} / ${rangeCount}</span>`
        : '';
    const roleInfo = '';

    if (filteredCount === 0) {
        statsEl.html(
            `<i class="fa-solid fa-filter-circle-xmark" style="color:#ef4444;"></i> ` +
            `${rangeInfo} · <span style="color:#f87171;">0 楼匹配筛选条件</span> ` +
            `<span style="color:#4b5563;">(共载入 ${grandTotal} 楼)</span>`
        ).css('display', '');
        return;
    }

    const fusionTypeNow = $('#wizard-fusion-type').val() || 'historical';
    const iconColor = SUMMARY_COLORS[fusionTypeNow] || '#60a5fa';
    const renderStats = (tokens, exact) => {
        statsEl.html(
            `<i class="fa-solid fa-chart-bar" style="color:${iconColor};"></i> ` +
            `${rangeInfo}${filterInfo}${roleInfo} · ` +
            `${exact ? '' : '约 '}<span style="color:rgba(255,255,255,0.55);">${tokens.toLocaleString()} tokens</span>`
        ).css('display', '');
    };
    // Show the fast estimate immediately, then refine with SillyTavern's REAL
    // tokenizer (matches the selected API/model exactly). The estimate is a rough
    // CJK heuristic and undercounts; getTokenCountAsync uses the actual tokenizer.
    renderStats(estTokens, false);
    try {
        const ctx = window.SillyTavern.getContext();
        if (typeof ctx.getTokenCountAsync === 'function') {
            // Tag a token so a stale async result from a previous call can't overwrite
            // a newer render.
            const myToken = (updateFusionTokenStats._seq = (updateFusionTokenStats._seq || 0) + 1);
            ctx.getTokenCountAsync(fullPayload).then((real) => {
                if (myToken !== updateFusionTokenStats._seq) return; // superseded
                if (typeof real === 'number' && real > 0) renderStats(real, true);
            }).catch(() => {});
        }
    } catch (e) { /* fall back to estimate already shown */ }
}

// ══════════════════════════════════════════════════════════════════════
// REGION: 设置表单事件绑定（所有 tab 的 jQuery 事件处理 — 本文件最大区块）
// ══════════════════════════════════════════════════════════════════════
// Settings Form Handlers
function registerNodeFormListeners() {
    // Master switch live binding: when the user flips the master, immediately
    // grey out / re-enable the sub-toggles and persist silently. Without this,
    // the user has to save/reload before the visual disabled state matches.
    $(document).off('change.wizardMaster', '#wizard-is-enabled')
        .on('change.wizardMaster', '#wizard-is-enabled', function () {
            applyMasterToggleState();
            saveConfig(true);
        });
    // Per-layer auto toggles: persist silently on change. (Pre/post-flash also
    // get the same treatment so the user sees no inconsistency.)
    $(document).off('change.wizardSubToggles', '#wizard-sub-toggles input[type="checkbox"]')
        .on('change.wizardSubToggles', '#wizard-sub-toggles input[type="checkbox"]', function () {
            saveConfig(true);
        });

    // Body-level tooltip for the ? icons. Appended to <body> so it escapes the
    // modal's overflow:hidden / scroll containers and is never clipped. Position
    // is clamped to the viewport so long text is always fully visible.
    $(document).off('mouseenter.wizardTip', '.wizard-tooltip-icon').on('mouseenter.wizardTip', '.wizard-tooltip-icon', function () {
        const text = $(this).attr('data-tooltip');
        if (!text) return;
        let bubble = document.getElementById('wizard-tooltip-bubble');
        if (!bubble) {
            bubble = document.createElement('div');
            bubble.id = 'wizard-tooltip-bubble';
            document.body.appendChild(bubble);
        }
        bubble.textContent = text;
        bubble.classList.add('wizard-tooltip-visible');

        const icon = this.getBoundingClientRect();
        // Measure after it's displayed.
        const bw = bubble.offsetWidth;
        const bh = bubble.offsetHeight;
        const margin = 8;
        const vw = window.innerWidth;
        const vh = window.innerHeight;

        // Prefer opening downward (consistent across all icons); flip up only if
        // there isn't room below.
        let top = icon.bottom + 6;
        if (top + bh + margin > vh) {
            top = icon.top - bh - 6;
        }
        top = Math.max(margin, Math.min(top, vh - bh - margin));

        // Center horizontally on the icon, then clamp into the viewport so the
        // full text shows even if the icon is near an edge.
        let left = icon.left + icon.width / 2 - bw / 2;
        left = Math.max(margin, Math.min(left, vw - bw - margin));

        bubble.style.top = `${top}px`;
        bubble.style.left = `${left}px`;
    });
    $(document).off('mouseleave.wizardTip', '.wizard-tooltip-icon').on('mouseleave.wizardTip', '.wizard-tooltip-icon', function () {
        const bubble = document.getElementById('wizard-tooltip-bubble');
        if (bubble) bubble.classList.remove('wizard-tooltip-visible');
    });

    $(document).off('click', '#wizard-node-cancel-btn').on('click', '#wizard-node-cancel-btn', function () {
        if (nodeEditDraftSnapshot?.path) {
            const liveNode = findNodeByPath(memoryTree, nodeEditDraftSnapshot.path);
            if (liveNode) {
                restoreNodeDraftFields(liveNode, nodeEditDraftSnapshot.subtree);
                renderTreeView(memoryTree, $('#wizard-tree-root'));
                loadNodeIntoForm(liveNode);
                toastr.info('已取消本次节点编辑，恢复到编辑前状态。');
                return;
            }
        }
        nodeEditDraftSnapshot = null;
        $('#wizard-node-original-path').val('');
        $('#wizard-node-path').val('');
        $('#wizard-node-title').val('');
        $('#wizard-node-hint').val('');
        $('#wizard-node-keywords').val('');
        $('#wizard-node-content').val('');
        $('#wizard-node-send-path').prop('checked', true);
        $('#wizard-node-pinned').prop('checked', false);
        $('#wizard-node-archived').prop('checked', false);
        $('#wizard-node-color').val('');
        $('#wizard-node-color-palette .wizard-color-swatch').removeClass('wizard-color-swatch-active');
        $('#wizard-node-color-palette').css('display', 'none');
        $('#wizard-node-color-chevron').css('transform', 'rotate(0deg)');
        updateNodeColorPreview('');
        $('#wizard-node-editor-title').text('新增/编辑节点');
    });

    // Collapsible node color section (default collapsed).
    $(document).off('click', '#wizard-node-color-toggle').on('click', '#wizard-node-color-toggle', function () {
        const palette = $('#wizard-node-color-palette');
        const chevron = $('#wizard-node-color-chevron');
        const isOpen = palette.css('display') !== 'none';
        if (isOpen) {
            palette.css('display', 'none');
            chevron.css('transform', 'rotate(0deg)');
        } else {
            palette.css('display', 'flex');
            chevron.css('transform', 'rotate(90deg)');
        }
    });

    // {{memory_tree}} / {{memory_tree_header}} 注入内容折叠面板 + 开关 + 预览
    $(document).off('click', '#wizard-tree-injection-toggle').on('click', '#wizard-tree-injection-toggle', function (e) {
        // 点击预览按钮不折叠
        if ($(e.target).closest('#wizard-tree-injection-preview-btn').length) return;
        const body = $('#wizard-tree-injection-body');
        const chevron = $('#wizard-tree-injection-chevron');
        const isOpen = body.css('display') !== 'none';
        if (isOpen) {
            body.css('display', 'none');
            chevron.css('transform', 'rotate(0deg)');
        } else {
            body.css('display', 'block');
            chevron.css('transform', 'rotate(90deg)');
        }
    });

    // 7+2 个注入开关：变化即存，且若预览框可见则即时刷新
    const injectionSwitchSel = '#wizard-tree-injection-body input[type="checkbox"]';
    $(document).off('change.wizardInjectionSwitch', injectionSwitchSel).on('change.wizardInjectionSwitch', injectionSwitchSel, function () {
        config.mtIncludePath = $('#wizard-mt-path').prop('checked');
        config.mtIncludeHint = $('#wizard-mt-hint').prop('checked');
        config.mtIncludePinBody = $('#wizard-mt-pin').prop('checked');
        config.mtIncludeRoutedBody = $('#wizard-mt-routed').prop('checked');
        config.mtIncludeAllBody = $('#wizard-mt-all').prop('checked');
        config.mtKeywordTrigger = $('#wizard-mt-keyword-trigger').prop('checked');
        config.mthIncludePath = $('#wizard-mth-path').prop('checked');
        config.mthIncludeHint = $('#wizard-mth-hint').prop('checked');
        saveConfig(true);
        if ($('#wizard-tree-injection-preview').css('display') !== 'none') {
            renderTreeInjectionPreview();
        }
    });

    // 路径索引瘦身两个数值框：变化即存，且若预览框可见则即时刷新
    const injectionNumSel = '#wizard-mth-max-depth, #wizard-mth-max-children';
    $(document).off('change.wizardInjectionNum input.wizardInjectionNum', injectionNumSel).on('change.wizardInjectionNum input.wizardInjectionNum', injectionNumSel, function () {
        config.mthMaxDepth = Math.max(0, parseInt($('#wizard-mth-max-depth').val()) || 0);
        config.mthMaxChildren = Math.max(0, parseInt($('#wizard-mth-max-children').val()) || 0);
        saveConfig(true);
        if ($('#wizard-tree-injection-preview').css('display') !== 'none') {
            renderTreeInjectionPreview();
        }
    });

    // 预览按钮：编译两个宏当前输出，填入 <pre> + 长度读数
    function renderTreeInjectionPreview() {
        const memOut = compileMemoryTreeMacroValue();
        const hdrOut = compileMemoryTreeNames();
        const memLen = (memOut || '').length;
        const hdrLen = (hdrOut || '').length;
        const memTok = memLen ? estimateTokens(memOut) : 0;
        const hdrTok = hdrLen ? estimateTokens(hdrOut) : 0;
        const pre = $('#wizard-tree-injection-preview');
        pre.text(`── {{memory_tree}} (${memLen} 字 / ~${memTok} tok) ──\n${memOut || '(空)'}\n\n── {{memory_tree_header}} (${hdrLen} 字 / ~${hdrTok} tok) ──\n${hdrOut || '(空)'}`);
        pre.css('display', 'block');
        $('#wizard-tree-injection-len').text(`{{memory_tree}}: ${memLen} 字 / ~${memTok} tok　{{memory_tree_header}}: ${hdrLen} 字 / ~${hdrTok} tok`);
    }
    $(document).off('click', '#wizard-tree-injection-preview-btn').on('click', '#wizard-tree-injection-preview-btn', function (e) {
        e.stopPropagation();
        // 若面板折叠，先展开（预览输出在 body 内）
        const body = $('#wizard-tree-injection-body');
        if (body.css('display') === 'none') {
            body.css('display', 'block');
            $('#wizard-tree-injection-chevron').css('transform', 'rotate(90deg)');
        }
        renderTreeInjectionPreview();
    });

    // Color swatch picker. Selecting a swatch live-previews the color on the
    // node's tree header immediately (final persistence still requires 保存节点).
    $(document).off('click', '.wizard-color-swatch').on('click', '.wizard-color-swatch', function () {
        const color = $(this).data('color') || '';
        $('#wizard-node-color').val(color);
        $('#wizard-node-color-palette .wizard-color-swatch').removeClass('wizard-color-swatch-active');
        $(this).addClass('wizard-color-swatch-active');
        updateNodeColorPreview(color);

        // Live preview on the matching tree header (by the node being edited).
        const editingPath = $('#wizard-node-original-path').val();
        if (editingPath) {
            const headerEl = $(`.wizard-tree-header[data-path="${editingPath.replace(/"/g, '\\"')}"]`);
            if (headerEl.length) {
                if (color) {
                    headerEl.addClass('has-custom-color');
                    headerEl.attr('data-custom-color', color);
                    headerEl[0].style.setProperty('--node-custom-color', color);
                } else {
                    // Cleared: drop the override so the category/default color returns.
                    headerEl.removeClass('has-custom-color');
                    headerEl.removeAttr('data-custom-color');
                    headerEl[0].style.removeProperty('--node-custom-color');
                }
            }
        }
    });

    // Auto-sync: editing the Title rewrites the last segment of the full path so
    // the path's leaf always matches the node name.
    $(document).off('input', '#wizard-node-title').on('input', '#wizard-node-title', function () {
        const newTitle = $(this).val();
        const currentPath = $('#wizard-node-path').val();
        const segments = currentPath.split('/');
        segments[segments.length - 1] = newTitle;
        $('#wizard-node-path').val(segments.join('/'));
    });

    function saveNodeFromForm() {
        const originalPath = $('#wizard-node-original-path').val();
        const newPath = $('#wizard-node-path').val().trim();
        const title = $('#wizard-node-title').val().trim();
        const hint = $('#wizard-node-hint').val().trim();
        const keywords = $('#wizard-node-keywords').val().trim();
        const content = $('#wizard-node-content').val().trim();
        const sendPath = $('#wizard-node-send-path').prop('checked');
        const pinned = $('#wizard-node-pinned').prop('checked');
        const archived = $('#wizard-node-archived').prop('checked');
        const color = $('#wizard-node-color').val() || '';

        if (!newPath || !title) {
            return;
        }

        // If we are editing an existing node, update it IN PLACE (preserving its
        // children) and re-prefix any descendant paths if the path changed.
        if (originalPath) {
            const existingNode = findNodeByPath(memoryTree, originalPath);
            if (existingNode) {
                existingNode.title = title;
                existingNode.hint = hint;
                existingNode.keywords = keywords;
                existingNode.content = content;
                existingNode.sendPath = sendPath;
                existingNode.pinned = pinned;
                existingNode.archived = archived;
                existingNode.updated = new Date().toISOString().slice(0, 10);
                if (color) existingNode.color = color; else delete existingNode.color;

                // Archiving a parent cascades to all descendants (so a whole
                // branch greys out together).
                if (archived && existingNode.children && existingNode.children.length) {
                    collectNodeAndChildren(existingNode).forEach(n => { n.archived = true; });
                }

                // Turning OFF a parent's send-path cascades to all descendants:
                // if the母节点 path isn't sent, neither are its children's.
                if (!sendPath && existingNode.children && existingNode.children.length) {
                    collectNodeAndChildren(existingNode).forEach(n => { n.sendPath = false; });
                }

                if (originalPath !== newPath) {
                    // Re-home the node: re-prefix its own path and all descendants.
                    reparentNode(existingNode, originalPath, newPath);
                }

                saveTreeToServer();
                beginNodeEditDraft(findNodeByPath(memoryTree, newPath) || existingNode);
                toastr.success('保存节点成功！');
                return;
            }
        }

        // Brand-new node: build any missing parent folders, then create the leaf.
        const segments = newPath.split('/');
        let currentList = memoryTree;
        let runningPath = "";

        for (let i = 0; i < segments.length - 1; i++) {
            const segment = segments[i];
            runningPath = runningPath ? `${runningPath}/${segment}` : segment;
            let parentNode = currentList.find(n => n.path === runningPath);
            if (!parentNode) {
                parentNode = {
                    path: runningPath,
                    title: segment,
                    hint: "分类目录",
                    pinned: false,
                    content: "",
                    updated: new Date().toISOString().slice(0, 10),
                    children: []
                };
                currentList.push(parentNode);
            }
            if (!parentNode.children) parentNode.children = [];
            currentList = parentNode.children;
        }

        const leafTitle = segments[segments.length - 1];
        let leafNode = currentList.find(n => n.title === leafTitle);
        if (leafNode) {
            leafNode.title = title;
            leafNode.hint = hint;
            leafNode.keywords = keywords;
            leafNode.content = content;
            leafNode.sendPath = sendPath;
            leafNode.pinned = pinned;
            leafNode.archived = archived;
            leafNode.updated = new Date().toISOString().slice(0, 10);
            if (color) leafNode.color = color; else delete leafNode.color;
        } else {
            leafNode = {
                path: newPath,
                title: title,
                hint: hint,
                keywords: keywords,
                sendPath: sendPath,
                pinned: pinned,
                archived: archived,
                content: content,
                updated: new Date().toISOString().slice(0, 10),
                children: []
            };
            if (color) leafNode.color = color;
            currentList.push(leafNode);
        }

        saveTreeToServer();
        beginNodeEditDraft(leafNode);
        toastr.success('保存节点成功！');
    }

    $(document).off('click', '#wizard-node-save-btn').on('click', '#wizard-node-save-btn', function () {
        saveNodeFromForm();
    });

    // Editor changes are applied to the in-memory tree immediately so the left tree
    // reflects badges/dim/color/text without requiring Save. Save persists to disk;
    // Cancel restores nodeEditDraftSnapshot. Full-path changes are excluded because
    // re-homing is a save-time operation.
    $(document).off('change.wizardNodeDraft', '#wizard-node-send-path, #wizard-node-pinned, #wizard-node-archived, #wizard-node-title, #wizard-node-hint, #wizard-node-content, #wizard-node-color')
        .on('change.wizardNodeDraft', '#wizard-node-send-path, #wizard-node-pinned, #wizard-node-archived, #wizard-node-title, #wizard-node-hint, #wizard-node-content, #wizard-node-color', function () {
            applyNodeEditorDraftToTree();
        });

    // Pressing Enter in the Title / full-path / Hint single-line fields saves the
    // node immediately. The Content textarea is intentionally excluded so Enter
    // there just inserts a newline.
    $(document).off('keydown', '#wizard-node-title, #wizard-node-path, #wizard-node-hint').on('keydown', '#wizard-node-title, #wizard-node-path, #wizard-node-hint', function (e) {
        if (e.key === 'Enter') {
            e.preventDefault();
            saveNodeFromForm();
        }
    });

    // Tab switcher
    $(document).off('click', '.wizard-tab').on('click', '.wizard-tab', function () {
        const tab = $(this).data('tab');
        $('.wizard-tab').removeClass('active');
        $(this).addClass('active');
        $('.wizard-tab-content').removeClass('active');
        $(`#wizard-tab-${tab}`).addClass('active');

        if (tab === 'context-fusion') {
            // Reflect any active filter tags + the current mode inputs on entry.
            $('#wizard-sandbox-filter-tags').trigger('wizard:refresh');
            // Recompute the time-based floor remap so the coverage badge map is built
            // from a non-null, live-chat-derived state (never stale stored coveredFloors).
            ensureFloorRemap();
            // Auto-sync the sandbox to the live chat when its floor count is stale
            // (chat grew/shrank since last load), then re-render with fresh floors.
            syncSandboxIfStale().then(synced => { if (synced) { ensureFloorRemap(); renderSandboxChat(); } });
            renderSandboxChat();
        } else if (tab === 'summaries') {
            renderShijiRules();
            renderShijiList();
            updateSummaryProgress();
        }
    });

    $(document).off('click', '#wizard-refresh-logs-btn').on('click', '#wizard-refresh-logs-btn', function (e) {
        e.stopPropagation(); // don't toggle the collapsible when hitting 刷新
        loadLogs();
    });

    // Collapsible 检索日志 section (now living at the bottom of Settings, default
    // collapsed). Load the latest log lines on expand.
    $(document).off('click', '#wizard-logs-toggle').on('click', '#wizard-logs-toggle', function () {
        const body = $('#wizard-logs-body');
        const chevron = $('#wizard-logs-chevron');
        const isOpen = body.css('display') !== 'none';
        if (isOpen) {
            body.css('display', 'none');
            chevron.css('transform', 'rotate(0deg)');
        } else {
            body.css('display', 'block');
            chevron.css('transform', 'rotate(90deg)');
            loadLogs();
        }
    });

    // Collapsible 时记 section (default collapsed). Re-render on expand so it
    // reflects the latest chat state.
    $(document).off('click', '#wizard-shiji-toggle').on('click', '#wizard-shiji-toggle', function () {
        const body = $('#wizard-shiji-body');
        const chevron = $('#wizard-shiji-chevron');
        const isOpen = body.css('display') !== 'none';
        if (isOpen) {
            body.css('display', 'none');
            chevron.css('transform', 'rotate(0deg)');
        } else {
            body.css('display', 'block');
            chevron.css('transform', 'rotate(90deg)');
            renderShijiRules();
            renderShijiList();
        }
    });

    // 时记 send-mode toggle: re-render preview + persist.
    $(document).off('change', '#wizard-shiji-mode').on('change', '#wizard-shiji-mode', function () {
        config.shijiMode = $(this).val() || 'uncovered';
        renderShijiList();
        saveConfig(true);
    });

    // 始终保持X楼: 强制保留最近 X 楼正文（即使已被覆盖）。
    $(document).off('input.shijikeep change.shijikeep', '#wizard-shiji-keep-floors').on('input.shijikeep change.shijikeep', '#wizard-shiji-keep-floors', function () {
        config.shijiKeepFloors = Math.max(0, parseInt($(this).val()) || 0);
        renderShijiList();
        saveConfig(true);
    });

    // 时记注入格式选项: 楼层编号 / 现实时间（AI/User 分开）
    $(document).off('change', '#wizard-shiji-show-floor').on('change', '#wizard-shiji-show-floor', function () {
        config.shijiShowFloor = $(this).prop('checked');
        renderShijiList();
        saveConfig(true);
    });
    $(document).off('change', '#wizard-shiji-show-date-ai').on('change', '#wizard-shiji-show-date-ai', function () {
        config.shijiShowDateAi = $(this).prop('checked');
        renderShijiList();
        saveConfig(true);
    });
    $(document).off('change', '#wizard-shiji-show-date-user').on('change', '#wizard-shiji-show-date-user', function () {
        config.shijiShowDateUser = $(this).prop('checked');
        renderShijiList();
        saveConfig(true);
    });
    $(document).off('change', '#wizard-shiji-show-model').on('change', '#wizard-shiji-show-model', function () {
        config.shijiShowModel = $(this).prop('checked');
        renderShijiList();
        saveConfig(true);
    });
    $(document).off('change', '#wizard-fake-chat-history').on('change', '#wizard-fake-chat-history', function () {
        config.fakeChatHistory = $(this).prop('checked');
        saveConfig(true);
        syncFakeChatRegex(); // 立即同步 ST 全局 regex 脚本（开 → 检查/创建并启用；关 → disabled）。
    });
    $(document).off('change', '#wizard-fake-chat-history-summaries').on('change', '#wizard-fake-chat-history-summaries', function () {
        config.fakeChatHistoryIncludeSummaries = $(this).prop('checked');
        saveConfig(true);
    });

    $(document).off('input change', '#wizard-anthropic-cache-control-json').on('input change', '#wizard-anthropic-cache-control-json', function () {
        config.anthropicCacheControlJson = $(this).val() || defaultAnthropicCacheControlJson();
        updateAnthropicCacheControlPreview();
    });
    $(document).off('click', '#wizard-anthropic-cache-control-reset').on('click', '#wizard-anthropic-cache-control-reset', function () {
        config.anthropicCacheControlJson = '{\n  "type": "ephemeral",\n  "ttl": "5m"\n}';
        $('#wizard-anthropic-cache-control-json').val(config.anthropicCacheControlJson);
        $('#wizard-anthropic-cache-ttl').val('5m');
        config.anthropicCacheTTL = '5m';
        updateAnthropicCacheControlPreview();
        saveConfig(true);
    });
    $(document).off('click', '#wizard-anthropic-cache-control-apply-ttl').on('click', '#wizard-anthropic-cache-control-apply-ttl', function () {
        config.anthropicCacheTTL = $('#wizard-anthropic-cache-ttl').val() || '5m';
        config.anthropicCacheControlJson = defaultAnthropicCacheControlJson();
        $('#wizard-anthropic-cache-control-json').val(config.anthropicCacheControlJson);
        updateAnthropicCacheControlPreview();
        saveConfig(true);
    });
    $(document).off('change', '#wizard-anthropic-cache-ttl').on('change', '#wizard-anthropic-cache-ttl', function () {
        config.anthropicCacheTTL = $(this).val() || '5m';
        syncAnthropicCacheControlJsonFromTtlIfDefault();
        updateAnthropicCacheControlPreview();
        saveConfig(true);
    });

    $(document).off('click', '#wizard-anthropic-cache-test-btn').on('click', '#wizard-anthropic-cache-test-btn', function () {
        refreshAnthropicCacheConfigFromUi();
        const { mainReport, internal, snapshotReport } = buildAnthropicCacheTestReport();
        const scope = config.anthropicCacheScope || 'internal';
        const parts = [];
        if (!config.anthropicCacheEnabled) parts.push('未启用');
        if (scope === 'internal' || scope === 'both') {
            const ok = internal.filter(x => x.candidate).map(x => x.name);
            const bad = internal.filter(x => !x.candidate).map(x => x.name);
            parts.push(`内部 profile: ${ok.length ? ok.join(', ') : '无 Claude 候选'}${bad.length ? `；非候选 ${bad.join(', ')}` : ''}`);
        }
        if (scope === 'main' || scope === 'both') {
            if (mainReport.mode === 'gateway') {
                parts.push(`主聊天网关标记: 找到 ${mainReport.candidateCount} 个 {{cache_anchor}}（将转为 [[CACHE_BREAK]] 交本地网关注入 cache_control）`);
            } else if (mainReport.mode === 'manual') {
                parts.push(`主聊天静态锚点: 找到 ${mainReport.candidateCount} 个，达标 ${mainReport.cacheableCount} 个`);
            } else {
                parts.push(`主聊天倒数深度静态候选: ${mainReport.candidateCount} 个，达标 ${mainReport.cacheableCount} 个`);
            }
            parts.push(snapshotReport.captured
                ? `真实 payload 快照: ${snapshotReport.meta?.chatLength || 0} messages，${snapshotReport.cacheBlockCount} 个 cache_control`
                : '真实 payload 快照: 未捕获，请先触发一次主聊天生成');
        }
        const text = parts.join(' ｜ ');
        renderCacheSettingsCheckResult(text);
        writeLog(`CacheControl test: ${text}`);
        if (config.anthropicCacheEnabled && (scope === 'main' || scope === 'both') && mainReport.mode === 'gateway') {
            // 网关模式：cache_control 由本地网关注入，离线快照里只会出现 [[CACHE_BREAK]] 文本，不会有 cache_control 字段。
            if (mainReport.candidateCount === 0) {
                toastr.warning('Cache 设置检查完成：网关模式下没找到 {{cache_anchor}}。请在 preset/template 里放 {{cache_anchor}}。');
            } else {
                toastr.success(`Cache 设置检查完成：网关模式，${mainReport.candidateCount} 个 {{cache_anchor}} 将转为 [[CACHE_BREAK]] 由本地网关注入 cache_control。`);
            }
        } else if (config.anthropicCacheEnabled && (scope === 'main' || scope === 'both') && snapshotReport.captured && snapshotReport.cacheBlockCount === 0) {
            toastr.warning('Cache 设置检查完成：真实 payload 快照里没有 cache_control。请检查 {{cache_anchor}} 位置、生效范围或降低最小字符数。');
        } else if (config.anthropicCacheEnabled && (scope === 'main' || scope === 'both') && !snapshotReport.captured) {
            toastr.warning('Cache 设置检查完成：尚未捕获真实 payload。请先触发一次主聊天生成，再点“真实 payload 离线对比”。');
        } else {
            toastr.success('Cache 设置检查完成，结果已显示在按钮右侧并写入日志。');
        }
    });

    // 本地反代网关：健康检查 + （若未运行则经服务端插件 spawn 启动）+ 打开 console + 切换 profile。
    $(document).off('click', '#wizard-gateway-open-btn').on('click', '#wizard-gateway-open-btn', async function () {
        const $btn = $(this);
        if ($btn.prop('disabled')) return;
        const GATEWAY = 'http://127.0.0.1:8788';
        const profileName = ($('#wizard-gateway-profile').val() || '').trim();
        const checkHealth = async () => {
            try {
                const r = await fetch(`${GATEWAY}/health`, { method: 'GET' });
                return r.ok;
            } catch { return false; }
        };
        let healthy = await checkHealth();
        if (!healthy) {
            // 经服务端插件 spawn 网关（需 enableServerPlugins=true）。
            $btn.prop('disabled', true).css('opacity', '0.65');
            toastr.info('本地网关未运行，正在启动…');
            try {
                const r = await fetch('/api/plugins/st-memory-wizzard/gateway/start', { method: 'POST', headers: getWizardHeaders() });
                const j = await r.json().catch(() => ({}));
                if (j.ok) {
                    healthy = true;
                    toastr.success('本地网关已启动。');
                } else {
                    toastr.error(`启动失败：${j.error || '未知错误'}。可手动双击 gateway/start-gateway.bat。`);
                    $btn.prop('disabled', false).css('opacity', '');
                    return;
                }
            } catch (e) {
                toastr.error(`启动请求失败：${e.message}。需开启 enableServerPlugins，或手动双击 gateway/start-gateway.bat。`);
                $btn.prop('disabled', false).css('opacity', '');
                return;
            }
            $btn.prop('disabled', false).css('opacity', '');
        }
        if (profileName) {
            const ok = await switchConnectionProfile(profileName);
            if (ok) toastr.success(`已切换连接配置 →「${profileName}」，并打开网关控制台。`);
            else toastr.error('切换 profile 失败，请确认名称正确，仅打开网关控制台。');
        } else {
            toastr.info('未选网关 profile，仅打开网关控制台。');
        }
        window.open(`${GATEWAY}/console`, '_blank');
    });

    $(document).off('click', '#wizard-anthropic-cache-offline-probe-btn').on('click', '#wizard-anthropic-cache-offline-probe-btn', async function () {
        const $btn = $(this);
        if ($btn.prop('disabled')) return;
        $btn.prop('disabled', true).css('opacity', '0.65');
        try {
            const result = runAnthropicCacheOfflineProbe();
            renderCacheOfflineProbeResult(result);
            const sim = result.simulation;
            if (config.anthropicCacheAiExplain) {
                toastr.info('正在调用 AI，把两轮 cache 对比结果解释成人话...');
                result.aiExplanation = await explainAnthropicCachePlacementWithAi(result);
                renderCacheOfflineProbeResult(result);
            }
            console.info(`${LOG_PREFIX} CacheControl offline probe result: matched=${sim.matched}, stableTokens≈${sim.stableTokens}, simulatedRead≈${sim.round2.simulated_cache_read_input_tokens}.`);
            if (sim.matched) toastr.success(config.anthropicCacheAiExplain ? '真实 payload 离线对比完成：AI 已解释推荐放置位置。' : '真实 payload 离线对比完成：已直接告诉你实际落点。');
            else toastr.warning('真实 payload 离线对比完成：当前最终 payload 无法形成可复用前缀，理论上不会 cache read。');
        } catch (e) {
            const msg = e?.message || String(e);
            renderCacheProbeError(msg);
            console.error(`${LOG_PREFIX} CacheControl offline probe failed: ${msg}`);
            toastr.error(`Cache 离线模拟失败：${msg}`);
        } finally {
            $btn.prop('disabled', false).css('opacity', '');
        }
    });

    // 时记 add regex rule: validate the pattern, parse the optional position
    // window, push to config.shijiRules, re-render rules + preview, persist.
    $(document).off('click', '#wizard-shiji-add-rule').on('click', '#wizard-shiji-add-rule', function () {
        const regex = ($('#wizard-shiji-rule-regex').val() || '').trim();
        if (!regex) { toastr.warning('请先填写 regex。'); return; }
        try { new RegExp(regex); } catch (e) { toastr.error(`非法 regex: ${e.message}`); return; }
        const minRaw = ($('#wizard-shiji-rule-posmin').val() || '').trim();
        const maxRaw = ($('#wizard-shiji-rule-posmax').val() || '').trim();
        const posMin = minRaw === '' ? null : Math.max(1, parseInt(minRaw));
        const posMax = maxRaw === '' ? null : Math.max(1, parseInt(maxRaw));
        if (posMin != null && posMax != null && posMin > posMax) {
            toastr.warning('起始位不能大于结束位。');
            return;
        }
        const role = $('#wizard-shiji-rule-role').val() || 'both';
        const mode = $('#wizard-shiji-rule-mode').val() || 'keep';
        if (!Array.isArray(config.shijiRules)) config.shijiRules = [];
        config.shijiRules.push({ regex, posMin, posMax, role, mode });
        $('#wizard-shiji-rule-regex').val('');
        $('#wizard-shiji-rule-posmin').val('');
        $('#wizard-shiji-rule-posmax').val('');
        renderShijiRules();
        renderShijiList();
        saveConfig(true);
    });

    // ── 融合前正则（recap pre-regex）规则编辑器事件 ──
    // Add a new 融合前正则 rule. Same UX as the 时记 add-row (role + position window + mode).
    $(document).off('click', '#wizard-recap-add-rule').on('click', '#wizard-recap-add-rule', function () {
        const regex = ($('#wizard-recap-rule-regex').val() || '').trim();
        if (!regex) { toastr.warning('regex 不能为空。'); return; }
        try { new RegExp(regex); } catch (e) { toastr.error(`非法 regex: ${e.message}`); return; }
        const minRaw = ($('#wizard-recap-rule-posmin').val() || '').trim();
        const maxRaw = ($('#wizard-recap-rule-posmax').val() || '').trim();
        const posMin = minRaw === '' ? null : Math.max(1, parseInt(minRaw));
        const posMax = maxRaw === '' ? null : Math.max(1, parseInt(maxRaw));
        if (posMin != null && posMax != null && posMin > posMax) {
            toastr.warning('起始位不能大于结束位。');
            return;
        }
        const roleRaw = $('#wizard-recap-rule-role').val() || 'both';
        const role = (roleRaw === 'ai' || roleRaw === 'user') ? roleRaw : 'both';
        const mode = $('#wizard-recap-rule-mode').val() === 'remove' ? 'remove' : 'keep';
        if (!Array.isArray(config.recapPreRegexRules)) config.recapPreRegexRules = [];
        config.recapPreRegexRules.push({ regex, posMin, posMax, role, mode });
        $('#wizard-recap-rule-regex').val('');
        $('#wizard-recap-rule-posmin').val('');
        $('#wizard-recap-rule-posmax').val('');
        renderRecapPreRegexRules();
        saveConfig(true);
    });

    $(document).off('click', '.wizard-recap-rule-remove').on('click', '.wizard-recap-rule-remove', function () {
        const i = parseInt($(this).data('index'));
        if (!Array.isArray(config.recapPreRegexRules) || isNaN(i)) return;
        config.recapPreRegexRules.splice(i, 1);
        renderRecapPreRegexRules();
        saveConfig(true);
    });

    $(document).off('change', '.wizard-recap-rule-edit').on('change', '.wizard-recap-rule-edit', function () {
        const i = parseInt($(this).data('index'));
        if (!Array.isArray(config.recapPreRegexRules) || isNaN(i) || !config.recapPreRegexRules[i]) return;
        const val = ($(this).val() || '').trim();
        if (!val) { toastr.warning('regex 不能为空。'); $(this).val(config.recapPreRegexRules[i].regex); return; }
        try { new RegExp(val); } catch (e) {
            toastr.error(`非法 regex: ${e.message}`);
            $(this).val(config.recapPreRegexRules[i].regex);
            return;
        }
        config.recapPreRegexRules[i].regex = val;
        saveConfig(true);
    });

    $(document).off('change', '.wizard-recap-rule-mode-edit').on('change', '.wizard-recap-rule-mode-edit', function () {
        const i = parseInt($(this).data('index'));
        if (!Array.isArray(config.recapPreRegexRules) || isNaN(i) || !config.recapPreRegexRules[i]) return;
        config.recapPreRegexRules[i].mode = $(this).val() === 'remove' ? 'remove' : 'keep';
        renderRecapPreRegexRules();
        saveConfig(true);
    });

    // 融合前正则 inline-edit a rule's ROLE (ai / user / both).
    $(document).off('change', '.wizard-recap-rule-role-edit').on('change', '.wizard-recap-rule-role-edit', function () {
        const i = parseInt($(this).data('index'));
        if (!Array.isArray(config.recapPreRegexRules) || isNaN(i) || !config.recapPreRegexRules[i]) return;
        const v = $(this).val();
        config.recapPreRegexRules[i].role = (v === 'ai' || v === 'user') ? v : 'both';
        renderRecapPreRegexRules();
        saveConfig(true);
    });

    // 融合前正则 inline-edit a rule's position window (posMin / posMax). Empty = 不限.
    // Shared handler for both number inputs; validates min <= max when both set.
    $(document).off('change', '.wizard-recap-rule-posmin-edit, .wizard-recap-rule-posmax-edit')
        .on('change', '.wizard-recap-rule-posmin-edit, .wizard-recap-rule-posmax-edit', function () {
        const i = parseInt($(this).data('index'));
        if (!Array.isArray(config.recapPreRegexRules) || isNaN(i) || !config.recapPreRegexRules[i]) return;
        const isMin = $(this).hasClass('wizard-recap-rule-posmin-edit');
        const raw = ($(this).val() || '').trim();
        const parsed = raw === '' ? null : Math.max(1, parseInt(raw));
        const rule = config.recapPreRegexRules[i];
        const nextMin = isMin ? parsed : (rule.posMin == null || rule.posMin === '' ? null : rule.posMin);
        const nextMax = isMin ? (rule.posMax == null || rule.posMax === '' ? null : rule.posMax) : parsed;
        if (nextMin != null && nextMax != null && nextMin > nextMax) {
            toastr.warning('起始位不能大于结束位。');
            renderRecapPreRegexRules(); // revert the displayed value
            return;
        }
        rule.posMin = nextMin;
        rule.posMax = nextMax;
        renderRecapPreRegexRules();
        saveConfig(true);
    });

    // 时记 remove regex rule.
    $(document).off('click', '.wizard-shiji-rule-remove').on('click', '.wizard-shiji-rule-remove', function () {
        const i = parseInt($(this).data('index'));
        if (!Array.isArray(config.shijiRules) || isNaN(i)) return;
        config.shijiRules.splice(i, 1);
        renderShijiRules();
        renderShijiList();
        saveConfig(true);
    });

    // 时记 inline-edit a rule's regex directly in the list (validate on blur,
    // write back to config.shijiRules[i].regex, refresh preview + persist).
    $(document).off('change', '.wizard-shiji-rule-edit').on('change', '.wizard-shiji-rule-edit', function () {
        const i = parseInt($(this).data('index'));
        if (!Array.isArray(config.shijiRules) || isNaN(i) || !config.shijiRules[i]) return;
        const val = ($(this).val() || '').trim();
        if (!val) { toastr.warning('regex 不能为空。'); $(this).val(config.shijiRules[i].regex); return; }
        try { new RegExp(val); } catch (e) {
            toastr.error(`非法 regex: ${e.message}`);
            $(this).val(config.shijiRules[i].regex); // revert to last valid value
            return;
        }
        config.shijiRules[i].regex = val;
        renderShijiList(); // refresh the per-floor preview to reflect the new rule
        saveConfig(true);
    });

    // 时记 inline-edit a rule's ROLE (ai / user / both).
    $(document).off('change', '.wizard-shiji-rule-role-edit').on('change', '.wizard-shiji-rule-role-edit', function () {
        const i = parseInt($(this).data('index'));
        if (!Array.isArray(config.shijiRules) || isNaN(i) || !config.shijiRules[i]) return;
        const v = $(this).val();
        config.shijiRules[i].role = (v === 'ai' || v === 'user') ? v : 'both';
        renderShijiRules();
        renderShijiList();
        saveConfig(true);
    });

    // 时记 inline-edit a rule's MODE (keep / remove).
    $(document).off('change', '.wizard-shiji-rule-mode-edit').on('change', '.wizard-shiji-rule-mode-edit', function () {
        const i = parseInt($(this).data('index'));
        if (!Array.isArray(config.shijiRules) || isNaN(i) || !config.shijiRules[i]) return;
        config.shijiRules[i].mode = $(this).val() === 'remove' ? 'remove' : 'keep';
        renderShijiRules();
        renderShijiList();
        saveConfig(true);
    });

    // 时记 inline-edit a rule's position window (posMin / posMax). Empty = 不限.
    // Shared handler for both number inputs; validates min <= max.
    $(document).off('change', '.wizard-shiji-rule-posmin-edit, .wizard-shiji-rule-posmax-edit')
        .on('change', '.wizard-shiji-rule-posmin-edit, .wizard-shiji-rule-posmax-edit', function () {
        const i = parseInt($(this).data('index'));
        if (!Array.isArray(config.shijiRules) || isNaN(i) || !config.shijiRules[i]) return;
        const isMin = $(this).hasClass('wizard-shiji-rule-posmin-edit');
        const raw = ($(this).val() || '').trim();
        const parsed = raw === '' ? null : Math.max(1, parseInt(raw));
        const rule = config.shijiRules[i];
        const nextMin = isMin ? parsed : (rule.posMin == null || rule.posMin === '' ? null : rule.posMin);
        const nextMax = isMin ? (rule.posMax == null || rule.posMax === '' ? null : rule.posMax) : parsed;
        if (nextMin != null && nextMax != null && nextMin > nextMax) {
            toastr.warning('起始位不能大于结束位。');
            renderShijiRules(); // revert the displayed value
            return;
        }
        rule.posMin = nextMin;
        rule.posMax = nextMax;
        renderShijiRules();
        renderShijiList();
        saveConfig(true);
    });

    // Save configuration button
    $(document).off('click', '#wizard-save-settings-btn').on('click', '#wizard-save-settings-btn', function () {
        saveConfig();
    });

    // Tree Search
    function performTreeSearch() {
        const q = $('#wizard-tree-search').val().trim().toLowerCase();
        if (!q) {
            renderTreeView(memoryTree, $('#wizard-tree-root'));
            return;
        }

        // Filter tree
        function searchNodes(nodes) {
            const results = [];
            nodes.forEach(node => {
                const titleMatch = node.title.toLowerCase().includes(q);
                const hintMatch = node.hint && node.hint.toLowerCase().includes(q);
                const contentMatch = node.content && node.content.toLowerCase().includes(q);

                let childrenMatches = [];
                if (node.children) {
                    childrenMatches = searchNodes(node.children);
                }

                if (titleMatch || hintMatch || contentMatch || childrenMatches.length > 0) {
                    const cloned = { ...node, children: childrenMatches };
                    results.push(cloned);
                }
            });
            return results;
        }
        const filteredTree = searchNodes(memoryTree);
        renderTreeView(filteredTree, $('#wizard-tree-root'));
    }

    $(document).off('click', '#wizard-tree-search-btn').on('click', '#wizard-tree-search-btn', performTreeSearch);
    $(document).off('input', '#wizard-tree-search').on('input', '#wizard-tree-search', performTreeSearch);

    // Context Fusion Tab handlers
    $(document).off('click', '#wizard-context-load-btn').on('click', '#wizard-context-load-btn', async function () {
        const context = window.SillyTavern?.getContext();
        if (!context || !context.chat || context.chat.length === 0) {
            toastr.warning('当前没有加载任何聊天或聊天内容为空！');
            return;
        }

        sandboxChatContext = JSON.parse(JSON.stringify(context.chat));
        sandboxPage = 0; // reset to first page on a fresh load
        // Fresh snapshot = no pending floor edits yet; hide the apply button.
        sandboxEditsDirty = false;
        $('#wizard-context-apply-btn').css('display', 'none');
        renderSandboxChat();
        await saveSandboxChatToServer();
        toastr.success(`成功载入并保存了 ${sandboxChatContext.length} 条对话上下文！`);
    });

    // Fusion source toggle: floors vs existing records.
    $(document).off('change', '#wizard-fusion-source').on('change', '#wizard-fusion-source', function () {
        const src = $(this).val();
        if (src === 'records') {
            $('.wizard-fusion-floors-only').hide();
            $('.wizard-fusion-records-only').show();
        } else {
            $('.wizard-fusion-floors-only').show();
            $('.wizard-fusion-records-only').hide();
        }
    });

    // Persist sticky fusion-panel settings on any change so they survive a refresh.
    // Silent save (no toast). Floor start/end use both input+change so typing sticks.
    $(document).off('change.fusionSticky',
        '#wizard-fusion-source, #wizard-fusion-type, #wizard-fusion-record-from')
        .on('change.fusionSticky',
            '#wizard-fusion-source, #wizard-fusion-type, #wizard-fusion-record-from',
            () => { saveConfig(true); updateFusionTokenStats(); });
    $(document).off('input.fusionStickyFloors change.fusionStickyFloors', '#wizard-fusion-start, #wizard-fusion-end')
        .on('input.fusionStickyFloors change.fusionStickyFloors', '#wizard-fusion-start, #wizard-fusion-end',
            () => saveConfig(true));

    // ── 已有记录 勾选下拉：列出当前来源层所有未归档条目，支持多选。──
    // 每个条目用 wizard-switch 滑块替代原生 checkbox，名字颜色跟记录类型。
    // 事件委托挂在 container 上（static handler），不随 .html() 重建而丢失。
    let _recordPickerDelegated = false;
    function renderRecordPicker() {
        if ($('#wizard-fusion-source').val() !== 'records') return;
        const container = $('#wizard-fusion-record-picker');
        const countLabel = $('#wizard-fusion-record-pick-count');
        if (!container.length) return;
        const fromType = $('#wizard-fusion-record-from').val();
        const arr = getSummaryArray(fromType);
        const typeColor = SUMMARY_COLORS[fromType] || '#a78bfa';
        // Init picks
        if (!config.fusionRecordPicks) config.fusionRecordPicks = {};
        if (!config.fusionRecordPicks[fromType]) config.fusionRecordPicks[fromType] = [];
        const picks = config.fusionRecordPicks[fromType];
        if (!arr || !arr.length) {
            container.html('<span style="color:#6b7280;">（暂无记录）</span>');
            if (countLabel.length) countLabel.text('(已选 0)');
            return;
        }
        const active = arr.map((item, i) => ({ item, i })).filter(o => !sumIsArchived(o.item));
        if (!active.length) {
            container.html('<span style="color:#6b7280;">（暂无未归档记录）</span>');
            if (countLabel.length) countLabel.text('(已选 0)');
            return;
        }
        // Purge stale indices
        const valid = picks.filter(i => arr[i] && !sumIsArchived(arr[i]));
        config.fusionRecordPicks[fromType] = valid;
        const isChecked = (i) => valid.includes(i);
        const items = active.map(({ item, i }) => {
            const name = (item && item.name) ? item.name.trim() : '';
            const ts = sumTimespan(item) || '';
            const rt = sumRealTimespan(item) || '';
            const cf = sumCoveredFloors(item);
            const floorStr = cf ? '楼层 ' + cf.lo + '-' + cf.hi : '';
            const meta = [ts, rt, floorStr].filter(Boolean).join(' · ');
            const preview = (sumText(item) || '').slice(0, 40).replace(/\n/g, ' ');
            const chk = isChecked(i) ? ' checked' : '';
            const nameHtml = name
                ? ' <span style="color:' + typeColor + ';">' + name.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') + '</span>'
                : '';
            return '<div class="wizard-record-pick-row" data-idx="' + i + '" style="display:flex;align-items:flex-start;gap:8px;padding:3px 0;border-bottom:1px solid rgba(255,255,255,0.04);cursor:pointer;"><label class="wizard-switch" style="flex-shrink:0;margin-top:2px;"><input type="checkbox" class="wizard-record-pick-cb" data-idx="' + i + '"' + chk + '><span class="wizard-slider"></span></label><span style="line-height:1.35;flex:1;min-width:0;"><b>#' + (i + 1) + '</b>' + nameHtml + (meta ? ' <span style="color:#9ca3af;font-size:0.9em;">' + meta + '</span>' : '') + '<br><span style="color:#6b7280;font-size:0.85em;word-break:break-all;">' + preview + '…</span></span></div>';
        }).join('');
        container.html(items);
        const sel = valid.length;
        if (countLabel.length) countLabel.text('(已选 ' + sel + '/' + active.length + ')').css('color', sel >= 2 ? '#10b981' : '#f59e0b');
        // Static delegated handler — bound ONCE on the container, survives all
        // .html() rebuilds. .wizard-record-pick-row click toggles the switch.
        if (!_recordPickerDelegated) {
            _recordPickerDelegated = true;
            container.off('click.recordPicker', '.wizard-record-pick-row').on('click.recordPicker', '.wizard-record-pick-row', function (e) {
                // Don't toggle if the user clicked the slider itself — the browser
                // handles the native checkbox toggle; we just sync state afterward.
                const cb = $(this).find('.wizard-record-pick-cb')[0];
                if (!cb) return;
                // Let the native checkbox/label behavior run first (microtask), then
                // read the final state. Use setTimeout(0) to read AFTER the toggle.
                setTimeout(() => {
                    const idx = parseInt($(this).attr('data-idx'));
                    if (isNaN(idx)) return;
                    const curFromType = $('#wizard-fusion-record-from').val();
                    if (!config.fusionRecordPicks) config.fusionRecordPicks = {};
                    if (!config.fusionRecordPicks[curFromType]) config.fusionRecordPicks[curFromType] = [];
                    const stored = config.fusionRecordPicks[curFromType];
                    if (cb.checked) {
                        if (!stored.includes(idx)) stored.push(idx);
                    } else {
                        const pos = stored.indexOf(idx);
                        if (pos >= 0) stored.splice(pos, 1);
                    }
                    const arrNow = getSummaryArray(curFromType);
                    const cur = stored.filter(i => arrNow && arrNow[i] && !sumIsArchived(arrNow[i]));
                    const total = (arrNow || []).filter((x, i) => x && !sumIsArchived(x)).length;
                    const cl = $('#wizard-fusion-record-pick-count');
                    if (cl.length) cl.text('(已选 ' + cur.length + '/' + total + ')').css('color', cur.length >= 2 ? '#10b981' : '#f59e0b');
                    config.fusionRecordPicks[curFromType] = cur;
                    updateFusionTokenStats();
                }, 0);
            });
        }
    }
    // Wire renderRecordPicker into source/from changes
    $('#wizard-fusion-source').off('change.renderRecordPicker').on('change.renderRecordPicker', function () { renderRecordPicker(); });
    $('#wizard-fusion-record-from').off('change.renderRecordPicker').on('change.renderRecordPicker', function () { renderRecordPicker(); updateFusionTokenStats(); });
    // Pick-all / pick-none buttons
    $(document).off('click', '#wizard-fusion-pick-all').on('click', '#wizard-fusion-pick-all', function () {
        const ft = $('#wizard-fusion-record-from').val();
        const a = getSummaryArray(ft);
        if (!a) return;
        if (!config.fusionRecordPicks) config.fusionRecordPicks = {};
        config.fusionRecordPicks[ft] = a.map((x, i) => i).filter(i => !sumIsArchived(a[i]));
        renderRecordPicker();
        updateFusionTokenStats();
    });
    $(document).off('click', '#wizard-fusion-pick-none').on('click', '#wizard-fusion-pick-none', function () {
        const ft = $('#wizard-fusion-record-from').val();
        if (!config.fusionRecordPicks) config.fusionRecordPicks = {};
        config.fusionRecordPicks[ft] = [];
        renderRecordPicker();
        updateFusionTokenStats();
    });

    // Apply sandbox edits back to the real ST chat (visible in the conversation).
    $(document).off('click', '#wizard-context-apply-btn').on('click', '#wizard-context-apply-btn', async function () {
        const context = window.SillyTavern?.getContext();
        if (!context || !context.chat) { toastr.warning('当前没有打开聊天。'); return; }
        if (!sandboxChatContext || sandboxChatContext.length === 0) { toastr.warning('沙盒为空，请先载入上下文。'); return; }

        const ok = await context.Popup.show.confirm('应用更改到聊天？', '将把沙盒里各楼层修改后的正文写回当前聊天文件，聊天中会立即可见。此操作会修改原聊天。');
        if (!ok) return;

        let applied = 0;
        sandboxChatContext.forEach((sandboxMsg, floor) => {
            const target = context.chat[floor];
            if (!target) return; // floor no longer exists in the live chat
            const sKey = sandboxMsg.content !== undefined ? 'content' : 'mes';
            const tKey = target.content !== undefined ? 'content' : 'mes';
            const newText = sandboxMsg[sKey] || "";
            if (target[tKey] !== newText) {
                target[tKey] = newText;
                // Keep the active swipe in sync so the UI reflects the edit.
                if (Array.isArray(target.swipes) && target.swipe_id !== undefined && target.swipes[target.swipe_id] !== undefined) {
                    target.swipes[target.swipe_id] = newText;
                }
                applied++;
            }
        });

        try {
            await context.saveChat();
            if (typeof context.reloadCurrentChat === 'function') await context.reloadCurrentChat();
            toastr.success(`已应用 ${applied} 条更改到聊天。`);
            writeLog(`Applied ${applied} sandbox edits back to the live chat.`);
            // Edits are committed; clear the session dirty state and hide the button.
            sandboxEditsDirty = false;
            $('#wizard-context-apply-btn').css('display', 'none');
        } catch (e) {
            toastr.error('写回聊天失败: ' + e.message);
            writeLog(`Apply-to-chat failed: ${e.message}`, 'ERROR');
        }
    });

    // Collapse/expand the sandbox filter controls to give the floor list more room.
    $(document).off('click', '.wizard-sandbox-controls-toggle').on('click', '.wizard-sandbox-controls-toggle', function () {
        const block = $('#wizard-sandbox-controls-collapsible');
        const icon = $(this);
        const collapsed = block.css('display') === 'none';
        if (collapsed) {
            block.css('display', 'flex');
            icon.removeClass('fa-chevron-right').addClass('fa-chevron-down');
        } else {
            block.css('display', 'none');
            icon.removeClass('fa-chevron-down').addClass('fa-chevron-right');
        }
    });

    // Sandbox page-size control: re-page from the top while typing; persist on commit.
    $(document).off('input', '#wizard-sandbox-page-size').on('input', '#wizard-sandbox-page-size', function () {
        config.sandboxPageSize = Math.max(10, Math.min(1000, parseInt($(this).val()) || 100));
        sandboxPage = 0;
        renderSandboxChat();
    });
    $(document).off('change', '#wizard-sandbox-page-size').on('change', '#wizard-sandbox-page-size', function () {
        config.sandboxPageSize = Math.max(10, Math.min(1000, parseInt($(this).val()) || 100));
        saveConfig(true); // silent persist
    });

    // Sandbox regex filter: live re-render to refresh match previews, persist.
    // (Legacy single-regex input; also usable directly without adding a tag.)
    $(document).off('input', '#wizard-sandbox-regex').on('input', '#wizard-sandbox-regex', function () {
        config.sandboxRegex = $(this).val();
        renderSandboxChat();
    });
    $(document).off('change', '#wizard-sandbox-regex').on('change', '#wizard-sandbox-regex', function () {
        config.sandboxRegex = $(this).val();
        saveConfig(true); // silent persist
    });

    // Keyword filter: applies LIVE on every keystroke (Ctrl+F style) — no need to
    // click 添加筛选. Highlights matches in orange and centres the middle matched
    // floor in the list. Also persisted.
    $(document).off('input', '#wizard-sandbox-keyword').on('input', '#wizard-sandbox-keyword', function () {
        config.sandboxKeyword = $(this).val();
        sandboxPage = 0;
        renderSandboxChat();
        // renderSandboxChat already centred the mark inside each preview box; this
        // additionally centres the whole floor so its neighbours are reachable.
        centerMiddleKeywordHit();
    });
    $(document).off('change', '#wizard-sandbox-keyword').on('change', '#wizard-sandbox-keyword', function () {
        config.sandboxKeyword = $(this).val();
        saveConfig(true);
    });

    // Space-separated terms: phrase / AND / OR. Re-filters immediately so the effect
    // of switching is visible without retyping the keyword.
    $(document).off('change', '#wizard-sandbox-keyword-logic').on('change', '#wizard-sandbox-keyword-logic', function () {
        config.sandboxKeywordMode = $(this).val() || 'phrase';
        sandboxPage = 0;
        renderSandboxChat();
        centerMiddleKeywordHit();
        saveConfig(true);
    });

    // Red X inside the keyword box: clear the search in one click. The floor at the
    // centre of the view is captured first and re-centred afterwards — dropping the
    // filter makes the list far longer, so without an anchor the same scroll offset
    // lands on an unrelated floor and you lose the one you just searched for.
    $(document).off('click', '#wizard-sandbox-keyword-clear').on('click', '#wizard-sandbox-keyword-clear', function () {
        const anchor = centeredSandboxFloor();
        $('#wizard-sandbox-keyword').val('').focus();
        config.sandboxKeyword = '';
        sandboxPage = 0;
        if (anchor === null || !jumpToSandboxFloor(anchor)) renderSandboxChat();
        saveConfig(true);
    });

    // ---- Switchable match modes + removable filter tags ----
    // Show only the value input(s) relevant to the chosen mode.
    function populateSandboxRecordNames(type) {
        const arr = getSummaryArray(type) || [];
        const typeName = SUMMARY_TYPE_NAMES[type] || type;
        const sel = $('#wizard-sandbox-record-name');
        const prev = sel.val();
        sel.empty().append('<option value="">(全部条目)</option>');
        arr.forEach((item, i) => {
            const name = sumName(item) || `${typeName}#${i + 1}`;
            sel.append(`<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`);
        });
        // Show name select only when there are named entries; always show if non-empty
        if (arr.length) {
            sel.css('display', '');
            if (arr.some((item, i) => sumName(item) === prev)) sel.val(prev);
        } else {
            sel.css('display', 'none');
        }
    }

    $(document).off('change', '#wizard-sandbox-record-type').on('change', '#wizard-sandbox-record-type', function () {
        populateSandboxRecordNames($(this).val() || 'historical');
    });

    function syncSandboxModeInputs() {
        const mode = $('#wizard-sandbox-match-mode').val();
        sandboxMatchMode = mode;
        $('.wizard-sandbox-mode-input').hide();
        if (mode === 'regex') { $('#wizard-sandbox-regex').css('display', ''); $('.wizard-sandbox-regex-grp').css('display', ''); }
        else if (mode === 'keyword') $('#wizard-sandbox-keyword-wrap, #wizard-sandbox-keyword-logic').css('display', '');
        else if (mode === 'time') {
            $('#wizard-sandbox-time-wrap').css('display', 'flex');
            // Default range = yesterday → today (date inputs are day-granular).
            const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
            const now = new Date();
            const yest = new Date(now.getTime() - 24 * 60 * 60 * 1000);
            if (!$('#wizard-sandbox-time-from').val()) $('#wizard-sandbox-time-from').val(ymd(yest));
            if (!$('#wizard-sandbox-time-to').val()) $('#wizard-sandbox-time-to').val(ymd(now));
        }
        else if (mode === 'size') $('#wizard-sandbox-size-dir').css('display', '');
        else if (mode === 'model') {
            $('#wizard-sandbox-model-sel').css('display', '');
            // Auto-populate with the distinct models used across the sandbox.
            const models = Array.from(new Set(sandboxChatContext.map(msgModel).filter(Boolean)));
            const sel = $('#wizard-sandbox-model-sel');
            const prev = sel.val();
            sel.empty();
            if (!models.length) {
                sel.append('<option value="">（无模型信息，请先载入上下文）</option>');
            } else {
                models.forEach(m => sel.append(`<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`));
                if (models.includes(prev)) sel.val(prev);
            }
        }
        else if (mode === 'role') $('.wizard-sandbox-role-grp').css('display', '');
        else if (mode === 'record') {
            $('#wizard-sandbox-record-type').css('display', '');
            populateSandboxRecordNames($('#wizard-sandbox-record-type').val() || 'historical');
        }
    }
    $(document).off('change', '#wizard-sandbox-match-mode').on('change', '#wizard-sandbox-match-mode', function () {
        syncSandboxModeInputs();
        saveConfig(true);
    });
    // Allow external callers (tab switch) to refresh the tag chips + mode inputs.
    // When the panel opens we also AUTO-APPLY the saved active match template so its
    // saved filter rules (sandboxFilters/regex/keyword) are actually in effect — not
    // merely shown by name. Previously the dropdown showed the template but the rules
    // were never loaded until the user re-selected it manually.
    $(document).off('wizard:refresh', '#wizard-sandbox-filter-tags').on('wizard:refresh', '#wizard-sandbox-filter-tags', function () {
        syncSandboxModeInputs();
        const activeTpl = config.activeMatchTemplate || '';
        const hasTpl = Array.isArray(config.matchTemplates)
            && config.matchTemplates.some(t => t.name === activeTpl);
        if (activeTpl && hasTpl) {
            // Loads the template's filters into the live state, re-renders chips + chat.
            applyMatchTemplate(activeTpl);
        } else {
            renderSandboxFilterTags();
        }
        refreshMatchTemplateSelect();
    });

    // Render the active filter tags (pixiv-style chips with an X to remove).
    function renderSandboxFilterTags() {
        const wrap = $('#wizard-sandbox-filter-tags');
        if (!wrap.length) return;
        if (!sandboxFilters.length) {
            wrap.hide().empty();
            return;
        }
        wrap.empty().css('display', 'flex');
        sandboxFilters.forEach((f, i) => {
            const chip = $(`
                <span class="wizard-sandbox-filter-chip" data-index="${i}" style="display: inline-flex; align-items: center; gap: 6px; background: rgba(var(--wizard-primary-rgb), 0.15); border: 1px solid rgba(var(--wizard-primary-rgb), 0.45); color: var(--wizard-primary); padding: 2px 8px; border-radius: 12px; font-size: 0.95em; cursor:pointer;">
                    <span class="wizard-sandbox-tag-label"></span>
                    <i class="fa-solid fa-xmark wizard-sandbox-tag-remove" data-index="${i}" style="cursor: pointer; opacity: 0.8;"></i>
                </span>`);
            chip.find('.wizard-sandbox-tag-label').text(filterTagLabel(f));
            wrap.append(chip);
        });
    }

    function loadFilterTagIntoInputs(f) {
        if (!f) return;
        $('#wizard-sandbox-match-mode').val(f.type);
        syncSandboxModeInputs();
        if (f.type === 'regex') {
            $('#wizard-sandbox-regex').val(f.value || '');
            $('#wizard-sandbox-regex-role').val((f.role === 'ai' || f.role === 'user') ? f.role : 'both');
            $('#wizard-sandbox-regex-posmin').val((f.posMin == null || f.posMin === '') ? '' : f.posMin);
            $('#wizard-sandbox-regex-posmax').val((f.posMax == null || f.posMax === '') ? '' : f.posMax);
            $('#wizard-sandbox-regex-mode').val(f.mode === 'remove' ? 'remove' : 'keep');
        }
        else if (f.type === 'keyword') {
            $('#wizard-sandbox-keyword').val(f.value || '');
            $('#wizard-sandbox-keyword-logic').val(keywordModeOf(f));
        }
        else if (f.type === 'model') $('#wizard-sandbox-model-sel').val(f.value || '');
        else if (f.type === 'size') $('#wizard-sandbox-size-dir').val(f.value || 'desc');
        else if (f.type === 'role') {
            const v = typeof f.value === 'string' ? { keep: f.value, excluded: 'remove' } : (f.value || {});
            $('#wizard-sandbox-role-sel').val(v.keep || 'ai');
            $('#wizard-sandbox-role-excl').val(v.excluded || 'remove');
        } else if (f.type === 'time') {
            $('#wizard-sandbox-time-from').val(f.from || '');
            $('#wizard-sandbox-time-to').val(f.to || '');
        } else if (f.type === 'floorRange') {
            // floorRange is added from the pager 筛楼层 button, not the match-mode
            // dropdown. Reloading it writes its lo/hi back into the 上下文融合
            // 起始/结束楼层 inputs so the user can re-apply / tweak the range.
            const v = f.value || {};
            $('#wizard-fusion-start').val((typeof v.lo === 'number') ? v.lo : '');
            $('#wizard-fusion-end').val((typeof v.hi === 'number') ? v.hi : '');
        } else if (f.type === 'record') {
            $('#wizard-sandbox-record-type').val(f.value || 'historical');
            populateSandboxRecordNames(f.value || 'historical');
            if (f.name) $('#wizard-sandbox-record-name').val(f.name);
        }
        sandboxMatchMode = f.type;
        saveConfig(true);
        updateFusionTokenStats();
        toastr.info(`已载入筛选样式：${filterTagLabel(f)}`);
    }

    $(document).off('click', '.wizard-sandbox-filter-chip').on('click', '.wizard-sandbox-filter-chip', function (e) {
        if ($(e.target).hasClass('wizard-sandbox-tag-remove')) return;
        const idx = parseInt($(this).data('index'));
        loadFilterTagIntoInputs(sandboxFilters[idx]);
    });

    // Add a filter tag from the current mode + its input value.
    $(document).off('click', '#wizard-sandbox-add-filter').on('click', '#wizard-sandbox-add-filter', function () {
        const mode = $('#wizard-sandbox-match-mode').val();
        let tag = null;
        if (mode === 'regex') {
            const v = $('#wizard-sandbox-regex').val().trim();
            if (!v) { toastr.warning('请输入正则表达式。'); return; }
            try { new RegExp(v); } catch (e) { toastr.error('正则表达式无效。'); return; }
            // Optional role + backward-position window (same semantics as 时记 rules).
            const roleRaw = $('#wizard-sandbox-regex-role').val() || 'both';
            const role = (roleRaw === 'ai' || roleRaw === 'user') ? roleRaw : 'both';
            const minRaw = ($('#wizard-sandbox-regex-posmin').val() || '').trim();
            const maxRaw = ($('#wizard-sandbox-regex-posmax').val() || '').trim();
            const posMin = minRaw === '' ? null : Math.max(1, parseInt(minRaw));
            const posMax = maxRaw === '' ? null : Math.max(1, parseInt(maxRaw));
            if (posMin != null && posMax != null && posMin > posMax) {
                toastr.warning('起始位不能大于结束位。'); return;
            }
            const mode = $('#wizard-sandbox-regex-mode').val() === 'remove' ? 'remove' : 'keep';
            // Multiple regex tags are allowed (AND for filtering, concatenated for
            // extraction). Reject an exact duplicate (same pattern + role + window + mode).
            if (sandboxFilters.some(f => f.type === 'regex' && f.value === v
                && (f.role || 'both') === role
                && (f.posMin ?? null) === posMin && (f.posMax ?? null) === posMax
                && (f.mode || 'keep') === mode)) {
                toastr.info('该正则（含相同角色/位置/模式）已存在。'); return;
            }
            tag = { type: 'regex', value: v, role, posMin, posMax, mode };
        } else if (mode === 'keyword') {
            const v = $('#wizard-sandbox-keyword').val().trim();
            if (!v) { toastr.warning('请输入关键词。'); return; }
            tag = { type: 'keyword', value: v, kwMode: liveKeywordMode() };
        } else if (mode === 'time') {
            const fromStr = $('#wizard-sandbox-time-from').val();
            const toStr = $('#wizard-sandbox-time-to').val();
            if (!fromStr && !toStr) { toastr.warning('请至少选择一个时间端点。'); return; }
            // Parse the YYYY-MM-DD value as LOCAL midnight (and end-of-day for `to`).
            // Date.parse('YYYY-MM-DD') is UTC midnight, which in negative-offset
            // zones rolls back a day — that was the "05/22 leaks in" bug. Build the
            // Date from explicit components so it is unambiguously local.
            const localStart = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d, 0, 0, 0, 0).getTime(); };
            const localEnd = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d, 23, 59, 59, 999).getTime(); };
            const from = fromStr ? localStart(fromStr) : null;
            const to = toStr ? localEnd(toStr) : null;
            tag = { type: 'time', value: { from, to } };
        } else if (mode === 'size') {
            // Only one size-sort tag makes sense; replace any existing.
            sandboxFilters = sandboxFilters.filter(f => f.type !== 'size');
            tag = { type: 'size', value: $('#wizard-sandbox-size-dir').val() };
        } else if (mode === 'model') {
            const v = $('#wizard-sandbox-model-sel').val();
            if (!v) { toastr.warning('请选择一个模型。'); return; }
            tag = { type: 'model', value: v };
        } else if (mode === 'role') {
            // Only one role filter makes sense; replace any existing.
            sandboxFilters = sandboxFilters.filter(f => f.type !== 'role');
            const keep = $('#wizard-sandbox-role-sel').val() || 'ai';          // 'ai' | 'user'
            const excluded = $('#wizard-sandbox-role-excl').val() || 'remove'; // 'remove' | 'keep'
            tag = { type: 'role', value: { keep, excluded } };
        } else if (mode === 'record') {
            // Only one record filter makes sense; replace any existing.
            sandboxFilters = sandboxFilters.filter(f => f.type !== 'record');
            const recType = $('#wizard-sandbox-record-type').val() || 'historical';
            const recName = $('#wizard-sandbox-record-name').val() || '';
            tag = { type: 'record', value: recType, name: recName || undefined };
        }
        if (tag) {
            sandboxFilters.push(tag);
            // Keep the legacy regex preview in sync with the most recent regex tag,
            // and clear the input so the next regex can be typed (multi-regex).
            if (tag.type === 'regex') {
                config.sandboxRegex = tag.value;
                $('#wizard-sandbox-regex').val('');
                $('#wizard-sandbox-regex-posmin').val('');
                $('#wizard-sandbox-regex-posmax').val('');
                $('#wizard-sandbox-regex-role').val('both');
                $('#wizard-sandbox-regex-mode').val('keep');
            }
            renderSandboxFilterTags();
            sandboxPage = 0;
            renderSandboxChat();
        }
    });

    // Remove a filter tag.
    $(document).off('click', '.wizard-sandbox-tag-remove').on('click', '.wizard-sandbox-tag-remove', function () {
        const i = parseInt($(this).data('index'));
        const removed = sandboxFilters[i];
        sandboxFilters.splice(i, 1);
        if (removed && removed.type === 'regex' && !sandboxFilters.some(f => f.type === 'regex')) {
            config.sandboxRegex = ''; // clear legacy preview when last regex tag goes
            $('#wizard-sandbox-regex').val('');
        }
        renderSandboxFilterTags();
        sandboxPage = 0;
        renderSandboxChat();
    });

    // ---- Match-mode templates (save / switch / delete) ----
    function refreshMatchTemplateSelect() {
        const sel = $('#wizard-match-template-sel');
        if (!sel.length) return;
        const tpls = Array.isArray(config.matchTemplates) ? config.matchTemplates : [];
        sel.empty();
        sel.append('<option value="">（未使用模板）</option>');
        tpls.forEach(t => sel.append(`<option value="${escapeHtml(t.name)}">${escapeHtml(t.name)}</option>`));
        sel.val(config.activeMatchTemplate || '');
    }

    // Apply a template's saved state to the live filters + inputs.
    function applyMatchTemplate(name) {
        const tpls = Array.isArray(config.matchTemplates) ? config.matchTemplates : [];
        const t = tpls.find(x => x.name === name);
        config.activeMatchTemplate = name || '';
        if (!t) {
            // "（未使用模板）" — clear everything.
            sandboxFilters = [];
            config.sandboxRegex = '';
            config.sandboxKeyword = '';
            config.sandboxKeywordMode = 'phrase';
        } else {
            sandboxFilters = JSON.parse(JSON.stringify(t.filters || []));
            config.sandboxRegex = t.regex || '';
            config.sandboxKeyword = t.keyword || '';
            // Templates saved before the mode selector existed carry no keywordMode and
            // meant AND at the time, so they keep that rather than becoming phrases.
            config.sandboxKeywordMode = KEYWORD_MODES[t.keywordMode] ? t.keywordMode : 'and';
        }
        $('#wizard-sandbox-regex').val(config.sandboxRegex);
        $('#wizard-sandbox-keyword').val(config.sandboxKeyword);
        $('#wizard-sandbox-keyword-logic').val(liveKeywordMode());
        renderSandboxFilterTags();
        sandboxPage = 0;
        renderSandboxChat();
    }

    $(document).off('change', '#wizard-match-template-sel').on('change', '#wizard-match-template-sel', function () {
        applyMatchTemplate($(this).val());
        saveConfig(true);
    });

    $(document).off('click', '#wizard-match-template-save').on('click', '#wizard-match-template-save', async function () {
        const context = window.SillyTavern.getContext();
        let name = '';
        try {
            name = await context.Popup.show.input('保存匹配模板', '为当前匹配条件起个名字：');
        } catch (e) { name = window.prompt('模板名称：') || ''; }
        name = (name || '').trim();
        if (!name) return;
        if (!Array.isArray(config.matchTemplates)) config.matchTemplates = [];
        const snapshot = {
            name,
            filters: JSON.parse(JSON.stringify(sandboxFilters)),
            regex: config.sandboxRegex || '',
            keyword: config.sandboxKeyword || '',
            keywordMode: liveKeywordMode(),
        };
        const existing = config.matchTemplates.findIndex(t => t.name === name);
        if (existing >= 0) config.matchTemplates[existing] = snapshot;
        else config.matchTemplates.push(snapshot);
        config.activeMatchTemplate = name;
        refreshMatchTemplateSelect();
        await saveConfig(true);
        toastr.success(`已保存匹配模板「${name}」`);
    });

    $(document).off('click', '#wizard-match-template-del').on('click', '#wizard-match-template-del', async function () {
        const name = $('#wizard-match-template-sel').val();
        if (!name) { toastr.info('请先选择一个模板。'); return; }
        config.matchTemplates = (config.matchTemplates || []).filter(t => t.name !== name);
        if (config.activeMatchTemplate === name) config.activeMatchTemplate = '';
        refreshMatchTemplateSelect();
        await saveConfig(true);
        toastr.success(`已删除模板「${name}」`);
    });

    // Page count based on the CURRENTLY FILTERED entries (not the raw length).
    function sandboxPageCount() {
        const n = getFilteredSandboxEntries().length;
        return Math.max(1, Math.ceil(n / SANDBOX_PAGE_SIZE));
    }

    // Sandbox pagination: first / previous / next / last / jump.
    $(document).off('click', '.wizard-sandbox-first').on('click', '.wizard-sandbox-first', function () {
        if (sandboxPage !== 0) {
            sandboxPage = 0;
            renderSandboxChat();
            $('#wizard-context-editor-list').scrollTop(0);
        }
    });
    $(document).off('click', '.wizard-sandbox-prev').on('click', '.wizard-sandbox-prev', function () {
        if (sandboxPage > 0) {
            sandboxPage--;
            renderSandboxChat();
            $('#wizard-context-editor-list').scrollTop(0);
        }
    });
    $(document).off('click', '.wizard-sandbox-next').on('click', '.wizard-sandbox-next', function () {
        const pageCount = sandboxPageCount();
        if (sandboxPage < pageCount - 1) {
            sandboxPage++;
            renderSandboxChat();
            $('#wizard-context-editor-list').scrollTop(0);
        }
    });
    $(document).off('click', '.wizard-sandbox-last').on('click', '.wizard-sandbox-last', function () {
        const pageCount = sandboxPageCount();
        if (sandboxPage !== pageCount - 1) {
            sandboxPage = pageCount - 1;
            renderSandboxChat();
            $('#wizard-context-editor-list').scrollTop(0);
        }
    });
    // 筛楼层: read the 上下文融合 起始/结束楼层 inputs and apply them as a
    // floor-range filter (only show floors whose number falls in [lo, hi]).
    // Replaces any existing floorRange tag (one range at a time is meaningful).
    $(document).off('click', '.wizard-sandbox-filter-floorrange').on('click', '.wizard-sandbox-filter-floorrange', function () {
        const loRaw = $('#wizard-fusion-start').val().trim();
        const hiRaw = $('#wizard-fusion-end').val().trim();
        const lo = loRaw === '' ? null : parseInt(loRaw, 10);
        const hi = hiRaw === '' ? null : parseInt(hiRaw, 10);
        if ((lo === null && hi === null) || (lo !== null && isNaN(lo)) || (hi !== null && isNaN(hi))) {
            toastr.warning('请在「起始楼层 / 结束楼层」填入数字。');
            return;
        }
        if (lo !== null && hi !== null && lo > hi) {
            toastr.warning('起始楼层不能大于结束楼层。');
            return;
        }
        sandboxFilters = sandboxFilters.filter(f => f.type !== 'floorRange');
        const value = {};
        if (lo !== null) value.lo = lo;
        if (hi !== null) value.hi = hi;
        sandboxFilters.push({ type: 'floorRange', value });
        renderSandboxFilterTags();
        sandboxPage = 0;
        renderSandboxChat();
        const total = getFilteredSandboxEntries().length;
        toastr.success(`已按楼层 ${lo ?? '…'}-${hi ?? '…'} 筛选，共 ${total} 条。`);
    });
    // Jump directly to a FLOOR number (mesid). Finds the floor's position within the
    // CURRENTLY FILTERED set (floor != position when filters are active), switches to
    // the page holding it, then scrolls/flashes/focuses the row.
    $(document).off('change keydown', '.wizard-sandbox-jump-floor').on('change keydown', '.wizard-sandbox-jump-floor', function (e) {
        if (e.type === 'keydown' && e.key !== 'Enter') return;
        if (e.type === 'keydown') e.preventDefault();
        const floor = parseInt($(this).val());
        if (isNaN(floor)) { toastr.warning('请输入要跳转的楼层编号！'); return; }
        if (!jumpToSandboxFloor(floor)) {
            toastr.warning(`楼层 #${floor} 不在当前筛选结果中。`);
            return;
        }
        // Unlike the keyword-clear path, an explicit jump also focuses the body so the
        // user can start editing the floor they asked for straight away.
        $(`.context-msg-textarea[data-index="${floor}"]`).focus();
    });

    // Jump directly to page number X (1-based, matches the "第 X / N 页" label).
    $(document).off('change keydown', '.wizard-sandbox-jump-page').on('change keydown', '.wizard-sandbox-jump-page', function (e) {
        if (e.type === 'keydown' && e.key !== 'Enter') return;
        if (e.type === 'keydown') e.preventDefault();
        const pageCount = sandboxPageCount();
        const page = parseInt($(this).val());
        if (isNaN(page) || page < 1 || page > pageCount) {
            toastr.warning(`请输入有效的页码 (1 - ${pageCount})！`);
            return;
        }
        sandboxPage = page - 1; // convert to 0-based
        renderSandboxChat();
        $('#wizard-context-editor-list').scrollTop(0);
    });

    $(document).off('input', '.context-msg-textarea').on('input', '.context-msg-textarea', function () {
        const index = parseInt($(this).data('index'));
        const val = $(this).val();
        if (sandboxChatContext[index]) {
            const contentKey = sandboxChatContext[index].content !== undefined ? 'content' : 'mes';
            sandboxChatContext[index][contentKey] = val;
            // Editing a message body changes its token contribution -> refresh stats.
            updateFusionTokenStats();
            // First edit this session: reveal the "应用更改到聊天" button. Sandbox
            // floor edits are session-only and discarded on reload, so the button
            // only appears once the user has actually changed a floor.
            if (!sandboxEditsDirty) {
                sandboxEditsDirty = true;
                $('#wizard-context-apply-btn').css('display', '');
            }
        }
    });

    // Changing the floor range (start/end) alters which floors are fused, so the
    // token estimate must recompute live as the user types/changes the range.
    $(document).off('input.fusionStats change.fusionStats', '#wizard-fusion-start, #wizard-fusion-end')
        .on('input.fusionStats change.fusionStats', '#wizard-fusion-start, #wizard-fusion-end', function () {
            updateFusionTokenStats();
        });

    $(document).off('change', '.context-msg-textarea').on('change', '.context-msg-textarea', function () {
        const index = parseInt($(this).data('index'));
        const val = $(this).val();
        if (sandboxChatContext[index]) {
            const contentKey = sandboxChatContext[index].content !== undefined ? 'content' : 'mes';
            sandboxChatContext[index][contentKey] = val;
            // NOTE: deliberately NOT persisted to the server — sandbox floor edits
            // are session-only and discarded on reload. The user must click
            // "应用更改到聊天" to commit them to the real chat.
        }
    });

    // Pager button: jump to the OLDEST floor not covered by any summary record
    // (史记/周记/日记). Sets the start-floor field AND actually pages the list to that
    // floor, scrolling + flashing it (same behavior as 跳至第 X 楼). Uses the same
    // coverage map as the purple badges.
    $(document).off('click', '.wizard-sandbox-jump-unmarked').on('click', '.wizard-sandbox-jump-unmarked', function (e) {
        e.preventDefault();
        const len = Array.isArray(sandboxChatContext) ? sandboxChatContext.length : 0;
        if (!len) { toastr.info('请先载入当前聊天上下文。'); return; }
        // Use the remapped (delete-safe) coverage map so "已标记/未标记" matches the
        // colored 📖 badges — original coveredFloors would falsely mark current floors
        // that merely share an old absolute index with a deleted record. The map merges
        // ALL record types (史记/周记/日记), so coverage reflects every layer, not just 史记.
        const coverageMap = buildRemappedCoverageMap();
        let target = -1;
        for (let f = 0; f < len; f++) {
            if (!coverageMap.has(f)) { target = f; break; }
        }
        if (target < 0) {
            toastr.info('所有楼层都已被某条记标注。');
            return;
        }
        // Always reflect the target in the start-floor field.
        $('#wizard-fusion-start').val(target).trigger('input');

        // Page the list to the target floor (if it survives the active filters).
        const entries = getFilteredSandboxEntries();
        const pos = entries.findIndex(en => en.floor === target);
        if (pos < 0) {
            toastr.info(`已设起始楼层 #${target}，但它不在当前筛选结果中，无法定位。`);
            return;
        }
        sandboxPage = Math.floor(pos / SANDBOX_PAGE_SIZE);
        renderSandboxChat();
        const targetEl = $(`.context-msg-textarea[data-index="${target}"]`);
        if (targetEl.length > 0) {
            targetEl[0].scrollIntoView({ block: 'center' });
            targetEl.focus();
            const row = targetEl.closest('.wizard-context-msg-item');
            const orig = row.css('box-shadow');
            row.css('box-shadow', '0 0 0 2px #a78bfa');
            setTimeout(() => row.css('box-shadow', orig), 1200);
        }
        toastr.success(`已跳转到最老未标记楼层 #${target}`);
    });

    // Extract the AI's <name> / <time> tags from a fusion reply, then strip
    // them from the body. Both tags are optional. Returns the cleaned body
    // (falling back to the original text if stripping leaves it empty), plus
    // the parsed name and RP time span. Used by both the start handler and
    // the in-overlay "添加进记" button so the two stay in sync.
    function parseFusionRecord(rawText) {
        const text = (rawText || '').trim();
        let name = '';
        let timespan = '';
        const nameMatch = text.match(/<name>([\s\S]*?)<\/name>/i);
        if (nameMatch) name = nameMatch[1].trim();
        const timeMatch = text.match(/<time>([\s\S]*?)<\/time>/i);
        if (timeMatch) timespan = timeMatch[1].trim();
        const stripped = text
            .replace(/<name>[\s\S]*?<\/name>/ig, '')
            .replace(/<time>[\s\S]*?<\/time>/ig, '')
            .trim();
        return { body: stripped || text, name, timespan };
    }

    // Build the live fusion invocation from the current UI state.
    // Returns null and toast-warns on invalid input (missing context, bad range,
    // etc.). When ok, returns the full payload start-handler and continue-handler
    // both need: profile, fully-substituted systemPrompt, userContent (or "" if
    // {{history}} has already absorbed it), the typeName/typeColor for the
    // overlay header, and the floor range so callers can label/log.
    function buildFusionInvocation() {
        if (!sandboxChatContext || sandboxChatContext.length === 0) {
            toastr.warning('请先点击按钮载入聊天上下文！');
            return null;
        }
        const start = parseInt($('#wizard-fusion-start').val());
        const end = parseInt($('#wizard-fusion-end').val());
        const maxFloor = sandboxChatContext.length - 1;
        if (isNaN(start) || isNaN(end)) { toastr.warning('请输入有效的起始与结束楼层编号！'); return null; }
        if (start < 0 || end < 0) { toastr.warning('楼层编号从 0 开始，不能为负！'); return null; }
        if (start > end) { toastr.warning('起始楼层不能大于结束楼层！'); return null; }
        if (end > maxFloor) { toastr.warning(`结束楼层不能大于最大楼层号 (${maxFloor})！`); return null; }

        const fusionType = $('#wizard-fusion-type').val();
        const inRange = sandboxChatContext
            .map((msg, floor) => ({ msg, floor }))
            .filter(e => e.floor >= start && e.floor <= end);
        const applyFilters = config.fusionApplyFilters !== false;
        const covMapGen = (applyFilters && sandboxFilters.some(f => f.type === 'record' && f.value)) ? buildRemappedCoverageMap() : null;
        let filteredEntries = applyFilters ? inRange.filter(e => messagePassesFilters(e.msg, e.floor, covMapGen)) : inRange;
        const sizeTag = sandboxFilters.find(f => f.type === 'size');
        if (applyFilters && sizeTag) {
            const dir = sizeTag.value === 'asc' ? 1 : -1;
            filteredEntries.sort((a, b) => (msgBody(a.msg).length - msgBody(b.msg).length) * dir);
        }
        const formattedContext = filteredEntries.map(({ msg, floor }) => {
            const name = msgName(msg);
            const body = applyFilters ? extractFusionBody(msg, floor) : msgBody(msg);
            return `#${floor} [${name}]: ${body}`;
        }).join('\n');
        lastCompiledHistory = formattedContext;

        let systemPrompt = "";
        let typeName = "";
        if (fusionType === 'historical') { typeName = "史记"; systemPrompt = config.promptHistorical || FUSION_DEFAULT_PROMPTS.historical; }
        else if (fusionType === 'weekly') { typeName = "周记"; systemPrompt = config.promptWeekly || FUSION_DEFAULT_PROMPTS.weekly; }
        else if (fusionType === 'recap') { typeName = "日记"; systemPrompt = config.promptRecap || FUSION_DEFAULT_PROMPTS.recap; }
        const typeColor = SUMMARY_COLORS[fusionType] || '#a78bfa';

        // {{records}} expansion
        const hasRecordsToken = /\{\{\s*records\s*\}\}/i.test(systemPrompt);
        if (hasRecordsToken) {
            systemPrompt = systemPrompt.replace(/\{\{\s*records\s*\}\}/gi, compileAllRecords());
        } else if (config.fusionIncludeRecords) {
            const recordsBlock = compileOtherRecords(fusionType);
            if (recordsBlock) systemPrompt = `${recordsBlock}\n\n${systemPrompt}`;
        }
        // {{history}} expansion
        const hasHistoryToken = /\{\{\s*history\s*\}\}/i.test(systemPrompt);
        let finalSystemPrompt, finalUserContent;
        if (hasHistoryToken) {
            finalSystemPrompt = systemPrompt.replace(/\{\{\s*history\s*\}\}/gi, formattedContext);
            finalUserContent = "请根据以上内容进行融合总结。";
        } else {
            finalSystemPrompt = systemPrompt;
            finalUserContent = formattedContext;
        }
        // Manual-fusion tree fill: when enabled, append the <treeops> instruction block
        // (memory-tree path index + op schema) so the model emits tree ops after the
        // summary body. Shared with updateFusionTokenStats() so the displayed token
        // count includes this block too. See buildManualTreeOpsBlock().
        const treeOps = !!config.manualFusionTreeOps;
        if (treeOps) {
            finalSystemPrompt = `${finalSystemPrompt}${buildManualTreeOpsBlock()}`;
        }

        const profile = $('#wizard-fusion-profile').val() || "";
        return {
            profile, fusionType, typeName, typeColor,
            systemPrompt: finalSystemPrompt,
            userContent: finalUserContent,
            start, end, filteredEntries, hasHistoryToken, formattedContext, treeOps,
        };
    }

    $(document).off('click', '#wizard-fusion-start-btn').on('click', '#wizard-fusion-start-btn', async function () {
        // Record-to-record manual fusion. Uses checkbox picks (config.fusionRecordPicks)
        // instead of the old "最早 X 条" number input.
        if ($('#wizard-fusion-source').val() === 'records') {
            const fromType = $('#wizard-fusion-record-from').val();
            const fromArr = getSummaryArray(fromType);
            // Resolve picks from config, filtering out archived or out-of-range indices.
            const picksRaw = (config.fusionRecordPicks && config.fusionRecordPicks[fromType]) ? config.fusionRecordPicks[fromType] : [];
            const picks = picksRaw.filter(i => fromArr && fromArr[i] && !sumIsArchived(fromArr[i]));
            if (picks.length < 2) {
                toastr.warning(`请在下拉中勾选至少 2 条未归档的${SUMMARY_TYPE_NAMES[fromType] || '记'}。`);
                return;
            }
            const cnt = picks.length;

            // ── 史记→史记 (同层): stream window path ──
            if (fromType === 'historical') {
                const statusEl = $('#wizard-fusion-status');
                const typeColor = SUMMARY_COLORS['historical'] || '#a78bfa';
                statusEl.html(`<span style="color: ${typeColor};"><i class="fa-solid fa-brain fa-spin"></i> 正在把 ${cnt} 条史记融合为 1 条更宏观的史记...</span>`);
                $('#wizard-fusion-start-btn').hide();
                $('#wizard-fusion-stop-btn').prop('disabled', false);
                $('#wizard-fusion-stop-row').css('display', 'flex');

                // Reset streaming overlay.
                $('#wizard-fusion-stream-body').val('').prop('readonly', true);
                $('#wizard-fusion-stream-reasoning').val('');
                $('#wizard-fusion-stream-reasoning-wrap').hide().prop('open', false);
                $('#wizard-fusion-stream-stats').text('0 字符 · 0 tokens');
                $('#wizard-fusion-stream-status').text('连接中... (史记→史记)').css('color', typeColor);
                $('#wizard-fusion-stream-title').text('史记→史记 · AI 实时输出').css('color', typeColor);
                $('#wizard-fusion-stream-abort-btn').show().prop('disabled', false);
                $('#wizard-fusion-stream-add-record-btn').hide();
                $('#wizard-fusion-stream-revert-btn').hide();
                $('#wizard-fusion-stream-discard-btn').hide();
                $('#wizard-fusion-stream-continue-btn').prop('disabled', true);
                $('#wizard-fusion-stream-overlay')
                    .removeData('saveType').removeData('saveIndex').removeData('aiSnapshot').removeData('continueCtx')
                    .removeData('fuseSelfSources')
                    .removeAttr('data-save-type').removeAttr('data-save-index');

                fusionAbortController = new AbortController();

                try {
                    writeLog(`Starting 史记→史记 同层融合 for ${cnt} records.`);
                    const selfResult = await fuseSummariesSelf('historical', picks);
                    if (!selfResult) {
                        // Aborted or cancelled.
                        const partial = ($('#wizard-fusion-stream-body').val() || '').trim();
                        const statusNow = $('#wizard-fusion-stream-status').text();
                        $('#wizard-fusion-stream-body').val('').prop('readonly', true);
                        $('#wizard-fusion-stream-overlay')
                            .removeData('saveType').removeData('saveIndex')
                            .removeAttr('data-save-type').removeAttr('data-save-index')
                            .data('aiSnapshot', partial)
                            .data('continueCtx', null)
                            .data('fuseSelfSources', JSON.stringify(picks));
                        $('#wizard-fusion-stream-continue-btn').prop('disabled', false);
                        $('#wizard-fusion-stream-revert-btn').hide();
                        $('#wizard-fusion-stream-discard-btn').show();
                        $('#wizard-fusion-stream-stats').text('0 字符 · 已中止');
                        statusEl.html(`<span style="color: #f59e0b;"><i class="fa-solid fa-circle-minus"></i> 融合已终止。</span>`);
                        toastr.info('AI 融合生成已由用户终止。');
                    } else {
                        const { result: rawResult, indices: fusedIndices } = selfResult;
                        const _finishThinking = splitInlineThinking((rawResult || '').trim());
                        if (_finishThinking.thinking && !$('#wizard-fusion-stream-reasoning').val()) {
                            $('#wizard-fusion-stream-reasoning').val(_finishThinking.thinking);
                            $('#wizard-fusion-stream-reasoning-wrap').show().prop('open', true);
                        }
                        let trimmed = _finishThinking.body;
                        // Tree ops for 同层 fusion: 复用主模板「手动融合时一并填记忆树」开关。
                        if (config.manualFusionTreeOps) {
                            const treeOpsMatch = trimmed.match(/<treeops>([\s\S]*?)<\/treeops>/i);
                            trimmed = trimmed.replace(/<treeops>[\s\S]*?<\/treeops>/ig, '').trim();
                            if (treeOpsMatch) {
                                const rawOps = treeOpsMatch[1].replace(/```json/gi, '').replace(/```/g, '').trim();
                                try {
                                    const parsedOps = JSON.parse(rawOps);
                                    if (parsedOps && Array.isArray(parsedOps.ops) && parsedOps.ops.length) {
                                        const opSourceMeta = treeSourceMetaForFloor(
                                            Math.max(...fusedIndices.map(i => { const r = sumCoveredFloors(fromArr[i]); return r ? r.hi : 0; }))
                                        );
                                        applyTreeOperations(parsedOps.ops, opSourceMeta);
                                        await saveTreeToServer();
                                        try { renderTreeView(memoryTree, $('#wizard-tree-root')); } catch (e) { /* tree view may be closed */ }
                                        writeLog(`史记→史记 同层融合填树：应用了 ${parsedOps.ops.length} 个记忆树操作。`);
                                        toastr.info(`同层融合同时写入了 ${parsedOps.ops.length} 个记忆树操作。`);
                                    }
                                } catch (e) {
                                    writeLog(`史记→史记 同层融合填树：<treeops> 非法 JSON，已忽略。`, 'WARNING');
                                }
                            }
                        }
                        // Store source indices so the save callback can archive them.
                        $('#wizard-fusion-stream-overlay').data('fuseSelfSources', JSON.stringify(fusedIndices));
                        $('#wizard-fusion-stream-body').val(trimmed).prop('readonly', false);
                        $('#wizard-fusion-stream-stats').text(`${trimmed.length} 字符 · ${estimateTokens(trimmed).toLocaleString()} tokens · 可编辑`);
                        $('#wizard-fusion-stream-abort-btn').hide();
                        updateAddRecordBtnForType();
                        $('#wizard-fusion-stream-revert-btn').hide();
                        $('#wizard-fusion-stream-discard-btn').show();
                        $('#wizard-fusion-stream-continue-btn').prop('disabled', false);
                        statusEl.html(`<span style="color: #10b981;"><i class="fa-solid fa-circle-check"></i> 成功生成！请检查并点击「添加进史记」。源史记将在保存时归档。</span>`);
                        toastr.success(`AI 融合成功！请检查结果后保存。`);
                        writeLog(`Successfully fused ${cnt} 史记 into 1 via 同层融合 (stream window).`);
                    }
                } catch (err) {
                    console.error(err);
                    if (err.name === 'AbortError') {
                        statusEl.html(`<span style="color: #f59e0b;"><i class="fa-solid fa-circle-minus"></i> 融合已终止。</span>`);
                    } else {
                        statusEl.html(`<span style="color: #ef4444;"><i class="fa-solid fa-triangle-exclamation"></i> 融合失败: ${err.message}</span>`);
                        toastr.error(`融合失败: ${err.message}`);
                    }
                } finally {
                    $('#wizard-fusion-start-btn').show();
                    $('#wizard-fusion-stop-btn').prop('disabled', true);
                    $('#wizard-fusion-stop-row').hide();
                    const $st = $('#wizard-fusion-stream-status');
                    if ($st.text().startsWith('连接中') || $st.text().startsWith('生成中')) {
                        $st.text('已完成').css('color', '#10b981');
                    }
                    $('#wizard-fusion-stream-abort-btn').hide();
                    fusionAbortController = null;
                }
                return;
            }

            // ── 周记→史记 / 日记→周记 (跨层): silent JSON path ──
            const toType = fromType === 'weekly' ? 'historical' : 'weekly';

            const statusEl = $('#wizard-fusion-status');
            const typeColor = SUMMARY_COLORS[toType] || '#a78bfa';
            statusEl.html(`<span style="color: ${typeColor};"><i class="fa-solid fa-brain fa-spin"></i> 正在把 ${cnt} 条${SUMMARY_TYPE_NAMES[fromType]}融合为 ${SUMMARY_TYPE_NAMES[toType]}...</span>`);
            $('#wizard-fusion-start-btn').hide();
            $('#wizard-fusion-stop-btn').prop('disabled', false);
            $('#wizard-fusion-stop-row').css('display', 'flex');
            try {
                const ok = await fuseSummaries(fromType, toType, picks);
                if (ok) {
                    await saveSummariesToServer();
                    statusEl.html(`<span style="color:#10b981;"><i class="fa-solid fa-circle-check"></i> 成功融合为一条${SUMMARY_TYPE_NAMES[toType]}！来源已归档。</span>`);
                    toastr.success(`已融合 ${cnt} 条${SUMMARY_TYPE_NAMES[fromType]} → 1 条${SUMMARY_TYPE_NAMES[toType]}`);
                } else {
                    statusEl.html(`<span style="color:#ef4444;"><i class="fa-solid fa-triangle-exclamation"></i> 融合失败。</span>`);
                }
            } catch (e) {
                statusEl.html(`<span style="color:#ef4444;"><i class="fa-solid fa-triangle-exclamation"></i> 融合失败: ${e.message}</span>`);
            } finally {
                $('#wizard-fusion-start-btn').show();
                $('#wizard-fusion-stop-btn').prop('disabled', true);
                $('#wizard-fusion-stop-row').hide();
            }
            return;
        }

        if (!sandboxChatContext || sandboxChatContext.length === 0) {
            toastr.warning('请先点击按钮载入聊天上下文！');
            return;
        }

        const inv = buildFusionInvocation();
        if (!inv) return;
        const { profile: selectedProfile, fusionType, typeName, typeColor,
                systemPrompt: finalSystemPrompt, userContent: finalUserContent,
                start, end, filteredEntries, hasHistoryToken, formattedContext, treeOps } = inv;

        const statusEl = $('#wizard-fusion-status');
        statusEl.html(`<span style="color: ${typeColor};"><i class="fa-solid fa-brain fa-spin"></i> AI 正在进行 ${typeName} 融合生成，请稍候...</span>`);

        // Hide start button, show stop button
        $('#wizard-fusion-start-btn').hide();
        $('#wizard-fusion-stop-btn').prop('disabled', false);
        $('#wizard-fusion-stop-row').css('display', 'flex');

        // Reset the streaming overlay so the next fusion starts with a clean canvas.
        // The overlay itself is not shown automatically — the user opens it by clicking '+'.
        $('#wizard-fusion-stream-body').val('').prop('readonly', true);
        $('#wizard-fusion-stream-reasoning').val('');
        $('#wizard-fusion-stream-reasoning-wrap').hide().prop('open', false);
        $('#wizard-fusion-stream-stats').text('0 字符 · 0 tokens');
        $('#wizard-fusion-stream-status').text(`连接中... (${typeName})`).css('color', typeColor);
        $('#wizard-fusion-stream-title').text(`${typeName} · AI 实时输出`).css('color', typeColor);
        // Reset the per-run save target and button visibility:
        // - 中断生成 visible while generating
        // - smart save button hidden until there's something to commit
        $('#wizard-fusion-stream-abort-btn').show().prop('disabled', false);
        $('#wizard-fusion-stream-add-record-btn').hide();
        $('#wizard-fusion-stream-revert-btn').hide();
        $('#wizard-fusion-stream-discard-btn').hide();
        $('#wizard-fusion-stream-continue-btn').prop('disabled', true);
        $('#wizard-fusion-stream-overlay')
            .removeData('saveType').removeData('saveIndex').removeData('aiSnapshot').removeData('continueCtx')
            .removeAttr('data-save-type').removeAttr('data-save-index');

        fusionAbortController = new AbortController();

        try {
            writeLog(`Starting manual AI fusion call for ${typeName} covering range ${start} to ${end} using profile "${selectedProfile || 'Default'}".`);

            let result;
            if (config.fusionIncludePreset) {
                // Route through SillyTavern's full generation pipeline so the
                // active preset / character card / world info are all included.
                // (This is the user-opted "包含预设" path — it INTENTIONALLY looks
                // like a normal reply, just with our fusion prompt appended.)
                writeLog('Fusion path: WITH preset (generateQuietPrompt).');
                const stContext = window.SillyTavern.getContext();
                const combined = hasHistoryToken
                    ? finalSystemPrompt
                    : `${finalSystemPrompt}\n\n${formattedContext}`;
                if (typeof stContext.generateQuietPrompt === 'function') {
                    result = await stContext.generateQuietPrompt(combined, false, false);
                } else if (typeof stContext.generateRaw === 'function') {
                    result = await stContext.generateRaw({ prompt: combined });
                } else {
                    throw new Error('当前酒馆版本不支持带预设的生成接口 (generateQuietPrompt/generateRaw)。');
                }
            } else {
                // Isolated call: ONLY the fusion prompt + matched context, no preset,
                // no chat history, no character card. Uses ST's ChatCompletionService /
                // ConnectionManagerRequestService directly with the preset stripped —
                // this is what guarantees your active preset is NOT sent.
                writeLog(`Fusion path: ISOLATED (profile="${selectedProfile || 'active-API-no-preset'}").`);
                const onStreamChunk = (fullText, reasoningText) => {
                    const bodyEl = document.getElementById('wizard-fusion-stream-body');
                    if (!bodyEl) return;
                    const wasAtBottom = (bodyEl.scrollTop + bodyEl.clientHeight >= bodyEl.scrollHeight - 50);
                    // The model may deliver its chain-of-thought INLINE in <thinking>…</thinking>
                    // inside the body. Strip those blocks out of the visible body and show them in
                    // the 思考内容 pane.
                    const { body: cleanBody, thinking: inlineThinking } = splitInlineThinking(fullText);
                    bodyEl.value = cleanBody;
                    const thinking = (reasoningText || '').trim() || inlineThinking;
                    if (thinking) {
                        $('#wizard-fusion-stream-reasoning').val(thinking);
                        $('#wizard-fusion-stream-reasoning-wrap').show().prop('open', true);
                    }
                    $('#wizard-fusion-stream-stats').text(`${cleanBody.length} 字符 · ${estimateTokens(cleanBody).toLocaleString()} tokens`);
                    if ($('#wizard-fusion-stream-status').text().startsWith('连接中')) {
                        $('#wizard-fusion-stream-status').text(`生成中... (${typeName})`);
                    }
                    // Auto-scroll only when the user was already near the bottom.
                    if (wasAtBottom) bodyEl.scrollTop = bodyEl.scrollHeight;
                };
                result = await runIsolatedFusionCall(selectedProfile, [{ role: 'user', content: finalUserContent }], finalSystemPrompt, 0.2, 60000, fusionAbortController.signal, onStreamChunk);
            }
            // Peel any inline <thinking>…</thinking> out of the result into the 思考内容
            // pane — the model often delivers its chain-of-thought inline rather than as
            // a reasoning field. Strip it from the body so it never lands in the summary.
            const _finishThinking = splitInlineThinking((result || "").trim());
            if (_finishThinking.thinking && !$('#wizard-fusion-stream-reasoning').val()) {
                $('#wizard-fusion-stream-reasoning').val(_finishThinking.thinking);
                $('#wizard-fusion-stream-reasoning-wrap').show().prop('open', true);
            }
            let trimmed = _finishThinking.body;
            if (!trimmed) {
                throw new Error("AI 返回了空内容");
            }

            // Manual-fusion tree fill: extract the <treeops>…</treeops> JSON block (if
            // the feature was enabled and the model emitted one), apply its ops to the
            // memory tree, then strip the tag so it never lands in the summary body.
            if (treeOps) {
                const treeOpsMatch = trimmed.match(/<treeops>([\s\S]*?)<\/treeops>/i);
                // Always strip any treeops block from the body, even on parse failure.
                trimmed = trimmed.replace(/<treeops>[\s\S]*?<\/treeops>/ig, '').trim();
                if (treeOpsMatch) {
                    const rawOps = treeOpsMatch[1].replace(/```json/gi, '').replace(/```/g, '').trim();
                    try {
                        const parsedOps = JSON.parse(rawOps);
                        if (parsedOps && Array.isArray(parsedOps.ops) && parsedOps.ops.length) {
                            // Provenance: newest fused floor (real chat floor, remappable).
                            const opSourceMeta = treeSourceMetaForFloor(Math.max(start, end));
                            applyTreeOperations(parsedOps.ops, opSourceMeta);
                            await saveTreeToServer();
                            try { renderTreeView(memoryTree, $('#wizard-tree-root')); } catch (e) { /* tree view may be closed */ }
                            writeLog(`手动融合填树：应用了 ${parsedOps.ops.length} 个记忆树操作。`);
                            toastr.info(`手动融合同时写入了 ${parsedOps.ops.length} 个记忆树操作。`);
                        } else {
                            writeLog('手动融合填树：模型未返回任何 ops（空数组）。');
                        }
                    } catch (e) {
                        writeLog(`手动融合填树：<treeops> 不是合法 JSON，已忽略。Raw: ${rawOps.slice(0, 200)}`, 'WARNING');
                    }
                } else {
                    writeLog('手动融合填树：已开启但模型未输出 <treeops> 块。', 'WARNING');
                }
            }

            const { body: bodyText, name: parsedName, timespan: parsedRpTime } = parseFusionRecord(trimmed);
            trimmed = bodyText;

            // Real-world time span from the fused messages' send_date (computed once,
            // stored). Independent of the RP time; the per-record clock toggle decides
            // whether it is injected.
            let realTimespan = "";
            const tsList = filteredEntries.map(e => msgTimestamp(e.msg)).filter(t => !isNaN(t));
            if (tsList.length) {
                const min = Math.min(...tsList);
                const max = Math.max(...tsList);
                realTimespan = min === max ? formatTimestamp(min) : `${formatTimestamp(min)} ~ ${formatTimestamp(max)}`;
            }

            // Provenance: the floor range that was fused. Store the absolute floor
            // range so this record (any layer, incl. a 史记 over floors 0–299) marks
            // those floors as covered and excludes them from the 日记 trigger count.
            const srcLabel = `楼层 ${start}-${end}`;
            const newRecord = {
                text: trimmed,
                source: srcLabel,
                name: parsedName,
                timespan: parsedRpTime,
                realTimespan,
                showRealTime: defaultSummaryShowRealTime(),
                coveredFloors: { lo: Math.min(start, end), hi: Math.max(start, end) },
            };
            let savedIndex = -1;
            if (fusionType === 'historical') {
                if (!summaries.historicalSummaries) summaries.historicalSummaries = [];
                summaries.historicalSummaries.push(newRecord);
                savedIndex = summaries.historicalSummaries.length - 1;
            } else if (fusionType === 'weekly') {
                if (!summaries.weeklySummaries) summaries.weeklySummaries = [];
                summaries.weeklySummaries.push(newRecord);
                savedIndex = summaries.weeklySummaries.length - 1;
            } else if (fusionType === 'recap') {
                if (!summaries.recaps) summaries.recaps = [];
                summaries.recaps.push(newRecord);
                savedIndex = summaries.recaps.length - 1;
            }
            writeLog(`Fusion stored: name="${parsedName}", rpTime="${parsedRpTime}", realTime="${realTimespan}".`);

            await saveSummariesToServer();

            // Open the streaming overlay for editing: load the cleaned body text
            // (without <name>/<time> tags — that's what's actually stored in
            // record.text), enable editing, hide "中断生成", show "保存修改",
            // and remember which record this Save should write back to.
            $('#wizard-fusion-stream-overlay')
                .attr('data-save-type', fusionType)
                .attr('data-save-index', String(savedIndex))
                .data('aiSnapshot', trimmed)
                .data('continueCtx', {
                    profile: selectedProfile,
                    systemPrompt: finalSystemPrompt,
                    userContent: finalUserContent,
                    typeName,
                });
            $('#wizard-fusion-stream-body').val(trimmed).prop('readonly', false);
            $('#wizard-fusion-stream-stats').text(`${trimmed.length} 字符 · ${estimateTokens(trimmed).toLocaleString()} tokens · 可编辑`);
            $('#wizard-fusion-stream-abort-btn').hide();
            // Record was auto-stored; content == snapshot, so the smart button stays
            // hidden until the user edits the text (then it shows "覆盖当前X记").
            updateAddRecordBtnForType();
            $('#wizard-fusion-stream-revert-btn').hide();
            $('#wizard-fusion-stream-discard-btn').show();
            $('#wizard-fusion-stream-continue-btn').prop('disabled', false);

            statusEl.html(`<span style="color: #10b981;"><i class="fa-solid fa-circle-check"></i> 成功新建一条 ${typeName}！</span>`);
            toastr.success(`AI 融合成功！已新建一条${typeName}`);
            writeLog(`Successfully fused range ${start}-${end} into ${typeName} manually.`);
        } catch (err) {
            console.error(err);
            if (err.name === 'AbortError') {
                statusEl.html(`<span style="color: #f59e0b;"><i class="fa-solid fa-circle-minus"></i> 融合已终止。</span>`);
                toastr.info('AI 融合生成已由用户终止。');

                // Even after a mid-stream abort, let the user edit / continue
                // the partial text. Persistence to summaries is NOT available
                // here (no record was created), so the Save button stays hidden;
                // 继续 reuses the same conversation context to extend the
                // partial output, and Revert tracks the partial snapshot.
                // Per the user's request: on abort, CLEAR the displayed text and
                // show the 删除 (弃用) button so the user can discard the partial.
                const partial = ($('#wizard-fusion-stream-body').val() || '').trim();
                $('#wizard-fusion-stream-body').val('').prop('readonly', true);
                $('#wizard-fusion-stream-overlay')
                    .data('aiSnapshot', partial)
                    .data('continueCtx', {
                        profile: selectedProfile,
                        systemPrompt: finalSystemPrompt,
                        userContent: finalUserContent,
                        typeName,
                    });
                $('#wizard-fusion-stream-continue-btn').prop('disabled', false);
                $('#wizard-fusion-stream-revert-btn').hide();
                $('#wizard-fusion-stream-discard-btn').show();
                $('#wizard-fusion-stream-stats').text(`0 字符 · 已中止`);
            } else {
                statusEl.html(`<span style="color: #ef4444;"><i class="fa-solid fa-triangle-exclamation"></i> 融合失败: ${err.message}</span>`);
                toastr.error(`融合失败: ${err.message}`);
            }
        } finally {
            // Restore buttons visibility
            $('#wizard-fusion-start-btn').show();
            $('#wizard-fusion-stop-btn').prop('disabled', true);
            $('#wizard-fusion-stop-row').hide();
            // Mark the streaming overlay as finished (does not auto-close it).
            const $st = $('#wizard-fusion-stream-status');
            if ($st.text().startsWith('连接中') || $st.text().startsWith('生成中')) {
                $st.text('已完成').css('color', '#10b981');
            }
            // Generation is no longer in flight: hide the in-overlay abort button.
            // Save-button visibility is controlled by the success path itself
            // (only shown when a record was actually persisted).
            $('#wizard-fusion-stream-abort-btn').hide();
            fusionAbortController = null;
        }
    });

    $(document).off('click', '#wizard-fusion-stop-btn').on('click', '#wizard-fusion-stop-btn', function () {
        if (fusionAbortController) {
            writeLog("User requested abort of manual AI fusion.");
            fusionAbortController.abort();
            $(this).prop('disabled', true);
            $('#wizard-fusion-stream-status').text('已中止').css('color', '#ef4444');
        }

        // Call SillyTavern context stopGeneration to halt any SillyTavern active API generation (e.g. fallback)
        const context = window.SillyTavern?.getContext();
        if (context) {
            if (typeof context.stopGeneration === 'function') {
                context.stopGeneration();
            } else if (typeof context.abort === 'function') {
                context.abort();
            } else if (typeof window.abort === 'function') {
                window.abort();
            }
        }
    });

    // Open the AI streaming-output overlay (the '+' button next to the start
    // button). The '+' is permanently visible — when no fusion has ever run,
    // the overlay opens to an empty textarea ready for the user to type into
    // and let the AI continue from there.
    $(document).off('click', '#wizard-fusion-stream-view-btn').on('click', '#wizard-fusion-stream-view-btn', function () {
        $('#wizard-fusion-stream-overlay').css('display', 'flex');
        updateAddRecordBtnForType(); // sync 添加进X label + color to current type
        const $body = $('#wizard-fusion-stream-body');
        // If not currently generating, unlock the textarea and surface the
        // continue button so the user can write something and ask the AI to
        // pick up from there — even from a blank canvas.
        if (!fusionAbortController) {
            $body.prop('readonly', false);
            $('#wizard-fusion-stream-continue-btn').prop('disabled', false);
            $('#wizard-fusion-stream-abort-btn').hide();
            // Don't change the status line if a previous run set it to
            // 已完成 / 已中止 / 已保存 — those messages are still meaningful.
            // But if it's the brand-new "等待开始..." default, refresh it
            // to make the state explicit.
            const $st = $('#wizard-fusion-stream-status');
            if ($st.text().startsWith('等待开始')) {
                $st.text('空白 · 输入文本后点继续').css('color', '#9ca3af');
            }
        }
        const bodyEl = $body[0];
        if (bodyEl) {
            // Sync the stats line to whatever is currently in the textarea so
            // the counts reflect prior-run residue or user typing before any
            // input event has fired.
            $body.trigger('input.fusionRevert');
            bodyEl.scrollTop = bodyEl.scrollHeight;
        }
    });

    // X button closes the overlay. Closing the overlay never aborts generation
    // and never discards the streamed content — it just hides the window.
    $(document).off('click', '#wizard-fusion-stream-close-btn')
        .on('click', '#wizard-fusion-stream-close-btn', function () {
            $('#wizard-fusion-stream-overlay').hide();
        });

    // Clicking the dark backdrop (outside the inner container) also closes
    // the overlay — same effect as the X button. Clicks inside the container
    // (textarea, buttons, etc.) are filtered out by checking event.target.
    $(document).off('click', '#wizard-fusion-stream-overlay')
        .on('click', '#wizard-fusion-stream-overlay', function (e) {
            if (e.target === this) {
                $(this).hide();
            }
        });

    // Enter in the continue input triggers the Continue button. Shift+Enter
    // does NOT submit so the user can compose multi-line prompts if they like.
    $(document).off('keydown.fusionContinue', '#wizard-fusion-stream-continue-input')
        .on('keydown.fusionContinue', '#wizard-fusion-stream-continue-input', function (e) {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                $('#wizard-fusion-stream-continue-btn').trigger('click');
            }
        });

    // Copy the current streamed text to clipboard.
    $(document).off('click', '#wizard-fusion-stream-copy-btn').on('click', '#wizard-fusion-stream-copy-btn', async function () {
        const text = $('#wizard-fusion-stream-body').val();
        if (!text) {
            toastr.info('暂无内容可复制');
            return;
        }
        try {
            await navigator.clipboard.writeText(text);
            toastr.success('已复制到剪贴板');
        } catch (_) {
            toastr.error('复制失败');
        }
    });

    // Whenever the user edits the textarea, compare against the AI-completion
    // snapshot stored when generation finished. Show the Revert button only
    // when the current content differs AND we actually have a snapshot to
    // revert to. The snapshot itself is only set on a successful generation.
    // Whenever the user edits the textarea, refresh the live char/token
    // counter unconditionally, and additionally compare against the
    // AI-completion snapshot to decide whether Revert should be visible.
    // The stats line updates on every keystroke, regardless of whether a
    // snapshot exists.
    $(document).off('input.fusionRevert', '#wizard-fusion-stream-body')
        .on('input.fusionRevert', '#wizard-fusion-stream-body', function () {
            const value = this.value;
            const snapshot = $('#wizard-fusion-stream-overlay').data('aiSnapshot');
            const hasSnapshot = typeof snapshot === 'string';
            const diverged = hasSnapshot && value !== snapshot;
            $('#wizard-fusion-stream-revert-btn').toggle(diverged);
            const suffix = !hasSnapshot ? '' : (diverged ? ' · 已修改' : ' · 可编辑');
            $('#wizard-fusion-stream-stats').text(`${value.length} 字符 · ${estimateTokens(value).toLocaleString()} tokens${suffix}`);
            // The smart save button appears/disappears + relabels (添加/覆盖) based
            // on whether the content now diverges from the stored version.
            updateAddRecordBtnForType();
        });

    // Revert: restore the textarea to the AI-completion snapshot.
    $(document).off('click', '#wizard-fusion-stream-revert-btn')
        .on('click', '#wizard-fusion-stream-revert-btn', function () {
            const snapshot = $('#wizard-fusion-stream-overlay').data('aiSnapshot');
            if (typeof snapshot !== 'string') return;
            $('#wizard-fusion-stream-body').val(snapshot);
            $('#wizard-fusion-stream-stats').text(`${snapshot.length} 字符 · ${estimateTokens(snapshot).toLocaleString()} tokens · 已恢复`);
            $(this).hide();
        });

    // Continue: rebuild the live fusion config from the current UI (range,
    // filters, prompt, profile, includeRecords, etc.) every click, then send
    // [user(原 user 内容), assistant(已有 textarea), user(继续指令)] to keep
    // the model going. The '+' button stays visible permanently, so the user
    // can open this overlay any time — even without ever having generated —
    // and let the AI write a record from scratch using the current settings.
    $(document).off('click', '#wizard-fusion-stream-continue-btn')
        .on('click', '#wizard-fusion-stream-continue-btn', async function () {
            // Block re-entry while a fusion / continue is already in flight.
            if (fusionAbortController) {
                toastr.warning('正在生成中，请先终止当前生成再继续。');
                return;
            }

            const inv = buildFusionInvocation();
            if (!inv) return; // helper already toast-warned

            // The continuation prompt now lives inline at the bottom of the
            // overlay (not a window.prompt popup). Empty input falls back to
            // the conventional "Continue.".
            const $input = $('#wizard-fusion-stream-continue-input');
            const continueText = ($input.val() || '').trim() || 'Continue.';
            $input.val('');

            const $overlay = $('#wizard-fusion-stream-overlay');
            const $body = $('#wizard-fusion-stream-body');
            const before = $body.val();
            const separator = before && !before.endsWith('\n') ? '\n' : '';

            // Lock UI: hide continue/save/revert, show abort, lock textarea.
            const $continueBtn = $(this);
            $continueBtn.hide();
            $('#wizard-fusion-stream-add-record-btn').hide();
            $('#wizard-fusion-stream-revert-btn').hide();
            $('#wizard-fusion-stream-abort-btn').show().prop('disabled', false);
            $body.prop('readonly', true);
            const $st = $('#wizard-fusion-stream-status');
            $st.text(`继续生成中... (${inv.typeName})`).css('color', inv.typeColor);
            // Keep the overlay title in sync with the live fusion type, since
            // the user may have changed it since the last run.
            $('#wizard-fusion-stream-title').text(`${inv.typeName} · AI 实时输出`).css('color', inv.typeColor);

            // Wire up the shared abort controller so both the side-panel
            // 终止生成 and the in-overlay 中断生成 buttons work.
            fusionAbortController = new AbortController();
            $('#wizard-fusion-stop-btn').prop('disabled', false);
            $('#wizard-fusion-stop-row').css('display', 'flex');

            const messages = [
                { role: 'user', content: inv.userContent },
            ];
            if (before && before.length > 0) {
                messages.push({ role: 'assistant', content: before });
            }
            messages.push({ role: 'user', content: continueText });

            const onStreamChunk = (fullText, reasoningText) => {
                const bodyEl = $body[0];
                if (!bodyEl) return;
                const wasAtBottom = (bodyEl.scrollTop + bodyEl.clientHeight >= bodyEl.scrollHeight - 50);
                // Strip inline <thinking>…</thinking> from the freshly generated tail
                // and surface it in the 思考内容 pane (keep the existing `before` body).
                const { body: cleanTail, thinking: inlineThinking } = splitInlineThinking(fullText);
                bodyEl.value = before + separator + cleanTail;
                const thinking = (reasoningText || '').trim() || inlineThinking;
                if (thinking) {
                    $('#wizard-fusion-stream-reasoning').val(thinking);
                    $('#wizard-fusion-stream-reasoning-wrap').show().prop('open', true);
                }
                const total = bodyEl.value;
                $('#wizard-fusion-stream-stats').text(`${total.length} 字符 · ${estimateTokens(total).toLocaleString()} tokens`);
                if (wasAtBottom) bodyEl.scrollTop = bodyEl.scrollHeight;
            };

            try {
                writeLog(`Continue path: ISOLATED (profile="${inv.profile || 'active-API-no-preset'}"), type=${inv.typeName}, range=${inv.start}-${inv.end}, prompt="${continueText}".`);
                const result = await runIsolatedFusionCall(
                    inv.profile, messages, inv.systemPrompt, 0.2, 60000,
                    fusionAbortController.signal, onStreamChunk,
                );
                // Peel any inline <thinking>…</thinking> from the continuation tail into the
                // 思考内容 pane and off the body.
                const _tailSplit = splitInlineThinking((result || '').trim());
                const tail = _tailSplit.body;
                if (_tailSplit.thinking && !$('#wizard-fusion-stream-reasoning').val()) {
                    $('#wizard-fusion-stream-reasoning').val(_tailSplit.thinking);
                    $('#wizard-fusion-stream-reasoning-wrap').show().prop('open', true);
                }
                if (!tail) throw new Error('AI 返回了空内容');
                const finalText = before + separator + tail;
                $body.val(finalText).prop('readonly', false);
                // NOTE: aiSnapshot intentionally NOT updated to finalText. It stays
                // the last-committed version so (a) the smart button correctly shows
                // "覆盖当前X记" for the freshly continued (uncommitted) text, and
                // (b) Revert returns to the committed version. The continue path
                // never creates a record on its own.
                $('#wizard-fusion-stream-stats').text(`${finalText.length} 字符 · ${estimateTokens(finalText).toLocaleString()} tokens · 可编辑`);
                $st.text('已完成').css('color', '#10b981');
                updateAddRecordBtnForType(); // diverged from snapshot → button shows
                $continueBtn.show().prop('disabled', false);
            } catch (e) {
                if (e?.name === 'AbortError') {
                    $st.text('已中止').css('color', '#ef4444');
                    $body.prop('readonly', false);
                    const cur = $body.val();
                    $('#wizard-fusion-stream-stats').text(`${cur.length} 字符 · ${estimateTokens(cur).toLocaleString()} tokens · 已中止`);
                    updateAddRecordBtnForType();
                    $continueBtn.show().prop('disabled', false);
                } else {
                    $body.prop('readonly', false);
                    $st.text('继续生成失败').css('color', '#ef4444');
                    toastr.error(`继续生成失败: ${e.message || e}`);
                    updateAddRecordBtnForType();
                    $continueBtn.show().prop('disabled', false);
                }
            } finally {
                $('#wizard-fusion-stream-abort-btn').hide();
                $('#wizard-fusion-stop-btn').prop('disabled', true);
                $('#wizard-fusion-stop-row').hide();
                fusionAbortController = null;
            }
        });

    // In-overlay abort: same effect as the side-panel 终止生成 button.
    // It triggers the existing fusion abort controller; the finally block in
    // the start handler hides this button and updates the status line.
    $(document).off('click', '#wizard-fusion-stream-abort-btn').on('click', '#wizard-fusion-stream-abort-btn', function () {
        $('#wizard-fusion-stop-btn').trigger('click');
        $(this).prop('disabled', true);
    });

    // Single smart save button for the AI streaming overlay. Replaces the old
    // separate 添加进记 + 保存修改 pair. It is HIDDEN unless the textarea content
    // diverges from the last-stored version (data('aiSnapshot')), so there's only
    // ever an action button when there's something new to commit:
    //   • no record stored yet (no data-save-index) → "添加进X记"  (creates a new record)
    //   • a record is already stored                → "覆盖当前X记" (overwrites that record)
    // Label color always matches the fusion type's theme (史记紫/周记蓝/日记绿).
    function updateAddRecordBtnForType() {
        const fusionType = $('#wizard-fusion-type').val();
        const typeName = SUMMARY_TYPE_NAMES[fusionType] || '记';
        const color = SUMMARY_COLORS[fusionType] || '#a78bfa';
        // Build a translucent variant of the hex color for the gradient tail.
        const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color);
        const softColor = m
            ? `rgba(${parseInt(m[1], 16)}, ${parseInt(m[2], 16)}, ${parseInt(m[3], 16)}, 0.7)`
            : color;

        const $overlay = $('#wizard-fusion-stream-overlay');
        const $btn = $('#wizard-fusion-stream-add-record-btn');
        const value = $('#wizard-fusion-stream-body').val() || '';
        const snapshot = $overlay.data('aiSnapshot');
        const hasSnapshot = typeof snapshot === 'string';
        // "Stored" means a concrete record index this overlay is bound to.
        const idxStr = $overlay.attr('data-save-index');
        const isStored = idxStr !== undefined && idxStr !== null && idxStr !== '' && parseInt(idxStr, 10) >= 0;
        // Dirty = content differs from the last-committed snapshot. With no snapshot
        // (brand-new blank canvas), any non-empty text counts as dirty.
        const dirty = hasSnapshot ? (value !== snapshot) : (value.trim().length > 0);

        if (!dirty) { $btn.hide(); return; }

        const verb = isStored ? '覆盖当前' : '添加进';
        const icon = isStored ? 'fa-floppy-disk' : 'fa-plus';
        $btn.html(`<i class="fa-solid ${icon}"></i> ${verb}${typeName}`);
        $btn.css('background', `linear-gradient(135deg, ${color} 0%, ${softColor} 100%)`);
        $btn.attr('title', isStored
            ? `用当前内容覆盖刚才那条${typeName}`
            : `把当前内容新建为一条${typeName}，自动 parse 名字和时间`);
        $btn.show();
    }
    // Update whenever the fusion type changes (the selector also drives saveConfig
    // via the .fusionSticky listener; this is a separate, additive binding).
    $(document).off('change.addRecordColor', '#wizard-fusion-type')
        .on('change.addRecordColor', '#wizard-fusion-type', updateAddRecordBtnForType);

    // Smart save button — commits the textarea content into the layered-summary
    // layer matching the fusion type. Two modes, decided by whether this overlay is
    // already bound to a concrete record of the SAME type:
    //   • not stored (or type changed since last store) → CREATE a new record
    //   • stored                                        → OVERWRITE that record's text
    // Either way it auto-parses <name>/<time> tags and (when the floor range is
    // valid) attaches realTimespan + coveredFloors, exactly like an AI fusion.
    $(document).off('click', '#wizard-fusion-stream-add-record-btn')
        .on('click', '#wizard-fusion-stream-add-record-btn', async function () {
            const raw = ($('#wizard-fusion-stream-body').val() || '').trim();
            if (!raw) {
                toastr.warning('内容为空，无法添加。');
                return;
            }
            const fusionType = $('#wizard-fusion-type').val();
            const typeName = SUMMARY_TYPE_NAMES[fusionType];
            const arr = (fusionType === 'historical') ? (summaries.historicalSummaries ||= [])
                      : (fusionType === 'weekly')     ? (summaries.weeklySummaries     ||= [])
                      : (fusionType === 'recap')      ? (summaries.recaps              ||= [])
                      : null;
            if (!arr) {
                toastr.error('未识别的融合类型。');
                return;
            }

            const { body, name: parsedName, timespan: parsedRpTime } = parseFusionRecord(raw);

            // Derive realTimespan + coveredFloors: prefer 同层融合 source-merge,
            // otherwise use the floor range.
            let realTimespan = '';
            let coveredFloors = undefined;
            let srcLabel = '';
            let mergedTimespan = '';
            const $overlay = $('#wizard-fusion-stream-overlay');
            const fuseSelfSrc = $overlay.data('fuseSelfSources');
            if (fuseSelfSrc) {
                // 同层融合(史记→史记): derive from source records using mergeSourceSpans.
                try {
                    const srcPicks = JSON.parse(fuseSelfSrc);
                    const srcArr = getSummaryArray('historical');
                    if (srcArr && srcPicks.length >= 2) {
                        const spans = mergeSourceSpans(srcArr, srcPicks);
                        mergedTimespan = spans.mergedTimespan || '';
                        realTimespan = spans.mergedRealTimespan || '';
                        coveredFloors = spans.coveredFloors || undefined;
                        srcLabel = `史记 #${srcPicks.map(i => i + 1).join(', #')}`;
                    }
                } catch (e) { /* fall through to floor-range derivation */ }
            }
            if (!srcLabel) {
                // Floor-range derivation (standard path).
                const startVal = parseInt($('#wizard-fusion-start').val());
                const endVal = parseInt($('#wizard-fusion-end').val());
                const maxFloor = (sandboxChatContext?.length || 0) - 1;
                const rangeOk = !isNaN(startVal) && !isNaN(endVal) && startVal >= 0 && endVal >= startVal && endVal <= maxFloor;
                if (rangeOk) {
                    srcLabel = `楼层 ${startVal}-${endVal}`;
                    coveredFloors = { lo: Math.min(startVal, endVal), hi: Math.max(startVal, endVal) };
                    const tsList = [];
                    for (let f = startVal; f <= endVal; f++) {
                        const msg = sandboxChatContext[f];
                        if (msg) {
                            const t = msgTimestamp(msg);
                            if (!isNaN(t)) tsList.push(t);
                        }
                    }
                    if (tsList.length) {
                        const min = Math.min(...tsList);
                        const max = Math.max(...tsList);
                        realTimespan = (min === max) ? formatTimestamp(min) : `${formatTimestamp(min)} ~ ${formatTimestamp(max)}`;
                    }
                }
            }

            // Decide create vs overwrite. Overwrite is only valid when this overlay
            // is bound to an existing record of the SAME type at a live index.
            const boundType = $overlay.attr('data-save-type');
            const boundIdxStr = $overlay.attr('data-save-index');
            const boundIdx = parseInt(boundIdxStr, 10);
            const canOverwrite = boundType === fusionType
                && Number.isInteger(boundIdx) && boundIdx >= 0 && arr[boundIdx] !== undefined;

            let targetIdx;
            try {
                $(this).prop('disabled', true);
                if (canOverwrite) {
                    // Overwrite in place, preserving the existing record object but
                    // refreshing the fields the user may have changed.
                    const prev = (typeof arr[boundIdx] === 'object' && arr[boundIdx]) ? arr[boundIdx] : {};
                    arr[boundIdx] = {
                        ...prev,
                        text: body,
                        name: parsedName || prev.name || '',
                        timespan: parsedRpTime || prev.timespan || '',
                        ...(srcLabel ? { source: srcLabel } : {}),
                        ...(realTimespan ? { realTimespan } : {}),
                        ...(coveredFloors ? { coveredFloors } : {}),
                    };
                    targetIdx = boundIdx;
                } else {
                    const newRecord = {
                        text: body,
                        source: srcLabel,
                        name: parsedName,
                        timespan: parsedRpTime || mergedTimespan || '',
                        realTimespan,
                        showRealTime: defaultSummaryShowRealTime(),
                    };
                    if (coveredFloors) newRecord.coveredFloors = coveredFloors;
                    arr.push(newRecord);
                    targetIdx = arr.length - 1;
                }

                await saveSummariesToServer();
                // 同层融合(史记→史记): 首次保存时归档源史记。
                // overlay 携带 data-fuse-self-sources 时执行(非覆盖保存)。
                const fuseSelfSrc = $overlay.data('fuseSelfSources');
                if (fuseSelfSrc && !canOverwrite) {
                    try {
                        const srcPicks = JSON.parse(fuseSelfSrc);
                        const srcArr = getSummaryArray('historical');
                        if (srcArr && srcPicks.length) {
                            srcPicks.forEach(i => { if (srcArr[i] && !sumIsArchived(srcArr[i])) sumSetArchived(srcArr, i, true); });
                            writeLog(`同层融合归档源史记: [${srcPicks.join(',')}]`);
                        }
                    } catch (e) { /* ignore parse errors */ }
                    $overlay.removeData('fuseSelfSources');
                }
                renderAllSummaryLists();
                toastr.success(canOverwrite
                    ? `已覆盖当前 ${typeName}（名字="${parsedName || '未命名'}"）`
                    : `已添加 1 条 ${typeName}（名字="${parsedName || '未命名'}"）`);
                writeLog(`${canOverwrite ? 'Overwrite' : 'Add'}-record: ${typeName} idx=${targetIdx}, name="${parsedName}", time="${parsedRpTime}", real="${realTimespan}", range=${rangeOk ? `${startVal}-${endVal}` : 'n/a'}.`);

                // This record becomes/stays the bound target; sync the snapshot so
                // the smart button hides again until the next edit.
                $overlay
                    .attr('data-save-type', fusionType)
                    .attr('data-save-index', String(targetIdx))
                    .data('aiSnapshot', body);
                $('#wizard-fusion-stream-body').val(body);
                $('#wizard-fusion-stream-stats').text(`${body.length} 字符 · ${estimateTokens(body).toLocaleString()} tokens · ${canOverwrite ? '已覆盖' : '已添加'}`);
                updateAddRecordBtnForType(); // content == snapshot now → button hides
            } catch (e) {
                toastr.error(`保存失败: ${e.message || e}`);
            } finally {
                $(this).prop('disabled', false);
            }
        });

    // Discard the AI fusion result that was just auto-stored on success.
    // Reads the bound save-type + save-index from the overlay, splices that record
    // out of the in-memory array, saves to server, and resets the overlay state.
    $(document).off('click', '#wizard-fusion-stream-discard-btn')
        .on('click', '#wizard-fusion-stream-discard-btn', async function () {
            const $overlay = $('#wizard-fusion-stream-overlay');
            const saveType = $overlay.attr('data-save-type');
            const saveIdx  = parseInt($overlay.attr('data-save-index'), 10);
            const typeName = SUMMARY_TYPE_NAMES[saveType] || '记';

            if (!saveType || isNaN(saveIdx) || saveIdx < 0) {
                // No record bound (e.g. after an abort, or already discarded) — the
                // 删除 button here is just "clear the displayed text". Do that and
                // reset the overlay without touching summaries.
                $overlay
                    .removeData('aiSnapshot').removeData('continueCtx').removeData('fuseSelfSources')
                    .removeAttr('data-save-type').removeAttr('data-save-index');
                $('#wizard-fusion-stream-body').val('').prop('readonly', true);
                $('#wizard-fusion-stream-stats').text('0 字符 · 已清空');
                $('#wizard-fusion-stream-add-record-btn').hide();
                $('#wizard-fusion-stream-discard-btn').hide();
                $('#wizard-fusion-stream-continue-btn').prop('disabled', true);
                $('#wizard-fusion-stream-status').text('已清空').css('color', '#9ca3af');
                return;
            }
            const arr = getSummaryArray(saveType);
            if (!arr || arr[saveIdx] === undefined) {
                toastr.warning('记录已不存在。');
                return;
            }

            $(this).prop('disabled', true);
            try {
                arr.splice(saveIdx, 1);
                await saveSummariesToServer();
                renderAllSummaryLists();
                // Clear binding so the overlay is no longer tied to a record.
                $overlay
                    .removeData('aiSnapshot').removeData('continueCtx').removeData('fuseSelfSources')
                    .removeAttr('data-save-type').removeAttr('data-save-index');
                $('#wizard-fusion-stream-body').val('').prop('readonly', true);
                $('#wizard-fusion-stream-stats').text('0 字符 · 已弃用');
                $('#wizard-fusion-stream-add-record-btn').hide();
                $('#wizard-fusion-stream-discard-btn').hide();
                $('#wizard-fusion-stream-continue-btn').prop('disabled', true);
                $('#wizard-fusion-stream-status').text('已弃用').css('color', '#ef4444');
                toastr.info(`本次 ${typeName} 融合结果已弃用。`);
                writeLog(`Discarded ${typeName} at index ${saveIdx}.`);
            } catch (e) {
                toastr.error(`弃用失败: ${e.message || e}`);
            } finally {
                $(this).prop('disabled', false);
            }
        });

    // (The old separate #wizard-fusion-stream-save-btn handler was removed — the
    // smart #wizard-fusion-stream-add-record-btn now handles both create and
    // overwrite, appearing only when the content diverges from the stored version.)

    // Toggle all tree folders (Expand/Collapse all)
    $(document).off('click', '#wizard-tree-toggle-all-btn').on('click', '#wizard-tree-toggle-all-btn', function () {
        const allNodes = getAllNodes(memoryTree);
        if (allExpanded) {
            // Collapse all folders
            allNodes.forEach(n => {
                if (n.children && n.children.length > 0) {
                    collapsedPaths.add(n.path);
                }
            });
            allExpanded = false;
        } else {
            // Expand all folders
            collapsedPaths.clear();
            allExpanded = true;
        }
        renderTreeView(memoryTree, $('#wizard-tree-root'));
        $('#wizard-tree-toggle-all-btn').toggleClass('wizard-btn-warning', allExpanded);
    });

    // ---- Tree import / export / batch-edit ----

    // Export the whole tree.
    $(document).off('click', '#wizard-tree-export-all-btn').on('click', '#wizard-tree-export-all-btn', function () {
        if (!memoryTree || memoryTree.length === 0) {
            toastr.warning('记忆树为空，没有可导出的内容。');
            return;
        }
        const snapshot = JSON.parse(JSON.stringify(memoryTree));
        const payload = buildTreeExport(snapshot);
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const safeChat = (activeChatId || 'tree').replace(/[^a-z0-9_-]/gi, '_');
        downloadJson(payload, `memory_tree_${safeChat}_${stamp}.json`);
        toastr.success(`已导出整棵记忆树 (${payload.nodeCount} 个节点)`);
    });

    // Export only the selected nodes (batch mode).
    $(document).off('click', '#wizard-tree-export-selected-btn').on('click', '#wizard-tree-export-selected-btn', function () {
        if (selectedPaths.size === 0) {
            toastr.warning('请先勾选要导出的节点。');
            return;
        }
        const forest = collectSelectedForest();
        const payload = buildTreeExport(forest);
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        downloadJson(payload, `memory_tree_selected_${stamp}.json`);
        toastr.success(`已导出所选 ${payload.nodeCount} 个节点`);
    });

    // Import: open the hidden file picker.
    $(document).off('click', '#wizard-tree-import-btn').on('click', '#wizard-tree-import-btn', function () {
        $('#wizard-tree-import-file').val(''); // allow re-picking the same file
        $('#wizard-tree-import-file').trigger('click');
    });

    // ---- "从备份导入" : pick a server-side backup file and import it ----------
    // Tree backup import: list memory_tree_* backups, let the user pick one, read
    // it, and run the same merge/replace flow as the file-based import.
    $(document).off('click', '#wizard-tree-import-backup-btn').on('click', '#wizard-tree-import-backup-btn', async function () {
        const picked = await showBackupPicker('tree');
        if (!picked) return;
        const parsed = picked.data;
        let nodeForest = null;
        if (Array.isArray(parsed)) nodeForest = parsed;
        else if (parsed && parsed.format === 'memory-wizard-tree' && Array.isArray(parsed.nodes)) nodeForest = parsed.nodes;
        else if (parsed && Array.isArray(parsed.nodes)) nodeForest = parsed.nodes;
        if (!nodeForest || nodeForest.length === 0) { toastr.error('该备份不含有效的记忆树节点。'); return; }
        const valid = nodeForest.every(n => n && typeof n.path === 'string' && typeof n.title === 'string');
        if (!valid) { toastr.error('该备份的节点缺少 path / title 字段。'); return; }

        const importCount = getAllNodes(nodeForest).length;
        const context = window.SillyTavern.getContext();
        let mode = 'merge';
        try {
            const popup = new context.Popup(
                `<h3>从备份导入 ${importCount} 个节点</h3>
                 <div style="text-align:left; line-height:1.6; font-size:0.9em;">
                   <p style="color:#9ca3af;">备份: ${escapeHtml(picked.name)}</p>
                   <p><b>合并</b>：按路径覆盖同名节点，保留其他现有节点。</p>
                   <p><b>替换</b>：清空当前记忆树，整体换成备份内容（不可逆）。</p>
                 </div>`,
                context.POPUP_TYPE.TEXT, '',
                { customButtons: [{ text: '合并', result: 2 }, { text: '替换', result: 3 }], okButton: false, cancelButton: '取消' }
            );
            const res = await popup.show();
            if (res === 2) mode = 'merge';
            else if (res === 3) mode = 'replace';
            else { toastr.info('已取消导入。'); return; }
        } catch (e) {
            const yes = await context.Popup.show.confirm(`从备份导入 ${importCount} 个节点`, '「确定」= 合并 · 「取消」= 替换');
            mode = yes ? 'merge' : 'replace';
        }

        if (mode === 'replace') memoryTree = JSON.parse(JSON.stringify(nodeForest));
        else mergeImportedNodes(JSON.parse(JSON.stringify(nodeForest)));
        await saveTreeToServer();
        renderTreeView(memoryTree, $('#wizard-tree-root'));
        $('#wizard-status-nodes-count').text(getAllNodes(memoryTree).length + ' 个节点');
        toastr.success(`从备份导入成功 (${mode === 'replace' ? '整体替换' : '合并'})，共 ${importCount} 个节点`);
        writeLog(`Imported ${importCount} nodes from backup "${picked.name}" (${mode}).`);
    });

    $(document).off('change', '#wizard-tree-import-file').on('change', '#wizard-tree-import-file', async function () {
        const file = this.files && this.files[0];
        if (!file) return;
        let parsed;
        try {
            const text = await file.text();
            parsed = JSON.parse(text);
        } catch (e) {
            toastr.error('导入失败：文件不是有效的 JSON。');
            return;
        }

        // Accept either our envelope { format, nodes:[...] } or a bare node array.
        let nodeForest = null;
        if (Array.isArray(parsed)) {
            nodeForest = parsed;
        } else if (parsed && parsed.format === 'memory-wizard-tree' && Array.isArray(parsed.nodes)) {
            nodeForest = parsed.nodes;
        } else if (parsed && Array.isArray(parsed.nodes)) {
            nodeForest = parsed.nodes;
        }

        if (!nodeForest || nodeForest.length === 0) {
            toastr.error('导入失败：未找到有效的记忆树节点 (期望格式 memory-wizard-tree)。');
            return;
        }

        // Basic shape validation: each top node needs a path + title.
        const valid = nodeForest.every(n => n && typeof n.path === 'string' && typeof n.title === 'string');
        if (!valid) {
            toastr.error('导入失败：节点缺少 path / title 字段。');
            return;
        }

        const importCount = getAllNodes(nodeForest).length;
        const context = window.SillyTavern.getContext();

        // Ask merge vs replace via a clean 3-button dialog (合并 / 替换 / 取消).
        let mode = 'merge';
        try {
            const popup = new context.Popup(
                `<h3>导入 ${importCount} 个节点</h3>
                 <div style="text-align:left; line-height:1.6; font-size:0.9em;">
                   <p><b>合并</b>：按路径覆盖同名节点，保留其他现有节点。</p>
                   <p><b>替换</b>：清空当前记忆树，整体换成导入的内容（不可逆）。</p>
                 </div>`,
                context.POPUP_TYPE.TEXT,
                '',
                { customButtons: [
                    { text: '合并', result: 2 },
                    { text: '替换', result: 3 },
                ], okButton: false, cancelButton: '取消' }
            );
            const res = await popup.show();
            if (res === 2) mode = 'merge';
            else if (res === 3) mode = 'replace';
            else { toastr.info('已取消导入。'); return; }
        } catch (e) {
            // Fallback to confirm if the custom Popup API is unavailable.
            const popupResult = await context.Popup.show.confirm(
                `导入 ${importCount} 个节点`,
                `「确定」= 合并 · 「取消」= 替换`
            );
            mode = popupResult ? 'merge' : 'replace';
        }

        if (mode === 'replace') {
            memoryTree = JSON.parse(JSON.stringify(nodeForest));
        } else {
            mergeImportedNodes(JSON.parse(JSON.stringify(nodeForest)));
        }

        lastTreeMoveUndoSnapshot = null;
        updateUndoMoveButton();
        await saveTreeToServer();
        renderTreeView(memoryTree, $('#wizard-tree-root'));
        $('#wizard-status-nodes-count').text(getAllNodes(memoryTree).length + ' 个节点');
        toastr.success(`导入成功 (${mode === 'replace' ? '整体替换' : '合并'})，共处理 ${importCount} 个节点`);
        writeLog(`Imported ${importCount} nodes (${mode}).`);
    });

    $(document).off('click', '#wizard-tree-undo-move-btn').on('click', '#wizard-tree-undo-move-btn', async function () {
        if (!lastTreeMoveUndoSnapshot) {
            toastr.info('没有可撤回的移动。');
            return;
        }
        const snap = lastTreeMoveUndoSnapshot;
        lastTreeMoveUndoSnapshot = null;
        updateUndoMoveButton();
        writeLog(`Undo clicked: restoring snapshot of ${getAllNodes(snap.tree).length} nodes (current live tree has ${getAllNodes(memoryTree).length}).`, 'DEBUG');
        memoryTree = JSON.parse(JSON.stringify(snap.tree));
        // collapsedPaths is a const Set — mutate in place, don't reassign (reassigning
        // a const throws TypeError and silently aborted the whole undo before this fix).
        collapsedPaths.clear();
        (snap.collapsedPaths || []).forEach(p => collapsedPaths.add(p));
        aiNewNodePathsThisSession = new Set(snap.newPaths || []);
        const activePath = snap.activePath || '';
        writeLog(`Tree move undo applied; restoring ${getAllNodes(memoryTree).length} nodes.`);
        const treeRoot = $('#wizard-tree-root');
        if (treeRoot.length > 0) renderTreeView(memoryTree, treeRoot);
        await saveTreeToServer(true); // skip normalize — snapshot is already hierarchical
        if (activePath) {
            const node = findNodeByPath(memoryTree, activePath);
            if (node) loadNodeIntoForm(node);
        }
        toastr.success('已撤回上一次移动。');
    });

    // Toggle batch-edit (selection) mode.
    $(document).off('click', '#wizard-tree-select-mode-btn').on('click', '#wizard-tree-select-mode-btn', function () {
        treeSelectionMode = !treeSelectionMode;
        if (!treeSelectionMode) {
            selectedPaths.clear();
        }
        $(this).toggleClass('wizard-btn-warning', treeSelectionMode);
        $(this).find('i').attr('class', treeSelectionMode ? 'fa-solid fa-square-check' : 'fa-regular fa-square-check');
        updateTreeSelectionUI();
        rerenderTree();
    });

    // Select all / clear all (within the currently rendered view).
    $(document).off('click', '#wizard-tree-select-all-btn').on('click', '#wizard-tree-select-all-btn', function () {
        const visible = getAllNodes(currentRenderNodes || memoryTree);
        const allSelected = visible.length > 0 && visible.every(n => selectedPaths.has(n.path));
        if (allSelected) {
            visible.forEach(n => selectedPaths.delete(n.path));
        } else {
            visible.forEach(n => selectedPaths.add(n.path));
        }
        updateTreeSelectionUI();
        rerenderTree();
    });

    // Clear AI source/info provenance markers from selected nodes (does not delete nodes).
    $(document).off('click', '#wizard-tree-clear-info-selected-btn').on('click', '#wizard-tree-clear-info-selected-btn', async function () {
        if (selectedPaths.size === 0) {
            toastr.warning('请先勾选要删除 info 标记的节点。');
            return;
        }
        let changed = 0;
        selectedPaths.forEach(p => {
            const node = findNodeByPath(memoryTree, p);
            if (node && node.provenance) {
                delete node.provenance;
                changed++;
            }
        });
        if (!changed) { toastr.info('所选节点没有 info 标记。'); return; }
        await saveTreeToServer(true);
        renderTreeView(memoryTree, $('#wizard-tree-root'));
        toastr.success(`已删除 ${changed} 个节点的 info 标记。`);
    });

    // Delete all selected nodes.
    $(document).off('click', '#wizard-tree-delete-selected-btn').on('click', '#wizard-tree-delete-selected-btn', async function () {
        if (selectedPaths.size === 0) {
            toastr.warning('请先勾选要删除的节点。');
            return;
        }
        const forest = collectSelectedForest(); // top-level selected subtrees
        const topPaths = forest.map(n => n.path);
        const total = getAllNodes(forest).length;
        const context = window.SillyTavern.getContext();
        const confirmDel = await context.Popup.show.confirm(
            `确定删除所选 ${total} 个节点吗？`,
            '勾选的节点（含其所有子节点）将被删除！此操作不可逆。'
        );
        if (!confirmDel) return;

        // Delete each top-level selected subtree by path from the real tree.
        topPaths.forEach(p => {
            const node = findNodeByPath(memoryTree, p);
            if (node) deleteNodeFromTree(node);
        });
        selectedPaths.clear();
        await saveTreeToServer();
        renderTreeView(memoryTree, $('#wizard-tree-root'));
        $('#wizard-status-nodes-count').text(getAllNodes(memoryTree).length + ' 个节点');
        updateTreeSelectionUI();
        toastr.success(`已删除 ${total} 个节点`);
        writeLog(`Batch-deleted ${total} nodes.`);
    });

    // Batch color: toggle the swatch popup.
    $(document).off('click', '#wizard-tree-color-selected-btn').on('click', '#wizard-tree-color-selected-btn', function (e) {
        e.stopPropagation();
        if (selectedPaths.size === 0) {
            toastr.warning('请先勾选要应用配色的节点。');
            return;
        }
        const popup = $('#wizard-tree-color-popup');
        popup.css('display', popup.css('display') === 'none' ? 'flex' : 'none');
    });

    // Close the batch-color popup when clicking elsewhere.
    $(document).off('click.wizardBatchColor').on('click.wizardBatchColor', function (e) {
        if (!$(e.target).closest('#wizard-tree-color-selected-btn, #wizard-tree-color-popup').length) {
            $('#wizard-tree-color-popup').css('display', 'none');
        }
    });

    // Batch color: apply the chosen color to every selected node, then save.
    $(document).off('click', '.wizard-batch-color-swatch').on('click', '.wizard-batch-color-swatch', async function (e) {
        e.stopPropagation();
        const color = $(this).data('color') || '';
        if (selectedPaths.size === 0) {
            toastr.warning('请先勾选要应用配色的节点。');
            return;
        }
        let applied = 0;
        selectedPaths.forEach(p => {
            const node = findNodeByPath(memoryTree, p);
            if (node) {
                if (color) node.color = color; else delete node.color;
                applied++;
            }
        });
        $('#wizard-tree-color-popup').css('display', 'none');
        await saveTreeToServer();
        renderTreeView(memoryTree, $('#wizard-tree-root'));
        toastr.success(color ? `已为 ${applied} 个节点应用配色` : `已清除 ${applied} 个节点的配色`);
        writeLog(`Batch-applied color "${color || '(none)'}" to ${applied} nodes.`);
    });

    // Batch toggle 强制钉死 (pinned) on all selected nodes. If every selected node
    // is already pinned, this unsets; otherwise it sets all to pinned.
    // Batch toggle 发送路径 (sendPath) on all selected nodes. If every selected node
    // already sends its path, this turns it OFF (cascading to children, since a
    // parent with no sent path implies its children aren't sent either); otherwise ON.
    $(document).off('click', '#wizard-tree-sendpath-selected-btn').on('click', '#wizard-tree-sendpath-selected-btn', async function () {
        if (selectedPaths.size === 0) {
            toastr.warning('请先勾选要操作的节点。');
            return;
        }
        const nodes = [];
        selectedPaths.forEach(p => { const n = findNodeByPath(memoryTree, p); if (n) nodes.push(n); });
        if (!nodes.length) return;
        const allSend = nodes.every(n => n.sendPath !== false);
        const target = !allSend;
        let count = 0;
        if (target) {
            // Turning ON: only flip the selected nodes themselves.
            nodes.forEach(n => { n.sendPath = true; count++; });
        } else {
            // Turning OFF: cascade to descendants.
            nodes.forEach(n => {
                collectNodeAndChildren(n).forEach(c => { c.sendPath = false; count++; });
            });
        }
        await saveTreeToServer();
        renderTreeView(memoryTree, $('#wizard-tree-root'));
        toastr.success(target ? `已开启 ${count} 个节点的发送路径` : `已关闭 ${count} 个节点的发送路径（含子节点）`);
        writeLog(`Batch-sendPath ${target ? 'on' : 'off'} ${count} nodes.`);
    });

    $(document).off('click', '#wizard-tree-pin-selected-btn').on('click', '#wizard-tree-pin-selected-btn', async function () {
        if (selectedPaths.size === 0) {
            toastr.warning('请先勾选要操作的节点。');
            return;
        }
        const nodes = [];
        selectedPaths.forEach(p => { const n = findNodeByPath(memoryTree, p); if (n) nodes.push(n); });
        if (!nodes.length) return;
        const allPinned = nodes.every(n => n.pinned);
        nodes.forEach(n => { n.pinned = !allPinned; });
        await saveTreeToServer();
        renderTreeView(memoryTree, $('#wizard-tree-root'));
        toastr.success(allPinned ? `已取消 ${nodes.length} 个节点的强制钉死` : `已将 ${nodes.length} 个节点设为强制钉死`);
        writeLog(`Batch-${allPinned ? 'unpinned' : 'pinned'} ${nodes.length} nodes.`);
    });

    // Batch toggle 归档 (archived) on all selected nodes, cascading to children.
    // If every selected node is already archived, this unsets (also cascades).
    $(document).off('click', '#wizard-tree-archive-selected-btn').on('click', '#wizard-tree-archive-selected-btn', async function () {
        if (selectedPaths.size === 0) {
            toastr.warning('请先勾选要操作的节点。');
            return;
        }
        const nodes = [];
        selectedPaths.forEach(p => { const n = findNodeByPath(memoryTree, p); if (n) nodes.push(n); });
        if (!nodes.length) return;
        const allArchived = nodes.every(n => n.archived);
        const target = !allArchived;
        let count = 0;
        nodes.forEach(n => {
            collectNodeAndChildren(n).forEach(c => { c.archived = target; count++; });
        });
        await saveTreeToServer();
        renderTreeView(memoryTree, $('#wizard-tree-root'));
        toastr.success(target ? `已归档 ${count} 个节点（含子节点）` : `已取消归档 ${count} 个节点`);
        writeLog(`Batch-${target ? 'archived' : 'unarchived'} ${count} nodes.`);
    });

    // ─── AI Shrink feature ───────────────────────────────────────────────────

    // Update the bulk action bar: show/hide and update pending count label.
    // Also persists the pending suggestions so they survive an ST refresh.
    function updateAiShrinkBulkBar() {
        const count = pendingAiShrinkEdits.size;
        const bar = $('#wizard-ai-shrink-bulk-bar');
        if (count > 0) {
            bar.css('display', 'inline-flex');
            $('#wizard-ai-shrink-pending-count').text(`${count} 条建议`);
        } else {
            bar.css('display', 'none');
        }
        saveAiShrinkPending();
    }

    // Serialize the entire memory tree to a human-readable indented text for AI.
    function serializeTreeForAi(nodes, indent) {
        indent = indent || 0;
        const prefix = '  '.repeat(indent);
        let out = '';
        (nodes || []).forEach(node => {
            out += `${prefix}【${node.path}】\n`;
            if (node.content) {
                node.content.split('\n').forEach(line => {
                    out += `${prefix}  ${line}\n`;
                });
            }
            if (node.children && node.children.length) {
                out += serializeTreeForAi(node.children, indent + 1);
            }
        });
        return out;
    }

    // Insert or update a suggestion row below a tree header (module-level helper).
    const insertAiSuggestionRow = insertAiSuggestionRowImpl;

    function processAiShrinkOutput(rawText) {
        let raw = (rawText || '').trim();
        raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
        let suggestions;
        try {
            suggestions = JSON.parse(raw);
        } catch (e) {
            toastr.error('AI 返回的格式不是有效的 JSON 数组，未应用。');
            $('#wizard-ai-shrink-status').text('解析失败：AI 未返回合法 JSON。');
            $('#wizard-ai-shrink-stream-status').text('格式错误，未应用').css('color', '#ef4444');
            writeLog(`AI shrink parse error: ${e.message}. Raw: ${raw.slice(0, 200)}`, 'ERROR');
            return false;
        }
        if (!Array.isArray(suggestions)) {
            toastr.error('AI 返回的不是 JSON 数组，未应用。');
            $('#wizard-ai-shrink-status').text('格式错误：期望 JSON 数组。');
            $('#wizard-ai-shrink-stream-status').text('格式错误，未应用').css('color', '#ef4444');
            return false;
        }
        let applied = 0;
        suggestions.forEach((item, idx) => {
            if (!item || typeof item !== 'object') return;
            const suggestion = normalizeAiShrinkSuggestion(item);
            const isInsert = aiShrinkIsInsert(suggestion);
            const hasChange = isInsert || suggestion.content !== undefined || suggestion.parent !== undefined || suggestion.title !== undefined || suggestion.hint !== undefined || suggestion.keywords || suggestion.newPath;
            if (!hasChange) return;
            let key = suggestion.path || '';
            if (isInsert) {
                if (!suggestion.title || suggestion.content === undefined) {
                    writeLog(`AI shrink insert ignored: missing title/content: ${JSON.stringify(item)}`, 'WARNING');
                    return;
                }
                const targetPath = buildAiShrinkTargetPath('', null, suggestion);
                key = `__insert__${idx}__${targetPath}`;
            } else {
                if (!key) return;
                const node = findNodeByPath(memoryTree, key);
                if (!node) {
                    writeLog(`AI shrink: path not found in tree: "${key}"`, 'WARNING');
                    return;
                }
            }
            pendingAiShrinkEdits.set(key, suggestion);
            insertAiSuggestionRow(key, suggestion);
            applied++;
        });
        if (applied === 0) {
            toastr.info('AI 没有建议任何修改。');
            $('#wizard-ai-shrink-status').text('AI 未提出修改建议。');
        } else {
            toastr.success(`AI 提出了 ${applied} 条缩减建议，请逐条确认。`);
            $('#wizard-ai-shrink-status').text(`已收到 ${applied} 条建议，待确认。`);
        }
        updateAiShrinkBulkBar();
        return applied;
    }

    // Toggle the AI shrink panel.
    $(document).off('click', '#wizard-tree-ai-shrink-btn').on('click', '#wizard-tree-ai-shrink-btn', function () {
        const panel = $('#wizard-ai-shrink-panel');
        const isVisible = panel.css('display') !== 'none';
        if (isVisible) {
            panel.css('display', 'none');
            $('#wizard-tree-ai-shrink-btn').removeClass('wizard-btn-warning');
        } else {
            if (!$('#wizard-ai-shrink-prompt').val()) {
                $('#wizard-ai-shrink-prompt').val(config.aiShrinkPrompt || "");
            }
            panel.css('display', 'flex');
            $('#wizard-tree-ai-shrink-btn').addClass('wizard-btn-warning');
            // Compute and display the full tree token estimate.
            const treeText = serializeTreeForAi(memoryTree, 0);
            const tokens = estimateTokens(treeText);
            const nodeCount = getAllNodes(memoryTree).length;
            $('#wizard-ai-shrink-token-count').text(`${nodeCount} 个节点 · 约 ${tokens.toLocaleString()} tokens`);
        }
    });

    // Send to AI handler — also acts as stop button while a request is in flight.
    $(document).off('click', '#wizard-ai-shrink-send-btn').on('click', '#wizard-ai-shrink-send-btn', async function () {
        if (aiShrinkAbortController) {
            aiShrinkAbortController.abort();
            return;
        }
        if (!memoryTree || memoryTree.length === 0) {
            toastr.warning('记忆树为空，没有可发送的内容。');
            return;
        }
        const promptTemplate = $('#wizard-ai-shrink-prompt').val() || config.aiShrinkPrompt || "";
        const profileName = $('#wizard-ai-shrink-profile').val() || "";
        const treeText = serializeTreeForAi(memoryTree, 0);
        // User-owned prompt. If the user places {{memory_tree}}, inject the tree exactly
        // there; if not, append ONLY the raw tree text (no extra built-in instruction).
        const hasTreeToken = /\{\{\s*memory_tree\s*\}\}/i.test(promptTemplate);
        const finalPrompt = hasTreeToken
            ? promptTemplate.replace(/\{\{\s*memory_tree\s*\}\}/gi, treeText)
            : `${promptTemplate}\n\n${treeText}`;

        $('#wizard-ai-shrink-send-btn')
            .html('<i class="fa-solid fa-stop"></i> 停止')
            .css({ background: 'rgba(248,113,113,0.15)', 'border-color': 'rgba(248,113,113,0.5)', color: '#f87171' });
        $('#wizard-ai-shrink-status').text('正在发送给 AI，请稍候…');
        $('#wizard-ai-shrink-stream-body').val('');
        $('#wizard-ai-shrink-stream-reasoning').val('');
        $('#wizard-ai-shrink-stream-reasoning-wrap').hide().prop('open', false);
        $('#wizard-ai-shrink-stream-stats').text('0 字符 · 0 tokens');
        $('#wizard-ai-shrink-stream-status').text('连接中...').css('color', '#9ca3af');
        $('#wizard-ai-shrink-stream-abort-btn').show().prop('disabled', false);

        aiShrinkAbortController = new AbortController();
        try {
            const onStreamChunk = (fullText, reasoningText) => {
                const bodyEl = document.getElementById('wizard-ai-shrink-stream-body');
                if (!bodyEl) return;
                const wasAtBottom = (bodyEl.scrollTop + bodyEl.clientHeight >= bodyEl.scrollHeight - 50);
                // The model may deliver its chain-of-thought INLINE in <thinking>…</thinking>
                // inside the body (rather than as a separate reasoning stream field). Strip
                // such blocks out of the visible body and surface them in the 思考内容 pane.
                const { body: cleanBody, thinking: inlineThinking } = splitInlineThinking(fullText);
                bodyEl.value = cleanBody;
                const thinking = (reasoningText || '').trim() || inlineThinking;
                if (thinking) {
                    $('#wizard-ai-shrink-stream-reasoning').val(thinking);
                    $('#wizard-ai-shrink-stream-reasoning-wrap').show().prop('open', true);
                }
                $('#wizard-ai-shrink-stream-stats').text(`${cleanBody.length} 字符 · ${estimateTokens(cleanBody).toLocaleString()} tokens`);
                if ($('#wizard-ai-shrink-stream-status').text().startsWith('连接中')) {
                    $('#wizard-ai-shrink-stream-status').text('生成中...').css('color', '#60a5fa');
                }
                if (wasAtBottom) bodyEl.scrollTop = bodyEl.scrollHeight;
            };
            const result = await runIsolatedFusionCall(
                profileName,
                [{ role: 'user', content: finalPrompt }],
                AI_SHRINK_SYSTEM_PROMPT,
                0.2,
                120000,
                aiShrinkAbortController.signal,
                onStreamChunk
            );

            // Strip markdown code fences if present. Also peel any inline
            // <thinking>…</thinking> out of the body into the 思考内容 pane — the model
            // often delivers its chain-of-thought inline rather than as a reasoning field.
            const { body: cleanedRaw, thinking: finishThinking } = splitInlineThinking((result || "").trim());
            let raw = cleanedRaw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
            $('#wizard-ai-shrink-stream-body').val(raw);
            const thinking = ($('#wizard-ai-shrink-stream-reasoning').val() || '').trim() || finishThinking;
            if (thinking) {
                $('#wizard-ai-shrink-stream-reasoning').val(thinking);
                $('#wizard-ai-shrink-stream-reasoning-wrap').show().prop('open', true);
            }
            $('#wizard-ai-shrink-stream-stats').text(`${raw.length} 字符 · ${estimateTokens(raw).toLocaleString()} tokens`);
            $('#wizard-ai-shrink-stream-status').text('生成完成').css('color', '#34d399');
            $('#wizard-ai-shrink-stream-abort-btn').hide();
            const applied = processAiShrinkOutput(raw);
            if (applied === false) return;
            updateAiShrinkBulkBar();
            // Auto-save profile+prompt on successful send.
            config.aiShrinkProfile = profileName;
            config.aiShrinkPrompt = $('#wizard-ai-shrink-prompt').val() || "";
            saveConfig(true);
        } catch (e) {
            if (e.name === 'AbortError' || aiShrinkAbortController?.signal?.aborted) {
                toastr.info('AI 缩减已停止。');
                $('#wizard-ai-shrink-status').text('已停止。');
                $('#wizard-ai-shrink-stream-status').text('已中止').css('color', '#f59e0b');
            } else {
                toastr.error(`AI 请求失败: ${e.message}`);
                $('#wizard-ai-shrink-status').text(`错误: ${e.message}`);
                $('#wizard-ai-shrink-stream-status').text(`错误: ${e.message}`).css('color', '#ef4444');
                writeLog(`AI shrink request error: ${e.message}`, 'ERROR');
            }
        } finally {
            const pc = getComputedStyle(document.documentElement).getPropertyValue('--wizard-primary').trim() || '#a3842e';
            const pcRgb = getComputedStyle(document.documentElement).getPropertyValue('--wizard-primary-rgb').trim() || '163,132,46';
            $('#wizard-ai-shrink-send-btn')
                .html('<i class="fa-solid fa-paper-plane"></i> 发送给 AI')
                .css({ background: `rgba(${pcRgb},0.18)`, 'border-color': `rgba(${pcRgb},0.5)`, color: pc });
            $('#wizard-ai-shrink-stream-abort-btn').hide().prop('disabled', true);
            aiShrinkAbortController = null;
        }
    });

    $(document).off('click', '#wizard-ai-shrink-stream-view-btn').on('click', '#wizard-ai-shrink-stream-view-btn', function () {
        $('#wizard-ai-shrink-stream-overlay').css('display', 'flex');
    });

    $(document).off('click', '#wizard-ai-shrink-stream-close-btn').on('click', '#wizard-ai-shrink-stream-close-btn', function () {
        $('#wizard-ai-shrink-stream-overlay').css('display', 'none');
    });

    $(document).off('click', '#wizard-ai-shrink-stream-abort-btn').on('click', '#wizard-ai-shrink-stream-abort-btn', function () {
        if (aiShrinkAbortController) aiShrinkAbortController.abort();
    });

    $(document).off('click', '#wizard-ai-shrink-stream-clear-btn').on('click', '#wizard-ai-shrink-stream-clear-btn', function () {
        $('#wizard-ai-shrink-stream-body').val('');
        $('#wizard-ai-shrink-stream-reasoning').val('');
        $('#wizard-ai-shrink-stream-reasoning-wrap').hide().prop('open', false);
        $('#wizard-ai-shrink-stream-stats').text('0 字符 · 0 tokens');
        $('#wizard-ai-shrink-stream-status').text('已清空').css('color', '#9ca3af');
    });

    $(document).off('click', '#wizard-ai-shrink-stream-apply-btn').on('click', '#wizard-ai-shrink-stream-apply-btn', function () {
        const text = $('#wizard-ai-shrink-stream-body').val() || '';
        if (!text.trim()) {
            toastr.warning('实时输出为空，无法应用。');
            return;
        }
        const applied = processAiShrinkOutput(text);
        if (applied === false) return; // format error: keep text visible for repair/copy
        $('#wizard-ai-shrink-stream-body').val('');
        $('#wizard-ai-shrink-stream-reasoning').val('');
        $('#wizard-ai-shrink-stream-reasoning-wrap').hide().prop('open', false);
        $('#wizard-ai-shrink-stream-stats').text('0 字符 · 0 tokens');
        $('#wizard-ai-shrink-stream-overlay').css('display', 'none');
        $('#wizard-ai-shrink-stream-status').text('已应用').css('color', '#34d399');
    });

    $(document).off('click', '#wizard-ai-shrink-stream-copy-btn').on('click', '#wizard-ai-shrink-stream-copy-btn', async function () {
        const text = $('#wizard-ai-shrink-stream-body').val() || '';
        try {
            await navigator.clipboard.writeText(text);
            toastr.success('已复制 AI 缩减实时输出。');
        } catch (e) {
            toastr.error('复制失败。');
        }
    });

    function applyAiShrinkSuggestion(path, suggestionRaw) {
        const suggestion = normalizeAiShrinkSuggestion(suggestionRaw);
        const isInsert = path.startsWith('__insert__') || aiShrinkIsInsert(suggestion);
        if (isInsert) {
            const targetPath = buildAiShrinkTargetPath('', null, suggestion);
            const parts = targetPath.split('/').filter(Boolean);
            const title = parts.pop() || suggestion.title;
            const parent = parts.join('/');
            if (!title || suggestion.content === undefined) return false;
            if (findNodeByPath(memoryTree, targetPath)) {
                writeLog(`AI shrink insert ignored: target path already exists "${targetPath}".`, 'WARNING');
                return false;
            }
            applyTreeOperations([{
                op: 'insert',
                parent,
                title,
                hint: suggestion.hint || 'AI 缩减新增',
                content: suggestion.content,
                keywords: suggestion.keywords || '',
            }]);
            return true;
        }

        const node = findNodeByPath(memoryTree, path);
        if (!node) return false;
        const targetPath = buildAiShrinkTargetPath(path, node, suggestion);
        if (suggestion.content !== undefined) node.content = suggestion.content;
        if (suggestion.hint !== undefined) node.hint = suggestion.hint;
        if (suggestion.keywords) node.keywords = mergeKeywords(node.keywords, suggestion.keywords);
        if (targetPath && targetPath !== path) {
            if (targetPath.startsWith(`${path}/`)) {
                writeLog(`AI shrink move ignored: cannot move "${path}" under its own descendant "${targetPath}".`, 'WARNING');
                return false;
            }
            const existing = findNodeByPath(memoryTree, targetPath);
            if (existing && existing !== node) {
                writeLog(`AI shrink move ignored: target path already exists "${targetPath}".`, 'WARNING');
                return false;
            }
            const newTitle = targetPath.split('/').pop();
            node.title = newTitle;
            reparentNode(node, path, targetPath);
        }
        node.updated = new Date().toISOString().slice(0, 10);
        return true;
    }


    // Per-row accept: apply new content to the node and save.
    $(document).off('click', '.wizard-ai-suggestion-accept').on('click', '.wizard-ai-suggestion-accept', async function () {
        const path = $(this).data('path');
        const suggestion = pendingAiShrinkEdits.get(path);
        if (suggestion === undefined) return;
        const ok = applyAiShrinkSuggestion(path, suggestion);
        if (ok) {
            await saveTreeToServer();
            renderTreeView(memoryTree, $('#wizard-tree-root'));
            toastr.success(`已应用：${path.split('/').pop()}`);
        }
        pendingAiShrinkEdits.delete(path);
        $(`.wizard-ai-suggestion-row[data-path="${escapeHtml(path)}"]`).remove();
        updateAiShrinkBulkBar();
    });

    // Per-row reject: discard suggestion.
    $(document).off('click', '.wizard-ai-suggestion-reject').on('click', '.wizard-ai-suggestion-reject', function () {
        const path = $(this).data('path');
        pendingAiShrinkEdits.delete(path);
        $(`.wizard-ai-suggestion-row[data-path="${escapeHtml(path)}"]`).remove();
        updateAiShrinkBulkBar();
    });

    // Bulk accept all pending suggestions.
    $(document).off('click', '#wizard-ai-shrink-accept-all-btn').on('click', '#wizard-ai-shrink-accept-all-btn', async function () {
        if (pendingAiShrinkEdits.size === 0) return;
        let applied = 0;
        // Apply deeper nodes first so if both a parent and child are suggested, the
        // child's content edits land before a parent move rewrites the subtree paths.
        Array.from(pendingAiShrinkEdits.entries())
            .sort((a, b) => b[0].split('/').length - a[0].split('/').length)
            .forEach(([path, suggestion]) => {
                if (applyAiShrinkSuggestion(path, suggestion)) applied++;
            });
        if (applied > 0) {
            await saveTreeToServer();
            renderTreeView(memoryTree, $('#wizard-tree-root'));
            toastr.success(`已应用 ${applied} 个节点建议`);
        }
        pendingAiShrinkEdits.clear();
        $('.wizard-ai-suggestion-row').remove();
        updateAiShrinkBulkBar();
    });

    // Bulk reject all pending suggestions.
    $(document).off('click', '#wizard-ai-shrink-reject-all-btn').on('click', '#wizard-ai-shrink-reject-all-btn', function () {
        pendingAiShrinkEdits.clear();
        $('.wizard-ai-suggestion-row').remove();
        updateAiShrinkBulkBar();
        toastr.info('已删除全部 AI 建议。');
    });

    // Auto-save shrink profile on change.
    $(document).off('change', '#wizard-ai-shrink-profile').on('change', '#wizard-ai-shrink-profile', function () {
        config.aiShrinkProfile = $(this).val() || "";
        saveConfig(true);
    });

    // ─── End AI Shrink ───────────────────────────────────────────────────────

    // ══════════════════════════════════════════════════════════════════════
    // REGION: 世界书面板（World Book）— 读取/编辑酒馆世界书，AI 单条/多条修改
    // ══════════════════════════════════════════════════════════════════════
    // SillyTavern World Info API（全部经 context，不新增后端路由）：
    //   loadWorldInfo(name) → { entries: { [uid]: WIEntry } }
    //   saveWorldInfo(name, data, immediately=false)
    //   getWorldInfoNames() → string[]
    //   updateWorldInfoList() → 刷新名称列表
    //   openWorldInfoEditor(name) / showWorldEditor / reloadWorldInfoEditor
    //   eventTypes.WORLDINFO_UPDATED → 保存后触发，用于失效缓存
    // 角色卡绑定世界书：context.characters[context.characterId]?.data?.extensions?.world
    // 群聊无单角色绑定 → 退化为手动选择。
    // （内置默认 Prompt、WB_OP_FIELDS、状态变量均已上移到顶层作用域，紧邻 loadConfig 之前，
    //  以便 loadConfig/saveConfig 与本区域的嵌套函数都能访问。）

    function wbCtx() {
        return window.SillyTavern?.getContext?.() || null;
    }

    // 当前楼层号（0-indexed 最新楼）。优先 live chat，退回 sandboxChatContext。
    function getCurrentFloorNumber() {
        const ctx = wbCtx();
        const live = Array.isArray(ctx?.chat) ? ctx.chat.length - 1 : -1;
        if (live >= 0) return live;
        return Array.isArray(sandboxChatContext) ? sandboxChatContext.length - 1 : -1;
    }

    // 角色卡绑定的世界书名；群聊/无绑定返回 null。
    function detectCharLinkedWorld() {
        const ctx = wbCtx();
        if (!ctx) return null;
        if (ctx.groupId) return null; // 群聊无单一绑定
        const chars = ctx.characters;
        const chid = ctx.characterId;
        if (Array.isArray(chars) && chid !== undefined && chid_valid(chid, chars)) {
            const w = chars[chid]?.data?.extensions?.world;
            return (typeof w === 'string' && w.trim()) ? w.trim() : null;
        }
        return null;
    }

    // 读取世界书（带简单内存缓存，WORLDINFO_UPDATED 会失效）。
    async function loadWbData(name) {
        if (!name) return null;
        if (wbCache && wbCache.name === name && wbCache.data) return wbCache.data;
        const ctx = wbCtx();
        if (!ctx?.loadWorldInfo) return null;
        try {
            const data = await ctx.loadWorldInfo(name);
            if (data) {
                wbCache = { name, data, ts: Date.now() };
                return data;
            }
        } catch (e) {
            writeLog(`WB loadWorldInfo("${name}") failed: ${e.message}`, 'ERROR');
            toastr.error(`读取世界书失败: ${e.message}`);
        }
        return null;
    }

    // 保存世界书（immediately=true 立即落盘）。保存前若 WI 编辑被禁用会等待。
    async function saveWbData(name, data) {
        const ctx = wbCtx();
        if (!ctx?.saveWorldInfo) { toastr.error('当前 SillyTavern 不支持 saveWorldInfo。'); return false; }
        try {
            if (typeof ctx.waitDuringWIDisabled === 'function') await ctx.waitDuringWIDisabled();
            await ctx.saveWorldInfo(name, data, true);
            // 保存后失效缓存（WORLDINFO_UPDATED 也会触发，这里双保险）。
            if (wbCache && wbCache.name === name) wbCache = null;
            return true;
        } catch (e) {
            writeLog(`WB saveWorldInfo("${name}") failed: ${e.message}`, 'ERROR');
            toastr.error(`保存世界书失败: ${e.message}`);
            return false;
        }
    }

    function nextWbUid(data) {
        const entries = data?.entries || {};
        let max = -1;
        for (const k of Object.keys(entries)) {
            const u = Number(entries[k]?.uid);
            if (!isNaN(u) && u > max) max = u;
        }
        return max + 1;
    }

    function wbEntryArr(data) {
        const entries = data?.entries || {};
        return Object.entries(entries).map(([k, e]) => ({ key: k, entry: e })).filter(x => x.entry && typeof x.entry === 'object');
    }

    function serializeEntryForAi(entry, mode) {
        const uid = entry.uid;
        const comment = entry.comment || '(无标题)';
        if (mode === 'titles') return `[#${uid}] ${comment}`;
        const keys = Array.isArray(entry.key) ? entry.key.join(', ') : (entry.key || '');
        const sec = Array.isArray(entry.keysecondary) && entry.keysecondary.length ? ` / ${entry.keysecondary.join(', ')}` : '';
        const content = entry.content || '';
        return `[#${uid}] ${comment}\nkeys: [${keys}${sec}]\ncontent:\n${content}`;
    }

    function serializeWorldBookForAi(data, mode) {
        return wbEntryArr(data).map(({ entry }) => serializeEntryForAi(entry, mode)).join('\n\n');
    }

    // 楼层范围正文：格式同 fusion `#floor [name]: body`，用 live chat，不带筛选。
    function getWbFloorRangeText(start, end) {
        const ctx = wbCtx();
        const chat = Array.isArray(ctx?.chat) ? ctx.chat : (Array.isArray(sandboxChatContext) ? sandboxChatContext : []);
        if (!chat.length) return '';
        const lo = (start === '' || start === null || isNaN(parseInt(start))) ? 0 : Math.max(0, parseInt(start));
        const hi = (end === '' || end === null || isNaN(parseInt(end))) ? chat.length - 1 : Math.min(chat.length - 1, parseInt(end));
        if (lo > hi) return '';
        const lines = [];
        for (let f = lo; f <= hi; f++) {
            const m = chat[f];
            if (!m) continue;
            lines.push(`#${f} [${msgName(m)}]: ${msgBody(m)}`);
        }
        return lines.join('\n');
    }

    // ── 渲染 ──
    async function renderWbBookSelector() {
        const ctx = wbCtx();
        const $sel = $('#wizard-wb-select');
        $sel.empty().append('<option value="">-- 请选择世界书 --</option>');
        let names = [];
        try {
            if (ctx?.getWorldInfoNames) names = ctx.getWorldInfoNames() || [];
        } catch (e) { writeLog(`WB getWorldInfoNames failed: ${e.message}`, 'ERROR'); }
        names.forEach(n => $sel.append($('<option></option>').val(n).text(n)));

        // 跟随角色卡：自动选择绑定书。
        const follow = $('#wizard-wb-follow-char').prop('checked');
        const linked = detectCharLinkedWorld();
        const hint = $('#wizard-wb-auto-hint');
        if (linked) {
            hint.text(`角色卡绑定: ${linked}`).css('color', '#34d399');
            if (follow && names.includes(linked)) {
                wbSelectedBook = linked;
            }
        } else {
            hint.text(ctx?.groupId ? '群聊：需手动选择' : '当前角色未绑定世界书').css('color', '#6b7280');
        }
        $sel.val(wbSelectedBook || "");
    }

    function renderWbEntryList(data) {
        const $list = $('#wizard-wb-entry-list');
        $list.empty();
        if (!data) { $list.html('<span class="wizard-wb-empty">未读取世界书</span>'); requestAnimationFrame(recheckWbOverflow); return; }
        const arr = wbEntryArr(data);
        if (!arr.length) { $list.html('<span class="wizard-wb-empty">世界书为空</span>'); $('#wizard-wb-entry-count').text(''); requestAnimationFrame(recheckWbOverflow); return; }
        $('#wizard-wb-entry-count').text(`共 ${arr.length} 条`);
        arr.forEach(({ entry }) => {
            const uid = entry.uid;
            const sel = (uid === wbSelectedUid) ? ' wizard-wb-selected' : '';
            const off = entry.disable ? ' wizard-wb-disabled' : '';
            const checked = wbMultiSelectedUids.has(uid) ? 'checked' : '';
            const title = entry.comment || '(无标题)';
            const keys = Array.isArray(entry.key) ? entry.key.join(', ') : (entry.key || '');
            const badges = [];
            if (entry.constant) badges.push('<span class="wizard-wb-badge wizard-wb-badge-const">常驻</span>');
            if (entry.disable) badges.push('<span class="wizard-wb-badge wizard-wb-badge-off">禁用</span>');
            const row = $(
                `<div class="wizard-wb-entry-row${sel}${off}" data-uid="${uid}">
                    <input type="checkbox" class="wizard-wb-entry-checkbox" data-uid="${uid}" ${checked} style="margin-top:3px;">
                    <div class="wizard-wb-entry-main">
                        <div class="wizard-wb-entry-title">${escapeHtml(title)}</div>
                        ${keys ? `<div class="wizard-wb-entry-keys">keys: ${escapeHtml(keys)}</div>` : ''}
                        <div class="wizard-wb-entry-badges">${badges.join('')}</div>
                    </div>
                </div>`
            );
            $list.append(row);
        });
        updateWbMultiCount();
        requestAnimationFrame(recheckWbOverflow);
    }

    function updateWbMultiCount() {
        const total = wbEntryArr(wbCache?.data).length;
        const n = wbMultiSelectedUids.size;
        $('#wizard-wb-entry-count').text(total ? `共 ${total} 条${n ? ' · 已选 ' + n : ''}` : '');
    }

    function setWbSingleTarget(entry) {
        if (!entry) {
            wbSelectedUid = null;
            $('#wizard-wb-single-target').text('未选择条目（点击上方列表条目）');
            return;
        }
        wbSelectedUid = entry.uid;
        $('#wizard-wb-single-target').html(`目标: <b>#${entry.uid} ${escapeHtml(entry.comment || '(无标题)')}</b>`);
    }

    function recheckWbOverflow() {
        const panel = document.getElementById('wizard-wb-panel');
        if (!panel || $('#wizard-wb-panel').css('display') === 'none') return;
        panel.classList.toggle('wizard-wb-overflowing', panel.scrollHeight > panel.clientHeight + 1);
    }

    function startWbOverflowObserver() {
        const panel = document.getElementById('wizard-wb-panel');
        if (!panel) return;
        stopWbOverflowObserver();
        requestAnimationFrame(recheckWbOverflow);
        if (typeof ResizeObserver === 'function') {
            wbOverflowObserver = new ResizeObserver(() => recheckWbOverflow());
            wbOverflowObserver.observe(panel);
        }
        window.addEventListener('resize', recheckWbOverflow);
    }

    function stopWbOverflowObserver() {
        if (wbOverflowObserver) {
            wbOverflowObserver.disconnect();
            wbOverflowObserver = null;
        }
        window.removeEventListener('resize', recheckWbOverflow);
        const panel = document.getElementById('wizard-wb-panel');
        if (panel) panel.classList.remove('wizard-wb-overflowing');
    }

    // ── 宏展开 ──
    function expandWbMacros(template, ctxObj) {
        let out = template || '';
        const replace = (name, val) => {
            const re = new RegExp(`\\{\\{\\s*${name}\\s*\\}\\}`, 'gi');
            if (re.test(out)) out = out.replace(re, val == null ? '' : val);
        };
        if (ctxObj.entry) {
            replace('entry_title', ctxObj.entry.comment || '');
            replace('entry_content', ctxObj.entry.content || '');
            const k = Array.isArray(ctxObj.entry.key) ? ctxObj.entry.key.join(', ') : (ctxObj.entry.key || '');
            replace('entry_keys', k);
            replace('entry_uid', ctxObj.entry.uid);
        }
        if (ctxObj.entriesFull !== undefined) replace('entries_full', ctxObj.entriesFull);
        if (ctxObj.entriesTitles !== undefined) replace('entries_titles', ctxObj.entriesTitles);
        if (ctxObj.wbFull !== undefined) replace('world_book_full', ctxObj.wbFull);
        if (ctxObj.wbTitles !== undefined) replace('world_book_titles', ctxObj.wbTitles);
        if (ctxObj.memoryTree !== undefined) replace('memory_tree', ctxObj.memoryTree);
        if (ctxObj.floors !== undefined) replace('floors', ctxObj.floors);
        return out;
    }

    // ── Token 统计（快估 + ST 真实分词器，带 seq 防过期）──
    // _wbTokenSeq 已上移到顶层作用域。
    async function refineWbTokens(payloadText, $el, fastTokens) {
        const ctx = wbCtx();
        const seq = ++_wbTokenSeq;
        try {
            if (ctx?.getTokenCountAsync) {
                const exact = await ctx.getTokenCountAsync(payloadText);
                if (seq === _wbTokenSeq) {
                    $el.text(`约 ${fastTokens.toLocaleString()} / 精确 ${exact.toLocaleString()} tokens`);
                }
            }
        } catch (_) { /* 保留快估值 */ }
    }

    function buildWbSinglePayload() {
        const data = wbCache?.data;
        const entry = (data && wbSelectedUid != null) ? (data.entries[String(wbSelectedUid)] || data.entries[wbSelectedUid]) : null;
        if (!entry) return null;
        const mode = wbLastSingleMode || 'reduce';
        const tmpl = $('#wizard-wb-single-prompt').val() || config[`wbPrompt${mode.charAt(0).toUpperCase() + mode.slice(1)}`] || '';
        const def = mode === 'reduce' ? DEFAULT_WB_PROMPT_REDUCE : mode === 'complete' ? DEFAULT_WB_PROMPT_COMPLETE : DEFAULT_WB_PROMPT_REWRITE;
        const template = tmpl || def;
        const treeText = serializeTreeForAi(memoryTree, 0);
        const floors = getWbFloorRangeText($('#wizard-wb-single-floor-start').val(), $('#wizard-wb-single-floor-end').val());
        const expanded = expandWbMacros(template, { entry, memoryTree: treeText, floors });
        // 未放置 entry_content/floors/memory_tree 的内容自动追加。
        const hasEntry = /\{\{\s*entry_content\s*\}\}/i.test(template);
        const hasFloors = /\{\{\s*floors\s*\}\}/i.test(template);
        const hasTree = /\{\{\s*memory_tree\s*\}\}/i.test(template);
        let user = expanded;
        if (!hasEntry) user += `\n\n[条目正文]\n${entry.content || ''}`;
        if (floors && !hasFloors) user += `\n\n[楼层范围]\n${floors}`;
        if (treeText && !hasTree) user += `\n\n[记忆树]\n${treeText}`;
        return { systemPrompt: WB_SINGLE_SYSTEM_PROMPT, userContent: user, entry };
    }

    function buildWbMultiPayload() {
        const data = wbCache?.data;
        if (!data) return null;
        const arr = wbEntryArr(data);
        const selected = arr.filter(({ entry }) => wbMultiSelectedUids.has(entry.uid)).map(x => x.entry);
        if (!selected.length) return null;
        const entriesFull = selected.map(e => serializeEntryForAi(e, 'full')).join('\n\n');
        const entriesTitles = selected.map(e => serializeEntryForAi(e, 'titles')).join('\n');
        const wbFull = arr.map(({ entry }) => serializeEntryForAi(entry, 'full')).join('\n\n');
        const wbTitles = arr.map(({ entry }) => serializeEntryForAi(entry, 'titles')).join('\n');
        const treeText = serializeTreeForAi(memoryTree, 0);
        const floors = getWbFloorRangeText($('#wizard-wb-multi-floor-start').val(), $('#wizard-wb-multi-floor-end').val());
        const template = $('#wizard-wb-multi-prompt').val() || config.wbPromptMulti || DEFAULT_WB_PROMPT_MULTI;
        const expanded = expandWbMacros(template, { entriesFull, entriesTitles, wbFull, wbTitles, memoryTree: treeText, floors });
        const hasFull = /\{\{\s*(world_book_full|entries_full)\s*\}\}/i.test(template);
        const hasFloors = /\{\{\s*floors\s*\}\}/i.test(template);
        const hasTree = /\{\{\s*memory_tree\s*\}\}/i.test(template);
        let user = expanded;
        if (!hasFull) user += `\n\n[当前世界书（含正文）]\n${wbFull}`;
        if (floors && !hasFloors) user += `\n\n[楼层范围]\n${floors}`;
        if (treeText && !hasTree) user += `\n\n[记忆树]\n${treeText}`;
        return { systemPrompt: WB_MULTI_SYSTEM_PROMPT, userContent: user, selected };
    }

    function updateWbSingleTokenStats() {
        const $el = $('#wizard-wb-single-token-count');
        const p = buildWbSinglePayload();
        if (!p) { $el.text(''); return; }
        const full = `${p.systemPrompt}\n${p.userContent}`;
        const fast = estimateTokens(full);
        $el.text(`约 ${fast.toLocaleString()} tokens`);
        refineWbTokens(full, $el, fast);
    }

    function updateWbMultiTokenStats() {
        const $el = $('#wizard-wb-multi-token-count');
        const p = buildWbMultiPayload();
        if (!p) { $el.text(''); return; }
        const full = `${p.systemPrompt}\n${p.userContent}`;
        const fast = estimateTokens(full);
        $el.text(`约 ${fast.toLocaleString()} tokens`);
        refineWbTokens(full, $el, fast);
    }

    // ── 操作归一化 / 校验 / 应用 ──
    function normalizeWbOp(raw) {
        if (!raw || typeof raw !== 'object') return null;
        const op = (raw.op || raw.action || '').toString().toLowerCase();
        if (!['update', 'add', 'delete', 'merge'].includes(op)) return null;
        const o = { op };
        if (op === 'update') {
            o.uid = raw.uid != null ? Number(raw.uid) : null;
            o.fields = {};
            if (raw.fields && typeof raw.fields === 'object') {
                for (const k of WB_OP_FIELDS) if (k in raw.fields) o.fields[k] = raw.fields[k];
            } else {
                for (const k of WB_OP_FIELDS) if (k in raw) o.fields[k] = raw[k];
            }
            if (o.uid == null || !Object.keys(o.fields).length) return null;
        } else if (op === 'add') {
            o.fields = {};
            const src = (raw.fields && typeof raw.fields === 'object') ? raw.fields : raw;
            for (const k of WB_OP_FIELDS) if (k in src) o.fields[k] = src[k];
            if (o.fields.comment === undefined || o.fields.content === undefined) return null;
        } else if (op === 'delete') {
            o.uid = raw.uid != null ? Number(raw.uid) : (raw.sourceUid != null ? Number(raw.sourceUid) : null);
            if (o.uid == null) return null;
        } else if (op === 'merge') {
            o.sourceUid = raw.sourceUid != null ? Number(raw.sourceUid) : null;
            o.targetUid = raw.targetUid != null ? Number(raw.targetUid) : null;
            o.mode = raw.mode || 'both';
            if (o.sourceUid == null || o.targetUid == null || o.sourceUid === o.targetUid) return null;
        }
        return o;
    }

    function validateWbOp(op, data, toggles) {
        const entries = data.entries || {};
        const hasUid = u => entries[String(u)] != null || entries[u] != null;
        if (op.op === 'update') {
            if (!toggles.allowChange) return { ok: false, reason: '未开启「允许修改已有条目」' };
            if (!hasUid(op.uid)) return { ok: false, reason: `update: uid ${op.uid} 不存在` };
        } else if (op.op === 'add') {
            if (!toggles.allowAdd) return { ok: false, reason: '未开启「允许新增条目」' };
        } else if (op.op === 'delete') {
            if (!toggles.allowDeleteMerge) return { ok: false, reason: '未开启「允许删除/合并」' };
            if (!hasUid(op.uid)) return { ok: false, reason: `delete: uid ${op.uid} 不存在` };
        } else if (op.op === 'merge') {
            if (!toggles.allowDeleteMerge) return { ok: false, reason: '未开启「允许删除/合并」' };
            if (!hasUid(op.sourceUid) || !hasUid(op.targetUid)) return { ok: false, reason: 'merge: uid 不存在' };
        }
        return { ok: true };
    }

    function findEntry(data, uid) {
        const e = data.entries;
        return e[String(uid)] != null ? e[String(uid)] : e[uid];
    }

    // 应用前快照（一键撤回）。
    function snapshotWb(name, data) {
        try { wbLastSnapshot = { name, data: JSON.parse(JSON.stringify(data)) }; } catch (_) { wbLastSnapshot = null; }
        $('#wizard-wb-undo-btn').css('display', wbLastSnapshot ? '' : 'none');
    }

    async function applyWbOps(ops) {
        const name = wbSelectedBook;
        if (!name) return 0;
        const data = await loadWbData(name);
        if (!data) return 0;
        snapshotWb(name, data);
        const entries = data.entries || (data.entries = {});
        let applied = 0;
        for (const op of ops) {
            if (op.op === 'update') {
                const e = findEntry(data, op.uid);
                if (!e) continue;
                for (const k of Object.keys(op.fields)) e[k] = op.fields[k];
                applied++;
            } else if (op.op === 'add') {
                const uid = nextWbUid(data);
                const base = { uid, key: [], keysecondary: [], comment: '', content: '', constant: false, vectorized: false, selective: true, selectiveLogic: 0, addMemo: false, order: 100, position: 0, disable: false, ignoreBudget: false, excludeRecursion: false, preventRecursion: false, delayUntilRecursion: 0, probability: 100, useProbability: true, depth: 4, group: '', groupOverride: false, groupWeight: 100, role: 0 };
                entries[String(uid)] = { ...base, ...op.fields, uid };
                applied++;
            } else if (op.op === 'delete') {
                if (findEntry(data, op.uid)) { delete entries[String(op.uid)]; delete entries[op.uid]; applied++; }
            } else if (op.op === 'merge') {
                const s = findEntry(data, op.sourceUid);
                const t = findEntry(data, op.targetUid);
                if (!s || !t) continue;
                if (op.mode !== 'keys') {
                    t.content = (t.content || '') + (s.content ? `\n\n${s.content}` : '');
                }
                if (op.mode !== 'content') {
                    t.key = Array.from(new Set([...(t.key || []), ...(s.key || [])]));
                    t.keysecondary = Array.from(new Set([...(t.keysecondary || []), ...(s.keysecondary || [])]));
                }
                delete entries[String(op.sourceUid)]; delete entries[op.sourceUid];
                applied++;
            }
        }
        if (applied > 0) {
            const ok = await saveWbData(name, data);
            if (!ok) return 0;
            await refreshWbEntryList();
        }
        return applied;
    }

    async function applyWbSingle(entry, newFields) {
        const name = wbSelectedBook;
        if (!name) return false;
        const data = await loadWbData(name);
        if (!data) return false;
        const e = findEntry(data, entry.uid);
        if (!e) { toastr.error('条目已不存在（可能被外部改动）。'); return false; }
        snapshotWb(name, data);
        for (const k of Object.keys(newFields)) {
            if (WB_OP_FIELDS.includes(k)) e[k] = newFields[k];
        }
        const ok = await saveWbData(name, data);
        if (!ok) return false;
        await refreshWbEntryList();
        return true;
    }

    async function undoWb() {
        if (!wbLastSnapshot) return;
        const ok = await saveWbData(wbLastSnapshot.name, wbLastSnapshot.data);
        if (ok) {
            toastr.success('已撤回上一次世界书应用。');
            wbLastSnapshot = null;
            $('#wizard-wb-undo-btn').css('display', 'none');
            await refreshWbEntryList();
        }
    }

    // ── 多条待确认操作行 ──
    function insertWbOpRow(op, idx) {
        const $list = $('#wizard-wb-entry-list');
        const key = `op_${idx}_${op.op}_${op.uid != null ? op.uid : (op.sourceUid + '_' + op.targetUid)}`;
        let desc = '';
        let oldText = '', newText = '';
        const data = wbCache?.data;
        if (op.op === 'update') {
            const e = findEntry(data || { entries: {} }, op.uid);
            desc = `修改 #${op.uid} ${e ? (e.comment || '(无标题)') : ''}`;
            oldText = e ? (e.content || '') : '';
            newText = op.fields.content != null ? op.fields.content : oldText;
            if (op.fields.comment && (!e || op.fields.comment !== e.comment)) desc += ` · 改标题为「${op.fields.comment}」`;
        } else if (op.op === 'add') {
            desc = `新增条目「${op.fields.comment}」`;
            newText = op.fields.content || '';
        } else if (op.op === 'delete') {
            const e = findEntry(data || { entries: {} }, op.uid);
            desc = `删除 #${op.uid} ${e ? (e.comment || '') : ''}`;
            oldText = e ? (e.content || '') : '';
        } else if (op.op === 'merge') {
            const s = findEntry(data || { entries: {} }, op.sourceUid);
            const t = findEntry(data || { entries: {} }, op.targetUid);
            desc = `合并 #${op.sourceUid} → #${op.targetUid}`;
            oldText = (s ? s.content || '' : '') + '\n──── 并入 ────\n' + (t ? t.content || '' : '');
            newText = (t ? t.content || '' : '') + (s && s.content ? `\n\n${s.content}` : '');
        }
        const $row = $(
            `<div class="wizard-wb-op-row" data-key="${escapeHtml(key)}">
                <div class="wizard-wb-op-head"><i class="fa-solid fa-wand-magic-sparkles"></i> ${escapeHtml(desc)}
                    <button class="wizard-btn wizard-wb-op-accept" data-key="${escapeHtml(key)}" style="margin-left:auto;padding:2px 8px;font-size:0.72em;background:rgba(52,211,153,0.15);border:1px solid rgba(52,211,153,0.5);color:#34d399;">应用</button>
                    <button class="wizard-btn wizard-wb-op-reject" data-key="${escapeHtml(key)}" style="padding:2px 8px;font-size:0.72em;background:rgba(248,113,113,0.12);border:1px solid rgba(248,113,113,0.4);color:#f87171;">丢弃</button>
                </div>
                <div class="wizard-wb-op-diff">
                    <div class="wizard-wb-op-col"><b>原</b>\n${escapeHtml(oldText)}</div>
                    <div class="wizard-wb-op-col"><b>新</b>\n${escapeHtml(newText)}</div>
                </div>
            </div>`
        );
        $list.append($row);
        wbPendingOps.set(key, op);
        updateWbOpsBulkBar();
    }

    function updateWbOpsBulkBar() {
        const n = wbPendingOps.size;
        const $bar = $('#wizard-wb-ops-bulk-bar');
        if (n > 0) { $bar.css('display', 'inline-flex'); $('#wizard-wb-ops-pending-count').text(`${n} 条建议`); }
        else { $bar.css('display', 'none'); }
        requestAnimationFrame(recheckWbOverflow);
    }

    // ── 解析 AI 输出 ──
    function processWbSingleOutput(rawText, entry) {
        let raw = (rawText || '').trim();
        raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
        let newFields = null;
        // 优先尝试 JSON 对象解析。
        if (raw.startsWith('{')) {
            try {
                const obj = JSON.parse(raw);
                if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
                    newFields = {};
                    for (const k of WB_OP_FIELDS) if (k in obj) newFields[k] = obj[k];
                    if (!Object.keys(newFields).length) newFields = null;
                }
            } catch (_) { newFields = null; }
        }
        // 退化为纯正文 → content。
        if (!newFields) newFields = { content: raw };
        return newFields;
    }

    function processWbMultiOutput(rawText, data, toggles) {
        let raw = (rawText || '').trim();
        raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
        let arr;
        try { arr = JSON.parse(raw); } catch (e) {
            toastr.error('AI 返回的不是合法 JSON 数组，未应用。');
            $('#wizard-wb-multi-status').text('解析失败：AI 未返回合法 JSON。');
            $('#wizard-wb-stream-status').text('格式错误，未应用').css('color', '#ef4444');
            return [];
        }
        if (!Array.isArray(arr)) { toastr.error('AI 返回的不是 JSON 数组。'); return []; }
        const valid = [];
        arr.forEach(item => {
            const op = normalizeWbOp(item);
            if (!op) { writeLog(`WB op ignored: unparseable: ${JSON.stringify(item).slice(0,120)}`, 'WARNING'); return; }
            const v = validateWbOp(op, data, toggles);
            if (!v.ok) { writeLog(`WB op dropped: ${op.op}: ${v.reason}`, 'WARNING'); toastr.warning(`已丢弃一条操作：${v.reason}`); return; }
            valid.push(op);
        });
        return valid;
    }

    // ── 流式 UI helpers ──
    function wbStreamResetUI() {
        $('#wizard-wb-stream-body').val('');
        $('#wizard-wb-stream-reasoning').val('');
        $('#wizard-wb-stream-reasoning-wrap').hide().prop('open', false);
        $('#wizard-wb-stream-stats').text('0 字符 · 0 tokens');
        $('#wizard-wb-stream-status').text('连接中...').css('color', '#9ca3af');
        $('#wizard-wb-stream-abort-btn').show().prop('disabled', false);
    }

    function wbStreamOnChunk(fullText, reasoningText) {
        const bodyEl = document.getElementById('wizard-wb-stream-body');
        if (!bodyEl) return;
        const wasAtBottom = (bodyEl.scrollTop + bodyEl.clientHeight >= bodyEl.scrollHeight - 50);
        const { body: cleanBody, thinking: inlineThinking } = splitInlineThinking(fullText);
        bodyEl.value = cleanBody;
        const thinking = (reasoningText || '').trim() || inlineThinking;
        if (thinking) {
            $('#wizard-wb-stream-reasoning').val(thinking);
            $('#wizard-wb-stream-reasoning-wrap').show().prop('open', true);
        }
        $('#wizard-wb-stream-stats').text(`${cleanBody.length} 字符 · ${estimateTokens(cleanBody).toLocaleString()} tokens`);
        if ($('#wizard-wb-stream-status').text().startsWith('连接中')) {
            $('#wizard-wb-stream-status').text('生成中...').css('color', '#60a5fa');
        }
        if (wasAtBottom) bodyEl.scrollTop = bodyEl.scrollHeight;
    }

    function wbSendBtnState($btn, sending) {
        if (sending) {
            $btn.html('<i class="fa-solid fa-stop"></i> 停止').css({ background: 'rgba(248,113,113,0.15)', 'border-color': 'rgba(248,113,113,0.5)', color: '#f87171' });
        } else {
            $btn.html('<i class="fa-solid fa-paper-plane"></i> 发送').css({ background: 'rgba(var(--wizard-primary-rgb),0.18)', 'border-color': 'rgba(var(--wizard-primary-rgb),0.5)', color: 'var(--wizard-primary)' });
        }
    }

    // ── 单条 AI 发送 ──
    async function runWbSingle() {
        if (wbAbortController) { wbAbortController.abort(); return; }
        const p = buildWbSinglePayload();
        if (!p) { toastr.warning('请先选择一个条目。'); return; }
        const profile = $('#wizard-wb-profile').val() || "";
        wbStreamMode = 'single';
        $('#wizard-wb-stream-title').text('世界书 · 单条 AI 输出');
        wbSendBtnState($('#wizard-wb-single-send-btn'), true);
        $('#wizard-wb-single-status').text('正在发送给 AI…');
        wbStreamResetUI();
        $('#wizard-wb-stream-overlay').css('display', 'flex');
        wbAbortController = new AbortController();
        try {
            const result = await runIsolatedFusionCall(
                profile,
                [{ role: 'user', content: p.userContent }],
                p.systemPrompt,
                0.3,
                120000,
                wbAbortController.signal,
                wbStreamOnChunk
            );
            const { body: cleanedRaw, thinking: finishThinking } = splitInlineThinking((result || "").trim());
            let raw = cleanedRaw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
            $('#wizard-wb-stream-body').val(raw);
            const thinking = ($('#wizard-wb-stream-reasoning').val() || '').trim() || finishThinking;
            if (thinking) { $('#wizard-wb-stream-reasoning').val(thinking); $('#wizard-wb-stream-reasoning-wrap').show().prop('open', true); }
            $('#wizard-wb-stream-stats').text(`${raw.length} 字符 · ${estimateTokens(raw).toLocaleString()} tokens`);
            $('#wizard-wb-stream-status').text('生成完成').css('color', '#34d399');
            $('#wizard-wb-stream-abort-btn').hide();
            $('#wizard-wb-single-status').text('AI 已输出，请在窗口内确认后「应用」。');
            // 自动保存 prompt/profile。
            const mode = wbLastSingleMode;
            config[`wbPrompt${mode.charAt(0).toUpperCase() + mode.slice(1)}`] = $('#wizard-wb-single-prompt').val() || "";
            config.wbProfile = profile;
            saveConfig(true);
        } catch (e) {
            if (e?.name === 'AbortError' || wbAbortController?.signal?.aborted) {
                toastr.info('世界书单条修改已停止。');
                $('#wizard-wb-single-status').text('已停止。');
                $('#wizard-wb-stream-status').text('已中止').css('color', '#f59e0b');
            } else {
                toastr.error(`AI 请求失败: ${e.message}`);
                $('#wizard-wb-single-status').text(`错误: ${e.message}`);
                $('#wizard-wb-stream-status').text(`错误: ${e.message}`).css('color', '#ef4444');
            }
        } finally {
            wbAbortController = null;
            wbSendBtnState($('#wizard-wb-single-send-btn'), false);
        }
    }

    // ── 多条 AI 发送 ──
    async function runWbMulti() {
        if (wbAbortController) { wbAbortController.abort(); return; }
        const data = wbCache?.data;
        if (!data) { toastr.warning('请先选择世界书。'); return; }
        const p = buildWbMultiPayload();
        if (!p) { toastr.warning('请先勾选至少一个条目。'); return; }
        const toggles = {
            allowChange: $('#wizard-wb-allow-change').attr('data-active') === 'true',
            allowAdd: $('#wizard-wb-allow-add').attr('data-active') === 'true',
            allowDeleteMerge: $('#wizard-wb-allow-delete-merge').attr('data-active') === 'true',
        };
        if (!toggles.allowChange && !toggles.allowAdd && !toggles.allowDeleteMerge) {
            toastr.warning('请至少开启一个操作开关（修改/新增/删除合并）。');
            return;
        }
        const profile = $('#wizard-wb-multi-profile').val() || "";
        wbStreamMode = 'multi';
        $('#wizard-wb-stream-title').text('世界书 · 多条 AI 输出');
        wbSendBtnState($('#wizard-wb-multi-send-btn'), true);
        $('#wizard-wb-multi-status').text('正在发送给 AI…');
        wbStreamResetUI();
        $('#wizard-wb-stream-overlay').css('display', 'flex');
        wbAbortController = new AbortController();
        try {
            const result = await runIsolatedFusionCall(
                profile,
                [{ role: 'user', content: p.userContent }],
                p.systemPrompt,
                0.3,
                180000,
                wbAbortController.signal,
                wbStreamOnChunk
            );
            const { body: cleanedRaw, thinking: finishThinking } = splitInlineThinking((result || "").trim());
            let raw = cleanedRaw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
            $('#wizard-wb-stream-body').val(raw);
            $('#wizard-wb-stream-stats').text(`${raw.length} 字符 · ${estimateTokens(raw).toLocaleString()} tokens`);
            $('#wizard-wb-stream-status').text('生成完成').css('color', '#34d399');
            $('#wizard-wb-stream-abort-btn').hide();
            const ops = processWbMultiOutput(raw, data, toggles);
            if (!ops.length) {
                $('#wizard-wb-multi-status').text('AI 未提出可用操作（或被开关全部丢弃）。');
                return;
            }
            // 暂存待确认操作并渲染行。
            $('.wizard-wb-op-row').remove();
            wbPendingOps.clear();
            ops.forEach((op, i) => insertWbOpRow(op, i));
            $('#wizard-wb-multi-status').text(`已收到 ${ops.length} 条建议，请在条目列表下方逐条确认或「全部应用」。`);
            config.wbMultiProfile = profile;
            config.wbMultiPrompt = $('#wizard-wb-multi-prompt').val() || "";
            config.wbAllowChangeExisting = toggles.allowChange;
            config.wbAllowAddNew = toggles.allowAdd;
            config.wbAllowDeleteMerge = toggles.allowDeleteMerge;
            saveConfig(true);
        } catch (e) {
            if (e?.name === 'AbortError' || wbAbortController?.signal?.aborted) {
                toastr.info('世界书多条修改已停止。');
                $('#wizard-wb-multi-status').text('已停止。');
                $('#wizard-wb-stream-status').text('已中止').css('color', '#f59e0b');
            } else {
                toastr.error(`AI 请求失败: ${e.message}`);
                $('#wizard-wb-multi-status').text(`错误: ${e.message}`);
                $('#wizard-wb-stream-status').text(`错误: ${e.message}`).css('color', '#ef4444');
            }
        } finally {
            wbAbortController = null;
            wbSendBtnState($('#wizard-wb-multi-send-btn'), false);
        }
    }

    // ── 刷新条目列表（保存后调用）──
    async function refreshWbEntryList() {
        if (!wbSelectedBook) return;
        const data = await loadWbData(wbSelectedBook); // 缓存已失效会重新读取
        if (data) renderWbEntryList(data);
    }

    // ── 切换面板显隐 ──
    function setWbPanelVisible(visible) {
        const $panel = $('#wizard-wb-panel');
        const $editor = $('#wizard-node-form-panel');
        const $btn = $('#wizard-tree-worldbook-btn');
        if (visible) {
            $editor.css('display', 'none');
            $panel.css('display', 'flex');
            $btn.addClass('wizard-btn-warning');
            focusWbPanelIfMobile();
            startWbOverflowObserver();
            // 默认末尾楼层 = 当前楼层号。
            const cur = getCurrentFloorNumber();
            if (cur >= 0) {
                if (!$('#wizard-wb-single-floor-end').val()) $('#wizard-wb-single-floor-end').val(cur);
                if (!$('#wizard-wb-multi-floor-end').val()) $('#wizard-wb-multi-floor-end').val(cur);
            }
            (async () => {
                await renderWbBookSelector();
                if (wbSelectedBook) {
                    const data = await loadWbData(wbSelectedBook);
                    renderWbEntryList(data);
                }
                updateWbSingleTokenStats();
                updateWbMultiTokenStats();
                requestAnimationFrame(recheckWbOverflow);
            })();
        } else {
            $panel.css('display', 'none');
            $editor.css('display', '');
            $btn.removeClass('wizard-btn-warning');
            stopWbOverflowObserver();
        }
    }

    // ── 事件绑定 ──
    $(document).off('click', '#wizard-tree-worldbook-btn').on('click', '#wizard-tree-worldbook-btn', function () {
        const visible = $('#wizard-wb-panel').css('display') !== 'none';
        setWbPanelVisible(!visible);
    });

    $(document).off('click', '#wizard-wb-refresh-btn').on('click', '#wizard-wb-refresh-btn', async function () {
        wbCache = null;
        await renderWbBookSelector();
        if (wbSelectedBook) { const d = await loadWbData(wbSelectedBook); renderWbEntryList(d); }
        toastr.info('世界书列表已刷新。');
    });

    $(document).off('click', '#wizard-wb-open-editor-btn').on('click', '#wizard-wb-open-editor-btn', function () {
        const ctx = wbCtx();
        if (!ctx || !wbSelectedBook) return;
        try {
            if (typeof ctx.openWorldInfoEditor === 'function') ctx.openWorldInfoEditor(wbSelectedBook);
            else if (typeof ctx.showWorldEditor === 'function') ctx.showWorldEditor(wbSelectedBook);
            else if (typeof ctx.reloadWorldInfoEditor === 'function') ctx.reloadWorldInfoEditor(wbSelectedBook, true);
            else toastr.warning('当前 SillyTavern 未暴露世界书编辑器接口。');
        } catch (e) { toastr.error(`打开编辑器失败: ${e.message}`); }
    });

    $(document).off('change', '#wizard-wb-select').on('change', '#wizard-wb-select', async function () {
        wbSelectedBook = $(this).val() || "";
        wbSelectedUid = null;
        wbMultiSelectedUids.clear();
        wbCache = null;
        if (wbSelectedBook) {
            const data = await loadWbData(wbSelectedBook);
            renderWbEntryList(data);
            setWbSingleTarget(null);
        } else {
            renderWbEntryList(null);
        }
        config.wbSelectedBook = wbSelectedBook;
        saveConfig(true);
        updateWbSingleTokenStats();
        updateWbMultiTokenStats();
    });

    $(document).off('change', '#wizard-wb-follow-char').on('change', '#wizard-wb-follow-char', async function () {
        config.wbFollowCharBook = $(this).prop('checked');
        saveConfig(true);
        await renderWbBookSelector();
        if (wbSelectedBook) { const d = await loadWbData(wbSelectedBook); renderWbEntryList(d); }
    });

    // 条目点击：单条模式选中目标；checkbox：多条勾选。
    $(document).off('click', '.wizard-wb-entry-row').on('click', '.wizard-wb-entry-row', async function (e) {
        if ($(e.target).is('.wizard-wb-entry-checkbox')) return; // 复选框单独处理
        const uid = Number($(this).data('uid'));
        const data = wbCache?.data;
        if (!data) return;
        const entry = findEntry(data, uid);
        if (!entry) return;
        setWbSingleTarget(entry);
        $('.wizard-wb-entry-row').removeClass('wizard-wb-selected');
        $(this).addClass('wizard-wb-selected');
        updateWbSingleTokenStats();
    });

    $(document).off('change', '.wizard-wb-entry-checkbox').on('change', '.wizard-wb-entry-checkbox', function () {
        const uid = Number($(this).data('uid'));
        if (this.checked) wbMultiSelectedUids.add(uid); else wbMultiSelectedUids.delete(uid);
        updateWbMultiCount();
        updateWbMultiTokenStats();
    });

    $(document).off('click', '#wizard-wb-select-all').on('click', '#wizard-wb-select-all', function () {
        const arr = wbEntryArr(wbCache?.data);
        arr.forEach(({ entry }) => wbMultiSelectedUids.add(entry.uid));
        $('.wizard-wb-entry-checkbox').prop('checked', true);
        updateWbMultiCount();
        updateWbMultiTokenStats();
    });

    $(document).off('click', '#wizard-wb-select-none').on('click', '#wizard-wb-select-none', function () {
        wbMultiSelectedUids.clear();
        $('.wizard-wb-entry-checkbox').prop('checked', false);
        updateWbMultiCount();
        updateWbMultiTokenStats();
    });

    // 模式 tab。
    $(document).off('click', '.wizard-wb-mode-tab').on('click', '.wizard-wb-mode-tab', function () {
        const which = $(this).attr('id') === 'wizard-wb-tab-single' ? 'single' : 'multi';
        $('.wizard-wb-mode-tab').attr('data-active', 'false');
        $(this).attr('data-active', 'true');
        if (which === 'single') {
            $('#wizard-wb-single-panel').css('display', 'flex');
            $('#wizard-wb-multi-panel').css('display', 'none');
            updateWbSingleTokenStats();
        } else {
            $('#wizard-wb-single-panel').css('display', 'none');
            $('#wizard-wb-multi-panel').css('display', 'flex');
            updateWbMultiTokenStats();
        }
        requestAnimationFrame(recheckWbOverflow);
    });

    // 单条预设：切换前先把当前文本框内容存回当前预设，避免编辑丢失。
    $(document).off('click', '.wizard-wb-preset').on('click', '.wizard-wb-preset', function () {
        const newMode = $(this).data('mode');
        const oldMode = wbLastSingleMode || 'reduce';
        if (oldMode !== newMode) {
            const oldDef = oldMode === 'reduce' ? DEFAULT_WB_PROMPT_REDUCE : oldMode === 'complete' ? DEFAULT_WB_PROMPT_COMPLETE : DEFAULT_WB_PROMPT_REWRITE;
            const normOld = (v, def) => { const s = (v || '').trim(); return (!s || s === def.trim()) ? "" : s; };
            config[`wbPrompt${oldMode.charAt(0).toUpperCase() + oldMode.slice(1)}`] = normOld($('#wizard-wb-single-prompt').val(), oldDef);
        }
        wbLastSingleMode = newMode;
        $('.wizard-wb-preset').removeClass('wizard-wb-preset-active');
        $(this).addClass('wizard-wb-preset-active');
        const def = newMode === 'reduce' ? DEFAULT_WB_PROMPT_REDUCE : newMode === 'complete' ? DEFAULT_WB_PROMPT_COMPLETE : DEFAULT_WB_PROMPT_REWRITE;
        const saved = config[`wbPrompt${newMode.charAt(0).toUpperCase() + newMode.slice(1)}`] || "";
        $('#wizard-wb-single-prompt').val(saved || def);
        config.wbLastSingleMode = newMode;
        saveConfig(true);
        updateWbSingleTokenStats();
    });

    // 宏标签点击 → 插入到聚焦输入框。
    $(document).off('click', '.wizard-wb-chip').on('click', '.wizard-wb-chip', function () {
        const token = $(this).data('token');
        const $focused = $(document.activeElement);
        if (!$focused.is('textarea')) {
            // 默认插入到单条 prompt（或多条，视当前可见面板）。
            const $tgt = $('#wizard-wb-multi-panel').css('display') !== 'none' ? $('#wizard-wb-multi-prompt') : $('#wizard-wb-single-prompt');
            insertWbTokenAtCursor($tgt, token);
        } else {
            insertWbTokenAtCursor($focused, token);
        }
    });

    function insertWbTokenAtCursor($ta, token) {
        const el = $ta[0];
        if (!el) return;
        const start = el.selectionStart ?? el.value.length;
        const end = el.selectionEnd ?? el.value.length;
        el.value = el.value.slice(0, start) + token + el.value.slice(end);
        el.selectionStart = el.selectionEnd = start + token.length;
        $ta.trigger('input');
    }

    // 输入变化 → 更新 token / 保存 prompt。
    $(document).off('input', '#wizard-wb-single-prompt').on('input', '#wizard-wb-single-prompt', () => updateWbSingleTokenStats());
    $(document).off('input', '#wizard-wb-multi-prompt').on('input', '#wizard-wb-multi-prompt', () => updateWbMultiTokenStats());
    $(document).off('input change', '.wizard-wb-floor').on('input change', '.wizard-wb-floor', function () {
        updateWbSingleTokenStats();
        updateWbMultiTokenStats();
    });
    $(document).off('change', '#wizard-wb-profile').on('change', '#wizard-wb-profile', function () { config.wbProfile = $(this).val() || ""; saveConfig(true); });
    $(document).off('change', '#wizard-wb-multi-profile').on('change', '#wizard-wb-multi-profile', function () { config.wbMultiProfile = $(this).val() || ""; saveConfig(true); });

    // 开关（修改/新增/删除合并）。
    $(document).off('click', '.wizard-wb-toggle').on('click', '.wizard-wb-toggle', function () {
        const cur = $(this).attr('data-active') === 'true';
        $(this).attr('data-active', String(!cur));
        const id = $(this).attr('id');
        if (id === 'wizard-wb-allow-change') config.wbAllowChangeExisting = !cur;
        else if (id === 'wizard-wb-allow-add') config.wbAllowAddNew = !cur;
        else if (id === 'wizard-wb-allow-delete-merge') config.wbAllowDeleteMerge = !cur;
        saveConfig(true);
    });

    // 发送按钮。
    $(document).off('click', '#wizard-wb-single-send-btn').on('click', '#wizard-wb-single-send-btn', runWbSingle);
    $(document).off('click', '#wizard-wb-multi-send-btn').on('click', '#wizard-wb-multi-send-btn', runWbMulti);
    $(document).off('click', '#wizard-wb-single-stream-view-btn').on('click', '#wizard-wb-single-stream-view-btn', function () {
        wbStreamMode = 'single'; $('#wizard-wb-stream-title').text('世界书 · 单条 AI 输出');
        $('#wizard-wb-stream-overlay').css('display', 'flex');
    });
    $(document).off('click', '#wizard-wb-multi-stream-view-btn').on('click', '#wizard-wb-multi-stream-view-btn', function () {
        wbStreamMode = 'multi'; $('#wizard-wb-stream-title').text('世界书 · 多条 AI 输出');
        $('#wizard-wb-stream-overlay').css('display', 'flex');
    });

    // 流式窗口按钮。
    $(document).off('click', '#wizard-wb-stream-close-btn').on('click', '#wizard-wb-stream-close-btn', function () { $('#wizard-wb-stream-overlay').css('display', 'none'); });
    $(document).off('click', '#wizard-wb-stream-abort-btn').on('click', '#wizard-wb-stream-abort-btn', function () { if (wbAbortController) wbAbortController.abort(); });
    $(document).off('click', '#wizard-wb-stream-clear-btn').on('click', '#wizard-wb-stream-clear-btn', function () {
        $('#wizard-wb-stream-body').val(''); $('#wizard-wb-stream-reasoning').val('');
        $('#wizard-wb-stream-reasoning-wrap').hide().prop('open', false);
        $('#wizard-wb-stream-stats').text('0 字符 · 0 tokens'); $('#wizard-wb-stream-status').text('已清空').css('color', '#9ca3af');
    });
    $(document).off('click', '#wizard-wb-stream-copy-btn').on('click', '#wizard-wb-stream-copy-btn', async function () {
        try { await navigator.clipboard.writeText($('#wizard-wb-stream-body').val() || ''); toastr.success('已复制。'); } catch (_) { toastr.error('复制失败。'); }
    });
    $(document).off('click', '#wizard-wb-stream-apply-btn').on('click', '#wizard-wb-stream-apply-btn', async function () {
        const text = $('#wizard-wb-stream-body').val() || '';
        if (!text.trim()) { toastr.warning('实时输出为空，无法应用。'); return; }
        if (wbStreamMode === 'single') {
            const data = wbCache?.data;
            const entry = (data && wbSelectedUid != null) ? findEntry(data, wbSelectedUid) : null;
            if (!entry) { toastr.warning('未选择目标条目。'); return; }
            const newFields = processWbSingleOutput(text, entry);
            const ok = await applyWbSingle(entry, newFields);
            if (ok) {
                toastr.success(`已应用：#${entry.uid} ${entry.comment || ''}`);
                $('#wizard-wb-single-status').text('已应用。');
                $('#wizard-wb-stream-overlay').css('display', 'none');
            }
        } else {
            // multi: 重新解析并直接应用（流式窗口「应用」= 全部应用）。
            const toggles = {
                allowChange: $('#wizard-wb-allow-change').attr('data-active') === 'true',
                allowAdd: $('#wizard-wb-allow-add').attr('data-active') === 'true',
                allowDeleteMerge: $('#wizard-wb-allow-delete-merge').attr('data-active') === 'true',
            };
            const ops = processWbMultiOutput(text, wbCache?.data || { entries: {} }, toggles);
            if (!ops.length) { toastr.warning('没有可应用的操作。'); return; }
            const n = await applyWbOps(ops);
            if (n > 0) {
                toastr.success(`已应用 ${n} 条操作。`);
                $('#wizard-wb-multi-status').text(`已应用 ${n} 条操作。`);
                $('.wizard-wb-op-row').remove(); wbPendingOps.clear(); updateWbOpsBulkBar();
                $('#wizard-wb-stream-overlay').css('display', 'none');
            }
        }
    });

    // 多条待确认行：逐条应用/丢弃。
    $(document).off('click', '.wizard-wb-op-accept').on('click', '.wizard-wb-op-accept', async function () {
        const key = $(this).data('key');
        const op = wbPendingOps.get(key);
        if (!op) return;
        const n = await applyWbOps([op]);
        if (n > 0) { toastr.success('已应用该操作。'); }
        wbPendingOps.delete(key);
        $(`.wizard-wb-op-row[data-key="${escapeHtml(key)}"]`).remove();
        updateWbOpsBulkBar();
    });
    $(document).off('click', '.wizard-wb-op-reject').on('click', '.wizard-wb-op-reject', function () {
        const key = $(this).data('key');
        wbPendingOps.delete(key);
        $(`.wizard-wb-op-row[data-key="${escapeHtml(key)}"]`).remove();
        updateWbOpsBulkBar();
    });
    $(document).off('click', '#wizard-wb-ops-accept-all-btn').on('click', '#wizard-wb-ops-accept-all-btn', async function () {
        if (!wbPendingOps.size) return;
        const ops = Array.from(wbPendingOps.values());
        const n = await applyWbOps(ops);
        if (n > 0) toastr.success(`已应用 ${n} 条操作。`);
        wbPendingOps.clear(); $('.wizard-wb-op-row').remove(); updateWbOpsBulkBar();
        $('#wizard-wb-multi-status').text(`已应用 ${n} 条操作。`);
    });
    $(document).off('click', '#wizard-wb-ops-reject-all-btn').on('click', '#wizard-wb-ops-reject-all-btn', function () {
        wbPendingOps.clear(); $('.wizard-wb-op-row').remove(); updateWbOpsBulkBar();
        toastr.info('已丢弃全部建议。');
    });

    // 撤回。
    $(document).off('click', '#wizard-wb-undo-btn').on('click', '#wizard-wb-undo-btn', undoWb);

    // 自定义 Prompt 编辑器。
    $(document).off('click', '#wizard-wb-prompt-edit-btn').on('click', '#wizard-wb-prompt-edit-btn', function () {
        $('#wizard-wb-prompt-reduce').val(config.wbPromptReduce || DEFAULT_WB_PROMPT_REDUCE);
        $('#wizard-wb-prompt-complete').val(config.wbPromptComplete || DEFAULT_WB_PROMPT_COMPLETE);
        $('#wizard-wb-prompt-rewrite').val(config.wbPromptRewrite || DEFAULT_WB_PROMPT_REWRITE);
        $('#wizard-wb-prompt-multi').val(config.wbPromptMulti || DEFAULT_WB_PROMPT_MULTI);
        $('#wizard-wb-prompt-editor-overlay').css('display', 'flex');
    });
    $(document).off('click', '#wizard-wb-prompt-editor-close').on('click', '#wizard-wb-prompt-editor-close', function () { $('#wizard-wb-prompt-editor-overlay').css('display', 'none'); });
    $(document).off('click', '#wizard-wb-prompt-editor-cancel').on('click', '#wizard-wb-prompt-editor-cancel', function () { $('#wizard-wb-prompt-editor-overlay').css('display', 'none'); });
    $(document).off('click', '#wizard-wb-prompt-editor-save').on('click', '#wizard-wb-prompt-editor-save', function () {
        const norm = (v, def) => { const s = (v || '').trim(); return (!s || s === def.trim()) ? "" : s; };
        config.wbPromptReduce = norm($('#wizard-wb-prompt-reduce').val(), DEFAULT_WB_PROMPT_REDUCE);
        config.wbPromptComplete = norm($('#wizard-wb-prompt-complete').val(), DEFAULT_WB_PROMPT_COMPLETE);
        config.wbPromptRewrite = norm($('#wizard-wb-prompt-rewrite').val(), DEFAULT_WB_PROMPT_REWRITE);
        config.wbPromptMulti = norm($('#wizard-wb-prompt-multi').val(), DEFAULT_WB_PROMPT_MULTI);
        saveConfig(true);
        // 若当前单条面板正在显示某预设，刷新其文本框。
        const m = wbLastSingleMode;
        const saved = config[`wbPrompt${m.charAt(0).toUpperCase() + m.slice(1)}`] || "";
        const def = m === 'reduce' ? DEFAULT_WB_PROMPT_REDUCE : m === 'complete' ? DEFAULT_WB_PROMPT_COMPLETE : DEFAULT_WB_PROMPT_REWRITE;
        $('#wizard-wb-single-prompt').val(saved || def);
        $('#wizard-wb-multi-prompt').val(config.wbPromptMulti || DEFAULT_WB_PROMPT_MULTI);
        $('#wizard-wb-prompt-editor-overlay').css('display', 'none');
        toastr.success('世界书 Prompts 已保存。');
        updateWbSingleTokenStats();
        updateWbMultiTokenStats();
    });

    // ── WORLDINFO_UPDATED / CHAT_CHANGED 钩子 ──
    // registerWbEventHooks 定义在 registerNodeFormListeners 作用域内，故在此处（同一作用域）调用一次即可。
    function registerWbEventHooks() {
        try {
            const ctx = window.SillyTavern.getContext();
            const es = ctx?.eventSource;
            const et = ctx?.eventTypes;
            if (!es || !et) return;
            if (et.WORLDINFO_UPDATED) {
                es.on(et.WORLDINFO_UPDATED, () => {
                    wbCache = null;
                    if (wbSelectedBook) { (async () => { const d = await loadWbData(wbSelectedBook); renderWbEntryList(d); })(); }
                });
            }
            if (et.CHAT_CHANGED) {
                es.on(et.CHAT_CHANGED, () => {
                    // 面板可见时：切换角色后重新检测绑定书、刷新选择器与条目，并把末尾楼层默认到当前楼层号。
                    if ($('#wizard-wb-panel').css('display') === 'none') return;
                    (async () => {
                        try {
                            await renderWbBookSelector();
                            if (wbSelectedBook) { const d = await loadWbData(wbSelectedBook); renderWbEntryList(d); }
                            const cur = getCurrentFloorNumber();
                            if (cur >= 0) {
                                $('#wizard-wb-single-floor-end').val(cur);
                                $('#wizard-wb-multi-floor-end').val(cur);
                            }
                        } catch (e) { writeLog(`WB chat-change refresh failed: ${e.message}`, 'ERROR'); }
                    })();
                });
            }
        } catch (e) { writeLog(`WB event hooks failed: ${e.message}`, 'ERROR'); }
    }
    registerWbEventHooks();

    // ─── End World Book ────────────────────────────────────────────────────

    // Move summary item up
    $(document).off('click', '.wizard-move-up-summary-btn').on('click', '.wizard-move-up-summary-btn', async function () {
        const type = $(this).data('type');
        const index = parseInt($(this).data('index'));

        let targetArray;
        if (type === 'historical') {
            targetArray = summaries.historicalSummaries;
        } else if (type === 'weekly') {
            targetArray = summaries.weeklySummaries;
        } else if (type === 'recap') {
            targetArray = summaries.recaps;
        }
        if (!targetArray || targetArray[index] === undefined) return;

        // 显示顺序是「同状态分组内、最新（高数组下标）在最上」。所以视觉「上移」= 与最近的
        // 同状态、更高数组下标的条目交换。跳过异状态条目，确保不会把 active 拖进归档堆或反之。
        const archived = sumIsArchived(targetArray[index]);
        for (let j = index + 1; j < targetArray.length; j++) {
            if (sumIsArchived(targetArray[j]) === archived) {
                const temp = targetArray[index];
                targetArray[index] = targetArray[j];
                targetArray[j] = temp;
                await saveSummariesToServer();
                toastr.success('位置调整成功');
                return;
            }
        }
    });

    // Move summary item down
    $(document).off('click', '.wizard-move-down-summary-btn').on('click', '.wizard-move-down-summary-btn', async function () {
        const type = $(this).data('type');
        const index = parseInt($(this).data('index'));

        let targetArray;
        if (type === 'historical') {
            targetArray = summaries.historicalSummaries;
        } else if (type === 'weekly') {
            targetArray = summaries.weeklySummaries;
        } else if (type === 'recap') {
            targetArray = summaries.recaps;
        }
        if (!targetArray || targetArray[index] === undefined) return;

        // 视觉「下移」= 与最近的同状态、更低数组下标的条目交换。
        const archived = sumIsArchived(targetArray[index]);
        for (let j = index - 1; j >= 0; j--) {
            if (sumIsArchived(targetArray[j]) === archived) {
                const temp = targetArray[index];
                targetArray[index] = targetArray[j];
                targetArray[j] = temp;
                await saveSummariesToServer();
                toastr.success('位置调整成功');
                return;
            }
        }
    });

    // 2. Add manual Recap (10)
    // The manual-add boxes start as a single line and grow with content. Helper to
    // resize one to fit, capped by its CSS max-height.
    function autoGrowTextarea(el) {
        if (!el) return;
        el.style.height = 'auto';
        el.style.height = Math.max(32, el.scrollHeight) + 'px';
    }
    $(document).off('input', '.wizard-summary-autogrow').on('input', '.wizard-summary-autogrow', function () {
        autoGrowTextarea(this);
    });

    // Shared helper for the three manual "add" buttons. Parses <name>/<time>
    // out of the input text exactly like a successful AI fusion does, pushes
    // a proper record object (not a bare string) into the target array, then
    // saves + clears the input.
    async function manualAddSummary(type, $input) {
        const raw = ($input.val() || '').trim();
        if (!raw) {
            const label = SUMMARY_TYPE_NAMES[type] || '内容';
            toastr.warning(`请输入${label}内容！`);
            return;
        }
        const arr = (type === 'historical') ? (summaries.historicalSummaries ||= [])
                  : (type === 'weekly')     ? (summaries.weeklySummaries     ||= [])
                  : (type === 'recap')      ? (summaries.recaps              ||= [])
                  : null;
        if (!arr) return;
        const { body, name, timespan } = parseFusionRecord(raw);
        arr.push({
            text: body,
            source: '',
            name,
            timespan,
            realTimespan: '',
            showRealTime: defaultSummaryShowRealTime(),
        });
        $input.val('');
        const inputEl = $input[0];
        if (inputEl) autoGrowTextarea(inputEl);
        await saveSummariesToServer();
        const typeName = SUMMARY_TYPE_NAMES[type] || type;
        toastr.success(`已手动添加一条${typeName}记录${name ? `（名字="${name}"）` : ''}`);
    }

    $(document).off('click', '#wizard-add-recap-btn').on('click', '#wizard-add-recap-btn', async function () {
        await manualAddSummary('recap', $('#wizard-manual-recap-input'));
    });

    // 3. Add manual Weekly Summary (100)
    $(document).off('click', '#wizard-add-weekly-btn').on('click', '#wizard-add-weekly-btn', async function () {
        await manualAddSummary('weekly', $('#wizard-manual-weekly-input'));
    });

    // 4. Add manual Historical Summary (500)
    $(document).off('click', '#wizard-add-historical-btn').on('click', '#wizard-add-historical-btn', async function () {
        await manualAddSummary('historical', $('#wizard-manual-historical-input'));
    });

    $(document).off('click', '.wizard-ai-layer-fuse-btn').on('click', '.wizard-ai-layer-fuse-btn', async function () {
        const $btn = $(this);
        const type = $btn.data('type');
        if ($btn.prop('disabled')) return;
        $btn.prop('disabled', true).css('opacity', '0.65');
        try {
            toastr.info('正在 AI 一键融合当前进度条...');
            await runManualLayerFusion(type);
        } finally {
            $btn.prop('disabled', false).css('opacity', '');
        }
    });

    // 5. Delete summary item
    $(document).off('click', '.wizard-delete-summary-btn').on('click', '.wizard-delete-summary-btn', function () {
        const type = $(this).data('type');
        const index = parseInt($(this).data('index'));

        let targetArray;
        let typeLabel;
        if (type === 'historical') {
            targetArray = summaries.historicalSummaries;
            typeLabel = '史记';
        } else if (type === 'weekly') {
            targetArray = summaries.weeklySummaries;
            typeLabel = '周记';
        } else if (type === 'recap') {
            targetArray = summaries.recaps;
            typeLabel = '日记';
        }

        if (!targetArray) return;

        const context = window.SillyTavern.getContext();
        context.Popup.show.confirm(
            `确定要删除这条${typeLabel}记录吗？`,
            `正文：${sumText(targetArray[index]).slice(0, 100)}...`
        ).then(async confirmDelete => {
            if (!confirmDelete) return;

            targetArray.splice(index, 1);
            await saveSummariesToServer();
            toastr.success(`${typeLabel}记录已删除`);
        });
    });

    // Archive a summary item (greys it out; excluded from macro output/triggers).
    $(document).off('click', '.wizard-archive-summary-btn').on('click', '.wizard-archive-summary-btn', async function () {
        const type = $(this).data('type');
        const index = parseInt($(this).data('index'));
        const arr = getSummaryArray(type);
        if (!arr || arr[index] === undefined) return;
        sumSetArchived(arr, index, true);
        await saveSummariesToServer();
        toastr.success('已归档');
    });

    // Restore an archived summary item.
    $(document).off('click', '.wizard-restore-summary-btn').on('click', '.wizard-restore-summary-btn', async function () {
        const type = $(this).data('type');
        const index = parseInt($(this).data('index'));
        const arr = getSummaryArray(type);
        if (!arr || arr[index] === undefined) return;
        sumSetArchived(arr, index, false);
        await saveSummariesToServer();
        toastr.success('已恢复');
    });

    // One-click clean: permanently remove all archived items of a type.
    $(document).off('click', '.wizard-clean-archived-btn').on('click', '.wizard-clean-archived-btn', async function () {
        const type = $(this).data('type');
        const arr = getSummaryArray(type);
        if (!arr) return;
        const before = arr.length;
        const kept = arr.filter(x => !sumIsArchived(x));
        const removed = before - kept.length;
        if (removed === 0) { toastr.info('没有已归档的条目。'); return; }
        const context = window.SillyTavern.getContext();
        const ok = await context.Popup.show.confirm(`清理 ${SUMMARY_TYPE_NAMES[type]} 的已归档条目？`, `将永久删除 ${removed} 条已归档记录，不可恢复。`);
        if (!ok) return;
        // Replace contents in place.
        arr.length = 0;
        kept.forEach(x => arr.push(x));
        await saveSummariesToServer();
        toastr.success(`已清理 ${removed} 条已归档${SUMMARY_TYPE_NAMES[type]}`);
    });

    // 6. Edit summary item — INLINE editing of NAME, RP/story time span, AND the covered
    // floor range directly in the item header (the body textarea is already click-editable).
    // Editing the RP time writes the same `timespan` field as the AI's <time> tag, so manual
    // entry has the identical effect — useful when the AI forgets the tag. Editing the floor
    // range writes coveredFloors + the "来源: 楼层 X-Y" source string (drives the jump button
    // and dedupe). An empty name falls back to the "史记#1" placeholder; empty RP time clears
    // it; both floor boxes empty clears the range.
    $(document).off('click', '.wizard-edit-summary-btn').on('click', '.wizard-edit-summary-btn', function () {
        const type = $(this).data('type');
        const index = parseInt($(this).data('index'));
        const meta = $(this).closest('.wizard-summary-item').find('.wizard-sum-meta').first();
        if (!meta.length || meta.data('editing')) return;
        meta.data('editing', true);

        const curName = meta.attr('data-name') || '';
        const curRp = meta.attr('data-rp') || '';
        const curReal = meta.attr('data-real') || '';
        const curSource = meta.attr('data-source') || '';
        const curLo = meta.attr('data-floor-lo') || '';
        const curHi = meta.attr('data-floor-hi') || '';
        const curNowLo = meta.attr('data-now-lo') || '';
        const curNowHi = meta.attr('data-now-hi') || '';
        const floorEditMode = meta.attr('data-floor-edit-mode') || 'orig-only';
        const placeholder = meta.attr('data-placeholder') || '名字';

        const inputCss = 'font-size:0.85em; padding:4px 8px; border-radius:5px; background:rgba(0,0,0,0.35); border:1px solid rgba(255,255,255,0.18); color:#e5e7eb; box-sizing:border-box; outline:none;';
        const floorInputCss = inputCss + ' width:70px; text-align:center;';
        const nowFloorInputCss = inputCss + ' width:70px; text-align:center; border-color:rgba(52,211,153,0.55); background:rgba(16,185,129,0.08);';
        // Pill-style group wrapper for each labeled field row.
        const rowCss = 'display:flex; align-items:center; gap:6px; flex-wrap:wrap;';
        const labelCss = 'font-size:0.78em; color:#9ca3af; min-width:54px; display:inline-flex; align-items:center; gap:4px;';
        const dashCss = 'color:#6b7280; padding:0 2px;';

        // 现存楼层 (now floors) is editable ONLY when the record is remapped (its source
        // line shows a「现 X-Y 楼 / 部分删除」suffix). A fully-deleted record exposes only
        // 原楼层; an unchanged record (orig-only) also hides 现楼层 to keep the dialog clean.
        const showNowFloors = floorEditMode === 'remapped';
        const isDeleted = floorEditMode === 'deleted';

        // 原楼层 row — always present. Header note differs for the deleted case.
        const origRow =
            `<div style="${rowCss}">` +
                `<span style="${labelCss}" title="来源楼层范围（原始绝对楼层号，影响去重；两格都留空=清除）"><i class="fa-solid fa-layer-group" style="color:#9ca3af;"></i>原楼层</span>` +
                `<input type="number" min="0" class="wizard-sum-floor-lo-input" placeholder="起" value="${escapeHtml(curLo)}" style="${floorInputCss}">` +
                `<span style="${dashCss}">–</span>` +
                `<input type="number" min="0" class="wizard-sum-floor-hi-input" placeholder="止" value="${escapeHtml(curHi)}" style="${floorInputCss}">` +
                (isDeleted ? `<span style="font-size:0.74em; color:#f87171; margin-left:4px;" title="本记对应楼层已被删除，只能修改原楼层号"><i class="fa-solid fa-trash-can"></i> 已删除</span>` : '') +
            `</div>`;

        // 现存楼层 row — only when remapped. Includes a clear (×) button to drop the
        // manual now-floor override and fall back to the auto time-based remap.
        const nowRow = showNowFloors
            ? `<div style="${rowCss}">` +
                `<span style="${labelCss.replace('#9ca3af','#34d399')}" title="现存楼层范围（删楼后的当前楼层号）。填写后会把该范围首/末楼的发送时间反写到现实时间段，使下次自动映射也得到这个范围。点 × 清空=取消手动覆盖。"><i class="fa-solid fa-location-crosshairs" style="color:#34d399;"></i>现楼层</span>` +
                `<input type="number" min="0" class="wizard-sum-now-lo-input" placeholder="起" value="${escapeHtml(curNowLo)}" style="${nowFloorInputCss}">` +
                `<span style="${dashCss}">–</span>` +
                `<input type="number" min="0" class="wizard-sum-now-hi-input" placeholder="止" value="${escapeHtml(curNowHi)}" style="${nowFloorInputCss}">` +
                `<i class="fa-solid fa-xmark wizard-sum-now-clear" style="cursor:pointer; color:#f87171; font-size:0.9em; margin-left:2px;" title="清空现楼层（取消手动覆盖，恢复按发送时间自动映射）"></i>` +
              `</div>`
            // Not remapped: still need hidden inputs so commit() can read them without
            // breaking. They carry the current values but are not shown.
            : `<input type="hidden" class="wizard-sum-now-lo-input" value="${escapeHtml(curNowLo)}">` +
              `<input type="hidden" class="wizard-sum-now-hi-input" value="${escapeHtml(curNowHi)}">`;

        meta.html(
            `<div style="display:flex; flex-direction:column; gap:8px; padding:10px; background:rgba(0,0,0,0.22); border:1px solid rgba(255,255,255,0.08); border-radius:8px; width:100%; box-sizing:border-box;">` +
                // Row 1: name + RP time
                `<div style="${rowCss}">` +
                    `<input type="text" class="wizard-sum-name-input" placeholder="${escapeHtml(placeholder)}" value="${escapeHtml(curName)}" style="${inputCss} flex:1 1 150px; min-width:120px;" title="名字（留空=默认编号）">` +
                    `<input type="text" class="wizard-sum-rp-input" placeholder="RP时间跨度（同 <time>）" value="${escapeHtml(curRp)}" style="${inputCss} flex:1 1 180px; min-width:140px;" title="RP/剧情时间跨度">` +
                `</div>` +
                // Row 2: real time span
                `<div style="${rowCss}">` +
                    `<input type="text" class="wizard-sum-real-input" placeholder="现实时间段 (YYYY-MM-DD HH:mm ~ …)" value="${escapeHtml(curReal)}" style="${inputCss} flex:1 1 100%; min-width:200px;" title="现实时间段（用于删楼后按发送时间映射/进度统计；留空=清除。格式如 2026-01-12 16:17 ~ 2026-01-15 01:29）">` +
                `</div>` +
                // Row 3: free-text source
                `<div style="${rowCss}">` +
                    `<input type="text" class="wizard-sum-source-input" placeholder="来源（如：楼层 800-1900 或自定义）" value="${escapeHtml(curSource)}" style="${inputCss} flex:1 1 100%; min-width:200px;" title="来源字符串（自由文字）。可解析格式：「楼层 X-Y」→ 自动写入原楼层；「现 A-B 楼」→ 自动写入现存楼层；两者都可以出现在同一行。其他文字原样保存。">` +
                `</div>` +
                // Divider
                `<div style="height:1px; background:rgba(255,255,255,0.07); margin:1px 0;"></div>` +
                // Floor rows (conditional)
                origRow +
                nowRow +
                // Save button row
                `<div style="display:flex; justify-content:flex-end; gap:10px; margin-top:2px;">` +
                    `<i class="fa-solid fa-xmark wizard-sum-edit-cancel" style="cursor:pointer; color:#f87171; font-size:1.15em;" title="取消（恢复未保存的楼层标记/内容）"></i>` +
                    `<i class="fa-solid fa-circle-check wizard-sum-edit-save" style="cursor:pointer; color:#34d399; font-size:1.15em;" title="保存"></i>` +
                `</div>` +
            `</div>`
        );
        const nameInput = meta.find('.wizard-sum-name-input');
        nameInput.focus();
        nameInput[0].setSelectionRange(curName.length, curName.length);

        let done = false; // guard against double-commit (save click + blur)
        const commit = async () => {
            if (done) return;
            done = true;
            meta.data('editing', false);
            const arr = getSummaryArray(type);
            if (!arr || arr[index] === undefined) { renderAllSummaryLists(); return; }
            sumSetName(arr, index, meta.find('.wizard-sum-name-input').val().trim());
            sumSetTimespan(arr, index, meta.find('.wizard-sum-rp-input').val().trim());
            // Real-world time span (free text; empty = clear). Stored verbatim so the
            // delete-aware floor remap / progress coverage can parse it back to ms.
            sumSetRealTimespan(arr, index, meta.find('.wizard-sum-real-input').val().trim());

            // 来源（自由文字）: parse known patterns to auto-fill floor fields,
            // then store the text verbatim. Recognised patterns:
            //   「楼层 X-Y」or「楼层X-Y」 → coveredFloors (orig floor range)
            //   「现 A-B 楼」              → nowFloors (current floor range)
            // Both may appear in the same string. Other text is kept as-is.
            const sourceRaw = meta.find('.wizard-sum-source-input').val().trim();
            let parsedNowFromSource = false;
            if (sourceRaw !== curSource) {
                // Parse 原楼层 from source string
                const origMatch = sourceRaw.match(/楼层\s*(\d+)\s*[-–]\s*(\d+)/);
                const nowMatch  = sourceRaw.match(/现\s*(\d+)\s*[-–]\s*(\d+)\s*楼/);
                if (origMatch) {
                    // Source text is the user's visible truth. If they changed it to
                    // "楼层 X-Y", force-sync the orig-floor inputs so coveredFloors is
                    // updated too (not left at an old hidden value like 0-16000).
                    const loInput = meta.find('.wizard-sum-floor-lo-input');
                    const hiInput = meta.find('.wizard-sum-floor-hi-input');
                    loInput.val(origMatch[1]);
                    hiInput.val(origMatch[2]);
                    // Source「楼层 X-Y」is an original/source label, not a current-floor
                    // override. Whether it is deleted/present is decided by realTimespan.
                }
                if (nowMatch) {
                    parsedNowFromSource = true;
                    const nowLoInput = meta.find('.wizard-sum-now-lo-input');
                    const nowHiInput = meta.find('.wizard-sum-now-hi-input');
                    if (nowLoInput.val().trim() === '') nowLoInput.val(nowMatch[1]);
                    if (nowHiInput.val().trim() === '') nowHiInput.val(nowMatch[2]);
                }
                // Store the free-text source verbatim (overrides the auto-generated "楼层 X-Y").
                const base = (typeof arr[index] === 'string') ? { text: arr[index] } : { ...arr[index] };
                if (sourceRaw) base.source = sourceRaw; else delete base.source;
                arr[index] = base;
            }

            // 现存楼层 A-B：只有 remapped 编辑模式才允许修改。
            // 两格都清空 = 用户明确要求不再显示「现 X-Y 楼 / 部分删除」括号，写入 hideNowFloors。
            // 重新填入数字 = 写 nowFloors，并自动取消 hideNowFloors。
            if (floorEditMode === 'remapped' || parsedNowFromSource) {
                let nowLoVal = meta.find('.wizard-sum-now-lo-input').val().trim();
                let nowHiVal = meta.find('.wizard-sum-now-hi-input').val().trim();
                if (nowLoVal === '' && nowHiVal === '') {
                    sumSetHideNowFloors(arr, index, true);
                } else {
                    sumSetNowFloors(arr, index, nowLoVal, nowHiVal);
                }
            }
            // Floor range: both blank → clear; otherwise set (sumSetCoveredFloors
            // syncs the "来源: 楼层 X-Y" source string too, UNLESS a free-text source
            // was explicitly entered above — in that case coveredFloors is updated but
            // the source string is NOT overwritten by sumSetCoveredFloors).
            const loVal = meta.find('.wizard-sum-floor-lo-input').val().trim();
            const hiVal = meta.find('.wizard-sum-floor-hi-input').val().trim();
            const realSpanFromCurrentFloors = (lo, hi) => {
                const ctx = window.SillyTavern?.getContext();
                const chat = ctx?.chat;
                const a = parseInt(lo), b = parseInt(hi);
                if (!Array.isArray(chat) || isNaN(a) || isNaN(b) || !chat[a] || !chat[b]) return '';
                const tA = msgTimestamp(chat[a]);
                const tB = msgTimestamp(chat[b]);
                if (isNaN(tA) || isNaN(tB)) return '';
                const minT = Math.min(tA, tB), maxT = Math.max(tA, tB);
                return minT === maxT ? formatTimestamp(minT) : `${formatTimestamp(minT)} ~ ${formatTimestamp(maxT)}`;
            };
            if (loVal === '' && hiVal === '') {
                // Only clear coveredFloors, don't touch the free-text source
                const base2 = (typeof arr[index] === 'string') ? { text: arr[index] } : { ...arr[index] };
                delete base2.coveredFloors;
                arr[index] = base2;
            } else {
                const loNum = parseInt(loVal), hiNum = parseInt(hiVal);
                if (!isNaN(loNum) && !isNaN(hiNum)) {
                    const base2 = (typeof arr[index] === 'string') ? { text: arr[index] } : { ...arr[index] };
                    const loSet = Math.min(loNum, hiNum);
                    const hiSet = Math.max(loNum, hiNum);
                    base2.coveredFloors = { lo: loSet, hi: hiSet };
                    // Keep send-time remap in sync with a manually edited floor range,
                    // but ONLY when the user did NOT manually type a real-timespan — they
                    // may be correcting a wrong auto-computed date by hand, and we must
                    // not overwrite their value.
                    const manualRealTyped = meta.find('.wizard-sum-real-input').val().trim();
                    if (!manualRealTyped) {
                        const recalculatedReal = realSpanFromCurrentFloors(loSet, hiSet);
                        if (recalculatedReal) base2.realTimespan = recalculatedReal;
                    }
                    // Only overwrite source with "楼层 X-Y" if no free-text source was entered
                    if (!sourceRaw || sourceRaw === curSource) {
                        base2.source = `楼层 ${Math.min(loNum, hiNum)}-${Math.max(loNum, hiNum)}`;
                    }
                    arr[index] = base2;
                }
            }
            await saveSummariesToServer(); // re-renders the list
        };
        const cancel = () => { if (done) return; done = true; meta.data('editing', false); renderAllSummaryLists(); };

        meta.find('.wizard-sum-edit-save').on('click', commit);
        meta.find('.wizard-sum-edit-cancel').on('mousedown click', function (e) {
            e.preventDefault();
            e.stopPropagation();
            cancel();
        });
        // × clear button on the 现楼层 row: wipe both now-floor inputs (= cancel the
        // manual override) but DO NOT commit/close the editor. mousedown + preventDefault
        // keeps focus inside the edit region so the blur auto-commit won't fire.
        meta.find('.wizard-sum-now-clear').on('mousedown', function (e) {
            e.preventDefault();
            const nowLo = meta.find('.wizard-sum-now-lo-input');
            meta.find('.wizard-sum-now-hi-input').val('');
            nowLo.val('').focus();
        });
        meta.find('input').on('keydown', function (e) {
            if (e.key === 'Enter') { e.preventDefault(); commit(); }
            else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
        });
        // Commit when focus leaves the whole editing region (next tick to allow tabbing
        // between the inputs / clicking the save check or the × clear button).
        meta.find('input').on('blur', function () {
            setTimeout(() => {
                if (!meta.find('input').is(':focus') && meta.data('editing')) commit();
            }, 120);
        });
    });

    // Clock icon toggles whether this record's real-world time span is injected into
    // its first line (【…|现实时间】). Default off. UI label shows 开/关 via highlight.
    $(document).off('click', '.wizard-toggle-realtime-btn').on('click', '.wizard-toggle-realtime-btn', async function () {
        const type = $(this).data('type');
        const index = parseInt($(this).data('index'));
        const arr = getSummaryArray(type);
        if (!arr || arr[index] === undefined) return;
        sumSetShowRealTime(arr, index, !sumShowRealTime(arr[index]));
        await saveSummariesToServer();
    });

    // ---- Layered-summary batch edit / import / export ----

    // 重新映射楼层: recompute (read-only) each record's floor membership against the
    // current chat and show "原 X-Y 楼 / 现 X-Y 楼 / 已删" annotations. The annotation
    // is ALWAYS on (auto-recomputed on every load/render), so this button is a manual
    // "refresh now" — useful right after deleting floors, without waiting for the next
    // loadSummaries. Never mutates stored data — purely a display overlay.
    $(document).off('click.wizardSumDefaultRealtime', '#wizard-sum-default-realtime').on('click.wizardSumDefaultRealtime', '#wizard-sum-default-realtime', function () {
        const next = $(this).attr('data-active') !== 'true';
        $(this).attr('data-active', next ? 'true' : 'false');
        config.summaryDefaultShowRealTime = next;
        saveConfig(true);
    });

    // 保留条数语义切换：外加(阈值之外) <-> 包含(阈值之内)。进度条门槛随之改变。
    $(document).off('click.wizardKeepLatestInc', '#wizard-keep-latest-inclusive').on('click.wizardKeepLatestInc', '#wizard-keep-latest-inclusive', function () {
        config.keepLatestInclusive = $(this).attr('data-active') !== 'true';
        renderKeepLatestToggle();
        saveConfig(true);
        updateSummaryProgress();
    });

    $(document).off('click', '#wizard-sum-remap-floors-btn').on('click', '#wizard-sum-remap-floors-btn', function () {
        // renderAllSummaryLists() recomputes floorRemapState against the live chat
        // (with sandboxChatContext fallback) and redraws. No need to compute here.
        $(this).addClass('wizard-btn-primary');
        renderAllSummaryLists();
        // Summarize the outcome for the user from the freshly recomputed state.
        let nDel = 0, nPart = 0, nPres = 0;
        if (floorRemapState) {
            for (const v of floorRemapState.values()) {
                if (v.status === 'deleted') nDel++;
                else if (v.status === 'partial') nPart++;
                else if (v.status === 'present') nPres++;
            }
        }
        toastr.success(`楼层映射已刷新：${nPres} 条完整存在 · ${nPart} 条部分删除 · ${nDel} 条已删除。`, '', { timeOut: 6000 });
        writeLog(`重新映射楼层: present=${nPres}, partial=${nPart}, deleted=${nDel}。`);
    });

    // 从备份回填时间: for records missing realTimespan/coveredFloors (legacy records
    // that only stored a "楼层 X-Y" source string), look up the ORIGINAL floor
    // send_dates in a chosen backup sandbox and fill in the correct time + floors.
    // The backup sandbox can be hundreds of MB, so the lookup runs server-side; we
    // only send the summaries (small) and the chosen backup name.
    $(document).off('click', '#wizard-sum-backfill-time-btn').on('click', '#wizard-sum-backfill-time-btn', async function () {
        const picked = await showBackupPicker('sandbox', true); // metaOnly: don't fetch content
        if (!picked) return;
        const $btn = $(this);
        $btn.prop('disabled', true);
        const origHtml = $btn.html();
        $btn.html('<i class="fa-solid fa-spinner fa-spin"></i> 回填中…');
        try {
            const res = await fetch('/api/plugins/st-memory-wizzard/backfill-realtime', {
                method: 'POST',
                headers: getWizardHeaders(),
                body: JSON.stringify({ summaries, sandboxName: picked.name, sandboxLocation: picked.location })
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                toastr.error(`回填失败：${err.error || res.status}`);
                return;
            }
            const data = await res.json();
            if (data && data.summaries) {
                summaries = data.summaries;
                normalizeSummaries();
                await saveSummariesToServer(); // persist the patched records
                // renderAllSummaryLists() recomputes the remap against the now-correct
                // times before redrawing, so no manual recompute is needed here.
                renderAllSummaryLists();
                toastr.success(`已回填 ${data.filled} 条记的发送时间（备份 ${data.sandboxLen} 楼）。跳过：无楼层 ${data.skippedNoFloors}、无时间 ${data.skippedNoTs}。`, '', { timeOut: 8000 });
                writeLog(`从备份回填时间: filled=${data.filled}, skippedNoFloors=${data.skippedNoFloors}, skippedNoTs=${data.skippedNoTs}, sandbox="${picked.name}" (${data.sandboxLen} floors).`);
            } else {
                toastr.error('回填返回数据异常。');
            }
        } catch (e) {
            toastr.error(`回填请求失败：${e.message}`);
            writeLog(`从备份回填时间失败: ${e.message}`, 'ERROR');
        } finally {
            $btn.prop('disabled', false).html(origHtml);
        }
    });

    $(document).off('click', '#wizard-sum-select-mode-btn').on('click', '#wizard-sum-select-mode-btn', function () {
        summarySelectionMode = !summarySelectionMode;
        if (!summarySelectionMode) selectedSummaries.clear();
        $(this).toggleClass('wizard-btn-warning', summarySelectionMode).removeClass('wizard-btn-primary');
        $(this).find('i').attr('class', summarySelectionMode ? 'fa-solid fa-square-check' : 'fa-regular fa-square-check');
        renderAllSummaryLists(); // re-render with/without checkboxes (also updates the bar)
    });

    // Checkbox toggle: add/remove the key, refresh the count.
    $(document).off('change', '.wizard-sum-select-cb').on('change', '.wizard-sum-select-cb', function () {
        const key = summaryKey($(this).data('type'), parseInt($(this).data('index')));
        if (this.checked) selectedSummaries.add(key); else selectedSummaries.delete(key);
        updateSummarySelectionUI();
    });

    // Section title checkbox: select/clear every item in THIS layer.
    $(document).off('change', '.wizard-sum-section-cb').on('change', '.wizard-sum-section-cb', function () {
        const type = $(this).data('type');
        const arr = getSummaryArray(type) || [];
        const check = this.checked;
        arr.forEach((_, i) => {
            const k = summaryKey(type, i);
            if (check) selectedSummaries.add(k); else selectedSummaries.delete(k);
        });
        renderAllSummaryLists(); // refresh item checkboxes + count
    });

    // Select all / clear all across the three layers.
    $(document).off('click', '#wizard-sum-select-all-btn').on('click', '#wizard-sum-select-all-btn', function () {
        const allKeys = [];
        SUMMARY_LAYERS.forEach(({ type }) => {
            (getSummaryArray(type) || []).forEach((_, i) => allKeys.push(summaryKey(type, i)));
        });
        const allSelected = allKeys.length > 0 && allKeys.every(k => selectedSummaries.has(k));
        selectedSummaries.clear();
        if (!allSelected) allKeys.forEach(k => selectedSummaries.add(k));
        renderAllSummaryLists();
    });

    // Export ALL three layers.
    $(document).off('click', '#wizard-sum-export-all-btn').on('click', '#wizard-sum-export-all-btn', function () {
        const subset = {
            historicalSummaries: summaries.historicalSummaries || [],
            weeklySummaries: summaries.weeklySummaries || [],
            recaps: summaries.recaps || [],
        };
        const payload = buildSummariesExport(subset);
        if (payload.count === 0) { toastr.warning('没有可导出的记。'); return; }
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const safeChat = (activeChatId || 'summaries').replace(/[^a-z0-9_-]/gi, '_');
        downloadJson(payload, `memory_summaries_${safeChat}_${stamp}.json`);
        toastr.success(`已导出全部分层摘要 (${payload.count} 条)`);
    });

    // Export only the selected items.
    $(document).off('click', '#wizard-sum-export-selected-btn').on('click', '#wizard-sum-export-selected-btn', function () {
        if (selectedSummaries.size === 0) { toastr.warning('请先勾选要导出的记。'); return; }
        const payload = buildSummariesExport(collectSelectedSummaries());
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        downloadJson(payload, `memory_summaries_selected_${stamp}.json`);
        toastr.success(`已导出所选 ${payload.count} 条`);
    });

    // Batch delete selected (process highest index first per layer to keep indices valid).
    $(document).off('click', '#wizard-sum-delete-selected-btn').on('click', '#wizard-sum-delete-selected-btn', async function () {
        if (selectedSummaries.size === 0) { toastr.warning('请先勾选要删除的记。'); return; }
        const total = selectedSummaries.size;
        const context = window.SillyTavern.getContext();
        const ok = await context.Popup.show.confirm(`确定删除所选 ${total} 条记吗？`, '此操作不可逆。');
        if (!ok) return;
        SUMMARY_LAYERS.forEach(({ type }) => {
            const arr = getSummaryArray(type);
            if (!arr) return;
            const idxs = [];
            arr.forEach((_, i) => { if (selectedSummaries.has(summaryKey(type, i))) idxs.push(i); });
            idxs.sort((a, b) => b - a).forEach(i => arr.splice(i, 1)); // descending splice
        });
        selectedSummaries.clear();
        await saveSummariesToServer();
        toastr.success(`已删除 ${total} 条记`);
        writeLog(`Batch-deleted ${total} summary records.`);
    });

    // Batch archive/restore: if ALL selected are archived → restore, else archive.
    $(document).off('click', '#wizard-sum-archive-selected-btn').on('click', '#wizard-sum-archive-selected-btn', async function () {
        if (selectedSummaries.size === 0) { toastr.warning('请先勾选要归档/恢复的记。'); return; }
        const items = [];
        selectedSummaries.forEach(k => {
            const { type, index } = parseSummaryKey(k);
            const arr = getSummaryArray(type);
            if (arr && arr[index] !== undefined) items.push({ arr, index });
        });
        const allArchived = items.length > 0 && items.every(({ arr, index }) => sumIsArchived(arr[index]));
        items.forEach(({ arr, index }) => sumSetArchived(arr, index, !allArchived));
        selectedSummaries.clear();
        await saveSummariesToServer();
        toastr.success(allArchived ? `已恢复 ${items.length} 条` : `已归档 ${items.length} 条`);
    });

    // Batch real-time toggle: if ALL selected are ON → turn off, else turn on.
    $(document).off('click', '#wizard-sum-realtime-selected-btn').on('click', '#wizard-sum-realtime-selected-btn', async function () {
        if (selectedSummaries.size === 0) { toastr.warning('请先勾选要切换的记。'); return; }
        const items = [];
        selectedSummaries.forEach(k => {
            const { type, index } = parseSummaryKey(k);
            const arr = getSummaryArray(type);
            if (arr && arr[index] !== undefined) items.push({ arr, index });
        });
        const allOn = items.length > 0 && items.every(({ arr, index }) => sumShowRealTime(arr[index]));
        items.forEach(({ arr, index }) => sumSetShowRealTime(arr, index, !allOn));
        selectedSummaries.clear();
        await saveSummariesToServer();
        toastr.success(allOn ? `已关闭 ${items.length} 条的现实时间` : `已开启 ${items.length} 条的现实时间`);
    });

    // Import: open the hidden file picker.
    $(document).off('click', '#wizard-sum-import-btn').on('click', '#wizard-sum-import-btn', function () {
        $('#wizard-sum-import-file').val(''); // allow re-picking the same file
        $('#wizard-sum-import-file').trigger('click');
    });

    // Summaries backup import: list summaries_* backups, pick one, read it, and run
    // the same append/replace flow as the file-based import.
    $(document).off('click', '#wizard-sum-import-backup-btn').on('click', '#wizard-sum-import-backup-btn', async function () {
        const picked = await showBackupPicker('summaries');
        if (!picked) return;
        const parsed = picked.data;
        let data = null;
        if (parsed && parsed.format === 'memory-wizard-summaries' && parsed.summaries) data = parsed.summaries;
        else if (parsed && (parsed.historicalSummaries || parsed.weeklySummaries || parsed.recaps)) data = parsed;
        if (!data) { toastr.error('该备份不含有效的分层摘要。'); return; }

        const norm = (a) => Array.isArray(a) ? a : [];
        const incoming = {
            historicalSummaries: norm(data.historicalSummaries),
            weeklySummaries: norm(data.weeklySummaries),
            recaps: norm(data.recaps),
        };
        const importCount = incoming.historicalSummaries.length + incoming.weeklySummaries.length + incoming.recaps.length;
        if (importCount === 0) { toastr.warning('该备份中没有任何记。'); return; }

        const context = window.SillyTavern.getContext();
        let mode = 'append';
        try {
            const popup = new context.Popup(
                `<h3>从备份导入 ${importCount} 条记</h3>
                 <div style="text-align:left; line-height:1.6; font-size:0.9em;">
                   <p style="color:#9ca3af;">备份: ${escapeHtml(picked.name)}</p>
                   <p><b>追加</b>：把备份的记加到现有三层的末尾，保留现有记。</p>
                   <p><b>替换</b>：清空当前三层，整体换成备份内容（不可逆）。</p>
                 </div>`,
                context.POPUP_TYPE.TEXT, '',
                { customButtons: [{ text: '追加', result: 2 }, { text: '替换', result: 3 }], okButton: false, cancelButton: '取消' }
            );
            const res = await popup.show();
            if (res === 2) mode = 'append';
            else if (res === 3) mode = 'replace';
            else { toastr.info('已取消导入。'); return; }
        } catch (e) {
            const yes = await context.Popup.show.confirm(`从备份导入 ${importCount} 条记`, '「确定」= 追加 · 「取消」= 替换');
            mode = yes ? 'append' : 'replace';
        }

        SUMMARY_LAYERS.forEach(({ key }) => {
            if (!Array.isArray(summaries[key])) summaries[key] = [];
            if (mode === 'replace') summaries[key] = incoming[key].slice();
            else summaries[key] = summaries[key].concat(incoming[key]);
        });
        selectedSummaries.clear();
        await saveSummariesToServer();
        toastr.success(`从备份导入成功 (${mode === 'replace' ? '整体替换' : '追加'})，共 ${importCount} 条`);
        writeLog(`Imported ${importCount} summary records from backup "${picked.name}" (${mode}).`);
    });

    $(document).off('change', '#wizard-sum-import-file').on('change', '#wizard-sum-import-file', async function () {
        const file = this.files && this.files[0];
        if (!file) return;
        let parsed;
        try {
            parsed = JSON.parse(await file.text());
        } catch (e) {
            toastr.error('导入失败：文件不是有效的 JSON。');
            return;
        }
        // Accept our envelope {format, summaries:{...}} or a bare {historicalSummaries,...}.
        let data = null;
        if (parsed && parsed.format === 'memory-wizard-summaries' && parsed.summaries) data = parsed.summaries;
        else if (parsed && (parsed.historicalSummaries || parsed.weeklySummaries || parsed.recaps)) data = parsed;
        if (!data) {
            toastr.error('导入失败：未找到有效的分层摘要 (期望格式 memory-wizard-summaries)。');
            return;
        }
        const norm = (a) => Array.isArray(a) ? a : [];
        const incoming = {
            historicalSummaries: norm(data.historicalSummaries),
            weeklySummaries: norm(data.weeklySummaries),
            recaps: norm(data.recaps),
        };
        const importCount = incoming.historicalSummaries.length + incoming.weeklySummaries.length + incoming.recaps.length;
        if (importCount === 0) { toastr.warning('文件中没有任何记。'); return; }

        const context = window.SillyTavern.getContext();
        let mode = 'append';
        try {
            const popup = new context.Popup(
                `<h3>导入 ${importCount} 条记</h3>
                 <div style="text-align:left; line-height:1.6; font-size:0.9em;">
                   <p><b>追加</b>：把导入的记加到现有三层的末尾，保留现有记。</p>
                   <p><b>替换</b>：清空当前三层，整体换成导入的内容（不可逆）。</p>
                 </div>`,
                context.POPUP_TYPE.TEXT, '',
                { customButtons: [{ text: '追加', result: 2 }, { text: '替换', result: 3 }], okButton: false, cancelButton: '取消' }
            );
            const res = await popup.show();
            if (res === 2) mode = 'append';
            else if (res === 3) mode = 'replace';
            else { toastr.info('已取消导入。'); return; }
        } catch (e) {
            const yes = await context.Popup.show.confirm(`导入 ${importCount} 条记`, '「确定」= 追加 · 「取消」= 替换');
            mode = yes ? 'append' : 'replace';
        }

        SUMMARY_LAYERS.forEach(({ type, key }) => {
            if (!Array.isArray(summaries[key])) summaries[key] = [];
            if (mode === 'replace') summaries[key] = incoming[key].slice();
            else summaries[key] = summaries[key].concat(incoming[key]);
        });
        selectedSummaries.clear();
        await saveSummariesToServer();
        toastr.success(`导入成功 (${mode === 'replace' ? '整体替换' : '追加'})，共 ${importCount} 条`);
        writeLog(`Imported ${importCount} summary records (${mode}).`);
    });

    $(document).off('input', '.wizard-summary-textarea').on('input', '.wizard-summary-textarea', function () {
        const type = $(this).data('type');
        const index = parseInt($(this).data('index'));
        const val = $(this).val();
        const targetArray = getSummaryArray(type);
        if (targetArray && targetArray[index] !== undefined) {
            sumSetText(targetArray, index, val);
        }
    });

    $(document).off('change', '.wizard-summary-textarea').on('change', '.wizard-summary-textarea', async function () {
        const type = $(this).data('type');
        const index = parseInt($(this).data('index'));
        const val = $(this).val();
        const targetArray = getSummaryArray(type);
        if (targetArray && targetArray[index] !== undefined) {
            sumSetText(targetArray, index, val);
            await saveSummariesToServer();
        }
    });

    // Fullscreen summary editing events
    // Per-record "拉低" expand: ONE click fully expands the record's textarea so the
    // entire content is visible (height = scrollHeight). Clicking again (now an
    // up-chevron) collapses it back to the default. Double-click also resets.
    $(document).off('click', '.wizard-sum-expand-btn').on('click', '.wizard-sum-expand-btn', function () {
        const ta = $(this).closest('.wizard-summary-item').find('textarea.wizard-summary-textarea').first();
        if (!ta.length) return;
        const icon = $(this);
        const isExpanded = icon.hasClass('fa-chevron-up');
        if (isExpanded) {
            // Collapse back to the default min height.
            ta.css('height', 'auto');
            icon.removeClass('fa-chevron-up').addClass('fa-chevron-down')
                .attr('title', '点击拉低该记，完整显示内容（再点收起）');
        } else {
            // Fully expand to fit all content.
            ta.css('height', 'auto');
            ta.css('height', (ta[0].scrollHeight + 4) + 'px');
            icon.removeClass('fa-chevron-down').addClass('fa-chevron-up')
                .attr('title', '点击收起');
        }
    });
    $(document).off('dblclick', '.wizard-sum-expand-btn').on('dblclick', '.wizard-sum-expand-btn', function () {
        const ta = $(this).closest('.wizard-summary-item').find('textarea.wizard-summary-textarea').first();
        if (!ta.length) return;
        ta.css('height', 'auto');
        $(this).removeClass('fa-chevron-up').addClass('fa-chevron-down')
            .attr('title', '点击拉低该记，完整显示内容（再点收起）');
    });

    // Per-section "拉低" expand: ONE click removes the list container's max-height cap
    // so EVERY entry in that section (史记/周记/日记) shows at once. Clicking again
    // (now an up-chevron) restores the default cap. Double-click also resets.
    $(document).off('click', '.wizard-list-expand-btn').on('click', '.wizard-list-expand-btn', function () {
        const el = document.getElementById($(this).data('target'));
        if (!el) return;
        const icon = $(this);
        if (el.dataset.defaultMaxHeight === undefined) el.dataset.defaultMaxHeight = el.style.maxHeight || '';
        const isExpanded = icon.hasClass('fa-chevron-up');
        if (isExpanded) {
            el.style.maxHeight = el.dataset.defaultMaxHeight || '';
            icon.removeClass('fa-chevron-up').addClass('fa-chevron-down')
                .attr('title', '拉低本区，显示全部条目（再点收起）');
        } else {
            el.style.maxHeight = 'none';
            icon.removeClass('fa-chevron-down').addClass('fa-chevron-up')
                .attr('title', '点击收起');
        }
    });
    $(document).off('dblclick', '.wizard-list-expand-btn').on('dblclick', '.wizard-list-expand-btn', function () {
        const el = document.getElementById($(this).data('target'));
        if (!el) return;
        el.style.maxHeight = el.dataset.defaultMaxHeight || '';
        $(this).removeClass('fa-chevron-up').addClass('fa-chevron-down')
            .attr('title', '拉低本区，显示全部条目（再点收起）');
    });

    $(document).off('click', '.wizard-fullscreen-summary-btn').on('click', '.wizard-fullscreen-summary-btn', function () {
        const type = $(this).data('type');
        const index = parseInt($(this).data('index'));

        let targetArray;
        let typeLabel = '';
        if (type === 'historical') {
            targetArray = summaries.historicalSummaries;
            typeLabel = '史记';
        } else if (type === 'weekly') {
            targetArray = summaries.weeklySummaries;
            typeLabel = '周记';
        } else if (type === 'recap') {
            targetArray = summaries.recaps;
            typeLabel = '日记';
        }

        if (!targetArray || targetArray[index] === undefined) return;

        const titleColor = SUMMARY_COLORS[type] || 'var(--wizard-primary)';
        const entryName = sumName(targetArray[index]);
        const entryText = sumText(targetArray[index]) || '';
        const firstLine = entryText.split('\n').find(l => l.trim()) || '';
        const displayTitle = entryName
            ? `${typeLabel} · ${entryName}`
            : firstLine
                ? `${typeLabel} · ${firstLine.length > 60 ? firstLine.slice(0, 60) + '…' : firstLine}`
                : `${typeLabel} #${index + 1}`;
        $('#wizard-fullscreen-title').html(`<i class="fa-solid fa-expand"></i> <span style="color:${titleColor};">${displayTitle}</span>`);
        $('#wizard-fullscreen-textarea').val(sumText(targetArray[index]));
        $('#wizard-fullscreen-type').val(type);
        $('#wizard-fullscreen-index').val(index);

        $('#wizard-summary-fullscreen-overlay').css('display', 'flex');
    });

    $(document).off('click', '#wizard-fullscreen-cancel, #wizard-fullscreen-close').on('click', '#wizard-fullscreen-cancel, #wizard-fullscreen-close', function () {
        $('#wizard-summary-fullscreen-overlay').css('display', 'none');
    });

    $(document).off('click', '#wizard-fullscreen-save').on('click', '#wizard-fullscreen-save', async function () {
        const type = $('#wizard-fullscreen-type').val();
        const index = parseInt($('#wizard-fullscreen-index').val());
        const newVal = $('#wizard-fullscreen-textarea').val();

        let targetArray;
        if (type === 'historical') {
            targetArray = summaries.historicalSummaries;
        } else if (type === 'weekly') {
            targetArray = summaries.weeklySummaries;
        } else if (type === 'recap') {
            targetArray = summaries.recaps;
        }

        if (targetArray && targetArray[index] !== undefined) {
            sumSetText(targetArray, index, newVal);

            const textarea = $(`.wizard-summary-textarea[data-type="${type}"][data-index="${index}"]`);
            if (textarea.length > 0) {
                textarea.val(newVal);
            }

            await saveSummariesToServer();
            toastr.success('已保存修改！');
        }

        $('#wizard-summary-fullscreen-overlay').css('display', 'none');
    });

    // Prompt template fullscreen editor
    $(document).off('click', '.wizard-prompt-fullscreen-btn').on('click', '.wizard-prompt-fullscreen-btn', function () {
        const targetId = $(this).data('target');
        const label = $(this).data('label') || '融合 Prompt';
        const val = $(`#${targetId}`).val() || '';
        $('#wizard-prompt-fullscreen-title').html(`<i class="fa-solid fa-expand"></i> 全屏编辑 — ${label}`);
        $('#wizard-prompt-fullscreen-textarea').val(val);
        $('#wizard-prompt-fullscreen-target').val(targetId);
        $('#wizard-prompt-fullscreen-overlay').css('display', 'flex');
    });

    $(document).off('click', '#wizard-prompt-fullscreen-cancel, #wizard-prompt-fullscreen-close').on('click', '#wizard-prompt-fullscreen-cancel, #wizard-prompt-fullscreen-close', function () {
        $('#wizard-prompt-fullscreen-overlay').css('display', 'none');
    });

    $(document).off('click', '#wizard-prompt-fullscreen-save').on('click', '#wizard-prompt-fullscreen-save', function () {
        const targetId = $('#wizard-prompt-fullscreen-target').val();
        const val = $('#wizard-prompt-fullscreen-textarea').val();
        if (targetId) $(`#${targetId}`).val(val);
        $('#wizard-prompt-fullscreen-overlay').css('display', 'none');
    });

    // Jump-to-floor from 分层摘要 item button: switch to 上下文融合 tab and navigate
    // to the start floor of the record's covered range. A floating button is shown
    // to jump to the end floor. Covered floors are highlighted with a stronger border.
    $(document).off('click', '.wizard-sum-jump-btn').on('click', '.wizard-sum-jump-btn', function () {
        const type = $(this).data('type');
        const lo = parseInt($(this).data('lo'));
        const hi = parseInt($(this).data('hi'));
        if (isNaN(lo) || isNaN(hi)) { toastr.warning('该条目没有楼层信息，无法跳转。'); return; }

        // Set the jump highlight so renderSandboxChat can color covered floors.
        sandboxJumpHighlight = { type, lo, hi };

        // Pre-fill the fusion floor range inputs so the user can immediately run
        // a fusion operation on the record's covered range.
        $('#wizard-fusion-start').val(lo).trigger('change');
        $('#wizard-fusion-end').val(hi).trigger('change');

        // Also copy the record's layer into the fusion type dropdown so a
        // re-generate lands in the SAME layer (日记/周记/史记) instead of whatever
        // was last selected — the summary `type` values (recap/weekly/historical)
        // match the #wizard-fusion-type option values 1:1.
        if (['recap', 'weekly', 'historical'].includes(type)) {
            $('#wizard-fusion-type').val(type).trigger('change');
        }

        // Switch to 上下文融合 tab.
        $('.wizard-tab').removeClass('active');
        $('[data-tab="context-fusion"]').addClass('active');
        $('.wizard-tab-content').removeClass('active');
        $('#wizard-tab-context-fusion').addClass('active');
        $('#wizard-sandbox-filter-tags').trigger('wizard:refresh');

        // If sandbox context is loaded, navigate to the start floor.
        if (sandboxChatContext && sandboxChatContext.length > 0) {
            SANDBOX_PAGE_SIZE = Math.max(10, parseInt(config.sandboxPageSize) || 100);
            // Find the filtered entry position for the target floor.
            const entries = getFilteredSandboxEntries();
            // Prefer exact floor match; fall back to first floor >= lo.
            let entryPos = entries.findIndex(e => e.floor === lo);
            if (entryPos < 0) entryPos = entries.findIndex(e => e.floor >= lo);
            if (entryPos < 0) entryPos = 0;
            sandboxPage = Math.floor(entryPos / SANDBOX_PAGE_SIZE);
            renderSandboxChat();
            // Scroll to the target item on the rendered page.
            setTimeout(() => {
                const items = document.querySelectorAll('#wizard-context-editor-list .wizard-context-msg-item');
                const itemIdx = entryPos - sandboxPage * SANDBOX_PAGE_SIZE;
                const target = items[itemIdx];
                if (target) {
                    target.scrollIntoView({ block: 'center', behavior: 'smooth' });
                    target.style.transition = 'box-shadow 0.3s';
                    target.style.boxShadow = `0 0 0 2px ${SUMMARY_COLORS[type] || '#34d399'}`;
                    setTimeout(() => { if (target) target.style.boxShadow = ''; }, 1400);
                }
            }, 80);
        } else {
            renderSandboxChat();
            toastr.info('请先载入上下文，再跳转到对应楼层。');
        }

        // Show the floating end-floor button.
        $('#wizard-jump-to-end-btn').css('display', 'flex').data('hi', hi).data('type', type);
    });

    // Floating end-floor jump button: navigate to the hi floor of the last jumped record.
    $(document).off('click', '#wizard-jump-to-end-btn').on('click', '#wizard-jump-to-end-btn', function () {
        const hi = parseInt($(this).data('hi'));
        const type = $(this).data('type') || 'historical';
        if (isNaN(hi) || !sandboxChatContext || !sandboxChatContext.length) return;
        SANDBOX_PAGE_SIZE = Math.max(10, parseInt(config.sandboxPageSize) || 100);
        const entries = getFilteredSandboxEntries();
        let entryPos = entries.findIndex(e => e.floor === hi);
        if (entryPos < 0) entryPos = entries.reduce((best, e, i) => e.floor <= hi ? i : best, 0);
        sandboxPage = Math.floor(entryPos / SANDBOX_PAGE_SIZE);
        renderSandboxChat();
        setTimeout(() => {
            const items = document.querySelectorAll('#wizard-context-editor-list .wizard-context-msg-item');
            const itemIdx = entryPos - sandboxPage * SANDBOX_PAGE_SIZE;
            const target = items[itemIdx];
            if (target) {
                target.scrollIntoView({ block: 'center', behavior: 'smooth' });
                target.style.transition = 'box-shadow 0.3s';
                target.style.boxShadow = `0 0 0 2px ${SUMMARY_COLORS[type] || '#34d399'}`;
                setTimeout(() => { if (target) target.style.boxShadow = ''; }, 1400);
            }
        }, 80);
    });

    // Clear jump highlight when switching away from context-fusion tab.
    $(document).off('click.clearJumpHighlight', '.wizard-tab').on('click.clearJumpHighlight', '.wizard-tab', function () {
        const tab = $(this).data('tab');
        if (tab !== 'context-fusion') {
            sandboxJumpHighlight = null;
            $('#wizard-jump-to-end-btn').css('display', 'none');
        }
    });

    // Auto-save on fusion profile change
    $(document).off('change', '#wizard-fusion-profile').on('change', '#wizard-fusion-profile', function () {
        saveConfig(true); // Silent save
    });

    // Live-apply modal width/height as the user types, and silent-save on change.
    $(document).off('input', '#wizard-ui-width, #wizard-ui-height').on('input', '#wizard-ui-width, #wizard-ui-height', function () {
        config.uiWidth = Math.max(30, Math.min(100, parseInt($('#wizard-ui-width').val()) || 90));
        config.uiHeight = Math.max(30, Math.min(100, parseInt($('#wizard-ui-height').val()) || 95));
        applyModalSize();
    });
    $(document).off('change', '#wizard-ui-width, #wizard-ui-height').on('change', '#wizard-ui-width, #wizard-ui-height', function () {
        saveConfig(true); // Silent save
    });

    // Sync theme color input and picker
    $(document).off('input', '#wizard-ui-color-picker').on('input', '#wizard-ui-color-picker', function () {
        const val = $(this).val();
        $('#wizard-ui-color').val(val);
        // Apply color dynamically in real-time
        document.documentElement.style.setProperty('--wizard-primary', val);
        const rgb = hexToRgb(val) || { r: 163, g: 132, b: 46 };
        document.documentElement.style.setProperty('--wizard-primary-rgb', `${rgb.r}, ${rgb.g}, ${rgb.b}`);
        $('#wizard-modal-overlay').css({
            '--wizard-primary': val,
            '--wizard-primary-rgb': `${rgb.r}, ${rgb.g}, ${rgb.b}`
        });
    });

    $(document).off('change', '#wizard-ui-color-picker').on('change', '#wizard-ui-color-picker', function () {
        saveConfig(true); // Silent save when finished choosing a color
    });

    $(document).off('input', '#wizard-ui-color').on('input', '#wizard-ui-color', function () {
        const val = $(this).val().trim();
        if (/^#[0-9a-fA-F]{6}$/.test(val)) {
            $('#wizard-ui-color-picker').val(val);
            // Apply color dynamically in real-time
            document.documentElement.style.setProperty('--wizard-primary', val);
            const rgb = hexToRgb(val) || { r: 163, g: 132, b: 46 };
            document.documentElement.style.setProperty('--wizard-primary-rgb', `${rgb.r}, ${rgb.g}, ${rgb.b}`);
            $('#wizard-modal-overlay').css({
                '--wizard-primary': val,
                '--wizard-primary-rgb': `${rgb.r}, ${rgb.g}, ${rgb.b}`
            });
        }
    });

    $(document).off('change', '#wizard-ui-color').on('change', '#wizard-ui-color', function () {
        const val = $(this).val().trim();
        if (/^#[0-9a-fA-F]{6}$/.test(val)) {
            saveConfig(true); // Silent save
        }
    });

    // 4. Test Connection and diagnostics (checkBackendConnection is module-scope
    //    so toggleModal can call it too — see definition above onChatChanged).
    $(document).off('click', '#wizard-btn-test-connection').on('click', '#wizard-btn-test-connection', async function () {
        toastr.info('正在测试与插件后端的连接...');
        const ok = await checkBackendConnection();
        if (ok) {
            toastr.success('与后端连接正常！');
        } else {
            toastr.error('无法连接至后端，请确认后台服务已启动。');
        }
    });

    // Mock Trigger Prompt Ready Hook
    $(document).off('click', '#wizard-btn-trigger-test').on('click', '#wizard-btn-trigger-test', async function () {
        const context = window.SillyTavern?.getContext();
        if (!context || !context.chatId) {
            toastr.warning('请先打开一个聊天以进行测试。');
            return;
        }
        toastr.info('正在模拟记忆路由检索...');
        try {
            writeLog("Manual diagnostic memory routing triggered by user.");
            const routingIndex = getTreePathIndex(memoryTree, { excludePinned: true });
            const routingLines = routingIndex ? routingIndex.split('\n') : [];
            writeLog(`[Diagnostic] Found ${routingLines.length} tree-index lines for routing index.`);
            routingLines.forEach(idx => writeLog(`[Diagnostic Index] ${idx}`));

            const chatHistory = context.chat;
            const recentMessages = chatHistory.slice(Math.max(0, chatHistory.length - 6));
            const recentText = recentMessages.map(m => `${m.role === 'assistant' ? 'Assistant' : 'User'}: ${m.content || m.mes || ""}`).join('\n');

            writeLog(`[Diagnostic Recent Turns]:\n${recentText}`);
            toastr.success('模拟路由执行完毕！请展开本页底部的“检索与归档日志”查看新记录。');
            loadLogs();
        } catch (e) {
            console.error(e);
            toastr.error('运行诊断测试失败: ' + e.message);
        }
    });

    // Toggle buttons inside the prompt editor overlay (visual on/off pills replacing
    // checkboxes). Values are read on Save, so the click handler only flips the
    // data-active attribute - no need to write config here.
    $(document).off('click.wizardFusionToggle', '#wizard-fusion-include-preset, #wizard-fusion-apply-filters, #wizard-fusion-include-records, #wizard-auto-fusion-tree-ops, #wizard-manual-fusion-tree-ops').on('click.wizardFusionToggle', '#wizard-fusion-include-preset, #wizard-fusion-apply-filters, #wizard-fusion-include-records, #wizard-auto-fusion-tree-ops, #wizard-manual-fusion-tree-ops', function () {
        const next = $(this).attr('data-active') !== 'true';
        $(this).attr('data-active', next ? 'true' : 'false');
    });
    $(document).off('change.wizardSceneSwitch', '#wizard-scene-switch-enabled').on('change.wizardSceneSwitch', '#wizard-scene-switch-enabled', function () {
        config.sceneSwitchEnabled = $(this).prop('checked');
        saveConfig(true);
    });

    // Custom Prompts editor overlay events
    $(document).off('click', '#wizard-prompt-edit-btn').on('click', '#wizard-prompt-edit-btn', function () {
        $('#wizard-prompt-historical').val(config.promptHistorical || '');
        $('#wizard-prompt-weekly').val(config.promptWeekly || '');
        $('#wizard-prompt-recap').val(config.promptRecap || '');
        renderRecapPreRegexRules();
        $('#wizard-fusion-include-preset').attr('data-active', config.fusionIncludePreset ? 'true' : 'false');
        $('#wizard-fusion-apply-filters').attr('data-active', config.fusionApplyFilters !== false ? 'true' : 'false');
        $('#wizard-fusion-include-records').attr('data-active', config.fusionIncludeRecords ? 'true' : 'false');
        $('#wizard-auto-fusion-tree-ops').attr('data-active', config.autoFusionTreeOps ? 'true' : 'false');
        $('#wizard-manual-fusion-tree-ops').attr('data-active', config.manualFusionTreeOps ? 'true' : 'false');
        $('#wizard-prompt-editor-overlay').css('display', 'flex');
    });

    // Insert {{history}} at the cursor of the last-focused fusion prompt textarea.
    $(document).off('click', '.wizard-fusion-history-chip').on('click', '.wizard-fusion-history-chip', function () {
        const token = $(this).data('token');
        // Target the most recently focused of the prompt textareas.
        let ta = document.activeElement;
        const ids = ['wizard-prompt-historical', 'wizard-prompt-weekly', 'wizard-prompt-recap'];
        if (!ta || !ids.includes(ta.id)) {
            ta = document.getElementById(lastFocusedFusionPrompt || 'wizard-prompt-historical');
        }
        if (!ta) return;
        const start = ta.selectionStart || 0;
        const end = ta.selectionEnd || 0;
        ta.value = ta.value.slice(0, start) + token + ta.value.slice(end);
        const pos = start + token.length;
        ta.focus();
        ta.setSelectionRange(pos, pos);
    });

    // Remember which fusion prompt textarea was focused (for the chip insert).
    $(document).off('focus.fusionPrompt', '#wizard-prompt-historical, #wizard-prompt-weekly, #wizard-prompt-recap').on('focus.fusionPrompt', '#wizard-prompt-historical, #wizard-prompt-weekly, #wizard-prompt-recap', function () {
        lastFocusedFusionPrompt = this.id;
    });

    $(document).off('click', '#wizard-prompt-editor-cancel, #wizard-prompt-editor-close').on('click', '#wizard-prompt-editor-cancel, #wizard-prompt-editor-close', function () {
        $('#wizard-prompt-editor-overlay').css('display', 'none');
    });

    $(document).off('click', '#wizard-prompt-editor-save').on('click', '#wizard-prompt-editor-save', async function () {
        config.promptHistorical = $('#wizard-prompt-historical').val().trim();
        config.promptWeekly = $('#wizard-prompt-weekly').val().trim();
        config.promptRecap = $('#wizard-prompt-recap').val().trim();
        // commitRecapPreRegexRules() keeps config.recapPreRegexRules in sync with the editor rows.
        commitRecapPreRegexRules();
        config.fusionIncludePreset = $('#wizard-fusion-include-preset').attr('data-active') === 'true';
        config.fusionApplyFilters = $('#wizard-fusion-apply-filters').attr('data-active') === 'true';
        config.fusionIncludeRecords = $('#wizard-fusion-include-records').attr('data-active') === 'true';
        config.autoFusionTreeOps = $('#wizard-auto-fusion-tree-ops').attr('data-active') === 'true';
        config.manualFusionTreeOps = $('#wizard-manual-fusion-tree-ops').attr('data-active') === 'true';
        $('#wizard-prompt-editor-overlay').css('display', 'none');
        await saveConfig();
        // Toggling "apply filters" changes which floors/content count -> refresh.
        updateFusionTokenStats();
    });

    // Fusion variable template inline editor events. The editor expands inline
    // directly below the 编辑融合变量模板 button (not as a full-screen overlay).
    $(document).off('click', '#wizard-fusion-template-edit-btn').on('click', '#wizard-fusion-template-edit-btn', function () {
        const inline = $('#wizard-fusion-template-inline');
        const isOpen = inline.css('display') !== 'none';
        if (isOpen) {
            // Toggle closed when the button is clicked again.
            inline.css('display', 'none');
            return;
        }
        const macroName = config.macroFusion || 'memory';
        $('#wizard-fusion-template-macro-label').text(`{{${macroName}}}`);
        $('#wizard-fusion-template-textarea').val(config.fusionTemplate !== undefined ? config.fusionTemplate : '');
        inline.css('display', 'flex');
        $('#wizard-fusion-template-textarea').focus();
    });

    $(document).off('click', '#wizard-fusion-template-cancel').on('click', '#wizard-fusion-template-cancel', function () {
        $('#wizard-fusion-template-inline').css('display', 'none');
    });

    // Insert a token at the cursor position in the template textarea
    $(document).off('click', '.wizard-fusion-token-chip').on('click', '.wizard-fusion-token-chip', function () {
        const token = $(this).data('token');
        const textarea = document.getElementById('wizard-fusion-template-textarea');
        if (!textarea) return;
        const start = textarea.selectionStart || 0;
        const end = textarea.selectionEnd || 0;
        const val = textarea.value;
        textarea.value = val.slice(0, start) + token + val.slice(end);
        const newPos = start + token.length;
        textarea.focus();
        textarea.setSelectionRange(newPos, newPos);
    });

    $(document).off('click', '#wizard-fusion-template-save').on('click', '#wizard-fusion-template-save', async function () {
        config.fusionTemplate = $('#wizard-fusion-template-textarea').val();
        $('#wizard-fusion-template-inline').css('display', 'none');
        await saveConfig();
        toastr.success('融合变量模板已保存！');
    });

    // 设为融合起始/结束楼层
    $(document).off('click', '.wizard-set-fusion-start-btn').on('click', '.wizard-set-fusion-start-btn', function () {
        const floor = $(this).data('floor');
        $('#wizard-fusion-start').val(floor).trigger('change');
        config.fusionStart = String(floor);
        saveConfig(true);
    });
    $(document).off('click', '.wizard-set-fusion-end-btn').on('click', '.wizard-set-fusion-end-btn', function () {
        const floor = $(this).data('floor');
        $('#wizard-fusion-end').val(floor).trigger('change');
        config.fusionEnd = String(floor);
        saveConfig(true);
    });

    // Per-message fullscreen editor events (each sandbox reply opens its own).
    $(document).off('click', '.wizard-msg-fullscreen-btn').on('click', '.wizard-msg-fullscreen-btn', function () {
        const index = parseInt($(this).data('index'));
        const msg = sandboxChatContext[index];
        if (!msg) return;
        const contentKey = msg.content !== undefined ? 'content' : 'mes';
        const name = msgName(msg);
        $('#wizard-msg-fullscreen-title').html(`<i class="fa-solid fa-expand"></i> 全屏编辑 #${index} (楼层) - ${name}`);
        $('#wizard-msg-fullscreen-index').val(index);
        $('#wizard-msg-fullscreen-textarea').val(msg[contentKey] || "");
        $('#wizard-msg-fullscreen-overlay').css('display', 'flex');
        $('#wizard-msg-fullscreen-textarea').focus();
    });

    $(document).off('click', '#wizard-msg-fullscreen-cancel, #wizard-msg-fullscreen-close').on('click', '#wizard-msg-fullscreen-cancel, #wizard-msg-fullscreen-close', function () {
        $('#wizard-msg-fullscreen-overlay').css('display', 'none');
    });

    $(document).off('click', '#wizard-msg-fullscreen-save').on('click', '#wizard-msg-fullscreen-save', function () {
        const index = parseInt($('#wizard-msg-fullscreen-index').val());
        const newVal = $('#wizard-msg-fullscreen-textarea').val();
        if (sandboxChatContext[index]) {
            const contentKey = sandboxChatContext[index].content !== undefined ? 'content' : 'mes';
            sandboxChatContext[index][contentKey] = newVal;
            // Reflect in the inline textarea without a full re-render.
            $(`.context-msg-textarea[data-index="${index}"]`).val(newVal);
            // Session-only edit (discarded on reload); reveal the apply button.
            if (!sandboxEditsDirty) {
                sandboxEditsDirty = true;
                $('#wizard-context-apply-btn').css('display', '');
            }
            updateFusionTokenStats();
            toastr.success('已保存到沙盒（点「应用更改到聊天」写回聊天）。');
        }
        $('#wizard-msg-fullscreen-overlay').css('display', 'none');
    });

    // Node Content fullscreen editor: opens with the current 记忆正文 textarea
    // value, and "应用到正文" copies it back (final persistence still needs 保存节点).
    $(document).off('click', '#wizard-node-content-fullscreen-btn').on('click', '#wizard-node-content-fullscreen-btn', function () {
        $('#wizard-node-content-fullscreen-textarea').val($('#wizard-node-content').val());
        $('#wizard-node-content-fullscreen-overlay').css('display', 'flex');
        $('#wizard-node-content-fullscreen-textarea').focus();
    });

    $(document).off('click', '#wizard-node-content-fullscreen-cancel, #wizard-node-content-fullscreen-close').on('click', '#wizard-node-content-fullscreen-cancel, #wizard-node-content-fullscreen-close', function () {
        $('#wizard-node-content-fullscreen-overlay').css('display', 'none');
    });

    $(document).off('click', '#wizard-node-content-fullscreen-save').on('click', '#wizard-node-content-fullscreen-save', function () {
        $('#wizard-node-content').val($('#wizard-node-content-fullscreen-textarea').val());
        $('#wizard-node-content-fullscreen-overlay').css('display', 'none');
        toastr.info('正文已更新，请点击"保存节点"以持久化。');
    });
}

// Ping the backend plugin and update the diagnostic "后端服务连接状态" line.
// Module-scope so both toggleModal (on open) and the 测试连接 button can call it.
async function checkBackendConnection() {
    const statusEl = $('#wizard-status-connection');
    try {
        const res = await fetch('/api/plugins/st-memory-wizzard/get-config', {
            method: 'POST',
            headers: getWizardHeaders(),
            body: JSON.stringify({})
        });
        if (res.ok) {
            statusEl.html('<span style="color: #10b981;"><i class="fa-solid fa-circle-check"></i> 正常连接 (通信成功)</span>');
            return true;
        } else {
            statusEl.html('<span style="color: #ef4444;"><i class="fa-solid fa-triangle-exclamation"></i> 连接异常 (HTTP ' + res.status + ')</span>');
            return false;
        }
    } catch (e) {
        statusEl.html('<span style="color: #ef4444;"><i class="fa-solid fa-triangle-exclamation"></i> 无法连接到后端</span>');
        return false;
    }
}

// Modal Visibility toggle
function toggleModal(show) {
    const overlay = $('#wizard-modal-overlay');
    const icon = $('#wizard-top-bar-btn .drawer-icon');

    if (show) {
        overlay.css('display', 'flex');
        icon.removeClass('closedIcon').addClass('openIcon');

        // Load configurations & connection profiles
        loadConfig();

        // Update diagnostic UI fields
        checkBackendConnection();
        $('#wizard-status-chat-id').text(activeChatId ? activeChatId.replace(/\.png$/i, '') : '无 (未打开聊天)');

        const totalNodes = getAllNodes(memoryTree).length;
        $('#wizard-status-nodes-count').text(totalNodes + ' 个节点');

        if (activeChatId) {
            renderTreeView(memoryTree, $('#wizard-tree-root'));
            loadSummaries();
            writeLog('Modal content loaded/refreshed.');
        } else {
            $('#wizard-tree-root').html('<li style="color: #9ca3af; padding: 12px; text-align: center;"><i class="fa-solid fa-info-circle" style="margin-right: 6px;"></i>请先打开一个聊天以加载记忆树。</li>');
        }
    } else {
        overlay.css('display', 'none');
        icon.removeClass('openIcon').addClass('closedIcon');
    }
}

// Ensure Modal is in the DOM
async function ensureModalInDOM() {
    if ($('#wizard-modal-overlay').length > 0) return;

    try {
        writeLog('Loading settings.html...');
        const response = await fetch('/scripts/extensions/third-party/st-memory-wizzard/settings.html');
        if (!response.ok) {
            throw new Error(`Failed to fetch settings.html: ${response.statusText}`);
        }
        const htmlText = await response.text();

        // Wrap it in overlay and append to body
        const overlay = $('<div id="wizard-modal-overlay" class="wizard-modal-overlay"></div>');
        overlay.html(htmlText);
        $('body').append(overlay);

        // Bind close event
        $(document).on('click', '#wizard-modal-close-btn', function () {
            toggleModal(false);
        });

        // Close when clicking outside content (on overlay itself)
        // Check both mousedown and mouseup to prevent accidental closing when dragging textareas
        let isMouseDownOnOverlay = false;
        overlay.on('mousedown', function (e) {
            isMouseDownOnOverlay = (e.target === this);
        });
        overlay.on('mouseup', function (e) {
            if (isMouseDownOnOverlay && e.target === this) {
                toggleModal(false);
            }
            isMouseDownOnOverlay = false;
        });

        // Close on Escape key press
        $(document).on('keydown', function (e) {
            if (e.key === 'Escape') {
                toggleModal(false);
            }
        });

        // Re-register form/settings/tab listeners to ensure they target the newly added elements
        registerNodeFormListeners();

        writeLog('Modal overlay successfully injected into DOM.');
    } catch (e) {
        console.error(`${LOG_PREFIX} Failed to load settings.html`, e);
        writeLog(`Failed to load settings.html: ${e.message}`, 'ERROR');
    }
}

// Add a button on the top bar, next to the extensions icon
async function addTopBarButton() {
    if ($('#wizard-top-bar-btn').length > 0) return;

    // Create top bar button matching SillyTavern's theme (structured as a drawer toggle)
    const topBtn = $(`
        <div id="wizard-top-bar-btn" class="drawer" style="width: auto; margin: 0 -5px;">
            <div class="drawer-toggle drawer-header" style="display: flex; align-items: center; justify-content: center; width: 40px; height: 100%; cursor: pointer;">
                <div class="drawer-icon fa-solid fa-brain fa-fw closedIcon" title="Memory Wizard 记忆之术" style="font-size: 1.25rem; position: relative; top: 5px;"></div>
            </div>
        </div>
    `);

    const extensionsBtn = $('#extensions-settings-button');
    if (extensionsBtn.length > 0) {
        extensionsBtn.before(topBtn);
    } else {
        $('#top-bar').append(topBtn);
    }

    // Bind click event to toggle the custom modal
    topBtn.on('click', async function (e) {
        e.stopPropagation();
        await ensureModalInDOM();
        const isOpen = $('#wizard-modal-overlay').css('display') === 'flex';
        toggleModal(!isOpen);
    });
}

function consumeSessionNewMarkers(tree) {
    let consumed = false;
    function walk(nodes) {
        if (!Array.isArray(nodes)) return;
        nodes.forEach(n => {
            if (n && n.__sessionNew) {
                aiNewNodePathsThisSession.add(n.path);
                delete n.__sessionNew;
                consumed = true;
            }
            if (n && n.children) walk(n.children);
        });
    }
    walk(tree);
    return consumed;
}

function migrateTreeStructure(tree) {
    if (!Array.isArray(tree)) return { migrated: false, tree };

    // Find "身份核" at the root level
    const identityNode = tree.find(n => n.path === '身份核');
    if (!identityNode) {
        return { migrated: false, tree };
    }

    if (!identityNode.children) {
        identityNode.children = [];
    }

    let migrated = false;
    const newTree = [];

    for (const node of tree) {
        if (node.path === '身份核') {
            newTree.push(node);
            continue;
        }

        // Check if the node is "当前进行中事项", "豁免三条", or starts with "身份核/"
        if (node.path && (node.path === '当前进行中事项' || node.path === '豁免三条' || node.path.startsWith('身份核/'))) {
            // Adjust path if it doesn't start with '身份核/'
            if (!node.path.startsWith('身份核/')) {
                node.path = '身份核/' + node.path;
            }

            // Check if it already exists in identityNode's children (by title or path)
            const exists = identityNode.children.some(c => c.path === node.path || c.title === node.title);
            if (!exists) {
                identityNode.children.push(node);
            }
            migrated = true;
        } else {
            newTree.push(node);
        }
    }

    return { migrated, tree: newTree };
}

// Resolve a STABLE storage key for the current character/group that does NOT
// change across chat branches. SillyTavern's chatId is the per-branch chat
// filename, so it differs for every fork/branch — keying plugin data by it makes
// memory "vanish" when you switch branches. Instead we key by the character's
// avatar filename (unique & stable) for solo chats, or the group id for groups.
// Falls back to the raw chatId only when no character/group context exists.
function resolveStorageKey() {
    const context = window.SillyTavern?.getContext();
    if (!context) return "";
    // Group chat: the group id is stable across all of the group's branches.
    if (context.groupId) {
        return `group_${context.groupId}`;
    }
    // Solo chat: the avatar filename is the canonical stable id for a character
    // (characterId is just an array index and shifts as characters are added /
    // removed). characters[characterId].avatar is unique and persistent.
    const chars = context.characters;
    const chid = context.characterId;
    if (Array.isArray(chars) && chid !== undefined && chid_valid(chid, chars) && chars[chid]?.avatar) {
        return `char_${chars[chid].avatar}`;
    }
    // No resolvable character — fall back to the raw chat id.
    return context.chatId || "";
}
function chid_valid(chid, chars) {
    const n = parseInt(chid);
    return !isNaN(n) && n >= 0 && n < chars.length;
}

// ══════════════════════════════════════════════════════════════════════
// REGION: 初始化 / chat 切换（onChatChanged：迁移 key + 载树 + 合并共享 + 载摘要）
// ══════════════════════════════════════════════════════════════════════
// Reload extension when chat changes
async function onChatChanged() {
    const context = window.SillyTavern?.getContext();
    const newChatId = resolveStorageKey();

    // Ensure top bar button is present
    await addTopBarButton();

    if (!newChatId) {
        activeChatId = "";
        return;
    }

    if (activeChatId !== newChatId) {
        activeChatId = newChatId;
        writeLog(`Active chat changed to "${activeChatId}". Loading tree and summaries...`);

        // One-time migration: when this stable character key has no data yet but
        // the legacy per-branch chatId file does, copy the legacy data over so
        // existing memory survives the switch to stable keying. The legacy chatId
        // is the real ST chat filename for the currently open branch.
        const legacyChatId = context?.chatId || "";
        if (legacyChatId && legacyChatId !== newChatId) {
            try {
                await fetch('/api/plugins/st-memory-wizzard/migrate-key', {
                    method: 'POST',
                    headers: getWizardHeaders(),
                    body: JSON.stringify({ fromChatId: legacyChatId, toChatId: newChatId })
                });
            } catch (e) {
                console.error(`${LOG_PREFIX} Key migration request failed`, e);
            }
        }

        // Reload global config into the UI after activeChatId changes so per-character
        // sticky fields (notably fusion start/end) restore this character/group's saved range.
        await loadConfig();

        // Reset batch-edit selection when switching chats (paths belong to the
        // previous tree).
        selectedPaths.clear();
        lastTreeMoveUndoSnapshot = null;
        updateUndoMoveButton();
        treeSelectionMode = false;
        $('#wizard-tree-select-mode-btn').removeClass('wizard-btn-warning');
        $('#wizard-tree-select-mode-btn').find('i').attr('class', 'fa-regular fa-square-check');
        updateTreeSelectionUI();

        // Load any pending AI shrink suggestions saved for this chat so the green
        // suggestion rows reappear after a refresh / chat switch.
        loadAiShrinkPending();

        // Fetch tree from server
        treeLoadInProgress = true; // any saveTreeToServer() below must not touch the shared doc yet
        try {
            const res = await fetch('/api/plugins/st-memory-wizzard/get-tree', {
                method: 'POST',
                headers: getWizardHeaders(),
                body: JSON.stringify({ chatId: activeChatId })
            });
            const data = await res.json();
            if (Array.isArray(data)) {
                memoryTree = data;
                writeLog(`Tree loaded: ${memoryTree.length} root nodes.`);

                // Auto-migrate tree structure if needed
                const migration = migrateTreeStructure(memoryTree);
                if (migration.migrated) {
                    memoryTree = migration.tree;
                    writeLog(`Auto-migrated tree structure to nest identity subnodes. Saving...`);
                    await saveTreeToServer();
                }
                if (consumeSessionNewMarkers(memoryTree)) {
                    writeLog('Consumed one-shot __sessionNew marker(s) for this frontend session. Saving cleanup...');
                    await saveTreeToServer();
                }
            } else {
                writeLog(`Unexpected tree response: ${JSON.stringify(data).slice(0, 200)}`, 'WARNING');
                memoryTree = [];
            }

            // Merge the global shared branch ("共有记忆") into the top of this tree so
            // every character/group sees and edits the same shared root. Done after any
            // load-time migration saves (which persist only the per-character forest).
            await fetchAndMergeSharedTree();

            // Fresh tree data → next full-tree render should start fully collapsed.
            treeCollapseInitialized = false;

            // Render the tree if the root is in the DOM
            const treeRoot = $('#wizard-tree-root');
            if (treeRoot.length > 0) {
                renderTreeView(memoryTree, treeRoot);
            }
        } catch (e) {
            console.error(`${LOG_PREFIX} Failed to load tree`, e);
            writeLog(`Failed to load tree: ${e.message}`, 'ERROR');
        } finally {
            treeLoadInProgress = false; // load done — shared-tree saves may proceed again
        }

        // Fetch summaries. loadSummaries() also recomputes floorRemapState against the
        // current chat (the annotation is permanently on), so the "现 A-B 楼" labels are
        // correct right after a chat switch / page refresh without any manual action.
        // It compares each record's stored send-time range to the current chat's
        // send_dates — no anchors, no index math, no auto-shift; coveredFloors always
        // keep their ORIGINAL numbers (the remap is display-only).
        await loadSummaries();

        // Fetch sandbox chat context, then sync it to the live chat if the snapshot's
        // floor count is stale (chat grew / shrank since it was last saved).
        await loadSandboxChatFromServer();
        await syncSandboxIfStale();
    }
}

// ----------------------------------------------------
// EXTENSION INITIALIZATION
// ----------------------------------------------------
jQuery(async () => {
    console.log(`${LOG_PREFIX} Loading frontend script...`);

    // Load modal overlay into DOM immediately
    await ensureModalInDOM();

    // Add top bar button
    await addTopBarButton();

    // Bind listeners
    registerNodeFormListeners();

    // Load configs into memory
    await loadConfig();

    // Hook listeners
    const eventSource = window.SillyTavern.getContext().eventSource;
    const eventTypes = window.SillyTavern.getContext().eventTypes;

    eventSource.on(eventTypes.GENERATION_STARTED, onGenerationStartedSceneSwitch);
    eventSource.on(eventTypes.CHAT_COMPLETION_PROMPT_READY, onChatCompletionPromptReady);
    eventSource.on(eventTypes.GENERATION_AFTER_COMMANDS, injectMemoryAsHistory);
    eventSource.on(eventTypes.CHARACTER_MESSAGE_RENDERED, onMessageReceived);
    eventSource.on(eventTypes.CHAT_CHANGED, onChatChanged);

    // Initial load
    await onChatChanged();

    // 同步伪造模式 ST regex 状态（用户上次保存时若已开启，启动后立即确保脚本就位）。
    syncFakeChatRegex();

    console.log(`${LOG_PREFIX} Loaded successfully!`);
});
