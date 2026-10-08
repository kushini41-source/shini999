#!/usr/bin/env python3
"""Turn your latest Instagram / Facebook Page posts into Stories.

Flow per new post:
  1. Read recent posts (IG: /{ig-user-id}/media, FB: /{page-id}/posts).
  2. Render a 1080x1920 story image (blurred background, post image, caption excerpt).
  3. Upload it to the Page as an unpublished photo (gives a photo_id and a public CDN URL).
  4. FB story: POST /{page-id}/photo_stories with that photo_id.
     IG story: POST /{ig-user-id}/media media_type=STORIES image_url=<CDN URL>, then media_publish.
  5. Record the post id in the state file so it is never turned into a story twice.

Environment variables:
  META_PAGE_TOKEN   long-lived Page access token (required unless --dry-run with --sample)
  FB_PAGE_ID        Facebook Page id
  IG_USER_ID        Instagram Business/Creator account id linked to the Page
  GRAPH_VERSION     Graph API version (default v26.0)
  STORY_FONT        path to a CJK-capable .ttf/.otf/.ttc font (auto-detected otherwise)

Run with --help for options.
"""

from __future__ import annotations

import argparse
import io
import json
import os
import subprocess
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests
from PIL import Image, ImageDraw, ImageFilter, ImageFont, ImageOps

W, H = 1080, 1920
GRAPH = "https://graph.facebook.com/{ver}"
DEFAULT_STATE = Path(__file__).resolve().parent.parent / "state.json"


# --------------------------------------------------------------------------- Graph API

class Graph:
    def __init__(self, token: str, version: str):
        self.token = token
        self.base = GRAPH.format(ver=version)

    def _check(self, r: requests.Response) -> dict:
        try:
            data = r.json()
        except ValueError:
            r.raise_for_status()
            raise
        if r.status_code >= 400 or "error" in data:
            err = data.get("error", {})
            raise RuntimeError(f"Graph API error {err.get('code')}: {err.get('message', r.text)}")
        return data

    def get(self, path: str, **params) -> dict:
        params["access_token"] = self.token
        return self._check(requests.get(f"{self.base}/{path}", params=params, timeout=60))

    def post(self, path: str, files=None, **data) -> dict:
        data["access_token"] = self.token
        return self._check(requests.post(f"{self.base}/{path}", data=data, files=files, timeout=120))

    def delete(self, path: str) -> dict:
        return self._check(requests.delete(f"{self.base}/{path}",
                                           params={"access_token": self.token}, timeout=60))


def fetch_ig_posts(g: Graph, ig_user_id: str, limit: int) -> list[dict]:
    fields = "id,caption,media_type,media_url,thumbnail_url,permalink,timestamp"
    items = g.get(f"{ig_user_id}/media", fields=fields, limit=limit).get("data", [])
    posts = []
    for m in items:
        img = m.get("thumbnail_url") if m.get("media_type") == "VIDEO" else m.get("media_url")
        posts.append({
            "key": f"ig:{m['id']}",
            "source": "ig",
            "text": m.get("caption") or "",
            "image_url": img,
            "permalink": m.get("permalink"),
            "time": parse_time(m["timestamp"]),
        })
    return posts


def fetch_fb_posts(g: Graph, page_id: str, limit: int) -> list[dict]:
    fields = "id,message,full_picture,permalink_url,created_time,is_published"
    items = g.get(f"{page_id}/posts", fields=fields, limit=limit).get("data", [])
    posts = []
    for p in items:
        if p.get("is_published") is False:
            continue
        if not p.get("message") and not p.get("full_picture"):
            continue  # e.g. profile-picture updates
        posts.append({
            "key": f"fb:{p['id']}",
            "source": "fb",
            "text": p.get("message") or "",
            "image_url": p.get("full_picture"),
            "permalink": p.get("permalink_url"),
            "time": parse_time(p["created_time"]),
        })
    return posts


def parse_time(s: str) -> datetime:
    # Graph returns e.g. 2026-10-08T03:15:00+0000
    return datetime.strptime(s, "%Y-%m-%dT%H:%M:%S%z")


def upload_unpublished_photo(g: Graph, page_id: str, png: bytes) -> tuple[str, str]:
    """Upload to the Page without publishing. Returns (photo_id, public CDN url)."""
    res = g.post(f"{page_id}/photos", files={"source": ("story.png", png, "image/png")},
                 published="false")
    photo_id = res["id"]
    info = g.get(photo_id, fields="images")
    url = max(info["images"], key=lambda i: i["width"] * i["height"])["source"]
    return photo_id, url


def publish_fb_story(g: Graph, page_id: str, photo_id: str) -> str:
    res = g.post(f"{page_id}/photo_stories", photo_id=photo_id)
    return res.get("post_id", "")


def publish_ig_story(g: Graph, ig_user_id: str, image_url: str) -> str:
    container = g.post(f"{ig_user_id}/media", media_type="STORIES", image_url=image_url)["id"]
    for _ in range(30):
        status = g.get(container, fields="status_code").get("status_code")
        if status == "FINISHED":
            break
        if status in ("ERROR", "EXPIRED"):
            raise RuntimeError(f"IG container {container} status {status}")
        time.sleep(5)
    else:
        raise RuntimeError(f"IG container {container} not ready after 150s")
    return g.post(f"{ig_user_id}/media_publish", creation_id=container)["id"]


# --------------------------------------------------------------------------- rendering

FONT_CANDIDATES = [
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/noto-cjk/NotoSansCJK-Bold.ttc",
    "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
    "/System/Library/Fonts/PingFang.ttc",
    "C:/Windows/Fonts/msjhbd.ttc",
    "C:/Windows/Fonts/msjh.ttc",
]


def find_font() -> str | None:
    env = os.environ.get("STORY_FONT")
    if env and Path(env).exists():
        return env
    for c in FONT_CANDIDATES:
        if Path(c).exists():
            return c
    try:
        out = subprocess.run(["fc-list", ":lang=zh-tw", "file"], capture_output=True,
                             text=True, timeout=10).stdout
        for line in out.splitlines():
            path = line.split(":")[0].strip()
            if path:
                return path
    except (OSError, subprocess.SubprocessError):
        pass
    return None


def load_font(size: int) -> ImageFont.FreeTypeFont:
    path = find_font()
    if path:
        return ImageFont.truetype(path, size)
    return ImageFont.load_default(size)


NO_LINE_START = set("，。、；：？！）」』》〉】,.;:?!)%」…")


def wrap(draw: ImageDraw.ImageDraw, text: str, font, max_w: int, max_lines: int) -> list[str]:
    """Character-level wrap so it works for Chinese (no spaces) and English alike."""
    lines: list[str] = []
    for para in text.splitlines():
        para = para.strip()
        if not para:
            continue
        cur = ""
        for ch in para:
            if draw.textlength(cur + ch, font=font) <= max_w or ch in NO_LINE_START:
                cur += ch  # closing punctuation may hang past the margin
            elif ch.isascii() and ch.isalnum() and cur[-1:].isascii() and cur[-1:].isalnum() \
                    and " " in cur:
                head, tail = cur.rsplit(" ", 1)  # don't split an English word
                lines.append(head)
                cur = tail + ch
            else:
                lines.append(cur)
                cur = ch.lstrip()
            if len(lines) >= max_lines:
                break
        if cur and len(lines) < max_lines:
            lines.append(cur)
        if len(lines) >= max_lines:
            break
    total = "".join(text.split())
    shown = "".join("".join(lines).split())
    if lines and len(shown) < len(total):
        last = lines[-1]
        while last and draw.textlength(last + "…", font=font) > max_w:
            last = last[:-1]
        lines[-1] = last + "…"
    return lines


def rounded(img: Image.Image, radius: int) -> Image.Image:
    mask = Image.new("L", img.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, *img.size), radius=radius, fill=255)
    out = img.convert("RGBA")
    out.putalpha(mask)
    return out


def gradient(c1: tuple, c2: tuple) -> Image.Image:
    base = Image.new("RGB", (W, H), c1)
    top = Image.new("RGB", (W, H), c2)
    mask = Image.linear_gradient("L").resize((W, H))
    return Image.composite(top, base, mask)


def render_story(post: dict, photo: Image.Image | None, cfg: dict) -> bytes:
    label = cfg.get("label", "新貼文")
    footer = cfg.get("footer", "完整內容請看主頁貼文")
    accent = tuple(cfg.get("accent", (255, 196, 0)))

    if photo is not None:
        photo = ImageOps.exif_transpose(photo).convert("RGB")
        bg = ImageOps.fit(photo, (W, H)).filter(ImageFilter.GaussianBlur(40))
        bg = Image.blend(bg, Image.new("RGB", (W, H), (0, 0, 0)), 0.45)
    else:
        bg = gradient((32, 32, 64), (140, 60, 120))
    canvas = bg.convert("RGBA")
    draw = ImageDraw.Draw(canvas)

    # top label pill
    f_label = load_font(46)
    tw = draw.textlength(label, font=f_label)
    pill = (60, 120, 60 + tw + 64, 120 + 84)
    draw.rounded_rectangle(pill, radius=42, fill=accent)
    draw.text((60 + 32, 120 + 42), label, font=f_label, fill=(20, 20, 20), anchor="lm")

    y = 260
    if photo is not None:
        fg = photo.copy()
        fg.thumbnail((920, 1000 if post["text"] else 1300), Image.LANCZOS)
        fg = rounded(fg, 36)
        x = (W - fg.width) // 2
        shadow = Image.new("RGBA", (fg.width + 80, fg.height + 80), (0, 0, 0, 0))
        ImageDraw.Draw(shadow).rounded_rectangle((40, 50, fg.width + 40, fg.height + 50),
                                                 radius=40, fill=(0, 0, 0, 150))
        shadow = shadow.filter(ImageFilter.GaussianBlur(20))
        canvas.alpha_composite(shadow, (x - 40, y - 40))
        canvas.alpha_composite(fg, (x, y))
        y += fg.height + 70
        text_size, max_lines = 46, max(2, (H - 260 - y) // 64)
    else:
        y = 420
        text_size, max_lines = 64, 14

    if post["text"]:
        f_text = load_font(text_size)
        line_h = int(text_size * 1.45)
        lines = wrap(draw, post["text"], f_text, 920, min(max_lines, 8 if photo else 14))
        if photo is None:
            y = max(300, (H - len(lines) * line_h) // 2)
        for line in lines:
            draw.text((80, y), line, font=f_text, fill=(255, 255, 255))
            y += line_h

    # footer
    f_foot = load_font(40)
    draw.text((W // 2, H - 170), footer, font=f_foot, fill=(255, 255, 255, 230), anchor="mm")
    handle = cfg.get("handle")
    if handle:
        draw.text((W // 2, H - 110), handle, font=load_font(36), fill=accent, anchor="mm")

    buf = io.BytesIO()
    canvas.convert("RGB").save(buf, "PNG", optimize=True)
    return buf.getvalue()


def download_image(url: str | None) -> Image.Image | None:
    if not url:
        return None
    r = requests.get(url, timeout=60)
    r.raise_for_status()
    return Image.open(io.BytesIO(r.content))


# --------------------------------------------------------------------------- main

def load_state(path: Path) -> dict:
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    return {"done": {}}


def save_state(path: Path, state: dict) -> None:
    # keep the file small: drop entries older than 60 days
    cutoff = (datetime.now(timezone.utc) - timedelta(days=60)).isoformat()
    state["done"] = {k: v for k, v in state["done"].items() if v.get("at", "") >= cutoff}
    path.write_text(json.dumps(state, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def load_config(path: Path | None) -> dict:
    if path and path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    return {}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--sources", default="ig,fb", help="which feeds to read: ig,fb (default both)")
    ap.add_argument("--targets", default="same",
                    help="where to post the story: 'same' (IG post->IG story, FB post->FB story), "
                         "'both' (every post to both), or 'ig' / 'fb'")
    ap.add_argument("--hours", type=float, default=24, help="only posts newer than this (default 24)")
    ap.add_argument("--max", type=int, default=5, help="max stories per run (default 5)")
    ap.add_argument("--dry-run", action="store_true", help="render PNGs only, publish nothing")
    ap.add_argument("--out", default="story_out", help="where --dry-run writes PNGs")
    ap.add_argument("--state", default=str(DEFAULT_STATE), help="state file (dedup)")
    ap.add_argument("--config", default=None, help="JSON style config (label, footer, handle, accent)")
    ap.add_argument("--sample", nargs=2, metavar=("IMAGE_OR_NONE", "TEXT"),
                    help="render one local sample, no API needed (implies --dry-run)")
    args = ap.parse_args()

    cfg = load_config(Path(args.config) if args.config else
                      Path(__file__).resolve().parent.parent / "config.json")
    out = Path(args.out)

    if args.sample:
        img_arg, text = args.sample
        photo = None if img_arg.lower() == "none" else Image.open(img_arg)
        out.mkdir(parents=True, exist_ok=True)
        dest = out / "sample.png"
        dest.write_bytes(render_story({"text": text}, photo, cfg))
        print(f"rendered {dest}")
        return 0

    token = os.environ.get("META_PAGE_TOKEN")
    page_id = os.environ.get("FB_PAGE_ID")
    ig_id = os.environ.get("IG_USER_ID")
    if not token or not page_id:
        print("META_PAGE_TOKEN and FB_PAGE_ID are required (IG_USER_ID too for Instagram).", file=sys.stderr)
        return 2
    g = Graph(token, os.environ.get("GRAPH_VERSION", "v26.0"))

    sources = {s.strip() for s in args.sources.split(",") if s.strip()}
    posts: list[dict] = []
    if "ig" in sources:
        if not ig_id:
            print("IG_USER_ID missing, skipping Instagram feed.", file=sys.stderr)
        else:
            posts += fetch_ig_posts(g, ig_id, 25)
    if "fb" in sources:
        posts += fetch_fb_posts(g, page_id, 25)

    state_path = Path(args.state)
    state = load_state(state_path)
    since = datetime.now(timezone.utc) - timedelta(hours=args.hours)
    todo = sorted((p for p in posts if p["time"] >= since and p["key"] not in state["done"]),
                  key=lambda p: p["time"])[: args.max]

    if not todo:
        print("No new posts to turn into stories.")
        return 0

    failures = 0
    for post in todo:
        if args.targets == "same":
            targets = [post["source"]]
        elif args.targets == "both":
            targets = ["ig", "fb"]
        else:
            targets = [args.targets]
        if "ig" in targets and not ig_id:
            targets.remove("ig")

        print(f"- {post['key']} ({post['time']:%Y-%m-%d %H:%M}) -> {','.join(targets) or 'nothing'}")
        try:
            png = render_story(post, download_image(post["image_url"]), cfg)
            if args.dry_run:
                out.mkdir(parents=True, exist_ok=True)
                dest = out / f"{post['key'].replace(':', '_')}.png"
                dest.write_bytes(png)
                print(f"  rendered {dest}")
                continue

            photo_id, cdn_url = upload_unpublished_photo(g, page_id, png)
            result = {"at": datetime.now(timezone.utc).isoformat(), "permalink": post["permalink"]}
            if "fb" in targets:
                result["fb_story"] = publish_fb_story(g, page_id, photo_id)
                print(f"  FB story published {result['fb_story']}")
            if "ig" in targets:
                result["ig_story"] = publish_ig_story(g, ig_id, cdn_url)
                print(f"  IG story published {result['ig_story']}")
                if "fb" not in targets:
                    try:
                        g.delete(photo_id)  # helper upload no longer needed
                    except RuntimeError:
                        pass
            state["done"][post["key"]] = result
            save_state(state_path, state)  # save after each so a crash never double-posts
        except Exception as e:  # keep going with the other posts
            failures += 1
            print(f"  FAILED: {e}", file=sys.stderr)

    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
