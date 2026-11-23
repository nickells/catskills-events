/*! kofi-pill: a "Buy me a coffee" pill and Ko-fi tip panel for any page. https://github.com/nickells/kofi-pill */
//
// A pill rises into the bottom corner once a visitor has used the page a little (scrolled a few
// screens, or clicked a few controls), but only while none of the page's own Ko-fi links are on
// screen: one ask in view at a time. The pill and those links open Ko-fi's tip form in a dialog,
// loaded on first open, so pages that never open it make no request to Ko-fi. None of Ko-fi's
// scripts run on the page. Closing the pill keeps it away for a while.
//
// Set up with data attributes on this script's tag, or a window.kofiPill object set before it
// (attributes win). See the README for every option.
(function () {
  var script = document.currentScript;
  var attrs = (script && script.dataset) || {};
  var given = window.kofiPill || {};
  function option(name, fallback) {
    if (attrs[name] != null) return attrs[name];
    if (given[name] != null) return given[name];
    return fallback;
  }

  var kofiId = option("kofiId");
  if (!kofiId) {
    console.warn("kofi-pill: set data-kofi-id (your Ko-fi page id) to show the pill.");
    return;
  }
  var KOFI_URL = "https://ko-fi.com/" + kofiId;
  // Ko-fi's embeddable tip form, without the page's post feed.
  var KOFI_EMBED_URL = KOFI_URL + "/?hidefeed=true&widget=true&embed=true&preview=true";
  var ASK = option("ask", "Useful?");
  var CTA = option("cta", "Buy me a coffee");
  var CAPTION = option("caption", "");
  var SHOW_AFTER_SCREENS = Number(option("afterScreens", 3));
  var SHOW_AFTER_CLICKS = Number(option("afterClicks", 5));
  var HIDE_DAYS = Number(option("hideDays", 30));
  var DAY_MS = 24 * 60 * 60 * 1000;
  var HIDDEN_UNTIL_KEY = "kofi-pill-hidden-until";
  // What counts as using the page: clicks on blank space or text while reading don't.
  var CONTROLS = 'a, button, input, select, label, summary, [role="button"]';

  // Ko-fi's mug with a heart in it, in one ink (currentColor).
  var CUP_ICON =
    '<svg class="kofi-pill-cup" viewBox="0 0 24 24" aria-hidden="true">' +
      '<path d="M3.75 5h12.5A1.75 1.75 0 0 1 18 6.75V13a6.5 6.5 0 0 1-6.5 6.5h-3A6.5 6.5 0 0 1 2 13V6.75A1.75 1.75 0 0 1 3.75 5Z' +
      'M18 8h1.25a3.25 3.25 0 0 1 0 6.5H18"/>' +
      '<path fill="currentColor" stroke="none" d="M10 16.6 5.8 12.4a2.6 2.6 0 1 1 4.2-3.1 2.6 2.6 0 1 1 4.2 3.1Z"/>' +
    "</svg>";

  // Every size and color is a custom property with a default, so a site can restyle it from its
  // own CSS (see the README).
  var CSS =
    ":root{--kofi-pill-ink:#151515;--kofi-pill-on-ink:#fff;--kofi-pill-close:#e2e0d8;--kofi-pill-accent:currentColor;" +
      "--kofi-pill-muted:#5f5e58;--kofi-pill-hover:#f2f1ec;--kofi-pill-font:inherit;--kofi-pill-radius:6px;--kofi-pill-z:60}" +
    ".kofi-pill{position:fixed;right:16px;bottom:16px;z-index:var(--kofi-pill-z);display:flex;align-items:center;margin:0;" +
      "background:var(--kofi-pill-ink);color:var(--kofi-pill-on-ink);border-radius:999px;box-shadow:0 2px 10px rgba(0,0,0,.18);" +
      "font:600 13px/1.2 var(--kofi-pill-font);animation:kofi-pill-in .3s ease-out}" +
    "@keyframes kofi-pill-in{from{opacity:0;transform:translateY(12px)}}" +
    "@media (prefers-reduced-motion:reduce){.kofi-pill{animation:none}}" +
    ".kofi-pill a{display:flex;align-items:center;gap:8px;padding:8px 8px 8px 16px;color:inherit;text-decoration:none}" +
    ".kofi-pill strong{font-weight:700}" +
    ".kofi-pill a:hover strong{text-decoration:underline;text-decoration-color:var(--kofi-pill-accent);text-decoration-thickness:2px;text-underline-offset:3px}" +
    ".kofi-pill-cup{flex:none;width:20px;height:20px;fill:none;stroke:currentColor;stroke-width:2.25;stroke-linecap:round;stroke-linejoin:round}" +
    // In a page's own link it sits inline, centered on the text, so the link keeps its baseline.
    "[data-kofi-cup] .kofi-pill-cup{width:1.35em;height:1.35em;margin-right:.3em;vertical-align:middle}" +
    ".kofi-pill button{width:28px;height:28px;margin-right:4px;border:0;border-radius:50%;background:none;color:var(--kofi-pill-close);" +
      "font:400 18px/1 var(--kofi-pill-font);cursor:pointer}" +
    ".kofi-pill button:hover{color:var(--kofi-pill-on-ink);background:rgba(255,255,255,.12)}" +
    // The pill's height plus its offset from the bottom, so the page's end scrolls clear of it.
    "body.has-kofi-pill{padding-bottom:72px}" +
    "@media (max-width:600px){.kofi-pill{right:12px;bottom:12px}}" +
    // The panel: Ko-fi's tip form in a plain sheet, even padding on every side. The frame stays
    // under 400px wide, where Ko-fi draws its form flush to the frame's edges; wider, it adds side
    // margins of its own and no top one. #f9f9f9 is Ko-fi's embed background, so the frame's
    // edges don't show.
    ".kofi-pill-panel{width:min(420px,calc(100vw - 32px));max-height:calc(100dvh - 32px);margin:auto;padding:12px;border:0;" +
      "border-radius:var(--kofi-pill-radius);background:#f9f9f9;overflow:hidden}" +
    ".kofi-pill-panel[open]{display:flex;flex-direction:column;gap:12px}" +
    ".kofi-pill-panel::backdrop{background:rgba(21,21,21,.5)}" +
    ".kofi-pill-panel-head{display:flex;align-items:flex-start;justify-content:flex-end;gap:12px;padding:4px 0 0 4px}" +
    ".kofi-pill-panel-head p{flex:1;margin:0;font:400 13px/1.45 var(--kofi-pill-font);color:var(--kofi-pill-muted);text-wrap:pretty}" +
    // 712px is Ko-fi's suggested embed height: its tallest step (payment) without a scrollbar.
    ".kofi-pill-panel iframe{display:block;width:100%;height:712px;min-height:0;flex:0 1 auto;border:0}" +
    ".kofi-pill-close{flex:none;width:28px;height:28px;border:0;border-radius:50%;background:#fff;color:var(--kofi-pill-ink);" +
      "font:400 18px/1 var(--kofi-pill-font);cursor:pointer}" +
    ".kofi-pill-close:hover{background:var(--kofi-pill-hover)}";
  var style = document.createElement("style");
  style.id = "kofi-pill-style";
  style.textContent = CSS;
  // First in <head>, so the site's own CSS overrides it.
  document.head.insertBefore(style, document.head.firstChild);

  function escapeHtml(text) {
    var el = document.createElement("span");
    el.textContent = text;
    return el.innerHTML;
  }

  // The page's own links to Ko-fi, marked data-kofi; with data-kofi-cup they lead with the mug.
  var pageLinks = document.querySelectorAll("[data-kofi]");
  pageLinks.forEach(function (link) {
    if (link.hasAttribute("data-kofi-cup")) link.insertAdjacentHTML("afterbegin", CUP_ICON);
  });

  var panel;
  function openPanel() {
    if (!panel) {
      panel = document.createElement("dialog");
      panel.className = "kofi-pill-panel";
      panel.setAttribute("aria-label", "Support on Ko-fi");
      panel.innerHTML =
        '<div class="kofi-pill-panel-head">' +
          (CAPTION ? "<p>" + escapeHtml(CAPTION) + "</p>" : "") +
          '<button type="button" class="kofi-pill-close" aria-label="Close">×</button>' +
        "</div>" +
        '<iframe title="Tip on Ko-fi" src="' + KOFI_EMBED_URL + '"></iframe>';
      panel.querySelector("button").addEventListener("click", function () { panel.close(); });
      // A click on the backdrop lands on the dialog itself.
      panel.addEventListener("click", function (e) { if (e.target === panel) panel.close(); });
      document.body.appendChild(panel);
    }
    panel.showModal();
  }

  // Any Ko-fi link (the pill's, or the page's own) opens the panel, and fires a "kofi-pill:click"
  // event on document saying which one it was, for a site's analytics. A new-tab click (cmd,
  // ctrl, shift, middle button) still follows the link to Ko-fi.
  document.addEventListener("click", function (e) {
    var link = e.target instanceof Element && e.target.closest("[data-kofi], .kofi-pill a");
    if (!link) return;
    var from = link.getAttribute("data-kofi") || "pill";
    document.dispatchEvent(new CustomEvent("kofi-pill:click", { detail: { from: from } }));
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    openPanel();
  });

  try {
    if (Date.now() < Number(localStorage.getItem(HIDDEN_UNTIL_KEY))) return;
  } catch (e) { /* storage blocked: just show it */ }

  var pill = document.createElement("aside");
  pill.className = "kofi-pill";
  pill.setAttribute("aria-label", "Support this site");
  pill.innerHTML =
    '<a href="' + KOFI_URL + '" target="_blank" rel="noopener">' +
      CUP_ICON +
      "<span>" + (ASK ? escapeHtml(ASK) + " " : "") + "<strong>" + escapeHtml(CTA) + "</strong></span>" +
    "</a>" +
    '<button type="button" aria-label="Hide for now">×</button>';

  // The pill is up once the visitor has earned it, unless one of the page's own links is on
  // screen. It tucks away when that link scrolls back in, and returns after.
  var earned = false;
  var dismissed = false;
  var linksInView = new Set();
  function sync() {
    var up = earned && !dismissed && linksInView.size === 0;
    if (up === pill.isConnected) return;
    if (up) document.body.appendChild(pill);
    else pill.remove();
    document.body.classList.toggle("has-kofi-pill", up);
  }
  if (pageLinks.length && "IntersectionObserver" in window) {
    var watcher = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) linksInView.add(entry.target);
        else linksInView.delete(entry.target);
      });
      sync();
    });
    pageLinks.forEach(function (link) { watcher.observe(link); });
  }

  function hide() {
    try { localStorage.setItem(HIDDEN_UNTIL_KEY, String(Date.now() + HIDE_DAYS * DAY_MS)); } catch (e) {}
    dismissed = true;
    sync();
  }

  pill.querySelector("a").addEventListener("click", hide);
  pill.querySelector("button").addEventListener("click", hide);

  var clicks = 0;
  function onScroll() {
    if (window.scrollY >= SHOW_AFTER_SCREENS * window.innerHeight) show();
  }
  function onClick(e) {
    if (!(e.target instanceof Element) || !e.target.closest(CONTROLS)) return;
    if (++clicks >= SHOW_AFTER_CLICKS) show();
  }
  function show() {
    window.removeEventListener("scroll", onScroll);
    document.removeEventListener("click", onClick, true);
    earned = true;
    sync();
  }
  window.addEventListener("scroll", onScroll, { passive: true });
  document.addEventListener("click", onClick, true);
})();
