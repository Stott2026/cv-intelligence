// Applies the light/dark choice before the page draws, so it does not flash.
// Dark is the default: the Stott and May brand uses dark for tools consultants work in all day.
// A choice made with the Light / dark button is remembered in this browser.
(function () {
  var theme = 'dark';
  try {
    var saved = localStorage.getItem('cvi-theme');
    if (saved === 'light' || saved === 'dark') theme = saved;
  } catch (e) { /* storage blocked: use the default */ }
  document.documentElement.dataset.theme = theme;
})();
