# Release v1.6.0

Tag: `v1.6.0` · Release title: **Pawchive Downloader v1.6.0**

Attach these two files to the release:
- `pawchive-downloader-1.6.0.zip` — unpacked extension (recommended install)
- `pawchive-downloader-1.6.0.crx` — signed CRX3 package (same key as v1.5.5)

---

## Release body (copy below into the GitHub Release page)

```markdown
# Pawchive Downloader v1.6.0

A browser extension (Chrome / Edge, Manifest V3) that archives posts from
[pawchive.pw](https://pawchive.pw) into a clean, numbered local collection.

## New in v1.6.0

### Pick the posts you want
Author pages now show a checkbox list of posts (title, date, attachment count).
All posts on the current page are selected by default; use **Select all** /
**Select none**, or **Load all pages** to list every post on the author page and
choose any subset. Only the ticked posts are downloaded.

### One post at a time
Downloads now run as a pipeline: the extension fetches a post, queues its files,
waits until that post is finished, and only then fetches the next post. Downloads
start immediately instead of waiting for every post link to be collected first,
and the progress log shows the per-post file count.

## Features

- **Original files only** — uses the post's real file links and skips lazy-loaded thumbnails
- **Automatic folders** — `Author/YYYY-MM-DD-Post title/`, emoji and invalid characters stripped
- **Numbered media** — `1–9`, `01–99`, `001–999` depending on the total count; videos numbered in page order
- **links.txt** — collects cloud-drive links (Dropbox, Google Drive, Mega, Terabox, OneDrive, PikPak, synology.me, …), video links and attachments
- **Post picker** — tick posts on the current page or load all pages and choose a subset
- **Sequential downloads** — finish one post before starting the next
- **Queue controls** — pause / resume / stop, live progress, retries, rate-limit cooldown, and a standalone monitor window with diagnostics
- **Bilingual UI** — Simplified Chinese for `zh-CN`/`zh-Hans`; English for every other locale (including `zh-TW`/`zh-HK`), switched automatically from the browser language

## Also included (from 1.5.5)

- Language detection follows the first entry of the browser's preferred-language list
- Author ID no longer goes stale after htmx navigation between creators
- Edge filename protection with a clear warning when another download extension overrides names
- Expired signed download links are dropped from the resume queue

## Install (unpacked — recommended)

1. Download `pawchive-downloader-1.6.0.zip` and extract it
2. Open `chrome://extensions` (Chrome) or `edge://extensions` (Edge)
3. Enable **Developer mode**
4. Click **Load unpacked** and select the extracted folder
5. Open a Pawchive post or author page and click the extension icon

## About the CRX file

`pawchive-downloader-1.6.0.crx` is a signed CRX3 package (extension ID
`fkalehbnnpjmappejmajldeegpafahbh`, same key as v1.5.5). Modern Chrome/Edge
**block sideloading CRX files** on Windows, so you cannot install it by
double-clicking. Use it only for enterprise policy distribution
(`ExtensionInstallForcelist` + a hosted download URL) or Chromium-based browsers
that still allow it. For everything else, use the unpacked install above.

## Checksums (SHA-256)

```
402f190e3861a9a605550a0424d1c5f0a48eed02db8aa701577b84aafa15a9f3  pawchive-downloader-1.6.0.crx
c450e1297ed1380f74d9f0b84c4f0e25f309ed1ffba6e76ee00317df1c662d30  pawchive-downloader-1.6.0.zip
```

## Privacy & disclaimer

The extension works only on pawchive.pw and never sends your data anywhere —
options, queue state and history stay in your browser profile. Not affiliated
with Pawchive, Patreon, Pixiv Fanbox or any other platform. Pawchive hosts adult
content; use this tool only for content you are allowed to access and archive,
and respect the rights of the original creators. Released under the
[MIT license](LICENSE).
```
