# Edge Add-ons store listing — Pawchive Downloader

Package to upload: `pawchive-downloader-1.5.4.zip` (manifest at ZIP root).

## Listing (English)

**Name:** Pawchive Downloader

**Short description (≤132 chars):**
Archive Pawchive posts as original images/videos with numbered folders, link collection, and reliable names on Edge.

**Category:** Productivity

**Detailed description:**

```
Pawchive Downloader helps you archive posts from pawchive.pw as a clean, numbered local collection.

• Original files: uses the post's file links (skips lazy-loaded thumbnails).
• Automatic folders: Author/YYYY-MM-DD-Post title/ with emoji and invalid characters removed.
• Numbered media: 1–9, 01–99 or 001–999 depending on the total count; videos included.
• links.txt: collects cloud-drive links (Dropbox, Google Drive, Mega, Terabox, OneDrive, PikPak, synology.me, …), video links and attachments.
• Videos: downloaded directly.
• Author pages: crawl the current page or all pages, with an optional publish-date range.
• Queue controls: pause, resume, stop, live progress and diagnostics in a separate monitor window.
• Edge-safe names: the extension re-registers as the filename provider; if another download extension overrides names, the UI tells you how to fix it.
• Language: Simplified Chinese UI for zh-CN/zh-Hans; English for all other locales, including zh-TW.

The extension works only on pawchive.pw. It does not collect or transmit personal data. All options, queue state and history stay in your browser profile.

Not affiliated with Pawchive or any platform whose content is archived. Please respect copyright and only download content you are allowed to access.
```

**Search terms:** pawchive, downloader, archive, image downloader, fanbox, patreon, bulk download, gallery

## Listing (Simplified Chinese, optional)

**名称：** Pawchive 下载器

**简短描述：** 专为 pawchive.pw 设计的下载扩展：一键保存帖子的原图和视频，并自动整理到本地文件夹。

**详细描述：**

```
专为 pawchive.pw 设计的下载扩展：一键保存帖子的原图和视频，并自动整理到本地文件夹。
界面语言随浏览器自动切换（简体中文显示中文，其他语言显示英文）。数据仅保存在本地。

```

## Permission justifications (Partner Center)

- **downloads** — Required to save images, videos and links.txt into the user's download folder.
- **storage** — Required to persist options, the pending download queue and completed-file records locally, so downloads can resume and duplicates are skipped.
- **offscreen** — Required to create Blob URLs for the fetch-save fallback when a direct download is rejected by the data server.
- **declarativeNetRequest** — Required to set the User-Agent/Referer and strip client-hint headers on requests to pawchive.pw data servers, which otherwise return 403/429 to download tools.
- **Host permission `https://pawchive.pw/*` and `https://*.pawchive.pw/*`** — Required to read post/author pages and download media from Pawchive. No other sites are accessed.

## Privacy policy

Host `PRIVACY.md` at a public URL (GitHub Pages, a personal site, or a gist) and paste that
URL into the Partner Center privacy policy field. The extension collects no personal data;
all state is local.

## Screenshots

Edge requires at least one screenshot (1280×800 or 640×480, PNG/JPG). Suggested shots:

1. Popup on a post page (author/title/date, image/video/link counts, Download this post).
2. Popup on an author page (ID, date range, crawl controls).
3. Monitor window during a download (progress bars, pause/resume, diagnostics).

Do not include real personal information, private messages, or unrelated browser tabs in
screenshots.

## Submission checklist

- [ ] Build ZIP: `pawchive-downloader-1.5.4.zip` (contents of `pawchive-downloader-store/`, manifest at root).
- [ ] Test the ZIP by loading it unpacked in Edge and running one post download.
- [ ] Confirm the version is `1.5.4` and the package has no `test/`, logs, or local paths.
- [ ] Host the privacy policy and have the URL ready.
- [ ] Create/verify the Edge Partner Center developer account (may require verification).
- [ ] Upload the ZIP, fill name/short description/detailed description/category/search terms.
- [ ] Provide permission justifications (above).
- [ ] Upload screenshots and the 128×128 store icon (`icons/icon128.png`).
- [ ] Submit for certification.

## Important policy note

Pawchive archives adult content. Microsoft Edge Add-ons policies restrict sexually explicit
content and extensions whose primary purpose is accessing it. The extension itself only
downloads files the user can already view, but review may still reject or age-gate the
listing. If the public listing is rejected, consider:

- publishing as **unlisted** (link-only) if available for your account, or
- distributing the signed ZIP privately / via enterprise sideloading.

Do not misrepresent the extension's purpose in the listing; that can lead to removal.
