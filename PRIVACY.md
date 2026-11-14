# Privacy Policy — Pawchive Downloader

Last updated: 2026-11-15

Pawchive Downloader is a browser extension that helps users archive posts from
`pawchive.pw`. This policy explains what data the extension handles.

## Data collection

The extension **does not collect, transmit, sell or share personal data**.

- No analytics, telemetry, advertising or tracking services are used.
- No account, email address, browsing history or device identifier is collected.
- No data is sent to the developer or any third party.

## Data stored locally

The extension uses the browser's local extension storage for:

- UI options (root folder name, rename on/off, crawl delay, date range).
- The pending download queue and completed-file records (to resume and avoid duplicates).
- The last known download folder path (display only).

This data stays in the user's browser profile. Removing the extension or using
**Clear download records** / clearing extension data deletes it.

## Network access

The extension requests access to `pawchive.pw` and its subdomains so it can:

- Read post and author pages to find media links.
- Download images, videos and `links.txt` to the user's download folder.

Requests are sent only to Pawchive servers. Cloud-drive and video links found in post
text are written to a local text file; the extension does not open or upload them.

## Permissions

- `downloads` — save files to the browser download folder.
- `storage` — keep options, queue and deduplication records locally.
- `offscreen` — create Blob URLs for the fetch-save fallback.
- `declarativeNetRequest` — add the request headers required by Pawchive data servers.
- Host permission for `pawchive.pw` — read pages and download media.

## Contact

For privacy questions, use the developer contact shown on the extension's store listing.
