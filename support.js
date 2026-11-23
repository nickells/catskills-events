// The Ko-fi pill pinned to the bottom of every page, and the Ko-fi panel its links open. The panel
// is Ko-fi's own embed in a frame, loaded only once someone opens it; none of Ko-fi's scripts run
// on the page. The pill waits until the visitor has used the page a little (scrolled
// SHOW_AFTER_SCREENS screens down, or used SHOW_AFTER_CLICKS controls), and hiding it (or
// clicking through) keeps it away for HIDE_DAYS.
(function () {
  var KOFI_URL = "https://ko-fi.com/A7S62B6EOC";
  // Ko-fi's embeddable tip form, without the page's post feed.
  var KOFI_EMBED_URL = KOFI_URL + "/?hidefeed=true&widget=true&embed=true&preview=true";
  var SHOW_AFTER_SCREENS = 3;
  var SHOW_AFTER_CLICKS = 5;
  // What counts as using the page: clicks on blank space or text while reading don't.
  var CONTROLS = 'a, button, input, select, label, summary, [role="button"]';
  var HIDE_DAYS = 30;
  var DAY_MS = 24 * 60 * 60 * 1000;
  var HIDDEN_UNTIL_KEY = "kofi-hidden-until";
  // How long the "Hidden" note stays up after the pill is closed.
  var NOTE_MS = 3500;

  // Ko-fi's mug with a heart in it, in one ink (currentColor), so it matches the panel's own mark.
  // The pill leads with it, and so does each page's own link.
  var CUP_ICON =
    '<svg class="kofi-cup" viewBox="0 0 24 24" aria-hidden="true">' +
      '<path d="M3.75 5h12.5A1.75 1.75 0 0 1 18 6.75V13a6.5 6.5 0 0 1-6.5 6.5h-3A6.5 6.5 0 0 1 2 13V6.75A1.75 1.75 0 0 1 3.75 5Z' +
      'M18 8h1.25a3.25 3.25 0 0 1 0 6.5H18"/>' +
      '<path fill="currentColor" stroke="none" d="M10 16.6 5.8 12.4a2.6 2.6 0 1 1 4.2-3.1 2.6 2.6 0 1 1 4.2 3.1Z"/>' +
    "</svg>";
  document.querySelectorAll('[data-kofi="nav"]').forEach(function (link) {
    link.insertAdjacentHTML("afterbegin", CUP_ICON);
  });

  var panel;
  function openPanel() {
    if (!panel) {
      panel = document.createElement("dialog");
      panel.className = "kofi-panel";
      panel.setAttribute("aria-label", "Support on Ko-fi");
      panel.innerHTML =
        '<div class="kofi-panel-head">' +
          "<p>Tips cover the API bills for reading the area\u2019s flyers every morning. And caffeine.</p>" +
          '<button type="button" class="kofi-panel-close" aria-label="Close">×</button>' +
        "</div>" +
        '<iframe title="Tip on Ko-fi" src="' + KOFI_EMBED_URL + '"></iframe>';
      panel.querySelector("button").addEventListener("click", function () { panel.close(); });
      // A click on the backdrop lands on the dialog itself.
      panel.addEventListener("click", function (e) { if (e.target === panel) panel.close(); });
      document.body.appendChild(panel);
    }
    panel.showModal();
  }

  // Every Ko-fi link (the pill's, and the page's own marked data-kofi) opens the panel and reports
  // where it was clicked. Its href still goes to Ko-fi for a new-tab click.
  document.addEventListener("click", function (e) {
    var link = e.target instanceof Element && e.target.closest("[data-kofi]");
    if (!link) return;
    if (window.track) window.track("kofi_click", { from: link.getAttribute("data-kofi") });
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    openPanel();
  });

  try {
    if (Date.now() < Number(localStorage.getItem(HIDDEN_UNTIL_KEY))) return;
  } catch (e) { /* storage blocked: just show it */ }

  var pill = document.createElement("aside");
  pill.className = "kofi";
  pill.setAttribute("aria-label", "Support this site");
  pill.innerHTML =
    '<a href="' + KOFI_URL + '" target="_blank" rel="noopener" data-kofi="pill">' +
      CUP_ICON +
      '<span>Useful? <strong>Buy me a coffee</strong></span>' +
    "</a>" +
    '<button type="button" aria-label="Hide for now">×</button>';

  // The pill is up once the visitor has earned it, unless the page's own coffee link is on screen:
  // one ask in view at a time. It tucks away when that link scrolls back in, and returns after.
  var earned = false;
  var dismissed = false;
  var linksInView = new Set();
  function sync() {
    var up = earned && !dismissed && linksInView.size === 0;
    if (up === pill.isConnected) return;
    if (up) document.body.appendChild(pill);
    else pill.remove();
    document.body.classList.toggle("has-kofi", up);
  }
  var pageLinks = document.querySelectorAll('[data-kofi]:not([data-kofi="pill"])');
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

  // Closing it says where Ko-fi still lives, so hiding it is never losing it.
  function noteHidden() {
    var note = document.createElement("p");
    note.className = "kofi kofi-note";
    note.setAttribute("role", "status");
    note.textContent = "Hidden. \u201cBuy me a coffee\u201d stays up top.";
    document.body.appendChild(note);
    setTimeout(function () { note.remove(); }, NOTE_MS);
  }

  pill.querySelector("a").addEventListener("click", hide);
  pill.querySelector("button").addEventListener("click", function () {
    hide();
    noteHidden();
  });

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
