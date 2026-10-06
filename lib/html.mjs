import * as cheerio from "cheerio";

// A page's title, first heading and readable text, with links kept as markdown so the LLM can see them.
export function parseHtml(html, baseUrl) {
  const $ = cheerio.load(html);
  const pageTitle = $("title").text().trim();
  const h1 = $("h1").first().text().trim();
  $("script, style, nav, footer, noscript, iframe, svg").remove();
  $("a[href]").each((_, el) => {
    let href = $(el).attr("href");
    const text = $(el).text().trim();
    if (!href || !text) return;
    if (href.startsWith("/") && baseUrl) {
      try { href = new URL(href, baseUrl).href; } catch {}
    }
    if (href.startsWith("http")) {
      $(el).replaceWith(`[${text}](${href})`);
    }
  });
  // Preserve some structure: add newlines around block elements
  $("h1, h2, h3, h4, h5, h6, p, li, tr, br, div").each((_, el) => {
    $(el).prepend("\n");
  });
  const body = $.text().replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  return { pageTitle, h1, body };
}
