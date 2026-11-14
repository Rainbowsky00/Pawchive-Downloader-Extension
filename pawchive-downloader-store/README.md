# Pawchive Downloader

A Chrome / Edge extension for archiving **pawchive.pw** posts: original images and videos,
numbered folders, cloud-drive link collection, and reliable filenames.

> Not affiliated with Pawchive, Patreon, Pixiv Fanbox or any other platform.
> Only download content you are allowed to access and archive.

## Install (unpacked)

1. Open `chrome://extensions` (Chrome) or `edge://extensions` (Edge).
2. Enable **Developer mode**.
3. Click **Load unpacked** and select this folder.
4. Open a Pawchive post or author page and click the extension icon.

For Edge Store builds, install from the store listing instead.

## Language

The UI follows the browser language automatically:

- **Simplified Chinese** (`zh-CN`, `zh-Hans`, `zh-SG`, `zh-MY`) → Chinese UI.
- **Everything else**, including Traditional Chinese (`zh-TW`, `zh-HK`) → English UI.

The extension name/description in the manifest is localized the same way.

## Save rules

Files are saved under the browser's default download directory (an optional root folder
can be set in the popup):

```
Downloads/
└─ Author/
   └─ YYYY-MM-DD-Post title/
      ├─ 1.jpeg / 01.jpeg / 001.jpeg
      ├─ 6.mp4 / 02.mp4
      └─ links.txt
```

- The title has emoji and Windows-invalid characters removed.
- With **Rename files** enabled, all media is numbered in page order. Padding width is
  based on the total count: `1–9` → `1`; `10–99` → `01`; `100–999` → `001`.
- `links.txt` collects cloud-drive links (Dropbox, Google Drive, Mega, Terabox, OneDrive,
  PikPak, synology.me, …), video links, and other attachments found in the post body.
- Videos in the post are downloaded as well.

## Edge filename note

Chromium lets the **last-installed extension** control download filenames when several
extensions register `chrome.downloads.onDeterminingFilename`. If another download manager
extension is installed after this one, it may override the numbered filenames.
If the popup shows **“Filenames overridden by another extension”**:

1. Disable the conflicting download extension in `edge://extensions`, or
2. Remove this extension and load it again so it is the last-installed one.

## Permissions

| Permission | Why |
|---|---|
| `downloads` | Save images, videos and `links.txt` to the download folder. |
| `storage` | Remember options, the download queue and deduplication records locally. |
| `offscreen` | Create Blob URLs for the fetch-save fallback. |
| `declarativeNetRequest` | Set the required request headers for Pawchive data servers (avoids hotlink blocks/429). |
| Host access to `pawchive.pw` | Read post pages and download media from Pawchive. |

No data is sent to any third-party server. Everything (options, queue, completed records)
stays in the browser profile.

## Privacy

See [PRIVACY.md](PRIVACY.md). The extension does not collect, transmit or sell personal data.

## Development

- `background.js` — download queue, filename rules, `links.txt`, DNR rules.
- `content/content.js` — post parsing and author-page crawling.
- `popup/` — popup UI (Chinese and English variants selected by `lang.js`/`redirect.js`).
- `mini/` — standalone monitor window.
- `_locales/` — localized extension name and description.
