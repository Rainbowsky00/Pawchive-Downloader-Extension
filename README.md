# Pawchive Downloader

[English](#english) · [简体中文](#简体中文)

A browser extension (Chrome / Edge, Manifest V3) that archives posts from
[pawchive.pw](https://pawchive.pw) as a clean, numbered local collection:
original images and videos, automatic folders, cloud-drive link collection, and
reliable filenames even when other download extensions are installed.

---

<a id="english"></a>
## English

### Features

- **Original files only** — reads the post's file links and skips lazy-loaded thumbnails.
- **Automatic folders** — `Author/YYYY-MM-DD-Post title/`, with emoji and
  Windows-invalid characters removed from titles.
- **Numbered media** — `1–9`, `01–99` or `001–999` depending on the total count;
  videos are numbered together with images in page order.
- **links.txt** — collects cloud-drive links (Dropbox, Google Drive, Mega, Terabox,
  OneDrive, PikPak, synology.me, …), video links and other attachments found in the
  post body. Videos are downloaded as well.
- **Author pages** — crawl the current page or all pages (`?o=` pagination),
  with an optional publish-date range filter and per-post delay.
- **Queue controls** — pause / resume / stop, live per-file progress, retries,
  rate-limit cooldown, and a separate monitor window with diagnostics.
- **Edge-safe filenames** — the extension registers as the filename provider; if
  another download extension overrides names, the UI tells you how to fix it.
- **Bilingual UI** — Simplified Chinese for `zh-CN`/`zh-Hans`; English for every
  other locale (including `zh-TW`/`zh-HK`). Switched automatically from the browser
  language.

### Install

1. Open `chrome://extensions` (Chrome) or `edge://extensions` (Edge).
2. Enable **Developer mode**.
3. Click **Load unpacked** and select this folder (the one containing `manifest.json`).
4. Open a Pawchive post or author page and click the extension icon.

### Save rules

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

### Permissions

| Permission | Why |
|---|---|
| `downloads` | Save images, videos and `links.txt` to the download folder. |
| `storage` | Remember options, the download queue and deduplication records locally. |
| `offscreen` | Create Blob URLs for the fetch-save fallback. |
| `declarativeNetRequest` | Set the request headers required by Pawchive data servers (avoids 403/429 on downloads). |
| Host access to `pawchive.pw` | Read post pages and download media from Pawchive. |

No data leaves the browser. See [PRIVACY.md](PRIVACY.md).

### Note for Edge users

Chromium lets the **last-installed extension** control download filenames when several
extensions register `chrome.downloads.onDeterminingFilename`. If the popup shows
“Filenames overridden by another extension”:

1. Disable the conflicting download manager extension, **or**
2. Remove this extension and load it again so it is the last-installed one.

### Disclaimer

This project is not affiliated with Pawchive, Patreon, Pixiv Fanbox or any other
platform. Pawchive hosts adult content; use this tool only for content you are
allowed to access and archive, and respect the rights of the original creators.

### Development

```bash
# Offline unit tests (filename/queue logic, 43 checks)
node test_background.js

# Browser probes (load the unpacked extension via CDP, Edge/Chrome)
node test/sw_download_probe.mjs edge          # download pipeline + naming
PW_NOISY=1 node test/sw_download_probe.mjs edge   # with a conflicting extension
node test/scan_id_probe.mjs <author-url>      # author-ID detection
node test/lang_probe.mjs                      # zh-CN / zh-TW / en-US UI language
```

---

<a id="简体中文"></a>
## 简体中文

一个用于归档 [pawchive.pw](https://pawchive.pw) 帖子的浏览器扩展（Chrome / Edge，
Manifest V3）：原图原视频、自动建目录、网盘链接收集，并在 Edge 下稳定保留文件名。

### 功能

- **只下原图原视频**：读取帖子的文件链接，跳过懒加载缩略图。
- **自动建目录**：`作者/年-月-日-帖子标题/`，自动清理 emoji 和 Windows 非法字符。
- **统一编号**：按媒体总数补零（`1–9`、`01–99`、`001–999`），视频与图片按页面顺序一起编号。
- **links.txt**：收集正文里的网盘链接（Dropbox / Google Drive / Mega / Terabox /
  OneDrive / PikPak / synology.me 等）、视频链接和附件；视频本身也会下载。
- **作者页爬取**：只爬当前页或全部分页（`?o=` 翻页），支持按发布日期筛选时间段、
  设置每帖间隔。
- **队列控制**：暂停 / 继续 / 结束、单文件实时进度、失败重试、限流冷却，
  独立监控小窗带诊断记录。
- **Edge 文件名**：自动注册命名监听；若被其他下载扩展抢占，界面会给出处理方式。
- **双语界面**：简体中文环境（`zh-CN` / `zh-Hans`）显示中文，其他语言
  （含繁体 `zh-TW` / `zh-HK`）一律英文，随浏览器语言自动切换。

### 安装

1. 打开 `chrome://extensions`（Chrome）或 `edge://extensions`（Edge）。
2. 开启「开发者模式 / 开发人员模式」。
3. 点「加载已解压的扩展程序」，选择本目录（含 `manifest.json` 的文件夹）。
4. 打开 Pawchive 的帖子页或作者页，点击扩展图标即可使用。

### 保存规则

```
浏览器下载目录/
└─ 作者/
   └─ 年-月-日-标题/
      ├─ 1.jpeg / 01.jpeg / 001.jpeg
      ├─ 6.mp4 / 02.mp4
      └─ links.txt
```

补零宽度 = 媒体总数位数：≤9 → `1`；10–99 → `01`；100–999 → `001`。
弹窗里可设置一个「根目录」前缀文件夹。

### 权限说明

| 权限 | 用途 |
|---|---|
| `downloads` | 把图片、视频和 links.txt 保存到下载目录 |
| `storage` | 本地保存选项、下载队列与去重记录 |
| `offscreen` | 回退路径用 Blob URL 下载 |
| `declarativeNetRequest` | 修改 Pawchive 数据服务器的请求头（避免 403/429） |
| `pawchive.pw` 主机权限 | 读取帖子页并下载媒体 |

所有数据只留在浏览器本地，不会上传。详见 [PRIVACY.md](PRIVACY.md)。

### Edge 用户注意

Chromium 规定：多个扩展注册 `onDeterminingFilename` 时，由**最后安装的扩展**决定文件名。
若弹窗显示「⚠ 文件名被其他扩展改写」：

1. 在 `edge://extensions` 停用冲突的下载类扩展；或
2. 移除本扩展后重新「加载已解压的扩展程序」，让本扩展成为最后安装的那个。

### 免责声明

本项目与 Pawchive、Patreon、Pixiv Fanbox 等平台无关联。Pawchive 收录成人内容，
请只对有权访问与保存的内容使用本工具，并尊重原作者的版权。

### 开发测试

```bash
# 离线单元测试（命名/队列逻辑，43 项）
node test_background.js

# 浏览器探针（通过 CDP 加载未打包扩展，Edge/Chrome）
node test/sw_download_probe.mjs edge                 # 下载管线 + 命名
PW_NOISY=1 node test/sw_download_probe.mjs edge      # 模拟其他下载扩展抢名
node test/scan_id_probe.mjs <作者页链接>              # 作者 ID 识别
node test/lang_probe.mjs                             # zh-CN / zh-TW / en-US 界面语言
```

## License

[MIT](LICENSE)
