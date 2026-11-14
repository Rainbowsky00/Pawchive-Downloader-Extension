/**
 * Redirects the UI entry page to the localized variant.
 * Usage:
 *   <script src="../lang.js"></script>
 *   <script src="../redirect.js" data-zh="popup.zh.html" data-en="popup.en.html"></script>
 */
(() => {
  'use strict';
  const self = document.currentScript;
  const zh = self && self.getAttribute('data-zh');
  const en = self && self.getAttribute('data-en');
  if (!zh || !en) return;
  const target = (globalThis.PawLang && PawLang.isZh) ? zh : en;
  try { location.replace(target); } catch (e) { /* ignore */ }
})();
