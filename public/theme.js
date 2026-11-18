// Applies a saved light/dark choice before the page draws, so it does not flash.
try {
  var saved = localStorage.getItem('cvi-theme');
  if (saved === 'light' || saved === 'dark') document.documentElement.dataset.theme = saved;
} catch (e) { /* storage blocked: follow the system setting */ }
