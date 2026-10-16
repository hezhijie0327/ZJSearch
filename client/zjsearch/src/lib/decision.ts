// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

/** The browser's decision-model judgments: the server's ``POST
    /zjsearch/ask/decision`` route -- an HMAC-gated proxy to the
    deployment's decision model (one forward pass answering NAMED
    questions about a state: ``choice`` / ``score`` / ``noul``, each with
    its probability, no text generation).  The capability rides the
    page-data globals (`decision`, configured via ``zjsearch.decision``)
    and is handed in once at boot by `configureDecision`.

    Every call returns ``null`` when the feature is unavailable or the
    upstream failed -- the decision-service contract everywhere: a
    decision is a lens, not a dependency.  (The route's wire vocabulary
    -- the question shapes and the MAX_QUESTIONS ceiling -- is the
    server's own; this helper only carries it.) */

import { fetchJson } from "@/lib/http.ts";

export interface DecisionConfig {
  /** the page-data HMAC token of the decision capability */
  token: string;
}

let config: DecisionConfig | null = null;

/** Called once at boot with the page-data capability (null = absent). */
export function configureDecision(cfg: DecisionConfig | null): void {
  config = cfg;
}

export function decisionConfigured(): boolean {
  return config !== null;
}

/** One decision-model judgment: a compact state (text or JSON) plus 1..12
    named questions -- ``{"type": "choice"|"score"|"noul", ...}`` per the
    route's vocabulary -- answers back as ``{name: {choice|score|noul}}``
    with each verdict's distribution.  ``images`` lists picture URLs
    (http/https or data URLs, max 4) for visual judgments: fetched
    server-side and attached as image-1..image-N -- reference them in the
    state by those plain names.  Resolves null when the feature is
    off/unconfigured or the upstream failed. */
export async function decide(
  state: string | Record<string, unknown>,
  questions: Record<string, Record<string, unknown>>,
  images?: string[],
): Promise<{
  answers: Record<string, Record<string, unknown>>;
  usage?: Record<string, unknown> | null;
  latency_ms?: number;
} | null> {
  if (!config || !Object.keys(questions).length) {
    return null;
  }
  try {
    const result = await fetchJson<{
      answers?: Record<string, Record<string, unknown>>;
      usage?: Record<string, unknown> | null;
      latency_ms?: number;
    }>("/zjsearch/ask/decision", {
      body: JSON.stringify({ tk: config.token, state, questions, ...(images?.length ? { images } : {}) }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    if (!result.answers || typeof result.answers !== "object") {
      return null;
    }
    return {
      answers: result.answers,
      usage: result.usage ?? null,
      latency_ms: result.latency_ms,
    };
  } catch {
    return null;
  }
}
