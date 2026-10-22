// 用 Chromium 把 SVG 圖示轉成各尺寸 PNG
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const out = path.resolve(new URL('.', import.meta.url).pathname, '../extension/icons');
fs.mkdirSync(out, { recursive: true });
const svg = (size) => `<!doctype html><html><body style="margin:0;background:transparent">
<div style="width:${size}px;height:${size}px;border-radius:${size * 0.22}px;background:linear-gradient(135deg,#1a73e8,#0b4fb3);display:flex;align-items:center;justify-content:center;font:bold ${size * 0.62}px/1 'Noto Sans CJK TC','Noto Sans TC','Microsoft JhengHei','PingFang TC',sans-serif;color:#fff">譯</div>
</body></html>`;

const browser = await chromium.launch();
const page = await browser.newPage();
for (const size of [16, 32, 48, 128]) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(svg(size));
  await page.screenshot({ path: path.join(out, `icon${size}.png`), omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
}
await browser.close();
console.log('icons written to', out);
