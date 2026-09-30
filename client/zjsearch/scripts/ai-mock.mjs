// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

/**
 * Deterministic mock LLM for the zjsearch Lighthouse gate (`pnpm run audit`)
 * -- the AI counterpart of the zjaudit fixture engine.
 *
 * Speaks JUST enough of the OpenAI chat-completions wire protocol for the
 * theme's `openai_chat_completions` transport (searx/zjsearch/ai/llm.py):
 * SSE chunks with content / reasoning_content / tool_calls deltas, plus
 * non-streaming JSON objects for the structured gates.  Every completion is
 * FIXED text keyed by request shape, so the audited AI pages are as
 * variance-free as the fixture-engine ones:
 *
 * - `response_format.json_schema.name` names the gate -- research_gate
 *   answers `{"research": true}`, clarify_gate declines, the follow-up
 *   rewrite echoes the question, related_questions returns three canned
 *   questions.
 * - `tools` present is the researcher: the opener streams a one-line intent
 *   plus TWO calls — a web_search carrying the page's own `zjaudit <kind>`
 *   fixture query AND a web_reader reading the fixture result the search
 *   just numbered (the executor renders it through the MOCK BROWSERLESS
 *   endpoint below — the same server answers `POST .../content` with a
 *   fixed fixture page, so the reading-pane path runs offline; re-reading
 *   an already-numbered url exercises the read-in-full badge); the
 *   follow-up turn (its request carries tool results) streams closing
 *   prose and NO calls, which ends the research and hands over to the
 *   writer.
 * - the writer's system prompt is the only one carrying `<follow_ups>` --
 *   it streams the fixed cited markdown answer, one inline gallery group
 *   (the fixture feed's own image URL, exercising the zjs-images fence
 *   interception, the gallery event and the placeholder rendering) and
 *   the ```related fence (exercising the fence interception: suggestions,
 *   never raw fence text).
 * - anything else is the AI Overview: a short reasoning_content segment
 *   (the `<think>` relay) then the fixed cited answer.
 */

import { createServer } from "node:http";

const PORT = Number(process.env.ZJS_AI_MOCK_PORT ?? 8909);

const RELATED = [
  "What else does the audit gate cover?",
  "How is the mock transport configured?",
  "Which fixture engine powers these results?",
];

const WRITER_ANSWER = `**ZJSearch audit answer** -- this page is produced by the deterministic mock transport, so the Lighthouse run measures the UI, not model variance.

The fixture search returned ten cited sources [1, 2]; the synthesis renders the shared markdown surface. A list:

- first audited point, cited [3]
- second audited point, cited [4]

and a small comparison table:

| Surface | Audited |
| --- | --- |
| Research timeline | yes |
| Cited synthesis | yes |

Grounding stays honest: anything beyond the sources would carry [*] [5].`;

/** The inline image group: the fixture feed's own image URL (result #1
    carries it), verbatim -- the wire layer validates every fence URL
    against the run's registry, so this exercises the gallery event, the
    `{{zjs-gallery:0}}` placeholder and the client's AnswerGallery path
    offline.  The fence rides after the FIRST paragraph: a group that
    lands mid-answer shifts less settled content below it. */
const GALLERY_FENCE = '```zjs-images\n["/static/themes/zjsearch/img/512.png"]\n```';

const OVERVIEW_ANSWER = `**Audit overview** -- the quick answer card renders the fixture context with citations [1, 2] and a short closing line [3].`;

const CLOSING_PROSE = "The fixture search answered the question; the writer can cite these sources as they are.";

/** The mock Browserless page (POST .../content): a small fixture document
    whose headings/list/table survive the reader's markdown extraction --
    the model receives real condensed markdown, the client's call row
    shows a real character count. */
const PAGE_HTML = `<!doctype html>
<html>
<head><title>Audit fixture result #1</title></head>
<body>
<article>
<h1>Audit fixture result #1</h1>
<p>The page reader renders this fixture document in the mock browser and
condenses it to markdown for the model -- the reading pane under the
call row shows exactly this text.</p>
<ul>
<li>headings, lists and emphasis survive extraction</li>
<li>tables condense to GFM</li>
</ul>
<table>
<tr><th>Field</th><th>Value</th></tr>
<tr><td>Kind</td><td>offline fixture</td></tr>
<tr><td>Transport</td><td>mock browserless</td></tr>
</table>
</article>
</body>
</html>`;

/** Split text into token-ish deltas so the client's streaming render path
    (per-chunk state updates, the fence holdback) is really exercised. */
function textPieces(text, size = 7) {
  const out = [];
  for (let i = 0; i < text.length; i += size) {
    out.push({ content: text.slice(i, i + size) });
  }
  return out;
}

function sseChunk(delta, finish = null) {
  return `data: ${JSON.stringify({
    id: "chatcmpl-zjaudit",
    object: "chat.completion.chunk",
    created: 0,
    model: "zjaudit-mock",
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;
}

function streamChunks(res, pieces, finish) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write(sseChunk({ role: "assistant" }));
  for (const piece of pieces) {
    res.write(sseChunk(piece));
  }
  res.write(sseChunk({}, finish));
  // the openai usage contract: a terminal chunk with stream_options
  // include_usage carries the totals (+ the cache/reasoning breakout the
  // run footer renders) and NO choices
  res.write(
    `data: ${JSON.stringify({
      id: "chatcmpl-zjaudit",
      object: "chat.completion.chunk",
      created: 0,
      model: "zjaudit-mock",
      choices: [],
      usage: {
        prompt_tokens: 9876,
        completion_tokens: 7123,
        total_tokens: 16999,
        cache_creation_input_tokens: 1234,
        prompt_tokens_details: { cached_tokens: 3210 },
        completion_tokens_details: { reasoning_tokens: 2444 },
      },
    })}\n\n`,
  );
  res.write("data: [DONE]\n\n");
  res.end();
}

function jsonCompletion(res, obj) {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      id: "chatcmpl-zjaudit",
      object: "chat.completion",
      created: 0,
      model: "zjaudit-mock",
      choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(obj) }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
  );
}

function textOf(message) {
  const content = message?.content;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content.map((part) => String(part?.text ?? "")).join("\n");
  }
  return "";
}

/** The audited page's own question (`<q>zjaudit general</q>`) -- the mock
    searches exactly it, so the fixture engine keys. */
function questionOf(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role !== "user") {
      continue;
    }
    const match = textOf(messages[i]).match(/<q>([\s\S]*?)<\/q>/);
    if (match) {
      return match[1].trim();
    }
  }
  return "";
}

function gate(name, messages, res) {
  if (name === "clarify_gate") {
    jsonCompletion(res, { ask: false, intro: "", questions: [] });
    return;
  }
  if (name === "standalone_question") {
    const question = questionOf(messages)
      .match(/<follow_up>([\s\S]*?)<\/follow_up>/)?.[1]
      ?.trim();
    jsonCompletion(res, { question: question || "" });
    return;
  }
  if (name === "related_questions") {
    jsonCompletion(res, { questions: RELATED });
    return;
  }
  // research_gate and anything unknown: research on (the fail-open verdict)
  jsonCompletion(res, { research: true });
}

function researcher(answered, messages, res) {
  if (answered) {
    // the round after the tool results: STOP researching (no tool calls)
    // -- the writer phase takes over
    streamChunks(res, textPieces(CLOSING_PROSE), "stop");
    return;
  }
  const args = JSON.stringify({ query: questionOf(messages) || "zjaudit general" });
  const half = Math.ceil(args.length / 2);
  const pageArgs = JSON.stringify({ url: "https://example.com/zjaudit/general/1" });
  const pageHalf = Math.ceil(pageArgs.length / 2);
  streamChunks(
    res,
    [
      // reasoning deltas FIRST (multiple pieces -- the think relay must
      // deliver every one of them; a swallowed relay once left the client's
      // think segment holding only the first delta)
      ...textPieces("The request carries a fixture token, so one search and one page read cover it. ", 12).map(
        ({ content }) => ({ reasoning_content: content }),
      ),
      ...textPieces("Reading the request, then opening the fixture page the search will number. "),
      {
        tool_calls: [
          { index: 0, id: "call-zjaudit-1", type: "function", function: { name: "web_search", arguments: "" } },
        ],
      },
      { tool_calls: [{ index: 0, function: { arguments: args.slice(0, half) } }] },
      { tool_calls: [{ index: 0, function: { arguments: args.slice(half) } }] },
      {
        tool_calls: [
          { index: 1, id: "call-zjaudit-2", type: "function", function: { name: "web_reader", arguments: "" } },
        ],
      },
      { tool_calls: [{ index: 1, function: { arguments: pageArgs.slice(0, pageHalf) } }] },
      { tool_calls: [{ index: 1, function: { arguments: pageArgs.slice(pageHalf) } }] },
    ],
    "tool_calls",
  );
}

function route(body, res) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const system = messages
    .filter((m) => m?.role === "system")
    .map((m) => textOf(m))
    .join("\n");
  const schemaName = body.response_format?.json_schema?.name ?? body.response_format?.name;
  if (schemaName) {
    gate(schemaName, messages, res);
    return;
  }
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    researcher(
      messages.some((m) => m?.role === "tool"),
      messages,
      res,
    );
    return;
  }
  if (system.includes("<follow_ups>")) {
    // the gallery fence LEADS the writer's output: the tile then inserts
    // into an answer column that is still empty, so the fixture shifts
    // nothing (a fence that lands below streamed prose displaces it --
    // inherent to the feature, and the exact mid-answer placements stay
    // valid for real models).  The related fence is LAST (the prompt's
    // own ordering rule).
    streamChunks(
      res,
      textPieces(
        `${GALLERY_FENCE}\n\n${WRITER_ANSWER}\n\n\`\`\`related\n${JSON.stringify({ questions: RELATED })}\n\`\`\``,
      ),
    );
    return;
  }
  // the AI Overview: a reasoning segment first (the <think> relay), then
  // the cited answer
  streamChunks(res, [
    ...textPieces("The user asks about the audited query; the numbered context is the fixture set. ", 10).map(
      ({ content }) => ({ reasoning_content: content }),
    ),
    ...textPieces(OVERVIEW_ANSWER),
  ]);
}

export function startAiMock(port = PORT) {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      // the reader's request carries ?token=... — route on the PATH only
      const path = (req.url ?? "").split("?")[0];
      if (req.method === "POST" && path.endsWith("/content")) {
        // the mock Browserless (audit-settings.yml points
        // zjsearch.reader here): the page reader POSTs and reads
        // the body as the rendered HTML
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(PAGE_HTML);
        return;
      }
      if (req.method !== "POST" || !path.endsWith("/chat/completions")) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("not found");
        return;
      }
      let raw = "";
      req.on("data", (chunk) => {
        raw += chunk;
      });
      req.on("end", () => {
        let body = {};
        try {
          body = JSON.parse(raw || "{}");
        } catch {
          // an unparseable body routes as an empty completion
        }
        route(body, res);
      });
    });
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}
