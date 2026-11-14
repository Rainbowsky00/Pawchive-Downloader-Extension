/**
 * Language detection shared by the service worker, content script and extension pages.
 *
 * The UI language follows the FIRST entry of the browser's preferred-language list
 * (the list the user can reorder in settings), because that is the control users
 * actually change. Simplified Chinese locales (zh-CN / zh-Hans / zh-SG / zh-MY)
 * get the Chinese UI; everything else - including Traditional Chinese (zh-TW /
 * zh-HK / zh-MO / zh-Hant) - falls back to English.
 */
(() => {
  'use strict';
  let pref = '';
  let ui = '';
  try { pref = (navigator && navigator.language) || ''; } catch (e) { /* ignore */ }
  try {
    if (chrome && chrome.i18n && chrome.i18n.getUILanguage) ui = chrome.i18n.getUILanguage();
  } catch (e) { /* ignore */ }
  const first = String(pref || ui || 'en');
  const lc = first.toLowerCase().replace(/_/g, '-');
  const isZh = /^zh-(cn|hans|sg|my)(-|$)/.test(lc);
  globalThis.PawLang = {
    lang: first,
    uiLang: ui || first,
    isZh,
    pick(zh, en) { return isZh ? zh : en; }
  };
})();
