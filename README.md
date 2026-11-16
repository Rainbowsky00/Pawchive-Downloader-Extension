# Pawchive Downloader

A browser extension (Chrome / Edge, Manifest V3) that archives posts from
[pawchive.pw](https://pawchive.pw) as a clean, numbered local collection:
original images and videos, automatic folders, cloud-drive link collection, and
reliable filenames even when other download extensions are installed.

## Features

- **Original files only** — reads the post's file links and skips lazy-loaded thumbnails.
- **Automatic folders** — `Author/YYYY-MM-DD-Post title/`, with emoji and
  Windows-invalid characters removed from titles.
- **Numbered media** — `1–9`, `01–99` or `001–999` depending on the total count;
  videos are numbered together with images in page order.
- **links.txt** — collects cloud-drive links (Dropbox, Google Drive, Mega, Terabox,
  OneDrive, PikPak, synology.me, …), video links and other attachments found in the
  post body. Videos are downloaded as well.
- **Post picker** — on author pages, tick the posts you want from the current page,
  or click **Load all pages** to list every post; only the selected posts are downloaded.
- **One post at a time** — each post is fetched, downloaded and finished before the next
  post is started, so downloads begin immediately instead of waiting for every link to
  be collected first.
- **Author pages** — crawl the current page or all pages (`?o=` pagination),
  with an optional publish-date range filter and per-post delay.
- **Queue controls** — pause / resume / stop, live per-file progress, retries,
  rate-limit cooldown, and a separate monitor window with diagnostics.
- **Edge-safe filenames** — the extension registers as the filename provider; if
  another download extension overrides names, the UI tells you how to fix it.
- **Bilingual UI** — Simplified Chinese for `zh-CN`/`zh-Hans`; English for every
  other locale (including `zh-TW`/`zh-HK`). Switched automatically from the browser
  language.

## Install

1. Open `chrome://extensions` (Chrome) or `edge://extensions` (Edge).
2. Enable **Developer mode**.
3. Click **Load unpacked** and select this folder (the one containing `manifest.json`).
4. Open a Pawchive post or author page and click the extension icon.

## Save rules

```
Browser download folder/
└─ Author/
   └─ YYYY-MM-DD-Post title/
      ├─ 1.jpeg / 01.jpeg / 001.jpeg
      ├─ 6.mp4 / 02.mp4
      └─ links.txt
```

Padding width is based on the total media count:

| Total | Names |
|---|---|
| ≤ 9 | `1` … `9` |
| 10 – 99 | `01` … `99` |
| 100 – 999 | `001` … `999` |

An optional **root folder** prefix can be set in the popup.

## Permissions

| Permission | Why |
|---|---|
| `downloads` | Save images, videos and `links.txt` to the download folder. |
| `storage` | Remember options, the download queue and deduplication records locally. |
| `offscreen` | Create Blob URLs for the fetch-save fallback. |
| `declarativeNetRequest` | Set the request headers required by Pawchive data servers (avoids 403/429 on downloads). |
| Host access to `pawchive.pw` | Read post pages and download media from Pawchive. |

No data leaves the browser. See [PRIVACY.md](PRIVACY.md).

## Note for Edge users

Chromium lets the **last-installed extension** control download filenames when several
extensions register `chrome.downloads.onDeterminingFilename`. If the popup shows
“Filenames overridden by another extension”:

1. Disable the conflicting download manager extension, **or**
2. Remove this extension and load it again so it is the last-installed one.

## Disclaimer

This project is not affiliated with Pawchive, Patreon, Pixiv Fanbox or any other
platform. Pawchive hosts adult content; use this tool only for content you are
allowed to access and archive, and respect the rights of the original creators.

## Development

```bash
# Offline unit tests (filename/queue logic, 43 checks)
node test_background.js

# Browser probes (load the unpacked extension via CDP, Edge/Chrome)
node test/sw_download_probe.mjs edge          # download pipeline + naming
PW_NOISY=1 node test/sw_download_probe.mjs edge   # with a conflicting extension
node test/scan_id_probe.mjs <author-url>      # author-ID detection
node test/lang_probe.mjs                      # zh-CN / zh-TW / en-US UI language
node test/local_sequential_probe.mjs          # post picker + per-post pipeline (local fixture)
node test/popup_selection_probe.mjs           # popup checkbox UI

# Build a store package (excludes test/ and docs/, single manifest.json)
python build_store_zip.py
```

## License

[MIT](LICENSE)
