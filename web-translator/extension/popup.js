const $ = (id) => document.getElementById(id);
const LANG_NAMES = { en: '英文', ja: '日文', ko: '韓文', fr: '法文', de: '德文', es: '西班牙文', ru: '俄文', pt: '葡萄牙文', it: '義大利文', vi: '越南文', th: '泰文', id: '印尼文', ar: '阿拉伯文', 'zh-TW': '繁體中文', 'zh-CN': '簡體中文', zh: '中文' };

let tab = null, settings = null, status = null, host = '';

function send(msg) { return new Promise((r) => chrome.runtime.sendMessage(msg, (res) => r(res || { ok: false, error: { message: chrome.runtime.lastError?.message || '無回應' } }))); }

function hasKey(s) {
  return (s.provider === 'anthropic' && s.anthropicApiKey) || (s.provider === 'openai' && (s.openaiApiKey || !/api\.openai\.com/.test(s.openaiBaseUrl || ''))) || (s.provider === 'deepl' && s.deeplApiKey);
}

function render() {
  const st = $('status'); st.classList.remove('err');
  const btn = $('mainBtn');
  if (!tab || !/^(https?|file|ftp):/i.test(tab.url || '')) {
    st.textContent = '此頁面無法翻譯（瀏覧器內建頁面、商店或 PDF 檢視器不開放擴充功能存取）。';
    btn.disabled = true; return;
  }
  if (settings && !hasKey(settings)) {
    st.innerHTML = '尚未設定翻譯服務的 API key，請先到設定頁填寫。';
    st.classList.add('err');
    btn.textContent = '開啟設定'; btn.disabled = false; btn.dataset.action = 'options';
    return;
  }
  if (!status || !status.ok) {
    st.textContent = status?.error?.message || '無法連線到此頁面的內容腳本，請重新整理頁面後再試。';
    st.classList.add('err'); btn.disabled = true; return;
  }
  btn.disabled = false;
  const lang = status.pageLang ? (LANG_NAMES[status.pageLang] || status.pageLang) : null;
  if (status.active) {
    btn.textContent = '顯示原文'; btn.dataset.action = 'restore';
    const parts = [`已翻譯 ${status.done} 段`];
    if (status.inflight) parts.push(`進行中 ${status.inflight}`);
    if (status.failed) parts.push(`失敗 ${status.failed}`);
    st.textContent = parts.join('，');
    if (status.lastError) { st.textContent = `翻譯失敗：${status.lastError.message}`; st.classList.add('err'); }
    $('retryBtn').style.display = status.failed ? '' : 'none';
  } else {
    btn.textContent = '翻譯此頁'; btn.dataset.action = 'translate';
    st.textContent = lang ? `偵測到網頁語言：${lang}` : '準備就緒';
    $('retryBtn').style.display = 'none';
  }
  const l = status.pageLang && status.pageLang.split('-')[0];
  const langRow = $('autoLang').closest('.row');
  if (l && !/^zh/.test(l)) {
    langRow.style.display = '';
    $('langName').textContent = LANG_NAMES[l] || l;
    $('autoLang').checked = (settings.autoLanguages || []).includes(l);
    $('autoLang').dataset.lang = l;
  } else langRow.style.display = 'none';
}

async function refresh() {
  status = await send({ type: 'tabStatus', tabId: tab.id });
  render();
}

async function init() {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const s = await send({ type: 'getSettings' });
  settings = s.settings;
  try { host = new URL(tab.url).hostname; } catch (_) { host = ''; }
  $('host').textContent = host || '此網站';
  $('autoSite').checked = !!(settings.autoSites || []).includes(host);
  document.querySelector(`input[name=mode][value=${settings.displayMode || 'replace'}]`).checked = true;
  render();
  if (tab && /^(https?|file|ftp):/i.test(tab.url || '')) {
    await refresh();
    setInterval(() => { if (status?.active && (status.inflight || status.total > status.done + status.failed)) refresh(); }, 800);
  }
}

$('mainBtn').addEventListener('click', async () => {
  const a = $('mainBtn').dataset.action;
  if (a === 'options') { chrome.runtime.openOptionsPage(); return; }
  $('mainBtn').disabled = true;
  if (a === 'restore') await send({ type: 'restoreTab', tabId: tab.id });
  else await send({ type: 'translateTab', tabId: tab.id });
  await refresh();
});

$('retryBtn').addEventListener('click', async () => {
  await send({ type: 'restoreTab', tabId: tab.id });
  await send({ type: 'translateTab', tabId: tab.id });
  await refresh();
});

$('openOptions').addEventListener('click', (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); });

$('modeSeg').addEventListener('change', async (e) => {
  const mode = e.target.value;
  settings = (await send({ type: 'saveSettings', settings: { displayMode: mode } })).settings;
  if (status?.active) {
    await send({ type: 'restoreTab', tabId: tab.id });
    await send({ type: 'translateTab', tabId: tab.id });
    await refresh();
  }
});

$('autoSite').addEventListener('change', async (e) => {
  const set = new Set(settings.autoSites || []);
  if (e.target.checked) set.add(host); else set.delete(host);
  settings = (await send({ type: 'saveSettings', settings: { autoSites: Array.from(set) } })).settings;
  if (e.target.checked && !status?.active) { await send({ type: 'translateTab', tabId: tab.id }); await refresh(); }
});

$('autoLang').addEventListener('change', async (e) => {
  const l = e.target.dataset.lang;
  const set = new Set(settings.autoLanguages || []);
  if (e.target.checked) set.add(l); else set.delete(l);
  settings = (await send({ type: 'saveSettings', settings: { autoLanguages: Array.from(set) } })).settings;
  if (e.target.checked && !status?.active) { await send({ type: 'translateTab', tabId: tab.id }); await refresh(); }
});

init();
