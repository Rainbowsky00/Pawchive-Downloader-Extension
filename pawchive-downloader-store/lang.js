/**
 * Language detection shared by the service worker, content script and extension pages.
 *
 * Chinese UI is used ONLY for Simplified Chinese browser locales
 * (zh-CN / zh-Hans / zh-SG / zh-MY). Traditional Chinese (zh-TW / zh-HK / zh-MO /
 * zh-Hant) and every other language fall back to English.
 */
(() => {
  'use strict';
  let lang = 'en';
  try {
    if (chrome && chrome.i18n && chrome.i18n.getUILanguage) lang = chrome.i18n.getUILanguage();
    else if (navigator && navigator.language) lang = navigator.language;
  } catch (e) { /* fall back to English */ }
  const lc = String(lang || 'en').toLowerCase().replace(/_/g, '-');
  const isZh = /^zh-(cn|hans|sg|my)(-|$)/.test(lc);
  globalThis.PawLang = {
    lang,
    isZh,
    pick(zh, en) { return isZh ? zh : en; }
  };
})();
