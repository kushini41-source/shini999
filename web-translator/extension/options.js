const $ = (id) => document.getElementById(id);
const send = (msg) => new Promise((r) => chrome.runtime.sendMessage(msg, (res) => r(res || { ok: false, error: { message: chrome.runtime.lastError?.message || '無回應' } })));

const TEXT_FIELDS = ['anthropicApiKey', 'anthropicBaseUrl', 'anthropicEffort', 'openaiBaseUrl', 'openaiApiKey', 'openaiModel', 'deeplApiKey', 'targetLanguage', 'displayMode', 'bilingualStyle', 'glossary', 'customInstructions', 'provider'];
const BOOL_FIELDS = ['anthropicFallback', 'lazy', 'showToast', 'cacheEnabled', 'debug'];
const NUM_FIELDS = ['batchChars', 'batchItems', 'concurrency'];
const KNOWN_MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'];

function showProvider() {
  const p = $('provider').value;
  document.querySelectorAll('.prov').forEach((el) => el.classList.toggle('show', el.id === `prov-${p}`));
}

function load(s) {
  for (const f of TEXT_FIELDS) $(f).value = s[f] ?? '';
  for (const f of BOOL_FIELDS) $(f).checked = !!s[f];
  for (const f of NUM_FIELDS) $(f).value = s[f] ?? '';
  const m = s.anthropicModel || 'claude-opus-5-5';
  if (KNOWN_MODELS.includes(m)) { $('anthropicModelSel').value = m; $('anthropicModel').value = ''; }
  else { $('anthropicModelSel').value = 'custom'; $('anthropicModel').value = m; }
  $('anthropicCustomWrap').style.display = $('anthropicModelSel').value === 'custom' ? '' : 'none';
  document.querySelectorAll('input[name=src]').forEach((c) => { c.checked = (s.sourceLanguages || ['en']).includes(c.value); });
  document.querySelectorAll('input[name=autoLang]').forEach((c) => { c.checked = (s.autoLanguages || []).includes(c.value); });
  $('autoSites').value = (s.autoSites || []).join('\n');
  showProvider();
}

function collect() {
  const out = {};
  for (const f of TEXT_FIELDS) out[f] = $(f).value.trim();
  for (const f of BOOL_FIELDS) out[f] = $(f).checked;
  for (const f of NUM_FIELDS) { const n = parseInt($(f).value, 10); if (Number.isFinite(n) && n > 0) out[f] = n; }
  out.anthropicModel = $('anthropicModelSel').value === 'custom' ? ($('anthropicModel').value.trim() || 'claude-opus-5-5') : $('anthropicModelSel').value;
  let src = Array.from(document.querySelectorAll('input[name=src]:checked')).map((c) => c.value);
  if (!src.length) src = ['en'];
  out.sourceLanguages = src;
  out.autoLanguages = Array.from(document.querySelectorAll('input[name=autoLang]:checked')).map((c) => c.value);
  out.autoSites = $('autoSites').value.split(/\r?\n/).map((x) => x.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '')).filter(Boolean);
  return out;
}

function flash(el, text, ok) {
  el.textContent = text; el.className = `msg ${ok ? 'ok' : 'err'}`;
  if (ok) setTimeout(() => { if (el.textContent === text) el.textContent = ''; }, 3000);
}

$('provider').addEventListener('change', showProvider);
$('anthropicModelSel').addEventListener('change', () => { $('anthropicCustomWrap').style.display = $('anthropicModelSel').value === 'custom' ? '' : 'none'; });

$('save').addEventListener('click', async () => {
  const res = await send({ type: 'saveSettings', settings: collect() });
  flash($('saveMsg'), res.ok ? '已儲存' : `儲存失敗：${res.error?.message}`, res.ok);
});

$('testBtn').addEventListener('click', async () => {
  $('testMsg').className = 'msg'; $('testMsg').textContent = '測試中…';
  const res = await send({ type: 'testConnection', settings: collect() });
  flash($('testMsg'), res.ok ? `成功，範例譯文：${res.sample}` : `失敗：${res.error?.message}`, res.ok);
});

$('clearCache').addEventListener('click', async () => {
  const res = await send({ type: 'clearCache' });
  flash($('cacheMsg'), res.ok ? `已清除 ${res.removed} 筆` : `失敗：${res.error?.message}`, res.ok);
});

send({ type: 'getSettings' }).then((res) => load(res.settings || {}));
