// 彈出視窗：開關、自訂翻譯（chrome.storage.sync 雲端同步）、未翻譯清單
var CHUNK = 2000; // 每塊字元數；中文 UTF-8 一字 3 bytes，保持在單項 8KB 上限內
var custom = {};
var missing = {};

function $(id) { return document.getElementById(id); }
function flash(t) { $("msg").textContent = t; setTimeout(function () { $("msg").textContent = ""; }, 2500); }

function loadAll(cb) {
  chrome.storage.sync.get(null, function (r) {
    $("enabled").checked = r.enabled !== false;
    var json = "";
    for (var i = 0; i < (r.customChunks || 0); i++) json += r["custom_" + i] || "";
    try { custom = json ? JSON.parse(json) : {}; } catch (e) { custom = {}; }
    chrome.storage.local.get({ missing: {} }, function (l) {
      missing = l.missing || {};
      cb();
    });
  });
}

function saveCustom(cb) {
  var json = JSON.stringify(custom);
  var data = {}, n = Math.ceil(json.length / CHUNK);
  for (var i = 0; i < n; i++) data["custom_" + i] = json.slice(i * CHUNK, (i + 1) * CHUNK);
  data.customChunks = n;
  chrome.storage.sync.get("customChunks", function (old) {
    var stale = [];
    for (var j = n; j < (old.customChunks || 0); j++) stale.push("custom_" + j);
    chrome.storage.sync.set(data, function () {
      if (chrome.runtime.lastError) { flash("儲存失敗：" + chrome.runtime.lastError.message); return; }
      if (stale.length) chrome.storage.sync.remove(stale);
      cb && cb();
    });
  });
}

function hasTranslation(en) {
  return custom[en] || BUFFER_ZH_DICT[en] || GITHUB_ZH_DICT[en];
}

function renderMissing() {
  var box = $("missing"), f = $("filter").value.toLowerCase();
  box.innerHTML = "";
  var keys = Object.keys(missing).filter(function (k) { return !hasTranslation(k) && k.toLowerCase().indexOf(f) >= 0; }).sort();
  if (!keys.length) { box.innerHTML = '<p class="hint">目前沒有。打開 Buffer、GitHub 各頁面與選單後再回來看看。</p>'; return; }
  keys.slice(0, 300).forEach(function (en) {
    var row = document.createElement("div"); row.className = "row";
    var s = document.createElement("span"); s.className = "en"; s.textContent = en;
    var inp = document.createElement("input"); inp.type = "text"; inp.placeholder = "中文";
    var b = document.createElement("button"); b.textContent = "存";
    function go() { if (inp.value.trim()) addEntry(en, inp.value.trim()); }
    b.onclick = go; inp.onkeydown = function (e) { if (e.key === "Enter") go(); };
    row.append(s, inp, b); box.append(row);
  });
}

function renderCustom() {
  var box = $("custom"); box.innerHTML = "";
  var keys = Object.keys(custom).sort();
  if (!keys.length) { box.innerHTML = '<p class="hint">還沒有自訂翻譯。</p>'; return; }
  keys.forEach(function (en) {
    var row = document.createElement("div"); row.className = "row";
    var s = document.createElement("span"); s.className = "en"; s.textContent = en + " → " + custom[en];
    var b = document.createElement("button"); b.className = "ghost"; b.textContent = "刪除";
    b.onclick = function () { delete custom[en]; saveCustom(renderAll); };
    row.append(s, b); box.append(row);
  });
}

function renderAll() { renderMissing(); renderCustom(); }

function addEntry(en, zh) {
  custom[en] = zh;
  saveCustom(function () { delete missing[en]; chrome.storage.local.set({ missing: missing }); flash("已儲存：" + en); renderAll(); });
}

function download(name, obj) {
  var a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" }));
  a.download = name; a.click();
}

loadAll(renderAll);
$("enabled").onchange = function () { chrome.storage.sync.set({ enabled: this.checked }); };
$("add").onclick = function () {
  var en = $("newEn").value.trim(), zh = $("newZh").value.trim();
  if (!en || !zh) { flash("請填英文原文和中文翻譯"); return; }
  addEntry(en, zh); $("newEn").value = ""; $("newZh").value = "";
};
$("filter").oninput = renderMissing;
$("clearMissing").onclick = function () { missing = {}; chrome.storage.local.set({ missing: {} }); renderMissing(); };
$("export").onclick = function () { download("buffer-zh-custom.json", custom); };
$("exportMissing").onclick = function () {
  var out = {};
  Object.keys(missing).filter(function (k) { return !hasTranslation(k); }).sort().forEach(function (k) { out[k] = ""; });
  download("buffer-zh-missing.json", out);
};
$("import").onchange = function () {
  var file = this.files[0]; if (!file) return;
  file.text().then(function (t) {
    var obj = JSON.parse(t), n = 0;
    for (var k in obj) if (typeof obj[k] === "string" && obj[k].trim()) { custom[k] = obj[k].trim(); n++; }
    saveCustom(function () { flash("已匯入 " + n + " 筆"); renderAll(); });
  }).catch(function () { flash("檔案格式錯誤"); });
};
