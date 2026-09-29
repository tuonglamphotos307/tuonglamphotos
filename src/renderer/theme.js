'use strict';

// Applies the saved theme before first paint so the window never flashes the wrong colors.
(function () {
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem('theme'));
  } catch {
    // storage unavailable: follow the system
  }
  const dark = saved ? saved === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.documentElement.dataset.platform = (window.api && window.api.platform) || '';
})();
