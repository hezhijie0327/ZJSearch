// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

/**
 * The one fetch wrapper: every page-data / autocompleter / description
 * request goes through here so the `HTTP <status>` error contract, the
 * abort handling and the error shape stay identical everywhere.
 */

class HttpError extends Error {
  readonly status: number;
  /** truncated response body of the failed request, when the caller reads
      it (fetchStream does — the AI endpoint answers errors with a reason) */
  readonly detail: string;

  constructor(status: number, detail = "") {
    super(detail ? `HTTP ${status}: ${detail}` : `HTTP ${status}`);
    this.name = "HttpError";
    this.status = status;
    this.detail = detail;
  }
}

async function request(url: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new HttpError(response.status);
  }
  return response;
}

export async function fetchText(url: string, init?: RequestInit): Promise<string> {
  return (await request(url, init)).text();
}

export async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  return (await request(url, init)).json() as Promise<T>;
}

/** Streaming POST: JSON body in, plain-text chunks out (the AI summary
    endpoint).  HTTP errors keep the `HTTP <status>` contract and carry a
    truncated body excerpt as the error detail (the endpoint answers
    failures with a plain-text upstream reason); body chunks are decoded
    incrementally and flushed at the end of the stream. */
export async function fetchStream(
  url: string,
  body: unknown,
  onChunk: (text: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(url, {
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
    method: "POST",
    signal,
  });
  if (!response.ok || !response.body) {
    const detail = await response
      .text()
      .then((text) => text.replace(/\s+/g, " ").trim().slice(0, 240))
      .catch(() => "");
    throw new HttpError(response.status, detail);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      onChunk(decoder.decode(value, { stream: true }));
    }
  } finally {
    decoder.decode();
  }
}
