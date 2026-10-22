/*
 * 精準網頁翻譯 — content script
 *
 * 負責：
 *  1. 把頁面切成「翻譯單元」（一段只含行內元素的文字），保留行內標籤結構
 *  2. 把單元序列化成帶 <g1>…</g1> / <x2/> 標記的字串，交給 background 翻譯
 *  3. 把譯文解析回 DOM（取代原文或雙語對照），並可一鍵還原
 *  4. 以 IntersectionObserver 做延遲翻譯（只翻看得到的區域）、MutationObserver 處理動態內容
 *  5. 支援 open Shadow DOM 與 iframe（每個 frame 各自執行一份）
 */
(() => {
  if (window.__llmtInstalled) return;
  window.__llmtInstalled = true;

  const IS_TOP = window.top === window;

  // ---------- 標籤分類 ----------
  // 永遠不翻譯、不深入
  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'META', 'LINK', 'TITLE', 'BASE',
    'IFRAME', 'FRAME', 'OBJECT', 'EMBED', 'CANVAS', 'VIDEO', 'AUDIO', 'SOURCE', 'TRACK',
    'TEXTAREA', 'INPUT', 'SELECT', 'OPTION', 'OPTGROUP', 'DATALIST', 'PROGRESS', 'METER',
    'SVG', 'MATH', 'PRE', 'XMP', 'PLAINTEXT'
  ]);
  // 行內元素：可以出現在翻譯單元內並保留為 <gN> 群組
  const INLINE_TAGS = new Set([
    'A', 'ABBR', 'ACRONYM', 'B', 'BDI', 'BDO', 'BIG', 'CITE', 'DATA', 'DEL', 'DFN', 'EM', 'FONT',
    'I', 'INS', 'LABEL', 'MARK', 'Q', 'RB', 'RP', 'RT', 'RTC', 'RUBY', 'S', 'SMALL', 'SPAN',
    'STRIKE', 'STRONG', 'SUB', 'SUP', 'TIME', 'TT', 'U', 'BUTTON', 'OUTPUT', 'NOBR'
  ]);
  // 行內但內容不翻譯，當成不透明佔位符 <xN/>
  const OPAQUE_TAGS = new Set([
    'CODE', 'KBD', 'SAMP', 'VAR', 'IMG', 'BR', 'WBR', 'SVG', 'MATH', 'INPUT', 'SELECT',
    'TEXTAREA', 'PICTURE', 'CANVAS', 'VIDEO', 'AUDIO', 'IFRAME', 'OBJECT', 'EMBED', 'TEMPLATE',
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'METER', 'PROGRESS'
  ]);

  const OWN_ATTR = 'data-llmt';

  // ---------- 狀態 ----------
  const state = {
    active: false,          // 目前是否處於「已翻譯」狀態
    settings: null,
    units: [],              // 所有單元
    nodeToUnit: new WeakMap(),
    ownNodes: new WeakSet(),// 我們自己插入的節點（Mutation 時忽略）
    io: null,               // IntersectionObserver
    mo: null,               // MutationObserver
    observedRoots: new WeakSet(),
    queue: new Set(),       // 待送出的單元
    flushTimer: null,
    inflight: 0,
    done: 0,
    failed: 0,
    total: 0,
    lastError: null,
    pageLang: null,
    textCache: new Map(),   // 本頁內 原文→譲文 快取（SPA 重繪時立即回填）
    toast: null
  };

  const log = (...a) => { if (state.settings?.debug) console.debug('[llmt]', ...a); };

  // ---------- 設定 ----------
  async function loadSettings() {
    const res = await sendBg({ type: 'getSettings' });
    state.settings = res.settings;
    return state.settings;
  }

  function sendBg(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: { code: 'RUNTIME', message: chrome.runtime.lastError.message } });
          } else resolve(res || { ok: false, error: { code: 'EMPTY', message: '無回應' } });
        });
      } catch (e) {
        resolve({ ok: false, error: { code: 'RUNTIME', message: String(e) } });
      }
    });
  }

  // ---------- 語言判斷 ----------
  const RE_LATIN = /[A-Za-zÀ-ɏ]{2,}/;
  const RE_KANA = /[぀-ヿ]/;
  const RE_HANGUL = /[가-힯ᄀ-ᇿ]/;
  const RE_HAN = /[一-鿿㐀-䶿]/g;
  const RE_LETTER = /\p{L}/u;
  const RE_URLISH = /^(?:https?:\/\/\S+|[\w.+-]+@[\w-]+\.[\w.-]+|[\w-]+(?:\.[\w-]+)+(?:\/\S*)?)$/i;

  function shouldTranslateText(plain) {
    const t = plain.trim();
    if (!t || !RE_LETTER.test(t)) return false;          // 沒有任何字母
    if (RE_URLISH.test(t)) return false;                  // 純網址／Email／網域
    const src = state.settings?.sourceLanguages || ['en', 'ja', 'ko'];
    const any = src.includes('any');
    const hasKana = RE_KANA.test(t);
    const hasHangul = RE_HANGUL.test(t);
    const hanCount = (t.match(RE_HAN) || []).length;
    const latinLetters = (t.match(/[A-Za-zÀ-ɏ]/g) || []).length;

    // 已經是中文（有漢字、沒有假名／韓文，且漢字相對拉丁字母不算少）→ 不翻
    if (!hasKana && !hasHangul && hanCount > 0 && (latinLetters === 0 || (hanCount >= 2 && hanCount >= latinLetters * 0.3))) {
      // 例外：日文網頁上的純漢字詞（東京都、設定）交給模型判斷
      if (src.includes('ja') && state.pageLang === 'ja' && latinLetters === 0) return true;
      return false;
    }

    if (any) return true;
    if (src.includes('ja') && hasKana) return true;
    if (src.includes('ko') && hasHangul) return true;
    if (src.includes('en') && RE_LATIN.test(t) && !hasKana && !hasHangul) return true;
    return false;
  }

  // ---------- 元素判斷 ----------
  function isOwn(node) {
    return state.ownNodes.has(node) || (node.nodeType === 1 && node.hasAttribute(OWN_ATTR));
  }

  function isSkippable(el) {
    if (SKIP_TAGS.has(el.tagName)) return true;
    if (el.hasAttribute(OWN_ATTR)) return true;
    const tr = el.getAttribute('translate');
    if (tr === 'no') return true;
    if (el.classList && el.classList.contains('notranslate')) return true;
    const ce = el.getAttribute('contenteditable');
    if (ce !== null && ce !== 'false') return true;
    if (el.id === 'llmt-toast') return true;
    return false;
  }

  function isInlineEl(el) {
    return INLINE_TAGS.has(el.tagName) || OPAQUE_TAGS.has(el.tagName);
  }

  // 元素是否可做為翻譯單元內的行內內容（含其子樹）
  function isInlineSubtree(el) {
    if (!isInlineEl(el)) return false;
    if (OPAQUE_TAGS.has(el.tagName) || isSkippable(el)) return true; // 不透明，不看內部
    for (const c of el.children) {
      if (!isInlineSubtree(c)) return false;
    }
    return true;
  }

  function hasText(node) {
    return /\S/.test(node.textContent || '');
  }

  // ---------- 收集翻譯單元 ----------
  // 單元 = 同一父節點下、連續的行內節點（文字節點 + 行內元素）
  function collect(root, out) {
    if (!root) return;
    if (root.nodeType === 11 /* ShadowRoot / fragment */ || root.nodeType === 9) {
      observeRoot(root);
      for (const c of Array.from(root.childNodes)) collectNode(c, out);
      return;
    }
    collectNode(root, out);
  }

  function collectNode(node, out) {
    if (node.nodeType === 3) {
      // 游離文字節點（父節點含區塊元素）→ 以其父節點為基礎分 run
      if (node.parentNode && !state.nodeToUnit.has(node)) collectRuns(node.parentNode, out, node);
      return;
    }
    if (node.nodeType !== 1) return;
    const el = node;
    if (isSkippable(el) || isOwn(el)) return;
    if (el.shadowRoot) collect(el.shadowRoot, out);
    collectRuns(el, out);
  }

  // 把 parent 的子節點依「行內 run」分段
  function collectRuns(parent, out, onlyContaining) {
    if (parent.nodeType !== 1 && parent.nodeType !== 11) return;
    if (parent.nodeType === 1 && (isSkippable(parent) || isOwn(parent))) return;
    const children = Array.from(parent.childNodes);
    let run = [];
    const flush = () => {
      if (run.length) {
        if (!onlyContaining || run.includes(onlyContaining)) makeUnit(parent, run, out);
        run = [];
      }
    };
    for (const c of children) {
      if (isOwn(c)) { continue; } // 我們插入的雙語節點：忽略、不打斷 run
      if (c.nodeType === 3) { run.push(c); continue; }
      if (c.nodeType === 8) { continue; } // 註解不打斷 run
      if (c.nodeType !== 1) { flush(); continue; }
      if (isInlineSubtree(c)) { run.push(c); continue; }
      // 區塊元素：結束目前 run，並遞迴
      flush();
      if (!onlyContaining) collectNode(c, out);
    }
    flush();
  }

  function makeUnit(parent, nodes, out) {
    // 去掉頭尾純空白文字節點
    const isWs = (n) => n.nodeType === 3 && !/\S/.test(n.nodeValue);
    while (nodes.length && isWs(nodes[0])) nodes.shift();
    while (nodes.length && isWs(nodes[nodes.length - 1])) nodes.pop();
    // 整個 run 只有一個可深入的行內元素（例如獨立的 <a>、<span>、<button>）→ 以它的子節點為單元
    while (nodes.length === 1 && nodes[0].nodeType === 1 && !OPAQUE_TAGS.has(nodes[0].tagName) && !isSkippable(nodes[0])) {
      parent = nodes[0];
      nodes = Array.from(parent.childNodes).filter((n) => !isOwn(n) && n.nodeType !== 8);
      while (nodes.length && isWs(nodes[0])) nodes.shift();
      while (nodes.length && isWs(nodes[nodes.length - 1])) nodes.pop();
    }
    if (!nodes.length) return;
    // 已有單元涵蓋這些節點 → 跳過
    for (const n of nodes) {
      const u = state.nodeToUnit.get(n);
      if (u && u.state !== 'stale') return;
    }
    if (!nodes.some(hasText)) return;
    const ser = serialize(nodes);
    if (!ser) return;
    if (!shouldTranslateText(ser.plain)) return;
    const unit = {
      id: state.units.length,
      parent,
      nodes,
      elems: ser.elems,
      text: ser.text,
      prefix: ser.prefix,
      suffix: ser.suffix,
      state: 'pending',
      translation: null,
      snapshot: null,
      currentNodes: null,
      inserted: null
    };
    for (const n of nodes) state.nodeToUnit.set(n, unit);
    state.units.push(unit);
    out.push(unit);
  }

  // ---------- 序列化 ----------
  function esc(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;'); }
  function unesc(s) { return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'); }

  function serialize(nodes) {
    const elems = [];
    const parentEl = nodes[0].parentNode.nodeType === 1 ? nodes[0].parentNode : nodes[0].parentNode.host;
    let pre = false;
    try { pre = parentEl && /^pre/.test(getComputedStyle(parentEl).whiteSpace); } catch (_) { /* ignore */ }

    const walk = (list) => {
      let s = '';
      for (const n of list) {
        if (n.nodeType === 3) { s += esc(n.nodeValue); continue; }
        if (n.nodeType !== 1) continue;
        if (isOwn(n)) continue;
        const idx = elems.length;
        elems.push(n);
        const opaque = OPAQUE_TAGS.has(n.tagName) || isSkippable(n) || !hasText(n);
        if (opaque) s += `<x${idx}/>`;
        else s += `<g${idx}>${walk(Array.from(n.childNodes))}</g${idx}>`;
      }
      return s;
    };
    let text = walk(nodes);
    if (!pre) text = text.replace(/\s+/g, ' ');
    const m = text.match(/^(\s*)([\s\S]*?)(\s*)$/);
    const prefix = m[1], core = m[2], suffix = m[3];
    if (!core) return null;
    const plain = unesc(core.replace(/<\/?[gx]\d+\/?>/g, ''));
    return { text: core, plain, elems, prefix, suffix };
  }

  // ---------- 解析譯文 ----------
  // 回傳 [{type:'text', value}|{type:'g', idx, children}|{type:'x', idx}]
  function parseTranslation(str, elemCount) {
    const tokens = [];
    const re = /<(\/?)([gx])(\d+)\s*(\/?)>/g;
    let last = 0, m;
    while ((m = re.exec(str))) {
      if (m.index > last) tokens.push({ type: 'text', value: str.slice(last, m.index) });
      const idx = parseInt(m[3], 10);
      if (idx >= elemCount) { tokens.push({ type: 'text', value: m[0] }); last = re.lastIndex; continue; }
      if (m[2] === 'x') tokens.push({ type: 'x', idx });
      else if (m[1] === '/') tokens.push({ type: 'close', idx });
      else if (m[4] === '/') tokens.push({ type: 'x', idx }); // <g3/> 視為空元素
      else tokens.push({ type: 'open', idx });
      last = re.lastIndex;
    }
    if (last < str.length) tokens.push({ type: 'text', value: str.slice(last) });

    const root = { children: [] };
    const stack = [root];
    const used = new Set();
    for (const t of tokens) {
      const cur = stack[stack.length - 1];
      if (t.type === 'text') {
        cur.children.push({ type: 'text', value: unesc(t.value) });
      } else if (t.type === 'x') {
        if (used.has(t.idx)) continue;
        used.add(t.idx);
        cur.children.push({ type: 'x', idx: t.idx });
      } else if (t.type === 'open') {
        if (used.has(t.idx)) continue;
        used.add(t.idx);
        const node = { type: 'g', idx: t.idx, children: [] };
        cur.children.push(node);
        stack.push(node);
      } else if (t.type === 'close') {
        // 找到最近的同 idx 開啟節點並關閉到那裡
        let i = stack.length - 1;
        while (i > 0 && stack[i].idx !== t.idx) i--;
        if (i > 0) stack.length = i;
      }
    }
    return { tree: root.children, used };
  }

  // ---------- 套用譯文 ----------
  function unitAttached(unit) {
    return unit.nodes.every((n) => n.parentNode === unit.parent);
  }

  function takeSnapshot(unit) {
    const elemChildren = new Map();
    const textValues = new Map();
    const walk = (list) => {
      for (const n of list) {
        if (n.nodeType === 3) textValues.set(n, n.nodeValue);
        else if (n.nodeType === 1 && !OPAQUE_TAGS.has(n.tagName) && !isSkippable(n)) {
          const kids = Array.from(n.childNodes);
          elemChildren.set(n, kids);
          walk(kids);
        }
      }
    };
    walk(unit.nodes);
    return { elemChildren, textValues };
  }

  function buildNodes(tree, unit, clone) {
    const out = [];
    for (const t of tree) {
      if (t.type === 'text') {
        if (!t.value) continue;
        const tn = document.createTextNode(t.value);
        state.ownNodes.add(tn);
        out.push(tn);
      } else if (t.type === 'x') {
        const el = unit.elems[t.idx];
        if (!el) continue;
        if (clone) { const c = el.cloneNode(true); state.ownNodes.add(c); out.push(c); }
        else out.push(el);
      } else if (t.type === 'g') {
        const el = unit.elems[t.idx];
        if (!el) continue;
        const kids = buildNodes(t.children, unit, clone);
        if (clone) {
          const c = el.cloneNode(false);
          c.removeAttribute('id');
          state.ownNodes.add(c);
          for (const k of kids) c.appendChild(k);
          out.push(c);
        } else {
          el.replaceChildren(...kids);
          out.push(el);
        }
      }
    }
    return out;
  }

  function applyTranslation(unit, translated) {
    if (!unitAttached(unit)) { unit.state = 'stale'; return false; }
    const mode = state.settings.displayMode || 'replace';
    const { tree, used } = parseTranslation(translated, unit.elems.length);
    // 被模型漏掉的元素（例如連結）補在最後，避免內容消失
    for (let i = 0; i < unit.elems.length; i++) {
      if (!used.has(i) && !isNestedInUsed(unit, i, used)) {
        tree.push(OPAQUE_TAGS.has(unit.elems[i].tagName) || !hasText(unit.elems[i])
          ? { type: 'x', idx: i }
          : { type: 'g', idx: i, children: [{ type: 'text', value: unit.elems[i].textContent }] });
      }
    }
    if (tree.length && tree[0].type === 'text') tree[0].value = unit.prefix + tree[0].value;
    else if (unit.prefix) tree.unshift({ type: 'text', value: unit.prefix });
    const lastT = tree[tree.length - 1];
    if (lastT && lastT.type === 'text') lastT.value += unit.suffix;
    else if (unit.suffix) tree.push({ type: 'text', value: unit.suffix });

    unit.translation = translated;
    state.textCache.set(unit.text, translated);

    if (mode === 'bilingual') {
      const wrap = document.createElement('span');
      wrap.setAttribute(OWN_ATTR, 'translation');
      wrap.setAttribute('translate', 'no');
      wrap.lang = state.settings.targetLanguage === 'zh-CN' ? 'zh-Hans' : 'zh-Hant';
      const built = buildNodes(tree, unit, true);
      for (const b of built) wrap.appendChild(b);
      styleBilingual(wrap, unit);
      state.ownNodes.add(wrap);
      const anchor = unit.nodes[unit.nodes.length - 1].nextSibling;
      unit.parent.insertBefore(wrap, anchor);
      unit.inserted = wrap;
    } else {
      unit.snapshot = takeSnapshot(unit);
      const built = buildNodes(tree, unit, false);
      const anchor = unit.nodes[unit.nodes.length - 1].nextSibling;
      for (const n of unit.nodes) if (n.parentNode === unit.parent) unit.parent.removeChild(n);
      for (const n of built) unit.parent.insertBefore(n, anchor);
      unit.currentNodes = built;
      for (const n of built) state.nodeToUnit.set(n, unit);
    }
    unit.state = 'done';
    return true;
  }

  function isNestedInUsed(unit, idx, used) {
    let p = unit.elems[idx].parentNode;
    while (p && p !== unit.parent) {
      const j = unit.elems.indexOf(p);
      if (j >= 0 && used.has(j)) return true;
      p = p.parentNode;
    }
    return false;
  }

  function styleBilingual(wrap, unit) {
    let block = false;
    try {
      const parentEl = unit.parent.nodeType === 1 ? unit.parent : null;
      const d = parentEl ? getComputedStyle(parentEl).display : 'block';
      const coversAll = parentEl && Array.from(parentEl.childNodes).every((n) => unit.nodes.includes(n) || isOwn(n) || n.nodeType === 8 || (n.nodeType === 3 && !/\S/.test(n.nodeValue)));
      block = coversAll && !/^inline/.test(d) && d !== 'contents' && !['A', 'BUTTON', 'LABEL', 'SPAN'].includes(parentEl.tagName);
    } catch (_) { /* ignore */ }
    const style = state.settings.bilingualStyle || 'underline';
    let css = block ? 'display:block;margin-top:0.25em;' : 'display:inline;margin-left:0.35em;';
    if (style === 'underline') css += 'text-decoration:underline dashed rgba(120,120,120,.6);text-decoration-thickness:1px;text-underline-offset:3px;';
    else if (style === 'muted') css += 'opacity:.82;';
    else if (style === 'highlight') css += 'background:rgba(255,230,120,.25);border-radius:3px;padding:0 .15em;';
    wrap.style.cssText = css;
  }

  function restoreUnit(unit) {
    if (unit.state !== 'done') return;
    if (unit.inserted) {
      unit.inserted.remove();
      unit.inserted = null;
    } else if (unit.snapshot) {
      const { elemChildren, textValues } = unit.snapshot;
      for (const [el, kids] of elemChildren) el.replaceChildren(...kids);
      for (const [tn, v] of textValues) tn.nodeValue = v;
      if (unit.currentNodes) {
        const anchor = (() => {
          for (let i = unit.currentNodes.length - 1; i >= 0; i--) {
            const n = unit.currentNodes[i];
            if (n.parentNode === unit.parent) return n.nextSibling;
          }
          return null;
        })();
        for (const n of unit.currentNodes) if (n.parentNode === unit.parent) unit.parent.removeChild(n);
        for (const n of unit.nodes) unit.parent.insertBefore(n, anchor);
      }
      unit.snapshot = null;
      unit.currentNodes = null;
    }
    unit.state = 'pending';
  }

  // ---------- 排程與批次 ----------
  function enqueue(unit) {
    if (!state.active) return;
    if (unit.state !== 'pending') return;
    const cached = state.textCache.get(unit.text);
    if (cached) { applyTranslation(unit, cached); state.done++; updateToast(); return; }
    unit.state = 'queued';
    state.queue.add(unit);
    if (!state.flushTimer) state.flushTimer = setTimeout(flush, 60);
  }

  async function flush() {
    state.flushTimer = null;
    if (!state.active) { state.queue.clear(); return; }
    const units = Array.from(state.queue);
    state.queue.clear();
    if (!units.length) return;
    units.sort((a, b) => a.id - b.id);
    const maxChars = state.settings.batchChars || 1500;
    const maxItems = state.settings.batchItems || 30;
    let batch = [], chars = 0;
    const batches = [];
    for (const u of units) {
      if (batch.length && (chars + u.text.length > maxChars || batch.length >= maxItems)) { batches.push(batch); batch = []; chars = 0; }
      batch.push(u); chars += u.text.length;
    }
    if (batch.length) batches.push(batch);
    for (const b of batches) sendBatch(b);
  }

  async function sendBatch(units) {
    // 同文去重
    const uniq = new Map();
    for (const u of units) { if (!uniq.has(u.text)) uniq.set(u.text, []); uniq.get(u.text).push(u); }
    const texts = Array.from(uniq.keys());
    state.inflight += units.length;
    updateToast();
    const res = await sendBg({
      type: 'translate',
      texts,
      context: { title: document.title, host: location.hostname, pageLang: state.pageLang }
    });
    state.inflight -= units.length;
    if (!state.active) return;
    if (!res.ok) {
      state.lastError = res.error;
      for (const u of units) { u.state = 'error'; state.failed++; }
      updateToast();
      return;
    }
    texts.forEach((t, i) => {
      const out = res.results[i];
      for (const u of uniq.get(t)) {
        if (u.state !== 'queued') continue;
        if (typeof out === 'string' && out.trim()) {
          if (applyTranslation(u, out)) state.done++; else state.failed++;
        } else { u.state = 'error'; state.failed++; }
      }
    });
    if (res.error) state.lastError = res.error;
    updateToast();
  }

  // ---------- Observers ----------
  function ensureObservers() {
    if (!state.io) {
      state.io = new IntersectionObserver((entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const us = parentUnits.get(e.target);
          if (!us) continue;
          for (const u of us) if (u.state === 'pending') enqueue(u);
        }
      }, { rootMargin: '100% 0px 100% 0px' });
    }
    if (!state.mo) {
      state.mo = new MutationObserver(onMutations);
    }
    observeRoot(document);
  }

  function observeRoot(root) {
    if (!state.mo || state.observedRoots.has(root)) return;
    state.observedRoots.add(root);
    state.mo.observe(root, { childList: true, subtree: true, characterData: true });
  }

  const parentUnits = new WeakMap(); // parent element → units[]

  function registerUnits(units) {
    const eager = !state.settings.lazy;
    for (const u of units) {
      const target = u.parent.nodeType === 1 ? u.parent : (u.parent.host || null);
      if (eager || !target) { enqueue(u); continue; }
      if (!parentUnits.has(target)) parentUnits.set(target, []);
      parentUnits.get(target).push(u);
      state.io.observe(target);
    }
    state.total += units.length;
    updateToast();
  }

  let mutationTimer = null;
  const pendingMutations = [];
  function onMutations(records) {
    if (!state.active) return;
    for (const r of records) pendingMutations.push(r);
    if (!mutationTimer) mutationTimer = setTimeout(processMutations, 80);
  }

  function processMutations() {
    mutationTimer = null;
    if (!state.active) { pendingMutations.length = 0; return; }
    const records = pendingMutations.splice(0);
    const fresh = [];
    const seen = new Set();
    for (const r of records) {
      if (r.type === 'characterData') {
        const tn = r.target;
        if (isOwn(tn)) continue;
        const u = state.nodeToUnit.get(tn);
        if (u && u.state === 'done' && u.snapshot && u.snapshot.textValues.has(tn)) {
          // 頁面自己改了原文字：視為新內容
          u.snapshot.textValues.set(tn, tn.nodeValue);
        }
        if (u && (u.state === 'done' || u.state === 'error')) { u.state = 'stale'; }
        if (tn.parentNode && !seen.has(tn.parentNode)) { seen.add(tn.parentNode); collectRuns(tn.parentNode, fresh); }
        continue;
      }
      for (const n of r.addedNodes) {
        if (isOwn(n)) continue;
        if (n.nodeType === 3) {
          const p = n.parentNode;
          if (p && !seen.has(p)) { seen.add(p); collectRuns(p, fresh); }
        } else if (n.nodeType === 1) {
          if (isSkippable(n)) continue;
          // 新元素是行內 → 以父節點重新分 run；否則整棵收集
          if (isInlineSubtree(n) && n.parentNode) {
            const p = n.parentNode;
            if (!seen.has(p)) { seen.add(p); collectRuns(p, fresh); }
          } else collect(n, fresh);
        }
      }
    }
    if (fresh.length) { log('mutation units', fresh.length); registerUnits(fresh); }
  }

  // ---------- 主要操作 ----------
  async function translatePage() {
    await loadSettings();
    if (state.active) return status();
    state.active = true;
    state.lastError = null;
    ensureObservers();
    if (!state.pageLang) detectPageLanguage();
    const fresh = [];
    // 復用先前已收集但被還原的單元
    for (const u of state.units) if (u.state === 'pending' && unitAttached(u)) fresh.push(u);
    const startCount = state.units.length;
    collect(document.body || document.documentElement, fresh);
    log('units', fresh.length, 'new', state.units.length - startCount);
    state.total = 0; state.done = 0; state.failed = 0;
    registerUnits(fresh);
    reportBadge();
    return status();
  }

  function restorePage() {
    state.active = false;
    state.queue.clear();
    if (state.flushTimer) { clearTimeout(state.flushTimer); state.flushTimer = null; }
    for (const u of state.units) {
      if (u.state === 'done') restoreUnit(u);
      else if (u.state === 'queued' || u.state === 'error' || u.state === 'stale') u.state = 'pending';
    }
    if (state.io) { state.io.disconnect(); state.io = null; }
    hideToast();
    reportBadge();
    return status();
  }

  function status() {
    return {
      ok: true,
      active: state.active,
      total: state.total,
      done: state.done,
      failed: state.failed,
      inflight: state.inflight,
      lastError: state.lastError,
      pageLang: state.pageLang,
      isTop: IS_TOP
    };
  }

  async function detectPageLanguage() {
    try {
      const sample = (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 3000);
      if (sample.length < 20) return null;
      const res = await sendBg({ type: 'detectLanguage', text: sample });
      if (res.ok) state.pageLang = res.language;
      return state.pageLang;
    } catch (_) { return null; }
  }

  function reportBadge() {
    if (!IS_TOP) return;
    sendBg({ type: 'badge', active: state.active });
  }

  // ---------- Toast ----------
  function ensureToast() {
    if (!IS_TOP || !state.settings?.showToast) return null;
    if (state.toast && document.contains(state.toast)) return state.toast;
    const host = document.createElement('div');
    host.id = 'llmt-toast';
    host.setAttribute(OWN_ATTR, 'toast');
    host.setAttribute('translate', 'no');
    host.style.cssText = 'position:fixed;z-index:2147483647;right:16px;bottom:16px;font:13px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans TC",sans-serif;background:rgba(32,33,36,.92);color:#fff;padding:8px 12px;border-radius:8px;box-shadow:0 2px 10px rgba(0,0,0,.3);max-width:320px;pointer-events:auto;cursor:default;';
    host.addEventListener('click', () => { if (state.lastError) sendBg({ type: 'openOptions' }); });
    state.ownNodes.add(host);
    (document.body || document.documentElement).appendChild(host);
    state.toast = host;
    return host;
  }

  let toastHideTimer = null;
  function updateToast() {
    if (!IS_TOP || !state.active) return;
    const t = ensureToast();
    if (!t) return;
    if (toastHideTimer) { clearTimeout(toastHideTimer); toastHideTimer = null; }
    if (state.lastError) {
      t.textContent = `翻譯失敗：${state.lastError.message || state.lastError.code}（點擊開啟設定）`;
      t.style.background = 'rgba(176,0,32,.92)';
      return;
    }
    t.style.background = 'rgba(32,33,36,.92)';
    if (state.inflight > 0) {
      t.textContent = `翻譯中… ${state.done}/${state.done + state.inflight}`;
    } else {
      t.textContent = `已翻譯 ${state.done} 段${state.failed ? `，${state.failed} 段失敗` : ''}`;
      toastHideTimer = setTimeout(hideToast, 2500);
    }
  }

  function hideToast() {
    if (state.toast) { state.toast.remove(); state.toast = null; }
  }

  // ---------- 訊息 ----------
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
      switch (msg.type) {
        case 'ping': return { ok: true, active: state.active, isTop: IS_TOP };
        case 'translatePage': return translatePage();
        case 'restorePage': return restorePage();
        case 'toggle': return state.active ? restorePage() : translatePage();
        case 'getStatus': {
          if (!state.settings) await loadSettings();
          if (!state.pageLang) await detectPageLanguage();
          return status();
        }
        case 'settingsChanged': {
          await loadSettings();
          state.textCache.clear(); // 供應商／語言可能變了，不再沿用頁內快取
          return { ok: true };
        }
        default: return null;
      }
    })().then((r) => {
      // 只有頂層 frame 回覆，避免多 frame 搶回應
      if (r && (IS_TOP || msg.type === 'ping')) sendResponse(r);
    }).catch((e) => { if (IS_TOP) sendResponse({ ok: false, error: { code: 'CONTENT', message: String(e) } }); });
    return true;
  });

  // ---------- 自動翻譯 ----------
  async function maybeAutoTranslate() {
    if (!IS_TOP) return;
    try {
      const s = await loadSettings();
      if (!s) return;
      const host = location.hostname;
      if (s.autoSites && s.autoSites.includes(host)) { sendBg({ type: 'translateTab' }); return; }
      if (s.autoLanguages && s.autoLanguages.length) {
        const lang = await detectPageLanguage();
        if (lang && s.autoLanguages.includes(lang)) sendBg({ type: 'translateTab' });
      }
    } catch (_) { /* ignore */ }
  }

  if (document.readyState === 'complete') setTimeout(maybeAutoTranslate, 300);
  else window.addEventListener('load', () => setTimeout(maybeAutoTranslate, 300), { once: true });

  // 測試用內部介面
  window.__llmt = { serialize, parseTranslation, shouldTranslateText, collect, state, translatePage, restorePage };
})();
