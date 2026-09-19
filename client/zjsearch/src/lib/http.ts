// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

/**
 * The one fetch wrapper: every page-data / autocompleter / description
 * request goes through here so the `HTTP <status>` error contract, the
 * abort handling and the error shape stay identical everywhere.
 */

class HttpError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`HTTP ${status}`);
    this.name = "HttpError";
    this.status = status;
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
