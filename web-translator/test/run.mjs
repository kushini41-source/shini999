// 以假翻譯器驗證 content script 的切段、標籤保留、還原、雙語、動態內容、Shadow DOM
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const here = path.resolve(new URL('.', import.meta.url).pathname);
const contentJs = fs.readFileSync(path.join(here, '../extension/content.js'), 'utf8');
const fixture = fs.readFileSync(path.join(here, 'fixture.html'), 'utf8');

// 假翻譯：標籤外的文字轉大寫並加上【】，模擬「保留標籤的譯文」
const fakeTranslate = (s) => '【' + s.replace(/(<\/?[gx]\d+\/?>)|([^<]+)/g, (m, tag, txt) => tag ? tag : txt.toUpperCase()) + '】';

function shim(settingsOverride = {}) {
  return `
    window.__calls = [];
    window.__listeners = [];
    window.__settings = Object.assign({
      provider:'anthropic', targetLanguage:'zh-TW', sourceLanguages:['en'], displayMode:'replace',
      bilingualStyle:'underline', lazy:true, showToast:true, autoSites:[], autoLanguages:[], batchChars:1500, batchItems:30, debug:false
    }, ${JSON.stringify(settingsOverride)});
    window.chrome = {
      runtime: {
        lastError: null,
        sendMessage(msg, cb) {
          window.__calls.push(msg);
          let res;
          if (msg.type === 'getSettings') res = { ok:true, settings: window.__settings };
          else if (msg.type === 'translate') res = { ok:true, results: msg.texts.map(window.__fake) };
          else if (msg.type === 'detectLanguage') res = { ok:true, language:'en', reliable:true };
          else res = { ok:true };
          setTimeout(() => cb && cb(res), 5);
        },
        onMessage: { addListener(fn) { window.__listeners.push(fn); } }
      }
    };
    window.__send = (msg) => new Promise((resolve) => { for (const l of window.__listeners) l(msg, {}, resolve); });
    window.__fake = ${fakeTranslate.toString()};
  `;
}

const browser = await chromium.launch();
let failures = 0;
async function test(name, fn) {
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  page.on('pageerror', (e) => { console.error('  pageerror:', e.message); failures++; });
  try {
    await page.setContent(fixture);
    await fn(page);
    console.log('✓', name);
  } catch (e) {
    failures++;
    console.error('✗', name, '\n ', e.message);
  } finally { await page.close(); }
}

const inject = async (page, settings) => {
  await page.evaluate(shim(settings));
  await page.evaluate(contentJs);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

await test('serialize keeps inline structure and placeholders', async (page) => {
  await inject(page);
  const r = await page.evaluate(() => {
    const p = document.getElementById('p1');
    return window.__llmt.serialize(Array.from(p.childNodes));
  });
  assert.equal(r.text, 'This is a paragraph with a <g0>link to docs</g0>, some <g1>bold text</g1>, inline <x2/> and an image <x3/>.<x4/>Second line after break.');
  assert.equal(r.elems.length, 5);
  assert.equal(r.plain, 'This is a paragraph with a link to docs, some bold text, inline  and an image .Second line after break.');
});

await test('parseTranslation handles nesting, reordering and escapes', async (page) => {
  await inject(page);
  const r = await page.evaluate(() => { const x = window.__llmt.parseTranslation('前 <g1>粗 <x2/> 體</g1> 中 &lt;3 <g0>連結</g0> 後', 4); return { tree: x.tree, used: [...x.used] }; });
  assert.deepEqual(r.tree, [
    { type: 'text', value: '前 ' },
    { type: 'g', idx: 1, children: [{ type: 'text', value: '粗 ' }, { type: 'x', idx: 2 }, { type: 'text', value: ' 體' }] },
    { type: 'text', value: ' 中 <3 ' },
    { type: 'g', idx: 0, children: [{ type: 'text', value: '連結' }] },
    { type: 'text', value: ' 後' }
  ]);
  assert.deepEqual([...r.used].sort(), [0, 1, 2]);
});

await test('shouldTranslateText language heuristics', async (page) => {
  await inject(page);
  const r = await page.evaluate(async () => {
    await window.__send({ type: 'getStatus' });
    const f = window.__llmt.shouldTranslateText;
    const st = window.__llmt.state;
    const en = { en: f('Hello world'), zh: f('這是中文'), mixedZh: f('iPhone 很棒'), num: f('123 - 45%'), url: f('https://a.b/c'), ja: f('これは日本語'), ko: f('이것은 한국어'), single: f('X') };
    st.settings.sourceLanguages = ['en', 'ja', 'ko'];
    const all = { ja: f('これは日本語'), ko: f('이것은 한국어'), kanjiOnEnPage: f('東京都') };
    st.pageLang = 'ja';
    all.kanjiOnJaPage = f('東京都');
    return { en, all };
  });
  assert.deepEqual(r.en, { en: true, zh: false, mixedZh: false, num: false, url: false, ja: false, ko: false, single: false });
  assert.deepEqual(r.all, { ja: true, ko: true, kanjiOnEnPage: false, kanjiOnJaPage: true });
});

await test('replace mode: translates visible units, keeps tags, skips excluded, restores exactly', async (page) => {
  await inject(page);
  const before = await page.evaluate(() => document.body.innerHTML);
  await page.evaluate(() => window.__send({ type: 'translatePage' }));
  await wait(400);
  const r = await page.evaluate(() => ({
    h1: document.getElementById('h1').innerHTML,
    p1: document.getElementById('p1').innerHTML,
    mixed: document.getElementById('mixed').innerHTML,
    li2: document.getElementById('li2').innerHTML,
    zh: document.getElementById('zh').textContent,
    num: document.getElementById('num').textContent,
    pre: document.getElementById('pre').textContent,
    notr: document.getElementById('notr').textContent,
    btn: document.getElementById('btn').textContent,
    td: document.getElementById('td').textContent,
    ja: document.getElementById('ja').textContent,
    shadow: document.getElementById('shadow-host').shadowRoot.querySelector('#sp').innerHTML,
    far: document.getElementById('far').textContent,
    hidden: document.getElementById('hidden').textContent,
    active: window.__llmt.state.active,
    toast: !!document.getElementById('llmt-toast'),
    translateCalls: window.__calls.filter((c) => c.type === 'translate').length
  }));
  assert.equal(r.h1, '【WELCOME TO THE <em>EXAMPLE</em> SITE】');
  assert.equal(r.p1, '【THIS IS A PARAGRAPH WITH A <a href="/docs">LINK TO DOCS</a>, SOME <strong>BOLD TEXT</strong>, INLINE <code>code()</code> AND AN IMAGE <img src="x.png" alt="x">.<br>SECOND LINE AFTER BREAK.】');
  assert.equal(r.mixed, '【LEADING TEXT BEFORE BLOCK】 <p>【INNER PARAGRAPH TEXT】</p> 【TRAILING TEXT AFTER BLOCK】');
  assert.equal(r.li2, '【SECOND ITEM WITH <span class="notranslate">KeepMe</span>】');
  assert.equal(r.zh, '這一段已經是中文，不應該被翻譯。');
  assert.equal(r.num, '12345 - 67%');
  assert.equal(r.pre, 'preformatted  text   stays');
  assert.equal(r.notr, 'Do not translate me');
  assert.equal(r.btn, '【CLICK HERE】');
  assert.equal(r.td, '【CELL CONTENT】');
  assert.equal(r.ja, 'これは日本語の文章です。');
  assert.equal(r.shadow, '【SHADOW PARAGRAPH WITH <b>BOLD</b>】');
  assert.equal(r.far, 'Far away paragraph at the bottom', 'lazy: off-screen unit not yet translated');
  assert.equal(r.hidden, 'Hidden text block', 'display:none not translated until shown');
  assert.ok(r.active && r.toast);
  assert.ok(r.translateCalls >= 1 && r.translateCalls <= 3, `batched into ${r.translateCalls} calls`);

  // 捲到底 → 延遲翻譯
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await wait(400);
  assert.equal(await page.evaluate(() => document.getElementById('far').textContent), '【FAR AWAY PARAGRAPH AT THE BOTTOM】');

  // 顯示隱藏區塊 → 自動翻譯
  await page.evaluate(() => { window.scrollTo(0, 0); document.getElementById('hidden').classList.remove('hidden'); });
  await wait(400);
  assert.equal(await page.evaluate(() => document.getElementById('hidden').textContent), '【HIDDEN TEXT BLOCK】');

  // 動態加入內容
  await page.evaluate(() => { document.getElementById('dyn').innerHTML = '<p id="dp">Dynamic <i>content</i> arrived</p>'; window.scrollTo(0, 0); });
  await wait(500);
  assert.equal(await page.evaluate(() => document.getElementById('dp').innerHTML), '【DYNAMIC <i>CONTENT</i> ARRIVED】');

  // 還原
  await page.evaluate(() => window.__send({ type: 'restorePage' }));
  await wait(100);
  const after = await page.evaluate(() => document.body.innerHTML);
  const strip = (s) => s.replace(/<div id="dyn">[\s\S]*?<\/div>/, '<div id="dyn"></div>').replace(/<div class="hidden" id="hidden">|<div class="" id="hidden">/, '<div id="hidden">');
  assert.equal(strip(after), strip(before));
  const shadowAfter = await page.evaluate(() => document.getElementById('shadow-host').shadowRoot.querySelector('#sp').innerHTML);
  assert.equal(shadowAfter, 'Shadow paragraph with <b>bold</b>');

  // 再翻譯一次：應從頁內快取立即回填，不再呼叫 API
  const callsBefore = await page.evaluate(() => window.__calls.filter((c) => c.type === 'translate').length);
  await page.evaluate(() => window.__send({ type: 'translatePage' }));
  await wait(300);
  const r2 = await page.evaluate(() => ({ h1: document.getElementById('h1').innerHTML, calls: window.__calls.filter((c) => c.type === 'translate').length }));
  assert.equal(r2.h1, '【WELCOME TO THE <em>EXAMPLE</em> SITE】');
  assert.equal(r2.calls, callsBefore);
});

await test('replace mode: model drops a tag → element is appended, not lost', async (page) => {
  await inject(page);
  await page.evaluate(() => { window.__fake = (s) => '譯文沒有標籤'; });
  await page.evaluate(() => window.__send({ type: 'translatePage' }));
  await wait(300);
  const p1 = await page.evaluate(() => document.getElementById('p1').innerHTML);
  assert.ok(p1.startsWith('譯文沒有標籤'));
  assert.ok(p1.includes('<a href="/docs">link to docs</a>'));
  assert.ok(p1.includes('<img src="x.png" alt="x">'));
});

await test('bilingual mode: original untouched, translation appended, restore removes it', async (page) => {
  await inject(page, { displayMode: 'bilingual', lazy: false });
  const before = await page.evaluate(() => document.body.innerHTML);
  await page.evaluate(() => window.__send({ type: 'translatePage' }));
  await wait(400);
  const r = await page.evaluate(() => ({
    p1: document.getElementById('p1').innerHTML,
    far: document.getElementById('far').innerHTML,
    li2: document.getElementById('li2').innerHTML
  }));
  assert.ok(r.p1.startsWith('This is a paragraph with a <a href="/docs">link to docs</a>'), 'original kept');
  assert.ok(/<span data-llmt="translation" translate="no" lang="zh-Hant" style="display: ?block;[^"]*">【THIS IS A PARAGRAPH WITH A <a href="\/docs">LINK TO DOCS<\/a>/.test(r.p1), r.p1);
  assert.ok(r.far.includes('【FAR AWAY PARAGRAPH AT THE BOTTOM】'), 'eager mode translated off-screen unit');
  assert.ok(r.li2.includes('<span class="notranslate">KeepMe</span>】'));
  await page.evaluate(() => window.__send({ type: 'restorePage' }));
  await wait(100);
  const after = await page.evaluate(() => document.body.innerHTML);
  assert.equal(after, before);
});

await test('error from background surfaces in status and toast', async (page) => {
  await inject(page);
  await page.evaluate(() => {
    const orig = window.chrome.runtime.sendMessage;
    window.chrome.runtime.sendMessage = (msg, cb) => {
      if (msg.type === 'translate') return setTimeout(() => cb({ ok: false, error: { code: 'NO_API_KEY', message: '尚未設定 API key' } }), 5);
      return orig(msg, cb);
    };
  });
  await page.evaluate(() => window.__send({ type: 'translatePage' }));
  await wait(300);
  const r = await page.evaluate(async () => {
    const st = await window.__send({ type: 'getStatus' });
    return { err: st.lastError?.code, failed: st.failed, toast: document.getElementById('llmt-toast')?.textContent, h1: document.getElementById('h1').textContent };
  });
  assert.equal(r.err, 'NO_API_KEY');
  assert.ok(r.failed > 0);
  assert.ok(r.toast.includes('尚未設定 API key'));
  assert.equal(r.h1, 'Welcome to the example site');
});

await browser.close();
if (failures) { console.error(`${failures} failure(s)`); process.exit(1); }
console.log('all content tests passed');
