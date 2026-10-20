// 網站繁體中文化：把頁面上的介面文字（含彈出選單、提示框）換成中文
(function () {
  "use strict";

  // 依網站選字典：manifest 只會在對應網域載入該網站的字典檔
  var IS_GITHUB = typeof GITHUB_ZH_DICT !== "undefined";
  var DICT = IS_GITHUB ? GITHUB_ZH_DICT : BUFFER_ZH_DICT;
  var PATTERNS = IS_GITHUB ? GITHUB_ZH_PATTERNS : BUFFER_ZH_PATTERNS;
  var HOOK = IS_GITHUB ? GITHUB_ZH_HOOK : null;

  var SKIP_TAGS = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEXTAREA: 1, CODE: 1, PRE: 1, SVG: 1, svg: 1, TITLE: 1 };
  var ATTRS = ["placeholder", "title", "aria-label", "alt", "data-tooltip", "data-tip"];
  var MAX_LEN = 300;

  var enabled = true;
  var custom = {};      // 雲端同步的自訂翻譯（優先）
  var lower = {};       // 不分大小寫的查詢表
  var translated = new WeakMap(); // 文字節點 → 已套用的中文，避免重複處理
  var missing = {};     // 本頁找不到翻譯的字串
  var missingTimer = null;

  function rebuildLower() {
    lower = {};
    var k;
    for (k in DICT) lower[k.toLowerCase()] = DICT[k];
    for (k in custom) lower[k.toLowerCase()] = custom[k];
  }

  function lookup(text) {
    if (Object.prototype.hasOwnProperty.call(custom, text)) return custom[text];
    if (Object.prototype.hasOwnProperty.call(DICT, text)) return DICT[text];
    var l = text.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(lower, l)) return lower[l];
    // 去掉結尾標點再試一次，例如 "Settings:"、"Saved."
    var m = text.match(/^(.*?)([.:!?…]+)$/);
    if (m && m[1]) {
      var base = lookup(m[1]);
      if (base) return base + m[2].replace(/\./g, "。").replace(/:/g, "：").replace(/!/g, "！").replace(/\?/g, "？");
    }
    for (var i = 0; i < PATTERNS.length; i++) {
      var p = PATTERNS[i];
      if (p[0].test(text)) return text.replace(p[0], p[1]);
    }
    return null;
  }

  // 保留原本的前後空白
  function translateString(s) {
    if (!s || s.length > MAX_LEN) return null;
    var t = s.trim();
    if (!t || !/[A-Za-z]/.test(t)) return null;
    var zh = lookup(t);
    if (zh == null) {
      noteMissing(t);
      return null;
    }
    var start = s.indexOf(t);
    return s.slice(0, start) + zh + s.slice(start + t.length);
  }

  function noteMissing(t) {
    // 只記錄像介面文字的短字串（有英文字母、不像網址或 email）
    if (t.length < 2 || t.length > 120 || /https?:|www\.|@|^[#\d\W]+$/.test(t)) return;
    if (missing[t]) return;
    missing[t] = 1;
    clearTimeout(missingTimer);
    missingTimer = setTimeout(flushMissing, 3000);
  }

  function flushMissing() {
    try {
      chrome.storage.local.get({ missing: {} }, function (r) {
        var all = r.missing || {};
        for (var k in missing) if (!lookup(k)) all[k] = location.pathname;
        var keys = Object.keys(all);
        if (keys.length > 2000) keys.slice(0, keys.length - 2000).forEach(function (k) { delete all[k]; });
        chrome.storage.local.set({ missing: all });
      });
    } catch (e) { /* 擴充功能重新載入後舊頁面會失效，忽略 */ }
  }

  function inEditable(el) {
    while (el && el.nodeType === 1) {
      if (SKIP_TAGS[el.tagName]) return true;
      if (el.isContentEditable || el.getAttribute("contenteditable") === "true") return true;
      if (el.hasAttribute("data-zh-skip")) return true;
      el = el.parentElement;
    }
    return false;
  }

  function doText(node) {
    var v = node.nodeValue;
    if (translated.get(node) === v) return;
    if (!node.parentElement || inEditable(node.parentElement)) return;
    var zh = translateString(v);
    if (zh != null && zh !== v) {
      translated.set(node, zh);
      node.nodeValue = zh;
    }
  }

  function doAttrs(el) {
    for (var i = 0; i < ATTRS.length; i++) {
      var a = ATTRS[i];
      var v = el.getAttribute(a);
      if (!v) continue;
      var zh = translateString(v);
      if (zh != null && zh !== v) el.setAttribute(a, zh);
    }
    if (el.tagName === "INPUT" && /^(button|submit|reset)$/i.test(el.type) && el.value) {
      var zv = translateString(el.value);
      if (zv != null) el.value = zv;
    }
  }

  function walk(root) {
    if (!enabled || !root) return;
    if (HOOK && root.nodeType !== 3) HOOK(root);
    if (root.nodeType === 3) { doText(root); return; }
    if (root.nodeType !== 1 && root.nodeType !== 11 && root.nodeType !== 9) return;
    if (root.nodeType === 1) {
      if (SKIP_TAGS[root.tagName] || inEditable(root)) return;
      doAttrs(root);
    }
    var tw = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode: function (n) {
        if (n.nodeType === 1) {
          if (SKIP_TAGS[n.tagName] || n.isContentEditable || n.hasAttribute("data-zh-skip")) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    var n;
    while ((n = tw.nextNode())) {
      if (n.nodeType === 3) doText(n);
      else {
        doAttrs(n);
        if (n.shadowRoot) { walk(n.shadowRoot); observe(n.shadowRoot); }
      }
    }
  }

  function translateTitle() {
    var t = document.title;
    if (!t) return;
    // 例如 "Preferences | Buffer"
    var parts = t.split(/(\s[|\-–·]\s)/);
    var changed = false;
    for (var i = 0; i < parts.length; i += 2) {
      var zh = lookup(parts[i].trim());
      if (zh) { parts[i] = zh; changed = true; }
    }
    if (changed) document.title = parts.join("");
  }

  // 用 requestAnimationFrame 合併大量變動，避免拖慢頁面
  var pending = new Set();
  var scheduled = false;
  function queue(n) {
    pending.add(n);
    if (!scheduled) {
      scheduled = true;
      requestAnimationFrame(function () {
        scheduled = false;
        var list = Array.from(pending);
        pending.clear();
        list.forEach(walk);
      });
    }
  }

  var observed = new WeakSet();
  var mo = new MutationObserver(function (muts) {
    if (!enabled) return;
    for (var i = 0; i < muts.length; i++) {
      var m = muts[i];
      if (m.type === "childList") {
        for (var j = 0; j < m.addedNodes.length; j++) queue(m.addedNodes[j]);
      } else if (m.type === "characterData") {
        queue(m.target);
      } else if (m.type === "attributes") {
        if (!inEditable(m.target)) doAttrs(m.target);
      }
    }
  });
  function observe(root) {
    if (observed.has(root)) return;
    observed.add(root);
    mo.observe(root, {
      childList: true, subtree: true, characterData: true,
      attributes: true, attributeFilter: ATTRS.concat(["value"])
    });
  }

  function start() {
    if (!enabled) return;
    walk(document.documentElement);
    translateTitle();
    observe(document.documentElement);
    var titleEl = document.querySelector("title");
    if (titleEl) new MutationObserver(translateTitle).observe(titleEl, { childList: true, characterData: true, subtree: true });
  }

  function loadCustom(cb) {
    chrome.storage.sync.get(null, function (r) {
      enabled = r.enabled !== false;
      custom = {};
      var n = r.customChunks || 0, json = "";
      for (var i = 0; i < n; i++) json += r["custom_" + i] || "";
      try { if (json) custom = JSON.parse(json); } catch (e) { custom = {}; }
      rebuildLower();
      cb && cb();
    });
  }

  rebuildLower();
  loadCustom(function () {
    if (document.readyState === "loading") {
      // document_start 時 documentElement 已存在，先觀察，DOM 完成後再全頁處理一次
      observe(document.documentElement);
      document.addEventListener("DOMContentLoaded", start);
    } else start();
  });

  // 在彈出視窗新增翻譯或切換開關後，頁面不用重新整理即可套用
  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== "sync") return;
    var wasEnabled = enabled;
    loadCustom(function () {
      if (!enabled && wasEnabled) location.reload();
      else if (enabled) { translated = new WeakMap(); start(); }
    });
  });
})();
