// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { createRoot } from "react-dom/client";
import { App } from "@/app.tsx";
import { extractPageData, parseBootData, parseClientSettings, parseEmbeddedPageData } from "@/lib/pageData.ts";
import { watchSystemTheme } from "@/lib/theme.ts";
import { type AnyPageData, isErrorPageData, isRedirectPageData } from "@/lib/types.ts";
import "./styles/global.css";

/**
 * Prod: parse the payload embedded by the server shell — #page-data for
 * finished documents, #boot-data for streamed search pages (engines still
 * running, the real payload is pushed later through #page-data).
 * Dev (vite dev server): fetch it through the dev proxy.
 */
async function bootData(): Promise<AnyPageData | null> {
  const embedded = parseEmbeddedPageData() ?? parseBootData();
  if (embedded) {
    return embedded;
  }
  if (import.meta.env.DEV) {
    try {
      const resp = await fetch(window.location.href, { headers: { Accept: "text/html" } });
      return extractPageData(await resp.text());
    } catch {
      return null;
    }
  }
  return null;
}

/** Minimal error screen for the streamed search page: the HTTP status was
    already out when the engines failed, so the failure arrives as a boot
    payload (never rendered inside the router). */
function renderBootError(container: HTMLElement, message: string, instanceName: string): void {
  const box = document.createElement("div");
  box.className = "zjs-boot-error";
  const p = document.createElement("p");
  p.textContent = message;
  const a = document.createElement("a");
  a.href = "/";
  a.textContent = instanceName;
  box.append(p, a);
  container.append(box);
}

async function bootstrap(): Promise<void> {
  const container = document.getElementById("app");
  if (!container) {
    return;
  }
  watchSystemTheme();
  const initialData = await bootData();
  // boot payloads of the streamed search page: handled before the app takes
  // over (the static boot skeleton is still on screen until this point)
  if (initialData && isRedirectPageData(initialData)) {
    window.location.replace(initialData.url);
    return;
  }
  if (initialData && isErrorPageData(initialData)) {
    renderBootError(container, initialData.message, initialData.globals.instance_name);
    return;
  }
  // results boot: pull the (stream-pre-warmed) results chunk before React
  // takes over — the static boot skeleton stays on screen and the first
  // commit already renders the real pending state, keeping the three-way
  // swap static → pending → results gapless
  if (initialData?.globals.page === "results") {
    await import("@/pages/ResultsPage.tsx");
  }
  const settings = parseClientSettings();
  createRoot(container).render(<App initialData={initialData} settings={settings} />);
}

void bootstrap();
