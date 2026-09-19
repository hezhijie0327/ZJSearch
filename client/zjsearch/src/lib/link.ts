// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

/** target/rel attributes for outbound links, following the
    "open results in new tabs" preference (Shell nav, results, infobox
    urls, answers' sources — everywhere an external link is rendered). */
export function newTabLinkProps(onNewTab: boolean | undefined): { target?: string; rel: string } {
  return onNewTab ? { target: "_blank", rel: "noopener noreferrer" } : { rel: "noreferrer" };
}

/** True when the click carries a modifier (new tab / window) or is not a
    plain left click — SPA link handlers must let the browser take over. */
export function isModifiedClick(event: {
  altKey: boolean;
  button: number;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}): boolean {
  return event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0;
}

/** Hostname of an arbitrary URL for compact source labels; a malformed URL
    (plain-text "url" the server could not parse) is shown as-is. */
export function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}
