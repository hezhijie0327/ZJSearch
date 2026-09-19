// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

/** Client-side export of the results currently on screen (the payload page
    plus every appended infinite-scroll page).  That merged list only exists
    in the browser — the server cannot reconstruct it — so the download
    formats are generated here instead of re-running the search; the plain
    GET /search?format=… URLs stay untouched for feed readers and no-JS
    clients (the format chips keep their href for modified clicks).

    The emitted structures mirror the upstream serializers field by field so
    a download and a curl of the same query are interchangeable:
      JSON — webutils.get_json_response: {query, results, answers,
            corrections, infoboxes, suggestions, unresponsive_engines}, with
            results in the upstream result-dict shape (url, template, engine,
            engines, parsed_url as the 6-element ParseResult array, title,
            content, …, publishedDate as an ISO string — the payload's
            title_html/pretty_url/… theme fields are dropped),
            answers as {url, engine, parsed_url, template, …} (msgspec
            to_builtins shape), compact encoding.
      CSV  — webutils.write_csv_response: title,url,content,host,engine,
            score,type rows for results, answers, suggestions, corrections
            (the server crashes on answers — parsed_url is null there — this
            export fills the columns gracefully instead).
      RSS  — zjsearch/opensearch_response_rss.xml: instance_name channel,
            xml-stylesheet, opensearch elements, per-item description extras
            (torrent health, video length, author, image resolution),
            enclosure from thumbnail_src/img_src, RFC-822 pubDate. */

import type { AnswerData, ResultItem, SearchPageData } from "@/lib/types.ts";

const EXPORT_MIME: Record<string, string> = {
  csv: "application/csv",
  json: "application/json",
  rss: "text/xml",
  xml: "text/xml",
};

/** ResultItem fields that exist upstream under the same name; everything
    theme-only (title_html, pretty_url, favicon, …) is dropped from exports. */
const PASSTHROUGH_KEYS: Array<keyof ResultItem> = [
  "filesize",
  "seed",
  "leech",
  "files",
  "magnetlink",
  "torrentfile",
  "resolution",
  "img_format",
  "source",
  "author",
  "views",
  "length_seconds",
  "metadata",
  "comments",
  "tags",
  "authors",
  "editor",
  "publisher",
  "journal",
  "volume",
  "number",
  "pages",
  "doi",
  "issn",
  "isbn",
  "pdf_url",
  "html_url",
  "package_name",
  "version",
  "maintainer",
  "popularity",
  "license_name",
  "license_url",
  "homepage",
  "source_code_url",
  "repository",
  "filename",
  "size",
  "time",
  "mimetype",
  "embedded",
  "mtype",
  "subtype",
  "address",
  "map_links",
  "longitude",
  "latitude",
  "geojson",
  "boundingbox",
  "price",
  "shipping",
  "source_country",
];

function xmlEscape(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** jinja's urlencode (= quote_plus): spaces become "+" */
function urlencode(text: string): string {
  return encodeURIComponent(text).replaceAll("%20", "+");
}

function csvCell(value: unknown): string {
  const text = value === undefined || value === null ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** The upstream `parsed_url`: urllib's ParseResult namedtuple serializes to
    a 6-element array [scheme, netloc, path, params, query, fragment]; unset
    URLs stay null. */
function parsedUrl(url: string): [string, string, string, string, string, string] | null {
  try {
    const parsed = new URL(url);
    return [
      parsed.protocol.replace(/:$/, ""),
      parsed.host,
      parsed.pathname,
      "",
      parsed.search.replace(/^\?/, ""),
      parsed.hash.replace(/^#/, ""),
    ];
  } catch {
    return null;
  }
}

/** The upstream result-dict shape (LegacyResult.as_dict): base keys are
    always present, type-specific extras only when set.  `publishedDate`
    carries the payload's ISO instant, matching the upstream JSONEncoder's
    datetime.isoformat(). */
function upstreamResult(result: ResultItem): Record<string, unknown> {
  const mapped: Record<string, unknown> = {
    template: result.template,
    url: result.url,
    parsed_url: parsedUrl(result.url),
    engine: result.engines[0] ?? "",
    engines: result.engines,
    title: result.title_text,
    content: result.content_text,
    img_src: result.img_src ?? "",
    thumbnail: result.thumbnail ?? "",
    priority: result.priority ?? "",
    positions: "",
    score: result.score ?? 0,
    category: result.category ?? "",
    publishedDate: result.published_date ?? null,
    pubdate: "",
    iframe_src: result.iframe_src ?? null,
  };
  for (const key of PASSTHROUGH_KEYS) {
    const value = result[key];
    if (value !== undefined && value !== null && value !== "") {
      mapped[key] = value;
    }
  }
  // upstream videos carry `length` (the label), renamed to length_display in
  // the page payload
  if (result.length_display) {
    mapped.length = result.length_display;
  }
  return mapped;
}

/** The upstream answer shape (msgspec to_builtins of the BaseAnswer
    subclasses): {url, engine, parsed_url, template, <answer fields>}. */
function upstreamAnswer(answer: AnswerData): Record<string, unknown> {
  // the payload stores "" for unset strings; upstream answers emit null
  const base = {
    url: answer.url || null,
    engine: answer.engine || null,
    parsed_url: null,
    template: answer.template,
  };
  if (answer.template === "answer/legacy.html" || answer.template === "answer/stock.html") {
    return { ...base, answer: answer.answer, data: answer.data ?? null };
  }
  // translations / weather: their payload fields ride along after the base
  const payload: Record<string, unknown> = { ...answer };
  delete payload.template;
  delete payload.url;
  delete payload.engine;
  return { ...base, ...payload };
}

function buildResultsJson(data: SearchPageData, results: ResultItem[]): string {
  return JSON.stringify({
    query: data.q,
    results: results.map(upstreamResult),
    answers: data.answers.map(upstreamAnswer),
    corrections: data.corrections.map((correction) => correction.title),
    infoboxes: data.infoboxes,
    suggestions: data.suggestions.map((suggestion) => suggestion.title),
    unresponsive_engines: data.unresponsive_engines,
  });
}

function buildResultsCsv(data: SearchPageData, results: ResultItem[]): string {
  const keys = ["title", "url", "content", "host", "engine", "score", "type"];
  const rows: string[][] = [keys];
  for (const result of results) {
    rows.push([
      result.title_text,
      result.url,
      result.content_text,
      parsedUrl(result.url)?.[1] ?? "",
      result.engines[0] ?? "",
      result.score !== undefined ? String(result.score) : "",
      "result",
    ]);
  }
  for (const answer of data.answers) {
    // the upstream CSV crashes on answers (parsed_url is null there); the
    // client fills the columns gracefully, the answer text lands in `title`
    rows.push([
      "answer" in answer ? answer.answer : answer.template,
      answer.url ?? "",
      "",
      "",
      "engine" in answer ? answer.engine : "",
      "",
      "answer",
    ]);
  }
  for (const suggestion of data.suggestions) {
    rows.push([suggestion.title, "", "", "", "", "", "suggestion"]);
  }
  for (const correction of data.corrections) {
    rows.push([correction.title, "", "", "", "", "", "correction"]);
  }
  // CRLF rows like the upstream csv writer; BOM so Excel reads the UTF-8
  return `\uFEFF${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}`;
}

/** RFC-822 pubDate of the upstream template: `strftime('%a, %d %b %Y
    %H:%M:%S') + ' ' + (%z or '+0000')` — rendered for the UTC instant. */
function rssDate(iso: string | undefined): string | null {
  if (!iso) {
    return null;
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `${days[date.getUTCDay()]}, ${pad(date.getUTCDate())} ${months[date.getUTCMonth()]} ${date.getUTCFullYear()} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} +0000`
  );
}

/** The <description> extras of the upstream RSS template: torrent health,
    video length, author and image resolution ride along after the content. */
function rssDescription(result: ResultItem): string {
  const parts = [result.content_text || ""];
  if (result.template === "torrent.html") {
    if (result.filesize) {
      parts.push(` [${result.filesize}]`);
    }
    if (result.seed) {
      parts.push(` seeds ${result.seed}, leech ${result.leech}`);
    }
    if (result.files) {
      parts.push(`, ${result.files} files`);
    }
    if (result.magnetlink) {
      parts.push(` | magnet: ${result.magnetlink}`);
    }
  } else {
    if (result.template === "videos.html" && result.length_display) {
      parts.push(` [${result.length_display}]`);
    }
    if (result.author) {
      parts.push(` — ${result.author}`);
    }
    if (result.template === "images.html" && result.resolution) {
      parts.push(` [${result.resolution}]`);
    }
  }
  return parts.join("");
}

function rssItem(result: ResultItem): string {
  const lines = [
    "    <item>",
    `      <title>${xmlEscape(result.title_text)}</title>`,
    "      <type>result</type>",
    `      <link>${xmlEscape(result.url)}</link>`,
    `      <description>${xmlEscape(rssDescription(result))}</description>`,
  ];
  // the upstream template encloses thumbnail_src / img_src only — `thumbnail`
  // (the proxified general-thumbnail) never produces one
  const media = result.thumbnail_src || result.img_src;
  if (media) {
    const extension = (media.split("?", 1)[0] ?? media).split(".").pop()?.toLowerCase();
    const type = extension === "png" ? "png" : extension === "webp" ? "webp" : extension === "gif" ? "gif" : "jpeg";
    lines.push(`      <enclosure length="0" type="image/${type}" url="${xmlEscape(media)}"/>`);
  }
  const pubDate = rssDate(result.published_date);
  if (pubDate) {
    lines.push(`      <pubDate>${pubDate}</pubDate>`);
  }
  lines.push("    </item>");
  return lines.join("\n");
}

function buildResultsRss(data: SearchPageData, results: ResultItem[], origin: string): string {
  const q = xmlEscape(data.q);
  const instance = xmlEscape(data.globals.instance_name);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<?xml-stylesheet href="${origin}/rss.xsl" type="text/xsl"?>`,
    '<rss version="2.0"',
    '     xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/"',
    '     xmlns:atom="http://www.w3.org/2005/Atom">',
    "  <channel>",
    `    <instance_name>${instance}</instance_name>`,
    `    <title>${instance} search: ${q}</title>`,
    `    <link>${origin}/search?q=${urlencode(data.q)}</link>`,
    `    <description>Search results for "${q}" - ${instance}</description>`,
    "    <opensearch:startIndex>1</opensearch:startIndex>",
    `    <atom:link rel="search" type="application/opensearchdescription+xml" href="${origin}/opensearch.xml"/>`,
    `    <opensearch:Query role="request" searchTerms="${q}" startPage="1" />`,
    ...results.map(rssItem),
    "  </channel>",
    "</rss>",
  ].join("\n");
}

/** Build and download the current results as `format` (csv/json/rss; xml is
    an alias of rss) in the same structure as the server's format endpoints.
    Returns false when the format has no client-side builder — the caller
    then leaves the server URL link untouched. */
export function downloadResults(format: string, data: SearchPageData, results: ResultItem[], origin: string): boolean {
  const mime = EXPORT_MIME[format];
  if (!mime) {
    return false;
  }
  const text =
    format === "csv"
      ? buildResultsCsv(data, results)
      : format === "json"
        ? buildResultsJson(data, results)
        : buildResultsRss(data, results, origin);
  const safeQuery =
    data.q
      .replace(/[/\\:*?"<>|]+/g, "_")
      .trim()
      .slice(0, 64) || "results";
  const extension = format === "rss" || format === "xml" ? "xml" : format;
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `zjsearch_${safeQuery}.${extension}`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
  return true;
}
