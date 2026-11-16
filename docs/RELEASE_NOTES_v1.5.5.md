# Release v1.5.5

Tag: `v1.5.5` · Release title: **Pawchive Downloader v1.5.5**

Attach these two files to the release:
- `pawchive-downloader-1.5.5.zip` — unpacked extension (recommended install)
- `pawchive-downloader-1.5.5.crx` — signed CRX3 package

---

## Release body (copy below into the GitHub Release page)

```markdown
# Pawchive Downloader v1.5.5

A browser extension (Chrome / Edge, Manifest V3) that archives posts from
[pawchive.pw](https://pawchive.pw) into a clean, numbered local collection.

## Highlights

- **Original files only** — downloads the post's real file links and skips lazy-loaded thumbnails
- **Automatic folders** — `Author/YYYY-MM-DD-Post title/`, emoji and invalid characters stripped
- **Numbered media** — `1–9`, `01–99`, `001–999` depending on the total count; videos numbered in page order
- **links.txt** — collects cloud-drive links (Dropbox, Google Drive, Mega, Terabox, OneDrive, PikPak, synology.me, …), video links and attachments
- **Author pages** — crawl the current page or all pages, with an optional publish-date range and per-post delay
- **Queue controls** — pause / resume / stop, live progress, retries, rate-limit cooldown, plus a standalone monitor window with diagnostics
- **Bilingual UI** — Simplified Chinese for `zh-CN`/`zh-Hans`; English for every other locale (including `zh-TW`/`zh-HK`), switched automatically from the browser's language settings

## Changes in this release

- UI language now follows the **first entry of the browser's preferred-language list** (the list you can reorder in settings), so switching languages takes effect without reinstalling
- Fixed the author ID shown on author pages going stale when navigating between creators (htmx pages keep old `<meta>` values)
- Safer filenames on Edge: the extension registers as the filename provider and tells you when another download extension overrides it
- Dropped expired signed download links from the resume queue automatically

## Install (unpacked — recommended)

1. Download `pawchive-downloader-1.5.5.zip` and extract it
2. Open `chrome://extensions` (Chrome) or `edge://extensions` (Edge)
3. Enable **Developer mode**
4. Click **Load unpacked** and select the extracted folder
5. Open a Pawchive post or author page and click the extension icon

## About the CRX file

`pawchive-downloader-1.5.5.crx` is a signed CRX3 package. Modern Chrome/Edge
**block sideloading CRX files** on Windows, so you cannot install it by
double-clicking. Use it only for enterprise policy distribution
(`ExtensionInstallForcelist` + a hosted download URL) or Chromium-based browsers
that still allow it. For everything else, use the unpacked install above.

## Checksums (SHA-256)

```
45f65c1351a586ae4c95341bbefaf8ae8d30fdaba38eca6bbd8cf0fbdb970597  pawchive-downloader-1.5.5.crx
d9c38bab68b88c78f9d7761dfd968f52813146420934ea463c501c755dc125ed  pawchive-downloader-1.5.5.zip
```

## Privacy & disclaimer

The extension works only on pawchive.pw and never sends your data anywhere —
options, queue state and history stay in your browser profile. Not affiliated
with Pawchive, Patreon, Pixiv Fanbox or any other platform. Pawchive hosts adult
content; use this tool only for content you are allowed to access and archive,
and respect the rights of the original creators. Released under the
[MIT license](LICENSE).
```

---

## 中文参考（不用贴到 GitHub，仅供你自己对照内容）

**标题：Pawchive Downloader v1.5.5**

亮点：只下原图原视频；按「作者/年-月-日-标题」自动建目录；媒体按总数补零编号（1/01/001）；自动收集网盘链接为 links.txt；作者页整站翻页爬取＋日期筛选；队列支持暂停/继续/结束，带独立监控小窗；界面语言随浏览器偏好列表自动切换（简体中文→中文，其余含繁体→英文）。

本版改动：语言检测改为跟随浏览器语言偏好列表第一位；修复在创作者页面之间切换时作者 ID 显示旧值的问题；Edge 下文件名保护增强；恢复队列时自动丢弃已过期的签名链接。

安装：下载 ZIP 解压 → 浏览器扩展页开启开发者模式 → 加载已解压的扩展程序。CRX 文件仅供企业策略分发使用（新版浏览器禁止直接双击安装）。
