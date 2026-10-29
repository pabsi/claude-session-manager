// Loaded synchronously in <head> so the saved theme applies before the first paint.
(() => {
  let saved = null;
  try {
    saved = localStorage.getItem("csm-theme");
  } catch {}
  const dark = matchMedia("(prefers-color-scheme: dark)").matches;
  document.documentElement.dataset.theme = saved || (dark ? "dark" : "light");
})();
