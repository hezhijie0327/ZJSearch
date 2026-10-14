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

import { buildCitationMap, citedSourceRows, renumberCitations } from "@/lib/citations.ts";
import type { AnswerData, ResultItem, SearchPageData } from "@/lib/types.ts";

const EXPORT_MIME: Record<string, string> = {
  csv: "application/csv",
  json: "application/json",
  md: "text/markdown",
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

function buildResultsMarkdown(data: SearchPageData, results: ResultItem[], origin: string): string {
  const lines: string[] = [
    `# ${data.q}`,
    "",
    `_${results.length} results · ${data.globals.instance_name} · ${new Date().toLocaleString()} · ${origin}/search?q=${urlencode(data.q)}_`,
  ];
  if (data.answers.length > 0) {
    lines.push("", "## Answers", "");
    for (const answer of data.answers) {
      lines.push(`- ${"answer" in answer ? answer.answer : answer.template}`);
    }
  }
  lines.push("", "## Results", "");
  results.forEach((result, index) => {
    lines.push(`${index + 1}. [${result.title_text}](${result.url})`);
    if (result.content_text) {
      lines.push(`   ${result.content_text.replaceAll("\n", " ")}`);
    }
    if (result.engines.length > 0) {
      lines.push(`   _${result.engines.join(", ")}_`);
    }
  });
  return lines.join("\n");
}

/** The localized section labels an answer/thread export carries -- the
    documents must read like the UI that produced them (WYSIWYG), so the
    callers hand the i18n strings in (lib stays free of the catalogs). */
export interface ExportLabels {
  sources?: string;
}

/** One archived answer as markdown (the knowledge inspector's 复制为
    Markdown): the
    same shape as a thread export's single run -- title, the answer, the
    numbered source tail.  The text builder is shared with the inspector's
    复制为 Markdown action (the family contract's copy-as-markdown, same
    document either way).  The body and tail read the DOCUMENT-LOCAL
    citation numbers ([1..N] in first-citation order) -- the exported file
    is self-contained, not registry-littered. */
export function buildAnswerMarkdown(
  title: string,
  markdown: string,
  sources: Array<{ n: number; title: string; url: string }>,
  labels?: ExportLabels,
): string {
  const map = buildCitationMap([markdown], new Set(sources.map((source) => source.n)));
  const lines: string[] = [`# ${title}`, "", `_zjsearch · ${new Date().toLocaleString()}_`, ""];
  // the tail heading doubles as the body cites' anchor target: [1](#引用来源)
  // jumps to the source list in every renderer that slugs headings
  const sourcesLabel = labels?.sources || "Sources";
  const sourcesAnchor = sourcesLabel.trim().toLowerCase().replace(/\s+/g, "-");
  lines.push(renumberCitations(markdown, map, sourcesAnchor).trim(), "");
  if (map.size > 0) {
    lines.push(`## ${sourcesLabel}`, "");
    for (const source of citedSourceRows(map, sources)) {
      lines.push(`- [${source.local}] [${source.title || source.url}](${source.url})`);
    }
  }
  return lines.join("\n");
}

/** One REPORT document as Markdown: the outline's section titles become
    `## ` headings in order (the same document the research page rendered)
    with each section's body verbatim -- the knowledge inspector's 复制为
    Markdown for a report run, mirroring buildThreadMarkdown's source-list
    footing.  The whole document shares ONE citation map (sections in
    reading order): bodies and the source tail read the same local
    numbers. */
export function buildReportMarkdown(
  input: {
    title: string;
    subtitle?: string;
    sections: Array<{ title: string; text: string }>;
    sources: Array<{ n: number; title: string; url: string }>;
  },
  labels?: ExportLabels,
): string {
  const map = buildCitationMap(
    input.sections.map((section) => section.text),
    new Set(input.sources.map((source) => source.n)),
  );
  const lines: string[] = [`# ${input.title}`, ""];
  if (input.subtitle) {
    lines.push(`_${input.subtitle}_`, "");
  }
  lines.push(`_zjsearch · ${new Date().toLocaleString()}_`, "");
  // the tail heading doubles as the body cites' anchor target (see
  // buildAnswerMarkdown)
  const sourcesLabel = labels?.sources || "Sources";
  const sourcesAnchor = sourcesLabel.trim().toLowerCase().replace(/\s+/g, "-");
  for (const section of input.sections) {
    lines.push(`## ${section.title}`, "", renumberCitations(section.text, map, sourcesAnchor).trim(), "");
  }
  if (map.size > 0) {
    lines.push(`## ${sourcesLabel}`, "");
    for (const source of citedSourceRows(map, input.sources)) {
      lines.push(`- [${source.local}] [${source.title || source.url}](${source.url})`);
    }
  }
  return lines.join("\n");
}

/** One DECK as Marpit slide-source Markdown (the knowledge inspector's
    复制为 Markdown for a deck run): the gray-matter head makes the text a
    drop-in `deck: true` ZJBlog post (the blog's build re-renders it
    with the SAME marp-core kernel -- the family contract's payoff), the
    cover slide is minted from the outline exactly like the live view, and
    each chapter's slides join renumbered to the deck's own local
    citation sequence (a file, not a live run). */
export function buildDeckMarkdown(input: {
  title: string;
  subtitle?: string;
  sections: Array<{ text: string }>;
}): string {
  const map = buildCitationMap(
    input.sections.map((section) => section.text),
    undefined,
  );
  const lines: string[] = ["---", `title: ${input.title.replace(/\n/g, " ")}`];
  if (input.subtitle) {
    lines.push(`description: ${input.subtitle.replace(/\n/g, " ")}`);
  }
  lines.push("deck: true", "---", "", "<!-- _class: lead -->", "", `# ${input.title}`, "");
  if (input.subtitle) {
    lines.push(input.subtitle, "");
  }
  lines.push(new Date().toISOString().slice(0, 10), "");
  for (const section of input.sections) {
    const text = section.text.trim();
    if (text) {
      lines.push("---", "", renumberCitations(text, map), "");
    }
  }
  return lines.join("\n");
}

/** The structural run shape the AI-thread export reads (lib stays free of
    the feature's types). */
export interface MarkdownRun {
  q: string;
  answer: string;
  mode?: string;
  sources?: Array<{ n: number; title: string; url: string }>;
  /** the answer's inline image groups (the {{zjs-gallery:i}} placeholders
      index into this array) */
  galleries?: Array<Array<{ url: string; title?: string }>>;
}

/** One AI conversation as a readable Markdown document: title header, one
    `## ` section per question with the settled answer renumbered to the
    run's own citation sequence (the tail grounds exactly those numbers)
    and the cited sources at its foot.  The gallery
    placeholders never appear on paper: each becomes its group's images
    as markdown figures (an empty group just vanishes). */
export function buildThreadMarkdown(
  threadId: string,
  title: string,
  runs: MarkdownRun[],
  instance: string,
  labels?: ExportLabels,
): string {
  const lines: string[] = [`# ${title}`, "", `_${instance} · ${threadId} · ${new Date().toLocaleString()}_`];
  for (const run of runs) {
    // a run whose question IS the document title skips its section
    // heading -- the injected document heading would read twice (the
    // preview shows the title once)
    const ownSection = run.q.trim() !== title.trim();
    if (ownSection) {
      lines.push("", `## ${run.q}`, "");
    } else {
      lines.push("");
    }
    const answer = run.answer.replaceAll(/\{\{zjs-gallery:(\d+)\}\}/g, (_, index: string) => {
      const group = run.galleries?.[Number.parseInt(index, 10)] ?? [];
      return group.map((image) => `![${image.title ?? ""}](${image.url})`).join("\n");
    });
    // the run's own document-local numbering: the body and its tail agree
    const sources = run.sources ?? [];
    const map = buildCitationMap([answer], new Set(sources.map((source) => source.n)));
    if (answer.trim()) {
      lines.push(renumberCitations(answer, map).trim(), "");
    } else {
      lines.push(`_(no answer${run.mode ? ` · ${run.mode}` : ""})_`, "");
    }
    if (map.size > 0) {
      lines.push(`**${labels?.sources || "Sources"}**`, "");
      for (const source of citedSourceRows(map, sources)) {
        lines.push(`- [${source.local}] [${source.title || source.url}](${source.url})`);
      }
    }
  }
  return lines.join("\n");
}

/** Trigger a text download (the exporters' shared sink). */
function downloadText(filename: string, text: string, mime: string): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** The results-strip export chips: download the CURRENT results client-side. */
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
        : format === "md"
          ? buildResultsMarkdown(data, results, origin)
          : buildResultsRss(data, results, origin);
  const safeQuery =
    data.q
      .replace(/[/\\:*?"<>|]+/g, "_")
      .trim()
      .slice(0, 64) || "results";
  const extension = format === "rss" || format === "xml" ? "xml" : format;
  downloadText(`zjsearch_${safeQuery}.${extension}`, text, mime);
  return true;
}
