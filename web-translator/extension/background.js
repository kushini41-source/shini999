/*
 * 精準網頁翻譯 — background service worker
 *
 * 負責：設定、呼叫翻譯 API（Claude / OpenAI 相容 / DeepL）、翻譯快取、
 * 併發控制、語言偵測、右鍵選單、快捷鍵、工具列徽章。
 */

export const DEFAULTS = {
  provider: 'anthropic',             // anthropic | openai | deepl
  anthropicApiKey: '',
  anthropicBaseUrl: 'https://api.anthropic.com',
  anthropicModel: 'claude-opus-5-5',
  anthropicEffort: 'low',            // low | medium | high
  anthropicFallback: true,           // 伺服器端 fallbacks: "default"
  openaiBaseUrl: 'https://api.openai.com/v1',
  openaiApiKey: '',
  openaiModel: '',
  deeplApiKey: '',
  targetLanguage: 'zh-TW',           // zh-TW | zh-HK | zh-CN
  sourceLanguages: ['en'],           // en | ja | ko | any
  displayMode: 'replace',            // replace | bilingual
  bilingualStyle: 'underline',       // underline | muted | highlight | none
  lazy: true,                        // 只翻看得到的區域（省錢、較快）
  showToast: true,
  autoSites: [],                     // 永遠自動翻譯的網域
  autoLanguages: [],                 // 偵測到這些語言就自動翻譯，例如 ['en']
  glossary: '',                      // 每行 "原文 = 譯文"
  customInstructions: '',
  batchChars: 1500,
  batchItems: 30,
  concurrency: 3,
  cacheEnabled: true,
  debug: false
};

const TARGET_NAMES = {
  'zh-TW': '繁體中文（台灣用語，Taiwanese Mandarin）',
  'zh-HK': '繁體中文（香港用語）',
  'zh-CN': '简体中文（中国大陆用语）'
};
const SOURCE_NAMES = { en: 'English', ja: 'Japanese', ko: 'Korean', any: 'any language' };

// ---------- 設定 ----------
async function getSettings() {
  const stored = await chrome.storage.sync.get('settings');
  return { ...DEFAULTS, ...(stored.settings || {}) };
}

async function saveSettings(partial) {
  const cur = await getSettings();
  const next = { ...cur, ...partial };
  await chrome.storage.sync.set({ settings: next });
  broadcastSettingsChanged();
  return next;
}

async function broadcastSettingsChanged() {
  try {
    const tabs = await chrome.tabs.query({});
    for (const t of tabs) {
      if (!t.id) continue;
      chrome.tabs.sendMessage(t.id, { type: 'settingsChanged' }, () => void chrome.runtime.lastError);
    }
  } catch (_) { /* ignore */ }
}

// ---------- 快取（chrome.storage.local，容量有限、LRU 淘汰） ----------
const CACHE_PREFIX = 'c:';
const CACHE_MAX = 6000;
const memCache = new Map();

function hashKey(s) {
  // FNV-1a 32-bit ×2（不同種子），足夠當快取鍵
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x811c9dc5) >>> 0;
  }
  return h1.toString(36) + h2.toString(36) + s.length.toString(36);
}

function cacheNamespace(settings) {
  const model = settings.provider === 'anthropic' ? settings.anthropicModel
    : settings.provider === 'openai' ? settings.openaiModel : 'deepl';
  return `${settings.provider}|${model}|${settings.targetLanguage}|${hashKey(settings.glossary + '\n' + settings.customInstructions)}`;
}

async function cacheGetMany(ns, texts) {
  const keys = texts.map((t) => CACHE_PREFIX + hashKey(ns + '\u0000' + t));
  const out = new Array(texts.length).fill(null);
  const missingKeys = [];
  keys.forEach((k, i) => {
    if (memCache.has(k)) out[i] = memCache.get(k).v; else missingKeys.push(k);
  });
  if (missingKeys.length) {
    try {
      const got = await chrome.storage.local.get(missingKeys);
      keys.forEach((k, i) => {
        if (out[i] === null && got[k]) { out[i] = got[k].v; memCache.set(k, got[k]); }
      });
    } catch (_) { /* ignore */ }
  }
  return { keys, values: out };
}

let cacheCount = null;
async function cacheSetMany(entries) {
  if (!entries.length) return;
  const obj = {};
  const now = Date.now();
  for (const [k, v] of entries) { obj[k] = { v, t: now }; memCache.set(k, obj[k]); }
  try {
    await chrome.storage.local.set(obj);
    if (cacheCount === null) {
      const all = await chrome.storage.local.get(null);
      cacheCount = Object.keys(all).filter((k) => k.startsWith(CACHE_PREFIX)).length;
    } else cacheCount += entries.length;
    if (cacheCount > CACHE_MAX) await evictCache();
  } catch (_) { /* 容量滿等錯誤：忽略 */ }
}

async function evictCache() {
  const all = await chrome.storage.local.get(null);
  const items = Object.entries(all).filter(([k]) => k.startsWith(CACHE_PREFIX));
  items.sort((a, b) => (a[1].t || 0) - (b[1].t || 0));
  const removeN = Math.max(0, items.length - Math.floor(CACHE_MAX * 0.8));
  const keys = items.slice(0, removeN).map(([k]) => k);
  if (keys.length) await chrome.storage.local.remove(keys);
  for (const k of keys) memCache.delete(k);
  cacheCount = items.length - keys.length;
}

async function clearCache() {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter((k) => k.startsWith(CACHE_PREFIX));
  if (keys.length) await chrome.storage.local.remove(keys);
  memCache.clear();
  cacheCount = 0;
  return keys.length;
}

// ---------- 併發控制 ----------
class Semaphore {
  constructor(n) { this.n = n; this.q = []; }
  async acquire() {
    if (this.n > 0) { this.n--; return; }
    await new Promise((r) => this.q.push(r));
  }
  release() {
    const next = this.q.shift();
    if (next) next(); else this.n++;
  }
}
let sem = null, semSize = 0;
function getSem(n) {
  if (!sem || semSize !== n) { sem = new Semaphore(n); semSize = n; }
  return sem;
}

// ---------- 提示詞 ----------
function buildSystemPrompt(settings, context) {
  const target = TARGET_NAMES[settings.targetLanguage] || TARGET_NAMES['zh-TW'];
  const srcs = (settings.sourceLanguages || ['en']).map((s) => SOURCE_NAMES[s] || s).join(' / ');
  const lines = [
    `You are a professional translator. Translate web page text segments from ${srcs} into ${target}.`,
    '',
    'Output requirements:',
    '- Return a JSON object {"translations": [...]} with exactly one translated string per input segment, in the same order. Never merge, split, drop or add segments.',
    '- Segments may contain inline markup: <gN>…</gN> wraps a styled span/link, <xN/> is an untranslatable placeholder (image, code, line break). Keep every tag with the same number, keep nesting valid, and place each tag so that the translated words that correspond to the original wrapped words stay inside the same <gN> tag. Never add, remove or renumber tags. Do not output any other HTML.',
    '- "&lt;" and "&amp;" are escaped characters; keep them escaped.',
    '',
    'Translation quality:',
    `- Produce natural, fluent, accurate ${target}. Prefer idiomatic phrasing and natural Chinese word order over a literal, word-by-word rendering, while preserving the exact meaning, tone and register (UI label, headline, article, legal text, casual comment…). Keep UI labels and buttons short.`,
    settings.targetLanguage === 'zh-CN'
      ? '- Use Mainland China terminology (软件、网络、视频、鼠标、程序).'
      : '- Use Taiwan terminology and conventions (軟體、網路、影片、滑鼠、程式、資料、伺服器、行動裝置); never use Mainland terms such as 软件/视频/鼠标/网络/数据/服务器/移动端.',
    '- Keep proper nouns, brand/product names, people\'s names, code identifiers, file names, URLs, email addresses, numbers, units, hashtags and template placeholders ({name}, %s, $1) unchanged, unless a well-established Chinese name exists (e.g. 美國, 日本, 微軟, 谷歌→Google is fine to keep in English).',
    '- Use full-width Chinese punctuation (，。：；！？「」) in translated prose; keep punctuation inside code or data unchanged.',
    '- If a segment is already in Chinese, or contains nothing translatable (symbols, numbers, a lone brand name), return it unchanged.',
    '- Never add explanations, notes, pinyin or the original text.'
  ];
  const gl = parseGlossary(settings.glossary);
  if (gl.length) {
    lines.push('', 'Glossary (always use these renderings):');
    for (const [a, b] of gl) lines.push(`- ${a} → ${b}`);
  }
  if (settings.customInstructions && settings.customInstructions.trim()) {
    lines.push('', 'Additional instructions from the user:', settings.customInstructions.trim());
  }
  if (context) {
    const bits = [];
    if (context.title) bits.push(`page title: ${JSON.stringify(String(context.title).slice(0, 200))}`);
    if (context.host) bits.push(`site: ${context.host}`);
    if (bits.length) lines.push('', `Context for disambiguation (${bits.join(', ')}).`);
  }
  return lines.join('\n');
}

function parseGlossary(text) {
  const out = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(.+?)\s*(?:=|=>|→|->|:)\s*(.+)$/);
    if (m) out.push([m[1].trim(), m[2].trim()]);
  }
  return out;
}

function userMessage(texts) {
  return `Translate these ${texts.length} segments. Input JSON array:\n${JSON.stringify(texts)}`;
}

const TRANSLATIONS_SCHEMA = {
  type: 'object',
  properties: { translations: { type: 'array', items: { type: 'string' } } },
  required: ['translations'],
  additionalProperties: false
};

// ---------- 供應商 ----------
class ApiError extends Error {
  constructor(code, message, status) { super(message); this.code = code; this.status = status; }
}

async function httpJson(url, init, label) {
  let res;
  try {
    res = await fetch(url, init);
  } catch (e) {
    throw new ApiError('NETWORK', `${label} 連線失敗：${e.message}`);
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) { /* non-JSON */ }
  if (!res.ok) {
    const msg = data?.error?.message || data?.message || text.slice(0, 300) || res.statusText;
    const code = res.status === 401 || res.status === 403 ? 'AUTH'
      : res.status === 429 ? 'RATE_LIMIT'
        : res.status >= 500 ? 'SERVER' : 'HTTP';
    throw new ApiError(code, `${label} 回應 ${res.status}：${msg}`, res.status);
  }
  return data;
}

function extractJsonObject(s) {
  if (!s) return null;
  try { return JSON.parse(s); } catch (_) { /* fallthrough */ }
  const m = s.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch (_) { /* ignore */ } }
  return null;
}

async function translateAnthropic(texts, settings, context) {
  if (!settings.anthropicApiKey) throw new ApiError('NO_API_KEY', '尚未設定 Anthropic API key');
  const headers = {
    'content-type': 'application/json',
    'x-api-key': settings.anthropicApiKey,
    'anthropic-version': '2026-10-21',
    // 擴充功能從瀏覽器端直接呼叫 API，需要此標頭才能通過 CORS
    'anthropic-dangerous-direct-browser-access': 'true'
  };
  const body = {
    model: settings.anthropicModel || DEFAULTS.anthropicModel,
    max_tokens: 16000,
    system: buildSystemPrompt(settings, context),
    messages: [{ role: 'user', content: userMessage(texts) }],
    output_config: {
      effort: settings.anthropicEffort || 'low',
      format: { type: 'json_schema', schema: TRANSLATIONS_SCHEMA }
    }
  };
  if (settings.anthropicFallback !== false) {
    headers['anthropic-beta'] = 'server-side-fallback-2026-07-01';
    body.fallbacks = 'default';
  }
  const base = (settings.anthropicBaseUrl || DEFAULTS.anthropicBaseUrl).replace(/\/+$/, '');
  const data = await httpJson(`${base}/v1/messages`, {
    method: 'POST', headers, body: JSON.stringify(body)
  }, 'Anthropic API');
  if (data.stop_reason === 'refusal') {
    throw new ApiError('REFUSAL', `模型拒絕翻譲此段內容${data.stop_details?.explanation ? '：' + data.stop_details.explanation : ''}`);
  }
  if (data.stop_reason === 'max_tokens') throw new ApiError('TRUNCATED', '回應過長被截斷，請調低每批字數');
  const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  const parsed = extractJsonObject(text);
  if (!parsed || !Array.isArray(parsed.translations)) throw new ApiError('PARSE', '模型回傳格式無法解析');
  return parsed.translations;
}

async function translateOpenAI(texts, settings, context, withFormat = true) {
  if (!settings.openaiApiKey && /api\.openai\.com/.test(settings.openaiBaseUrl || '')) throw new ApiError('NO_API_KEY', '尚未設定 OpenAI API key');
  if (!settings.openaiModel) throw new ApiError('NO_MODEL', '尚未設定模型名稱');
  const base = (settings.openaiBaseUrl || DEFAULTS.openaiBaseUrl).replace(/\/+$/, '');
  const headers = { 'content-type': 'application/json' };
  if (settings.openaiApiKey) headers.authorization = `Bearer ${settings.openaiApiKey}`;
  const body = {
    model: settings.openaiModel,
    messages: [
      { role: 'system', content: buildSystemPrompt(settings, context) },
      { role: 'user', content: userMessage(texts) }
    ],
    temperature: 0.2
  };
  if (withFormat) body.response_format = { type: 'json_object' };
  let data;
  try {
    data = await httpJson(`${base}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body) }, 'OpenAI 相容 API');
  } catch (e) {
    if (withFormat && e.status === 400 && /response_format|json/i.test(e.message)) return translateOpenAI(texts, settings, context, false);
    throw e;
  }
  const content = data?.choices?.[0]?.message?.content;
  const parsed = extractJsonObject(Array.isArray(content) ? content.map((c) => c.text || '').join('') : content);
  if (!parsed) throw new ApiError('PARSE', '模型回傳格式無法解析');
  const arr = Array.isArray(parsed) ? parsed : parsed.translations;
  if (!Array.isArray(arr)) throw new ApiError('PARSE', '模型回傳格式無法解析');
  return arr;
}

async function translateDeepL(texts, settings) {
  if (!settings.deeplApiKey) throw new ApiError('NO_API_KEY', '尚未設定 DeepL API key');
  const free = /:fx$/.test(settings.deeplApiKey);
  const url = free ? 'https://api-free.deepl.com/v2/translate' : 'https://api.deepl.com/v2/translate';
  const target = settings.targetLanguage === 'zh-CN' ? 'ZH-HANS' : 'ZH-HANT';
  const src = settings.sourceLanguages || ['en'];
  const body = { text: texts, target_lang: target, tag_handling: 'xml', preserve_formatting: true };
  if (src.length === 1 && src[0] !== 'any') body.source_lang = src[0].toUpperCase();
  const data = await httpJson(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `DeepL-Auth-Key ${settings.deeplApiKey}` },
    body: JSON.stringify(body)
  }, 'DeepL API');
  if (!data || !Array.isArray(data.translations)) throw new ApiError('PARSE', 'DeepL 回傳格式無法解析');
  return data.translations.map((t) => t.text);
}

async function callProvider(texts, settings, context) {
  switch (settings.provider) {
    case 'openai': return translateOpenAI(texts, settings, context);
    case 'deepl': return translateDeepL(texts, settings);
    default: return translateAnthropic(texts, settings, context);
  }
}

// 確保回傳數量一致；不一致時重試一次，再不行就逐段翻
async function translateBatch(texts, settings, context) {
  const s = getSem(Math.max(1, settings.concurrency || 3));
  await s.acquire();
  try {
    let out = await callProvider(texts, settings, context);
    if (out.length === texts.length) return out.map((x) => (typeof x === 'string' ? x : String(x ?? '')));
    out = await callProvider(texts, settings, context);
    if (out.length === texts.length) return out.map((x) => (typeof x === 'string' ? x : String(x ?? '')));
  } finally {
    s.release();
  }
  // 逐段
  const results = [];
  for (const t of texts) {
    await s.acquire();
    try {
      const one = await callProvider([t], settings, context);
      results.push(typeof one[0] === 'string' ? one[0] : null);
    } catch (_) {
      results.push(null);
    } finally { s.release(); }
  }
  return results;
}

async function handleTranslate(texts, context) {
  const settings = await getSettings();
  const ns = cacheNamespace(settings);
  const results = new Array(texts.length).fill(null);
  let keys = null;
  if (settings.cacheEnabled) {
    const c = await cacheGetMany(ns, texts);
    keys = c.keys;
    c.values.forEach((v, i) => { if (v) results[i] = v; });
  }
  const missIdx = [];
  results.forEach((r, i) => { if (r === null) missIdx.push(i); });
  let error = null;
  if (missIdx.length) {
    const missTexts = missIdx.map((i) => texts[i]);
    try {
      const out = await translateBatch(missTexts, settings, context);
      const toCache = [];
      out.forEach((v, j) => {
        const i = missIdx[j];
        if (typeof v === 'string' && v.trim()) {
          results[i] = v;
          if (keys) toCache.push([keys[i], v]);
        }
      });
      if (settings.cacheEnabled) cacheSetMany(toCache);
    } catch (e) {
      error = { code: e.code || 'ERROR', message: e.message || String(e) };
      if (results.every((r) => r === null)) return { ok: false, error };
    }
  }
  return { ok: true, results, error };
}

// ---------- 語言偵測 ----------
async function detectLanguage(text) {
  try {
    const r = await chrome.i18n.detectLanguage(text);
    const top = (r.languages || []).sort((a, b) => b.percentage - a.percentage)[0];
    if (!top) return { ok: true, language: null, reliable: false };
    const lang = top.language.toLowerCase().split('-')[0];
    return { ok: true, language: lang === 'zh' ? top.language : lang, reliable: !!r.isReliable, percentage: top.percentage };
  } catch (e) {
    return { ok: false, error: { code: 'DETECT', message: String(e) } };
  }
}

// ---------- 分頁操作 ----------
async function sendToTab(tabId, msg) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, msg, (res) => {
      if (chrome.runtime.lastError) resolve({ ok: false, error: { code: 'NO_CONTENT', message: chrome.runtime.lastError.message } });
      else resolve(res || { ok: false, error: { code: 'EMPTY', message: '無回應' } });
    });
  });
}

async function ensureContentScript(tabId) {
  const ping = await sendToTab(tabId, { type: 'ping' });
  if (ping.ok) return true;
  try {
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['content.js'] });
    return true;
  } catch (e) {
    return false;
  }
}

async function toggleTab(tabId, force) {
  const ok = await ensureContentScript(tabId);
  if (!ok) return { ok: false, error: { code: 'UNSUPPORTED', message: '此頁面不允許擴充功能存取（例如 chrome:// 或商店頁面）' } };
  const type = force === true ? 'translatePage' : force === false ? 'restorePage' : 'toggle';
  return sendToTab(tabId, { type });
}

function setBadge(tabId, active) {
  try {
    chrome.action.setBadgeText({ tabId, text: active ? '譯' : '' });
    chrome.action.setBadgeBackgroundColor({ tabId, color: '#1a73e8' });
  } catch (_) { /* ignore */ }
}

// ---------- 事件 ----------
chrome.runtime.onInstalled.addListener(async () => {
  try {
    chrome.contextMenus.removeAll(() => {
      chrome.contextMenus.create({ id: 'llmt-toggle', title: '翻譯此頁面／顯示原文', contexts: ['page', 'frame', 'selection', 'link', 'image'] });
      chrome.contextMenus.create({ id: 'llmt-options', title: '翻譯設定…', contexts: ['action'] });
    });
  } catch (_) { /* ignore */ }
  const s = await getSettings();
  if (!s.anthropicApiKey && !s.openaiApiKey && !s.deeplApiKey) {
    chrome.runtime.openOptionsPage();
  }
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'llmt-toggle' && tab?.id) toggleTab(tab.id);
  if (info.menuItemId === 'llmt-options') chrome.runtime.openOptionsPage();
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== 'toggle-translate') return;
  const t = tab || (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  if (t?.id) toggleTab(t.id);
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg.type) {
      case 'getSettings': return { ok: true, settings: await getSettings() };
      case 'saveSettings': return { ok: true, settings: await saveSettings(msg.settings || {}) };
      case 'translate': return handleTranslate(msg.texts || [], msg.context || {});
      case 'detectLanguage': return detectLanguage(msg.text || '');
      case 'openOptions': chrome.runtime.openOptionsPage(); return { ok: true };
      case 'badge': if (sender.tab?.id) setBadge(sender.tab.id, !!msg.active); return { ok: true };
      case 'translateTab': {
        const tabId = msg.tabId ?? sender.tab?.id;
        if (!tabId) return { ok: false, error: { code: 'NO_TAB', message: '沒有分頁' } };
        return toggleTab(tabId, true);
      }
      case 'restoreTab': {
        const tabId = msg.tabId ?? sender.tab?.id;
        if (!tabId) return { ok: false, error: { code: 'NO_TAB', message: '沒有分頁' } };
        return toggleTab(tabId, false);
      }
      case 'toggleTab': {
        const tabId = msg.tabId ?? sender.tab?.id;
        if (!tabId) return { ok: false, error: { code: 'NO_TAB', message: '沒有分頁' } };
        return toggleTab(tabId);
      }
      case 'tabStatus': {
        if (!msg.tabId) return { ok: false, error: { code: 'NO_TAB', message: '沒有分頁' } };
        const ok = await ensureContentScript(msg.tabId);
        if (!ok) return { ok: false, error: { code: 'UNSUPPORTED', message: '此頁面不允許擴充功能存取' } };
        return sendToTab(msg.tabId, { type: 'getStatus' });
      }
      case 'clearCache': return { ok: true, removed: await clearCache() };
      case 'testConnection': {
        const settings = { ...(await getSettings()), ...(msg.settings || {}), cacheEnabled: false };
        try {
          const out = await callProvider(['Hello, world! This is a <g0>quick</g0> connection test.'], settings, { title: 'test', host: 'example.com' });
          return { ok: true, sample: out[0] };
        } catch (e) {
          return { ok: false, error: { code: e.code || 'ERROR', message: e.message || String(e) } };
        }
      }
      default: return { ok: false, error: { code: 'UNKNOWN', message: `未知訊息 ${msg.type}` } };
    }
  })().then(sendResponse).catch((e) => sendResponse({ ok: false, error: { code: 'BG', message: String(e?.message || e) } }));
  return true;
});
