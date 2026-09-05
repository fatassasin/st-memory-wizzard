import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Router } from 'express';
import { jsonParser } from '../../src/express-common.js';

const MODULE_ID = 'st-memory-wizzard';
const LOG_PREFIX = `[Memory Wizard Plugin]`;

const pluginRootDir = path.join(process.cwd(), 'data', 'default-user', 'extensions', 'st-memory-wizzard');
if (!fs.existsSync(pluginRootDir)) {
    fs.mkdirSync(pluginRootDir, { recursive: true });
}

// All persistent JSON documents live inside the Backups subfolder so they are
// not scattered across the plugin root.
const storageDir = path.join(pluginRootDir, 'Backups');
if (!fs.existsSync(storageDir)) {
    fs.mkdirSync(storageDir, { recursive: true });
}

// One-time migration: move any pre-existing data documents that used to live in
// the plugin root into the Backups folder. We only move files matching our known
// data-file patterns so that extension files like manifest.json / *.js / *.css /
// *.html are never touched.
const DATA_FILE_PATTERNS = [
    /^config\.json$/,
    /^memory_tree.*\.json$/,
    /^summaries.*\.json$/,
    /^sandbox_chat.*\.json$/,
    /^shared_memory_tree\.json$/,
];
try {
    const rootEntries = fs.readdirSync(pluginRootDir, { withFileTypes: true });
    for (const entry of rootEntries) {
        if (!entry.isFile()) continue;
        if (!DATA_FILE_PATTERNS.some(re => re.test(entry.name))) continue;
        const src = path.join(pluginRootDir, entry.name);
        const dest = path.join(storageDir, entry.name);
        if (!fs.existsSync(dest)) {
            try {
                fs.renameSync(src, dest);
                console.log(`${LOG_PREFIX} Migrated ${entry.name} into Backups/`);
            } catch (e) {
                console.error(`${LOG_PREFIX} Failed to migrate ${entry.name}:`, e);
            }
        }
    }
} catch (e) {
    console.error(`${LOG_PREFIX} Storage migration scan failed:`, e);
}

// Ensure category structure exists
const INITIAL_CATEGORIES = [
    { 
        path: "身份核", 
        title: "身份核", 
        hint: "聊关于我的设定/身份时读我", 
        pinned: true, 
        content: "身份核心设定。", 
        updated: new Date().toISOString().slice(0, 10), 
        children: [
            { path: "身份核/当前进行中事项", title: "当前进行中事项", hint: "聊目前有什么任务/在做什么时读我", pinned: true, content: "当前进行中事项。", updated: new Date().toISOString().slice(0, 10), children: [] },
            { path: "身份核/豁免三条", title: "豁免三条", hint: "我的行为规范/豁免条款", pinned: true, content: "豁免三条：不违反规则，保护设定，不背叛信赖。", updated: new Date().toISOString().slice(0, 10), children: [] }
        ] 
    },
    { path: "知识", title: "知识", hint: "聊具体概念/理论/事实时读我", pinned: false, content: "", updated: new Date().toISOString().slice(0, 10), children: [] },
    { path: "关系与情感", title: "关系与情感", hint: "聊与你的经历/情感/好恶时读我", pinned: false, content: "", updated: new Date().toISOString().slice(0, 10), children: [] },
    { path: "现实事件", title: "现实事件", hint: "聊现实新闻/天气/发生的具体事件时读我", pinned: false, content: "", updated: new Date().toISOString().slice(0, 10), children: [] },
    { path: "项目", title: "项目", hint: "聊我们在协作的计划/写代码/做视频时读我", pinned: false, content: "", updated: new Date().toISOString().slice(0, 10), children: [] },
    { path: "挂账", title: "挂账", hint: "聊还未完成的讨论/遗留账目/待办时读我", pinned: false, content: "", updated: new Date().toISOString().slice(0, 10), children: [] }
];

// The shared branch is one global root every character/group sees and can edit.
// It lives in a single file (shared_memory_tree.json) independent of any chat key,
// merged into each character's tree on load and split back out on save. Defaults to
// one pinned root "共有记忆" so it behaves like a persona-style always-on branch.
const SHARED_ROOT_PATH = "共有记忆";
const INITIAL_SHARED_TREE = [
    {
        path: SHARED_ROOT_PATH,
        title: SHARED_ROOT_PATH,
        hint: "所有角色共享的记忆，聊到跨角色通用的设定/事实时读我",
        pinned: true,
        shared: true,
        content: "",
        updated: new Date().toISOString().slice(0, 10),
        children: []
    }
];

const DEFAULT_CONFIG = {
    N_RECAP: 10,
    N_MERGE: 100,
    N_MELON: 500,
    N_SHIJI: 20,
    K_RECALL: 5,
    TOKEN_CAP: 8000,
    PIN_BUDGET: 3000,
    TIMEOUT_MS: 8000,
    SUPP_READ: 1,
    autoInjectRecall: true,
    recordTagName: "record",
    recallTagName: "recall",
    promptRouting: "",
    promptRecall: "",
    promptTreeFill: "",
    fableProfile: "",
    flashProfile: "",
    fusionProfile: "",
    isEnabled: true,
    enablePreFlash: true,
    enablePostFlash: true,
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

(以上为记忆树路径索引)`,
    uiColor: "#a3842e",
    uiWidth: 90,
    uiHeight: 95,
    sandboxMatchMode: "keyword",
    promptHistorical: `You are a professional historian. Your task is to merge and summarize the following numbered chat messages into a single historical summary (史记) of about 300 words.
Focus on major character development, plot points, and the grand narrative arc. Output only the summarized text directly in Chinese, without any JSON format, codeblock markdown tags, or prefix/suffix.`,
    promptWeekly: `You are a professional chronicler. Your task is to merge and summarize the following numbered chat messages into a weekly summary (周记) of about 150-200 words.
Focus on recent key interactions, character moods, and unresolved questions. Output only the summarized text directly in Chinese, without any JSON format, codeblock markdown tags, or prefix/suffix.`,
    promptRecap: `Write a storyline recap of the following numbered chat messages.
Focus on the dramatic arc, conversation tone, and quick recap of recent events. Max 200 Chinese characters. Output only the recap text directly in Chinese, without any JSON format, codeblock markdown tags, or prefix/suffix.`,
    // ── 世界书面板（World Book）── 镜像前端 config 默认值。
    wbProfile: "",
    wbMultiProfile: "",
    wbPromptReduce: "",
    wbPromptComplete: "",
    wbPromptRewrite: "",
    wbPromptMulti: "",
    wbAllowChangeExisting: false,
    wbAllowAddNew: false,
    wbAllowDeleteMerge: false,
    wbSelectedBook: "",
    wbLastSingleMode: "reduce",
    wbFollowCharBook: true
};

/**
 * Helper to load file safely
 */
function loadJsonFile(fileName, defaultValue) {
    const filePath = path.join(storageDir, fileName);
    if (!fs.existsSync(filePath)) {
        return defaultValue;
    }
    try {
        const content = fs.readFileSync(filePath, 'utf8');
        return JSON.parse(content);
    } catch (err) {
        console.error(`${LOG_PREFIX} Error parsing file ${fileName}:`, err);
        return defaultValue;
    }
}

// Timestamped historical snapshots live in Backups/history so they don't clutter
// the live documents in the Backups root.
const historyDir = path.join(storageDir, 'history');
if (!fs.existsSync(historyDir)) {
    fs.mkdirSync(historyDir, { recursive: true });
}

const logPath = path.join(pluginRootDir, 'wizzard.log');
const logStatePath = path.join(storageDir, 'wizzard_log_state.json');

// --- Local reverse-proxy gateway (ST-ClaudeCacheGateway) lifecycle ---
// The gateway ships at <pluginRootDir>/gateway/server.js (copied from
// 反代网关例子/ST-ClaudeCacheGateway-master). The frontend can't spawn
// processes, so we expose start/stop/status endpoints here. The gateway runs
// detached so it survives an ST restart; we only keep a handle to stop it
// within the same ST process lifetime.
const gatewayDir = path.join(pluginRootDir, 'gateway');
const gatewayServerFile = path.join(gatewayDir, 'server.js');
const GATEWAY_HOST = process.env.STMW_GATEWAY_HOST || '127.0.0.1';
const GATEWAY_PORT = Number(process.env.STMW_GATEWAY_PORT || 8788);
const gatewayHealthUrl = `http://${GATEWAY_HOST}:${GATEWAY_PORT}/health`;
let gatewayProcess = null;
let gatewayLogPath = path.join(pluginRootDir, 'gateway.log');

async function isGatewayHealthy() {
    try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 1500);
        const r = await fetch(gatewayHealthUrl, { method: 'GET', signal: ctrl.signal });
        clearTimeout(timer);
        return r.ok;
    } catch {
        return false;
    }
}

function beijingLogBucketKey(date = new Date()) {
    const bjt = new Date(date.getTime() + 8 * 60 * 60 * 1000);
    if (bjt.getUTCHours() < 6) {
        bjt.setUTCDate(bjt.getUTCDate() - 1);
    }
    return bjt.toISOString().slice(0, 10);
}

function clearLogIfDue() {
    const key = beijingLogBucketKey();
    let state = {};
    try {
        if (fs.existsSync(logStatePath)) {
            state = JSON.parse(fs.readFileSync(logStatePath, 'utf8')) || {};
        }
    } catch (err) {
        state = {};
    }

    if (state.lastClearBucket === key) return;

    try {
        fs.writeFileSync(logPath, '', 'utf8');
        fs.writeFileSync(logStatePath, JSON.stringify({ lastClearBucket: key, clearedAt: new Date().toISOString() }, null, 2), 'utf8');
        console.log(`${LOG_PREFIX} Cleared wizzard.log for Beijing 06:00 daily rotation (${key}).`);
    } catch (err) {
        console.error(`${LOG_PREFIX} Failed to rotate wizzard.log:`, err);
    }
}

// Skip history snapshots for payloads larger than this (sandbox chat copies can
// be hundreds of MB; snapshotting them on every save would balloon disk usage).
// The live document is always written; only the timestamped snapshot is skipped.
const MAX_SNAPSHOT_BYTES = 5 * 1024 * 1024; // 5 MiB

/**
 * Helper to save file safely, and write a timestamped snapshot into Backups/history/
 */
function saveJsonFile(fileName, data) {
    const filePath = path.join(storageDir, fileName);
    const content = JSON.stringify(data, null, 2);
    try {
        fs.writeFileSync(filePath, content, 'utf8');

        // Write timestamped snapshot (skipped for oversized payloads)
        if (Buffer.byteLength(content, 'utf8') <= MAX_SNAPSHOT_BYTES) {
            const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
            const baseName = fileName.replace('.json', '');
            const snapshotName = `${baseName}_${ts}.json`;
            fs.writeFileSync(path.join(historyDir, snapshotName), content, 'utf8');
        }

        return true;
    } catch (err) {
        console.error(`${LOG_PREFIX} Error writing file ${fileName}:`, err);
        return false;
    }
}

/**
 * Initializes the plugin router.
 */
export async function init(router) {
    console.log(`${LOG_PREFIX} Initializing backend router...`);
    clearLogIfDue();
    setInterval(clearLogIfDue, 10 * 60 * 1000).unref?.();

    // Get config
    router.post('/get-config', jsonParser, (req, res) => {
        const config = loadJsonFile('config.json', DEFAULT_CONFIG);
        res.json(config);
    });

    // Save config
    router.post('/save-config', jsonParser, (req, res) => {
        const { config } = req.body;
        const success = saveJsonFile('config.json', config);
        res.json({ success });
    });

    // Get memory tree for a specific chat
    router.post('/get-tree', jsonParser, (req, res) => {
        const { chatId } = req.body;
        if (!chatId) {
            return res.status(400).json({ error: 'Missing chatId' });
        }
        const safeId = chatId.replace(/[^a-z0-9_-]/gi, '_');
        const tree = loadJsonFile(`memory_tree_${safeId}.json`, INITIAL_CATEGORIES);
        res.json(tree);
    });

    // Save memory tree for a specific chat
    router.post('/save-tree', jsonParser, (req, res) => {
        const { chatId, tree } = req.body;
        if (!chatId || !tree) {
            return res.status(400).json({ error: 'Missing chatId or tree' });
        }
        const safeId = chatId.replace(/[^a-z0-9_-]/gi, '_');
        const success = saveJsonFile(`memory_tree_${safeId}.json`, tree);
        res.json({ success });
    });

    // Get the global shared memory branch (same for every character/group). No chatId:
    // there is exactly one shared document.
    router.post('/get-shared-tree', jsonParser, (_req, res) => {
        const tree = loadJsonFile('shared_memory_tree.json', INITIAL_SHARED_TREE);
        res.json(Array.isArray(tree) ? tree : INITIAL_SHARED_TREE);
    });

    // Save the global shared memory branch. The frontend sends only the shared
    // sub-forest (the "共有记忆" root and its descendants), split back out of the
    // merged tree before saving the per-character document.
    router.post('/save-shared-tree', jsonParser, (req, res) => {
        const { tree } = req.body;
        if (!Array.isArray(tree)) {
            return res.status(400).json({ error: 'Missing or invalid shared tree' });
        }
        const success = saveJsonFile('shared_memory_tree.json', tree);
        res.json({ success });
    });

    // Get summaries and recap logs for a specific chat
    router.post('/get-summaries', jsonParser, (req, res) => {
        const { chatId } = req.body;
        if (!chatId) {
            return res.status(400).json({ error: 'Missing chatId' });
        }
        const safeId = chatId.replace(/[^a-z0-9_-]/gi, '_');
        const defaultSummaries = {
            recaps: [],
            weeklySummaries: [],
            historicalSummaries: [],
            lastArchivedIndex: 0
        };
        const summaries = loadJsonFile(`summaries_${safeId}.json`, defaultSummaries);
        res.json(summaries);
    });

    // Save summaries and recap logs
    router.post('/save-summaries', jsonParser, (req, res) => {
        const { chatId, summaries } = req.body;
        if (!chatId || !summaries) {
            return res.status(400).json({ error: 'Missing chatId or summaries' });
        }
        const safeId = chatId.replace(/[^a-z0-9_-]/gi, '_');
        const success = saveJsonFile(`summaries_${safeId}.json`, summaries);
        res.json({ success });
    });

    // Get sandbox chat context
    router.post('/get-sandbox-chat', jsonParser, (req, res) => {
        const { chatId } = req.body;
        if (!chatId) {
            return res.status(400).json({ error: 'Missing chatId' });
        }
        const safeId = chatId.replace(/[^a-z0-9_-]/gi, '_');
        const chat = loadJsonFile(`sandbox_chat_${safeId}.json`, []);
        res.json(chat);
    });

    // Save sandbox chat context
    router.post('/save-sandbox-chat', jsonParser, (req, res) => {
        const { chatId, chat } = req.body;
        if (!chatId || !chat) {
            return res.status(400).json({ error: 'Missing chatId or chat' });
        }
        const safeId = chatId.replace(/[^a-z0-9_-]/gi, '_');
        const success = saveJsonFile(`sandbox_chat_${safeId}.json`, chat);
        res.json({ success });
    });

    // One-time data migration: copy legacy per-branch chatId files to a new
    // stable storage key, but ONLY when the destination does not yet exist (so we
    // never overwrite live data). Covers memory tree, summaries, and sandbox chat.
    router.post('/migrate-key', jsonParser, (req, res) => {
        const { fromChatId, toChatId } = req.body;
        if (!fromChatId || !toChatId) {
            return res.status(400).json({ error: 'Missing fromChatId or toChatId' });
        }
        const fromSafe = fromChatId.replace(/[^a-z0-9_-]/gi, '_');
        const toSafe = toChatId.replace(/[^a-z0-9_-]/gi, '_');
        if (fromSafe === toSafe) {
            return res.json({ migrated: false, reason: 'same-key' });
        }
        const prefixes = ['memory_tree_', 'summaries_', 'sandbox_chat_'];
        const copied = [];
        for (const prefix of prefixes) {
            const src = path.join(storageDir, `${prefix}${fromSafe}.json`);
            const dest = path.join(storageDir, `${prefix}${toSafe}.json`);
            try {
                // Only migrate when the source exists and the destination does not.
                if (fs.existsSync(src) && !fs.existsSync(dest)) {
                    fs.copyFileSync(src, dest);
                    copied.push(`${prefix}${toSafe}.json`);
                    console.log(`${LOG_PREFIX} Migrated ${prefix}${fromSafe} -> ${prefix}${toSafe}`);
                }
            } catch (e) {
                console.error(`${LOG_PREFIX} Failed migrating ${prefix}:`, e);
            }
        }
        res.json({ migrated: copied.length > 0, copied });
    });

    // List available backup files of a given kind ('tree' | 'summaries') for the
    // manual-import picker. Scans both the Backups root (live per-key documents)
    // and Backups/history (timestamped snapshots). Returns name/size/mtime, newest
    // first, so the user can recover data from any branch or point in time.
    router.post('/list-backups', jsonParser, (req, res) => {
        const { kind } = req.body;
        const prefix = kind === 'tree' ? 'memory_tree_' : (kind === 'summaries' ? 'summaries_' : (kind === 'sandbox' ? 'sandbox_chat_' : null));
        if (!prefix) {
            return res.status(400).json({ error: 'Invalid kind (expected "tree" or "summaries")' });
        }
        const results = [];
        const scan = (dir, location) => {
            let entries;
            try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
            catch (e) { return; }
            for (const entry of entries) {
                if (!entry.isFile()) continue;
                if (!entry.name.startsWith(prefix) || !entry.name.endsWith('.json')) continue;
                try {
                    const st = fs.statSync(path.join(dir, entry.name));
                    results.push({ name: entry.name, location, size: st.size, mtime: st.mtimeMs });
                } catch (e) { /* skip unreadable */ }
            }
        };
        scan(storageDir, 'live');
        scan(historyDir, 'history');
        results.sort((a, b) => b.mtime - a.mtime); // newest first
        res.json({ backups: results });
    });

    // Read one backup file's content for manual import. The name + location are
    // validated against the same prefix/extension rules and resolved strictly
    // inside the expected directory to prevent path traversal.
    router.post('/read-backup', jsonParser, (req, res) => {
        const { kind, name, location } = req.body;
        const prefix = kind === 'tree' ? 'memory_tree_' : (kind === 'summaries' ? 'summaries_' : (kind === 'sandbox' ? 'sandbox_chat_' : null));
        if (!prefix) {
            return res.status(400).json({ error: 'Invalid kind' });
        }
        // Whitelist the filename shape; reject anything with path separators.
        if (typeof name !== 'string' || !name.startsWith(prefix) || !name.endsWith('.json')
            || name.includes('/') || name.includes('\\') || name.includes('..')) {
            return res.status(400).json({ error: 'Invalid backup name' });
        }
        const baseDir = location === 'history' ? historyDir : storageDir;
        const filePath = path.join(baseDir, name);
        // Defense in depth: ensure the resolved path is still inside baseDir.
        if (path.relative(baseDir, filePath).startsWith('..')) {
            return res.status(400).json({ error: 'Path escapes backup directory' });
        }
        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ error: 'Backup not found' });
        }
        try {
            const content = fs.readFileSync(filePath, 'utf8');
            res.json({ name, data: JSON.parse(content) });
        } catch (err) {
            console.error(`${LOG_PREFIX} Failed to read backup ${name}:`, err);
            res.status(500).json({ error: 'Failed to read or parse backup' });
        }
    });

    // Backfill realTimespan + coveredFloors for summary records that are missing
    // them, using the ORIGINAL floor send_dates from a (possibly very large) sandbox
    // backup. Done server-side so the multi-hundred-MB sandbox JSON never has to be
    // shipped to the browser. Body: { summaries, sandboxName, sandboxLocation }.
    // For each record (across recaps/weeklySummaries/historicalSummaries) that lacks
    // a usable realTimespan, we read its `source: "楼层 X-Y"` (or existing
    // coveredFloors), look up those original floor indices in the backup sandbox, and
    // compute realTimespan from their send_dates + set coveredFloors. Records that
    // already have a realTimespan are left untouched. Returns the patched summaries
    // plus a count of how many records were filled.
    router.post('/backfill-realtime', jsonParser, (req, res) => {
        const { summaries, sandboxName, sandboxLocation } = req.body;
        if (!summaries || typeof summaries !== 'object') {
            return res.status(400).json({ error: 'Missing summaries' });
        }
        const prefix = 'sandbox_chat_';
        if (typeof sandboxName !== 'string' || !sandboxName.startsWith(prefix) || !sandboxName.endsWith('.json')
            || sandboxName.includes('/') || sandboxName.includes('\\') || sandboxName.includes('..')) {
            return res.status(400).json({ error: 'Invalid sandbox name' });
        }
        const baseDir = sandboxLocation === 'history' ? historyDir : storageDir;
        const filePath = path.join(baseDir, sandboxName);
        if (path.relative(baseDir, filePath).startsWith('..')) {
            return res.status(400).json({ error: 'Path escapes backup directory' });
        }
        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ error: 'Sandbox backup not found' });
        }

        let chat;
        try {
            chat = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        } catch (err) {
            console.error(`${LOG_PREFIX} Backfill: failed to parse sandbox ${sandboxName}:`, err);
            return res.status(500).json({ error: 'Failed to read or parse sandbox backup' });
        }
        if (!Array.isArray(chat)) {
            return res.status(400).json({ error: 'Sandbox backup is not a chat array' });
        }

        // Parse a send_date into ms. Mirrors the frontend msgTimestamp(): handles ISO,
        // numbers, and ST's "January 12, 2026 4:17pm" (no space before am/pm).
        const tsOf = (msg) => {
            if (!msg) return NaN;
            if (typeof msg.send_date === 'number') return msg.send_date;
            const raw = msg.send_date || '';
            if (!raw) return NaN;
            let t = Date.parse(raw);
            if (isNaN(t)) t = Date.parse(String(raw).replace(/(\d)\s*(am|pm)\b/i, '$1 $2'));
            return isNaN(t) ? NaN : t;
        };
        // Format ms as "YYYY-MM-DD HH:mm" (matches the frontend formatTimestamp()).
        const fmt = (ms) => {
            const d = new Date(ms);
            const p = (n) => String(n).padStart(2, '0');
            return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
        };
        // Resolve a record's floor range from coveredFloors or a "楼层 X-Y" source.
        const floorsOf = (item) => {
            if (item && typeof item === 'object' && item.coveredFloors
                && typeof item.coveredFloors.lo === 'number' && typeof item.coveredFloors.hi === 'number') {
                return { lo: item.coveredFloors.lo, hi: item.coveredFloors.hi };
            }
            const src = (item && typeof item === 'object') ? (item.source || '') : '';
            const m = String(src).match(/楼层\s*(\d+)\s*-\s*(\d+)/);
            if (!m) return null;
            const a = parseInt(m[1]), b = parseInt(m[2]);
            if (isNaN(a) || isNaN(b)) return null;
            return { lo: Math.min(a, b), hi: Math.max(a, b) };
        };
        const hasRealTs = (item) => item && typeof item === 'object' && typeof item.realTimespan === 'string' && item.realTimespan.trim();

        let filled = 0, skippedNoFloors = 0, skippedNoTs = 0;
        const layerKeys = ['recaps', 'weeklySummaries', 'historicalSummaries'];
        for (const key of layerKeys) {
            const arr = summaries[key];
            if (!Array.isArray(arr)) continue;
            for (let i = 0; i < arr.length; i++) {
                let item = arr[i];
                if (typeof item === 'string') item = { text: item };
                if (hasRealTs(item)) continue; // already has time — leave untouched
                const r = floorsOf(item);
                if (!r) { skippedNoFloors++; arr[i] = item; continue; }
                const tsList = [];
                for (let f = r.lo; f <= r.hi && f < chat.length; f++) {
                    const t = tsOf(chat[f]);
                    if (!isNaN(t)) tsList.push(t);
                }
                if (!tsList.length) { skippedNoTs++; arr[i] = item; continue; }
                const min = Math.min(...tsList), max = Math.max(...tsList);
                item.realTimespan = (min === max) ? fmt(min) : `${fmt(min)} ~ ${fmt(max)}`;
                item.coveredFloors = { lo: r.lo, hi: r.hi };
                arr[i] = item;
                filled++;
            }
        }

        res.json({ summaries, filled, skippedNoFloors, skippedNoTs, sandboxLen: chat.length });
    });

    // Write a log entry
    router.post('/log', jsonParser, (req, res) => {
        clearLogIfDue();
        const { message, level } = req.body;
        const timestamp = new Date().toISOString();
        const logLine = `[${timestamp}] [${level || 'INFO'}] ${message}\n`;
        // The log stays in the plugin root (not Backups/) because the frontend log
        // viewer fetches it as a static asset from the extension root URL.
        try {
            fs.appendFileSync(logPath, logLine, 'utf8');
            res.json({ success: true });
        } catch (err) {
            console.error(`${LOG_PREFIX} Failed to write log:`, err);
            res.json({ success: false });
        }
    });

    // --- Gateway lifecycle endpoints ---
    // Start the local gateway if it isn't already running. Idempotent: if the
    // gateway health endpoint already responds, we don't spawn a duplicate.
    router.post('/gateway/start', async (_req, res) => {
        try {
            if (await isGatewayHealthy()) {
                return res.json({ ok: true, alreadyRunning: true, pid: null });
            }
            if (!fs.existsSync(gatewayServerFile)) {
                return res.status(500).json({ ok: false, error: `gateway/server.js not found at ${gatewayServerFile}` });
            }
            // Pipe gateway stdout/stderr into a rotating log file so the user can
            // diagnose startup failures (port in use, node missing, etc.).
            const logStream = fs.createWriteStream(gatewayLogPath, { flags: 'a' });
            logStream.write(`\n[${new Date().toISOString()}] === starting gateway ===\n`);
            const child = spawn(process.execPath, ['server.js'], {
                cwd: gatewayDir,
                env: {
                    ...process.env,
                    HOST: GATEWAY_HOST,
                    PORT: String(GATEWAY_PORT),
                },
                detached: true,
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            child.stdout?.on('data', d => logStream.write(d));
            child.stderr?.on('data', d => logStream.write(d));
            child.on('exit', (code, sig) => {
                logStream.write(`[${new Date().toISOString()}] gateway exited code=${code} sig=${sig}\n`);
                if (gatewayProcess === child) gatewayProcess = null;
            });
            child.on('error', e => {
                logStream.write(`[${new Date().toISOString()}] gateway spawn error: ${e.message}\n`);
                if (gatewayProcess === child) gatewayProcess = null;
            });
            gatewayProcess = child;
            // Detach so the gateway survives an ST shutdown; unref so this child
            // doesn't keep the ST event loop alive.
            try { child.unref(); } catch { /* noop */ }

            // Wait briefly for the health endpoint to come up.
            let healthy = false;
            for (let i = 0; i < 20; i++) {
                await new Promise(r => setTimeout(r, 250));
                if (await isGatewayHealthy()) { healthy = true; break; }
            }
            res.json({ ok: healthy, alreadyRunning: false, pid: child.pid, logPath: gatewayLogPath });
        } catch (err) {
            console.error(`${LOG_PREFIX} gateway/start failed:`, err);
            res.status(500).json({ ok: false, error: String(err?.message || err) });
        }
    });

    router.post('/gateway/stop', async (_req, res) => {
        try {
            if (!gatewayProcess) {
                // Even if we have no handle (e.g. ST restarted), report whether the
                // gateway is still reachable.
                const running = await isGatewayHealthy();
                return res.json({ ok: !running, stopped: !running, noHandle: true, stillRunning: running });
            }
            try { process.kill(gatewayProcess.pid); } catch { /* maybe already dead */ }
            gatewayProcess = null;
            res.json({ ok: true, stopped: true });
        } catch (err) {
            res.status(500).json({ ok: false, error: String(err?.message || err) });
        }
    });

    router.get('/gateway/status', async (_req, res) => {
        const healthy = await isGatewayHealthy();
        res.json({ ok: true, running: healthy, haveHandle: !!gatewayProcess, host: GATEWAY_HOST, port: GATEWAY_PORT, logPath: gatewayLogPath });
    });

    console.log(`${LOG_PREFIX} Backend router endpoints registered!`);
}

export async function exit() {
    console.log(`${LOG_PREFIX} Exiting backend plugin...`);
    // The gateway is spawned detached+unref so it survives an ST restart; we
    // intentionally do NOT kill it here. Use the /gateway/stop endpoint (while
    // ST is running) to stop it explicitly.
}

const stMemoryWizzardModule = {
    init,
    exit,
    info: {
        id: MODULE_ID,
        name: 'ST Memory Wizard',
        description: 'Deterministic memory hierarchical indexing system for SillyTavern.'
    }
};

export default stMemoryWizzardModule;
