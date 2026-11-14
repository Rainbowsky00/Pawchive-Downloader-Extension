# Edge Partner Center submission answers (v1.5.4)

Pre-filled answers for the Edge Add-ons submission form. All fields are well
under the 1000-character limit.

## Single purpose description

```
This extension has a single purpose: archiving posts from the user's Pawchive (pawchive.pw) account. It downloads the original images and videos of a post into organized local folders (Author/YYYY-MM-DD-Title/, numbered files), collects cloud-storage links found in the post body into a links.txt file, and shows download progress in a popup and a separate monitor window. It works only on pawchive.pw.
```

## declarativeNetRequest justification

```
The Pawchive data servers (n*.pawchive.pw/data/*, t*.pawchive.pw/f/*) reject download requests that look like browser automation: requests sent with the default browser User-Agent and client-hint headers receive 403 ("Are you a bot or using download tools?") or 429, which breaks every file download. The extension uses one session-scoped declarativeNetRequest modifyHeaders rule, scoped by regexFilter to Pawchive data URLs only, to: (1) set a transparent custom User-Agent identifying the extension, (2) remove Sec-CH-UA*/Sec-Fetch-* client-hint headers that contradict that UA and trigger 429 rate limiting, (3) set the Accept and Referer headers required by these servers. The rule never blocks or redirects any request and does not apply to any other site. Without this header handling the extension's single purpose (saving files) cannot function.
```

## downloads justification

```
downloads is the core of the single purpose: saving files. chrome.downloads.download() writes each image/video into the user's download folder under the requested relative path (Author/YYYY-MM-DD-Title/NNN.ext) and saves links.txt. The extension also uses downloads.search/onChanged to verify completion and byte counts (0-byte files are deleted and retried), downloads.cancel to stop in-flight files when the user pauses or stops the queue, downloads.erase to clear this extension's own history entries when the user clears records, and registers an onDeterminingFilename listener that suggests the intended path for this extension's own downloads (Chromium discards the filename parameter of downloads.download() when any other installed extension also registers this event, which would break the numbered folder structure).
```

## offscreen justification

```
Used only for the fallback save path: when a direct download is rejected by the data server (429/0 bytes), the service worker fetches the bytes and hands them to an offscreen document (reason: BLOBS) which creates a Blob URL so the file can be saved with the intended filename. The offscreen document does nothing else: no DOM usage, no user interaction, no remote code; it converts bytes to a Blob and revokes the URL afterwards.
```

## storage justification

```
chrome.storage.local keeps, on the user's device only: UI options (root folder name, rename toggle, per-post delay, date range), the pending download queue, completed-file records used to skip duplicates and resume after a service-worker restart or browser restart, and a small folder-to-post mapping that prevents different posts with the same title from mixing files. Nothing is synced or sent anywhere. "Clear download records" and removing the extension delete this data.
```

## Host permissions justification

```
Host access is limited to pawchive.pw and its subdomains (https://pawchive.pw/* and https://*.pawchive.pw/*). The content script reads post pages and author post lists to find the original file links, video links and cloud-drive links in the post body (the single purpose). Paginated author lists are fetched from the same origin to enumerate all posts. Media files are served from Pawchive data subdomains (n*.pawchive.pw, t*.pawchive.pw); the host permission is required so the declarativeNetRequest header rule and the download requests can apply to them. No other hosts are accessed. Cloud-drive links found in posts are only written to a local links.txt file; the extension never opens or transmits them.
```

## Are you using remote code?

**Answer: No**

```
No. All JavaScript, HTML and CSS are included in the extension package. The extension does not load any remote code: no external <script> src, no dynamic import() of remote modules, no fetch/XMLHttpRequest evaluation of remote code, and no use of eval() or new Function(). The only network activity is fetching Pawchive pages and downloading media files from pawchive.pw; all fetched content is treated as data (DOM parsing / file bytes) and is never executed.
```
