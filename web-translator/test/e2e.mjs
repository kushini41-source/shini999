// 端對端：在 Chromium 載入真正的擴充功能，API 指向本機假伺服器
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';

const here = path.resolve(new URL('.', import.meta.url).pathname);
const extPath = path.join(here, '../extension');
const fixture = fs.readFileSync(path.join(here, 'fixture.html'), 'utf8');

const fake = (s) => '【' + s.replace(/(<\/?[gx]\d+\/?>)|([^<]+)/g, (m, tag, txt) => tag ? tag : txt.toUpperCase()) + '】';
const requests = [];

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    if (req.method === 'GET' && req.url === '/fixture.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(fixture);
    }
    const json = body ? JSON.parse(body) : null;
    requests.push({ url: req.url, headers: req.headers, body: json });
    if (req.url === '/v1/messages') {
      const texts = JSON.parse(json.messages[0].content.replace(/^[\s\S]*?\n/, ''));
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: json.model, stop_reason: 'end_turn',
        content: [{ type: 'text', text: JSON.stringify({ translations: texts.map(fake) }) }], usage: { input_tokens: 1, output_tokens: 1 } }));
    }
    if (req.url === '/v1/chat/completions') {
      const texts = JSON.parse(json.messages[1].content.replace(/^[\s\S]*?\n/, ''));
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify({ translations: texts.map((t) => '〔' + t + '〕') }) } }] }));
    }
    res.writeHead(404); res.end('nf');
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmt-e2e-'));
const context = await chromium.launchPersistentContext(userDataDir, {
  channel: 'chromium',
  headless: true,
  args: [`--disable-extensions-except=${extPath}`, `--load-extension=${extPath}`]
});
let failures = 0;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15000 });
  const extId = new URL(sw.url()).host;
  console.log('extension id', extId);
  const swErrors = [];
  sw.on('console', (m) => { if (m.type() === 'error') swErrors.push(m.text()); });
  // 等 service worker 的 chrome.* API 綁定完成
  for (let i = 0; i < 50; i++) {
    if (await sw.evaluate(() => typeof chrome !== 'undefined' && !!chrome.storage && !!chrome.tabs)) break;
    await wait(100);
  }

  // 寫入設定（指向假伺服器）
  await sw.evaluate(async (base) => {
    await chrome.storage.sync.set({ settings: { provider: 'anthropic', anthropicApiKey: 'sk-ant-test', anthropicBaseUrl: base, anthropicModel: 'claude-opus-5-5', anthropicEffort: 'low', lazy: false, displayMode: 'replace', glossary: 'docs = 文件', sourceLanguages: ['en'] } });
  }, base);

  // 開啟頁面並觸發翻譯（模擬快捷鍵／彈出視窗走的 toggleTab 路徑）
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.goto(`${base}/fixture.html`);
  await wait(500);
  const tabId = await sw.evaluate(async () => (await chrome.tabs.query({ url: 'http://127.0.0.1:*/fixture.html' }))[0].id);
  const r1 = await sw.evaluate(async (tabId) => new Promise((resolve) => chrome.tabs.sendMessage(tabId, { type: 'translatePage' }, resolve)), tabId);
  assert.ok(r1 && r1.ok, JSON.stringify(r1));
  await wait(1500);

  const dom = await page.evaluate(() => ({
    h1: document.getElementById('h1').innerHTML,
    p1: document.getElementById('p1').innerHTML,
    shadow: document.getElementById('shadow-host').shadowRoot.querySelector('#sp').innerHTML,
    far: document.getElementById('far').textContent
  }));
  assert.equal(dom.h1, '【WELCOME TO THE <em>EXAMPLE</em> SITE】');
  assert.ok(dom.p1.includes('<a href="/docs">LINK TO DOCS</a>'), dom.p1);
  assert.equal(dom.shadow, '【SHADOW PARAGRAPH WITH <b>BOLD</b>】');
  assert.equal(dom.far, '【FAR AWAY PARAGRAPH AT THE BOTTOM】');
  console.log('✓ real extension translated the page through mock Anthropic API');

  // 檢查送到 API 的請求形狀
  const req = requests.find((r) => r.url === '/v1/messages');
  assert.ok(req, 'anthropic request made');
  assert.equal(req.headers['x-api-key'], 'sk-ant-test');
  assert.equal(req.headers['anthropic-version'], '2026-10-21');
  assert.equal(req.headers['anthropic-dangerous-direct-browser-access'], 'true');
  assert.equal(req.headers['anthropic-beta'], 'server-side-fallback-2026-07-01');
  assert.equal(req.body.model, 'claude-opus-5-5');
  assert.equal(req.body.fallbacks, 'default');
  assert.equal(req.body.output_config.effort, 'low');
  assert.equal(req.body.output_config.format.type, 'json_schema');
  assert.ok(req.body.system.includes('docs → 文件'), 'glossary in system prompt');
  assert.ok(req.body.system.includes('台灣'), 'target language in system prompt');
  assert.ok(!('thinking' in req.body) && !('temperature' in req.body));
  console.log('✓ request shape ok', `(${requests.length} API calls)`);

  // 徽章
  const badge = await sw.evaluate(async (tabId) => chrome.action.getBadgeText({ tabId }), tabId);
  assert.equal(badge, '譯');

  // 還原、再翻 → 快取命中，不再打 API
  await sw.evaluate(async (tabId) => new Promise((resolve) => chrome.tabs.sendMessage(tabId, { type: 'restorePage' }, resolve)), tabId);
  await wait(200);
  assert.equal(await page.evaluate(() => document.getElementById('h1').innerHTML), 'Welcome to the <em>example</em> site');
  await page.reload();
  await wait(500);
  const n = requests.length;
  await sw.evaluate(async (tabId) => new Promise((resolve) => chrome.tabs.sendMessage(tabId, { type: 'translatePage' }, resolve)), tabId);
  await wait(1200);
  assert.equal(await page.evaluate(() => document.getElementById('h1').innerHTML), '【WELCOME TO THE <em>EXAMPLE</em> SITE】');
  assert.equal(requests.length, n, 'served from cache after reload');
  console.log('✓ restore + persistent cache ok');

  // getStatus／語言偵測
  const st = await sw.evaluate(async (tabId) => new Promise((resolve) => chrome.tabs.sendMessage(tabId, { type: 'getStatus' }, resolve)), tabId);
  assert.equal(st.active, true);
  assert.equal(st.pageLang, 'en');
  console.log('✓ status + language detection ok');

  // 切換到 OpenAI 相容供應商、雙語模式
  await sw.evaluate(async (base) => {
    const { settings } = await chrome.storage.sync.get('settings');
    await chrome.storage.sync.set({ settings: { ...settings, provider: 'openai', openaiBaseUrl: base + '/v1', openaiApiKey: 'k', openaiModel: 'test-model', displayMode: 'bilingual' } });
  }, base);
  await sw.evaluate(async (tabId) => new Promise((resolve) => chrome.tabs.sendMessage(tabId, { type: 'restorePage' }, resolve)), tabId);
  await sw.evaluate(async (tabId) => new Promise((resolve) => chrome.tabs.sendMessage(tabId, { type: 'settingsChanged' }, resolve)), tabId);
  await sw.evaluate(async (tabId) => new Promise((resolve) => chrome.tabs.sendMessage(tabId, { type: 'translatePage' }, resolve)), tabId);
  await wait(1200);
  const bi = await page.evaluate(() => document.getElementById('h1').innerHTML);
  assert.ok(bi.startsWith('Welcome to the <em>example</em> site<span data-llmt="translation"'), bi);
  assert.ok(bi.includes('〔Welcome to the <em>example</em> site〕'), bi);
  const oreq = requests.find((r) => r.url === '/v1/chat/completions');
  assert.equal(oreq.headers.authorization, 'Bearer k');
  assert.equal(oreq.body.response_format.type, 'json_object');
  console.log('✓ OpenAI-compatible provider + bilingual mode ok');

  // 設定頁與彈出視窗可以正常載入
  const opt = await context.newPage();
  const optErr = [];
  opt.on('pageerror', (e) => optErr.push(e.message));
  await opt.goto(`chrome-extension://${extId}/options.html`);
  await wait(400);
  assert.equal(await opt.inputValue('#openaiModel'), 'test-model');
  assert.equal(await opt.inputValue('#provider'), 'openai');
  await opt.fill('#glossary', 'repo = 儲存庫');
  await opt.click('#save');
  await wait(300);
  assert.equal(await opt.textContent('#saveMsg'), '已儲存');
  const saved = await sw.evaluate(async () => (await chrome.storage.sync.get('settings')).settings.glossary);
  assert.equal(saved, 'repo = 儲存庫');
  // 測試連線按鈕
  await opt.click('#testBtn');
  await wait(600);
  const tmsg = await opt.textContent('#testMsg');
  assert.ok(tmsg.includes('成功') && tmsg.includes('〔'), tmsg);
  assert.deepEqual(optErr, []);
  console.log('✓ options page loads, saves and tests connection');

  const pop = await context.newPage();
  const popErr = [];
  pop.on('pageerror', (e) => popErr.push(e.message));
  await pop.goto(`chrome-extension://${extId}/popup.html`);
  await wait(500);
  const popStatus = await pop.textContent('#status');
  assert.ok(popStatus.includes('無法翻譯'), popStatus); // 彈出視窗自己開成分頁時，目前分頁是 chrome-extension://
  assert.deepEqual(popErr, []);
  console.log('✓ popup page loads');

  assert.deepEqual(pageErrors, []);
  assert.deepEqual(swErrors, []);
} catch (e) {
  failures++;
  console.error('✗', e.message);
} finally {
  await context.close();
  server.close();
  fs.rmSync(userDataDir, { recursive: true, force: true });
}
if (failures) process.exit(1);
console.log('e2e passed');
