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
        if (!onlyContaining || run.includes(onlyContaining)) {
          const lines = splitLines(parent, run);
          if (lines && lines.group) makeLineGroup(parent, lines.group, out);
          else if (lines) for (const l of lines) makeUnit(parent, l.nodes, out, l.sep);
          else makeUnit(parent, run, out);
        }
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

  // 把「一段文字、用換行或 <br> 分行」的內容（歌詞、詩、說明文字）切成一行一個單元，
  // 這樣雙語對照可以一行原文配一行譯文，而不是整段譯文擠在最後。
  // 回傳 [{nodes, sep}]；不需要切時回傳 null。sep：'nl'＝以換行字元分行、'br'＝以 <br> 分行。
  function splitLines(parent, run) {
    const el = parent.nodeType === 1 ? parent : parent.host;
    let preWs = false;
    try { preWs = !!el && /^(pre|break-spaces)/.test(getComputedStyle(el).whiteSpace); } catch (_) { /* ignore */ }
    const NL = /\r?\n/;
    const isBr = (n) => n.nodeType === 1 && n.tagName === 'BR';
    const brCount = run.filter(isBr).length;
    // 單一文字節點、用換行字元分行（YouTube Music 歌詞）：不切節點、不換節點，只改它的文字。
    // 網站換歌時是直接改寫這個節點的內容，節點一旦被換掉，網站的更新就看不到了。
    if (preWs && !brCount) {
      const solid = run.filter((n) => !(n.nodeType === 3 && !/\S/.test(n.nodeValue)));
      if (solid.length === 1 && solid[0].nodeType === 3 && NL.test(solid[0].nodeValue)) return { group: solid[0] };
    }
    const hasNl = false;
    if (!brCount) return null;

    // <br>：像歌詞／詩（4 行以上且每行不長）就逐行切；否則只在連續兩個 <br>（段落間隔）處切
    let brMode = 'none';
    if (brCount) {
      const segs = [];
      let cur = '', prevBr = false, doubleBr = false;
      for (const n of run) {
        if (isBr(n)) { if (prevBr) doubleBr = true; if (cur.trim()) segs.push(cur.trim()); cur = ''; prevBr = true; }
        else { const t = n.textContent || ''; cur += t; if (/\S/.test(t)) prevBr = false; }
      }
      if (cur.trim()) segs.push(cur.trim());
      const lens = segs.map((s) => s.length).sort((a, b) => a - b);
      const median = lens.length ? lens[Math.floor(lens.length / 2)] : 0;
      if (segs.length >= 4 && median <= 60) brMode = 'all';
      else if (doubleBr) brMode = 'double';
    }
    if (!hasNl && brMode === 'none') return null;

    const expanded = run;

    const lines = [];
    let cur = [], lastSep = hasNl ? 'nl' : 'br';
    const push = (sep) => { lastSep = sep; if (cur.length) lines.push({ nodes: cur, sep }); cur = []; };
    let buf = [], bufBr = 0;
    const flushBuf = () => {
      if (!buf.length) return;
      if (bufBr >= 2) push('br'); else cur.push(...buf);
      buf = []; bufBr = 0;
    };
    for (const n of expanded) {
      if (brMode === 'double' && isBr(n)) { buf.push(n); bufBr++; continue; }
      if (brMode === 'double' && buf.length && n.nodeType === 3 && !/\S/.test(n.nodeValue)) { buf.push(n); continue; }
      flushBuf();
      if (hasNl && n.nodeType === 3 && /^[\r\n]+$/.test(n.nodeValue)) { push('nl'); continue; }
      if (brMode === 'all' && isBr(n)) { push('br'); continue; }
      cur.push(n);
    }
    flushBuf();
    push(lastSep);
    if (lines.length < 2) return [{ nodes: expanded, sep: null }];
    return lines;
  }

  // 多行文字節點：每行一個「虛擬單元」，共用同一個文字節點，譯文回來後重組整個節點的文字
  function makeLineGroup(parent, tn, out) {
    const existing = state.nodeToUnit.get(tn);
    if (existing && existing.state !== 'stale') {
      if (existing.isGroup ? groupAttached(existing) : true) return;
      markGroupStale(existing);
    }
    const group = { isGroup: true, tn, parent, orig: tn.nodeValue, written: null, state: 'active', parts: [] };
    const pieces = tn.nodeValue.split(/((?:\r?\n)+)/);
    const made = [];
    pieces.forEach((piece, i) => {
      if (i % 2 === 1) { group.parts.push({ sep: piece }); return; }
      const m = piece.match(/^(\s*)([\s\S]*?)(\s*)$/);
      const part = { raw: piece, lead: m[1], core: m[2], trail: m[3], unit: null };
      group.parts.push(part);
      if (!m[2] || !shouldTranslateText(m[2])) return;
      const unit = {
        id: state.units.length, parent, nodes: [tn], elems: [], text: esc(m[2]), prefix: '', suffix: '',
        state: 'pending', translation: null, snapshot: null, currentNodes: null, inserted: null, lineSep: null,
        group, plain: null
      };
      part.unit = unit;
      state.units.push(unit);
      made.push(unit);
    });
    if (!made.length) return;
    state.nodeToUnit.set(tn, group);
    out.push(...made);
  }

  function groupAttached(g) {
    return g.state !== 'stale' && g.tn.parentNode === g.parent && g.tn.nodeValue === (g.written ?? g.orig);
  }

  function markGroupStale(g) {
    g.state = 'stale';
    for (const p of g.parts) if (p.unit) p.unit.state = 'stale';
  }

  function renderGroup(g) {
    const bilingual = (state.settings.displayMode || 'replace') === 'bilingual';
    const text = g.parts.map((p) => {
      if (p.sep !== undefined) return p.sep;
      if (!p.unit || p.unit.state !== 'done') return p.raw;
      return bilingual ? `${p.raw}\n${p.lead}${p.unit.plain}` : `${p.lead}${p.unit.plain}${p.trail}`;
    }).join('');
    const changed = g.parts.some((p) => p.unit && p.unit.state === 'done');
    g.written = changed ? text : null;
    if (g.tn.nodeValue !== text) g.tn.nodeValue = text;
  }

  function makeUnit(parent, nodes, out, lineSep) {
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
      inserted: null,
      lineSep: lineSep || null   // 逐行單元：雙語譯文要另起一行
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
    if (unit.group) return groupAttached(unit.group);
    return unit.nodes.every((n) => n.parentNode === unit.parent);
  }

  // 單元的原文是否仍和收集當時一樣（未翻譯狀態下才有意義）
  function unitFresh(unit) {
    if (!unitAttached(unit)) return false;
    if (unit.group) return true;
    const ser = serialize(unit.nodes);
    return !!ser && ser.text === unit.text;
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
        // 取代模式盡量沿用原本的文字節點：React、Polymer 等框架會持有節點參考並直接改寫內容，
        // 換成新節點的話，網站之後的更新就不會顯示出來
        const reuse = !clone && unit.pool && unit.pool.length ? unit.pool.shift() : null;
        if (reuse) {
          reuse.nodeValue = t.value;
          unit.written.set(reuse, t.value);
          out.push(reuse);
          continue;
        }
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
    if (unit.group) {
      const g = unit.group;
      if (!groupAttached(g)) { markGroupStale(g); return false; }
      unit.translation = translated;
      unit.plain = unesc(translated.replace(/<\/?[gx]\d+\s*\/?>/g, '')).replace(/\s*\r?\n\s*/g, ' ').trim();
      state.textCache.set(unit.text, translated);
      unit.state = 'done';
      renderGroup(g);
      return true;
    }
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
      unit.pool = Array.from(unit.snapshot.textValues.keys());
      // 沿用的文字節點（含行內元素裡面的）都屬於這個單元，之後不可再被當成新內容收集
      for (const tn of unit.pool) state.nodeToUnit.set(tn, unit);
      unit.written = new Map();
      const built = buildNodes(tree, unit, false);
      unit.pool = null;
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
    const style0 = state.settings.bilingualStyle || 'underline';
    if (unit.lineSep) {
      // 逐行內容：譯文放在原文下一行，用和原文相同的分行方式（換行字元或 <br>）
      const brk = unit.lineSep === 'nl' ? document.createTextNode('\n') : document.createElement('br');
      state.ownNodes.add(brk);
      wrap.insertBefore(brk, wrap.firstChild);
      let lcss = 'display:inline;';
      if (style0 === 'underline') lcss += 'text-decoration:underline dashed rgba(120,120,120,.6);text-decoration-thickness:1px;text-underline-offset:3px;';
      else if (style0 === 'muted') lcss += 'opacity:.82;';
      else if (style0 === 'highlight') lcss += 'background:rgba(255,230,120,.25);border-radius:3px;';
      wrap.style.cssText = lcss;
      return;
    }
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
    if (unit.group) {
      const g = unit.group;
      unit.state = 'pending';
      if (groupAttached(g)) renderGroup(g); // 逐行退回；全部退回後就是原文
      return;
    }
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
      // 已在觀察中的元素不會再次觸發，先取消再觀察，讓已在畫面內的新內容立刻被翻譯
      state.io.unobserve(target);
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
        if (!tn.isConnected) continue; // 已被我們換下的原文節點
        const u = state.nodeToUnit.get(tn);
        if (u && u.isGroup) {
          if (groupAttached(u)) continue;            // 是我們自己寫入的
          markGroupStale(u);                          // 網站改寫了內容（例如換歌）→ 重新收集
          if (tn.parentNode && !seen.has(tn.parentNode)) { seen.add(tn.parentNode); collectRuns(tn.parentNode, fresh); }
          continue;
        }
        if (u && u.state !== 'stale') {
          if (u.written && u.written.get(tn) === tn.nodeValue) continue; // 是我們自己寫入的譯文
          // 原文其實沒變 → 忽略
          const ser = unitAttached(u) ? serialize(u.nodes) : null;
          if (ser && ser.text === u.text) continue;
        }
        if (u && u.state === 'done' && u.snapshot && u.snapshot.textValues.has(tn)) {
          // 頁面自己改了原文字：視為新內容
          u.snapshot.textValues.set(tn, tn.nodeValue);
        }
        if (u && (u.state === 'done' || u.state === 'error')) {
          if (u.inserted) { u.inserted.remove(); u.inserted = null; } // 移除過期的雙語譯文
          u.state = 'stale';
        }
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
    // 停用期間網站可能改過內容：原文已不同的舊單元作廢，交給下面重新收集
    for (const u of state.units) {
      if (u.state !== 'pending') continue;
      if (unitFresh(u)) fresh.push(u);
      else if (u.group) markGroupStale(u.group);
      else u.state = 'stale';
    }
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
      else if (u.state === 'queued' || u.state === 'error') u.state = 'pending';
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
  window.__llmt = { serialize, parseTranslation, shouldTranslateText, collect, splitLines, state, translatePage, restorePage };
})();
