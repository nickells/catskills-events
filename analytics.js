// PostHog, loaded from its CDN. Does nothing on localhost unless
// localStorage.analytics = "on", so test visits stay out of the numbers.
// The key is a public project key (it ships to every browser).
(function () {
  // Safe to call anywhere, any time: events wait for PostHog to load, and are dropped if it never does.
  var queue = [];
  window.track = function (name, props) { queue.push([name, props]); };

  var KEY = "phc_qNMnDmXS9x5qJf7YUi2JJ33hqhU5bQpocFktXaTcLZVz";
  var HOST = "https://us.i.posthog.com";
  var local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  var off = false;
  try { off = local && localStorage.getItem("analytics") !== "on"; } catch (e) { off = local; }
  if (off) { window.track = function () {}; return; }

  var s = document.createElement("script");
  s.async = true;
  s.src = HOST.replace(".i.posthog.com", "-assets.i.posthog.com") + "/static/array.js";
  // The URL carries the visitor's town or zip; PostHog gets the page, not the place.
  function scrub(v) {
    if (typeof v !== "string" || !/^https?:\/\//.test(v)) return v;
    try {
      var u = new URL(v);
      ["zip", "near", "q"].forEach(function (k) { u.searchParams.delete(k); });
      return u.toString();
    } catch (e) { return v; }
  }
  s.onload = function () {
    window.posthog.init(KEY, {
      api_host: HOST,
      ui_host: "https://us.posthog.com",
      capture_pageview: true,
      capture_pageleave: true,
      autocapture: false,
      capture_heatmaps: false,
      capture_dead_clicks: false,
      capture_exceptions: true,
      disable_session_recording: true,
      disable_surveys: true,
      // No cookies, and no person profiles: anonymous counts only.
      persistence: "localStorage",
      person_profiles: "identified_only",
      before_send: function (event) {
        [event.properties, event.$set, event.$set_once].forEach(function (props) {
          if (props) for (var k in props) props[k] = scrub(props[k]);
        });
        return event;
      },
      loaded: function (ph) { ph.register({ site: "catskills-events" }); },
    });
    window.track = function (name, props) { window.posthog.capture(name, props); };
    queue.forEach(function (q) { window.track(q[0], q[1]); });
    queue = [];
  };
  document.head.appendChild(s);

  // What people do on the page. Delegated from the document so the pages' own code stays untouched;
  // props say which control and value, never the visitor's place.
  var timers = {};
  function later(id, fn) { clearTimeout(timers[id]); timers[id] = setTimeout(fn, 1200); }

  document.addEventListener("click", function (e) {
    var t = e.target;
    if (!t.closest) return;
    var b;
    if ((b = t.closest(".filter-btn[data-time]"))) window.track("filter_changed", { filter: "when", value: b.dataset.time });
    else if ((b = t.closest(".filter-btn[data-category]")))
      window.track("filter_changed", { filter: "category", value: b.dataset.category, on: b.classList.contains("active") });
    else if ((b = t.closest(".view-btn"))) window.track("view_changed", { view: b.dataset.view });
    else if (t.closest("#clear-filters")) window.track("filters_cleared");
    else if ((b = t.closest("a.event-link"))) {
      var host = ""; try { host = new URL(b.href).hostname; } catch (err) {}
      window.track("event_link_clicked", { host: host, view: b.closest(".cal-event-name") ? "calendar" : "list" });
    } else if ((b = t.closest("#filters .filter-btn[data-c]")))
      window.track("filter_changed", { filter: "category", value: b.dataset.c, on: b.getAttribute("aria-pressed") === "true" });
    else if (t.closest("button.flyer")) window.track("flyer_opened");
    else if ((b = t.closest("a.post-link"))) window.track("post_link_clicked");
    else if ((b = t.closest(".aggregators a, .accounts a, .leaflet-popup a[href*=\"instagram.com\"]"))) {
      var shost = ""; try { shost = new URL(b.href).hostname; } catch (err) {}
      window.track("source_link_clicked", { host: shost, kind: b.closest("#aggregators") ? "aggregator" : b.closest("#venues") ? "venue" : "instagram" });
    } else if ((b = t.closest('a[href$="board.html"], a[href$="sources.html"], a[href$="index.html"]')))
      window.track("nav_clicked", { to: b.getAttribute("href").replace(".html", "") });
  });

  // Typing and dragging fire constantly; one event per burst.
  document.addEventListener("input", function (e) {
    var t = e.target;
    if (t.id === "search") later("search", function () { if (t.value) window.track("search_used", { term: t.value.toLowerCase().slice(0, 60) }); });
    else if (t.id === "distance-slider") later("dist", function () { window.track("distance_changed", { miles: Number(t.value) }); });
  });
})();
