// This site's settings for kofi-pill (github.com/nickells/kofi-pill, from jsDelivr), which loads after this,
// and its clicks passed to analytics.js.
window.kofiPill = {
  kofiId: "A7S62B6EOC",
  ask: "Useful?",
  cta: "Buy me a coffee",
  caption: "Tips cover the API bills for reading the area’s flyers every morning. And caffeine.",
};
document.addEventListener("kofi-pill:click", function (e) {
  if (window.track) window.track("kofi_click", e.detail);
});
