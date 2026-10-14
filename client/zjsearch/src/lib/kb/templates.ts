// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

// User-defined REPORT/DECK TEMPLATES: knowledge rows of kind "template"
// (the browser-local PGlite store -- the owner's call: templates live in
// the same store as the research memory, not localStorage).  Body = the
// template JSON {shape, sections} (the exact shape the presets use and
// the request body carries); title = the template's name; search_text =
// the name.  Legacy rows carry a BARE sections array -- they read as
// "report" (the only shape the manager shipped with).

import type { ReportTemplate, ReportTemplateSection, TemplateShape } from "@/lib/aicontracts.ts";
import { pgQuery } from "@/lib/pg.ts";

interface TemplateRow {
  id: string;
  title: string;
  body: string;
}

/** The stored body -> the template: the {shape, sections} object, or a
    legacy bare array (report).  null on anything malformed. */
function parseBody(row: TemplateRow): ReportTemplate | null {
  try {
    const parsed = JSON.parse(row.body) as unknown;
    const rawSections = Array.isArray(parsed)
      ? parsed
      : Array.isArray((parsed as { sections?: unknown }).sections)
        ? (parsed as { sections: ReportTemplateSection[] }).sections
        : null;
    if (!rawSections || rawSections.length < 2) {
      return null;
    }
    const shape: TemplateShape =
      !Array.isArray(parsed) && (parsed as { shape?: unknown }).shape === "deck" ? "deck" : "report";
    return { id: row.id, name: row.title, shape, sections: rawSections };
  } catch {
    return null;
  }
}

/** The saved user templates, oldest first (stable picker order). */
export async function listTemplates(): Promise<ReportTemplate[]> {
  const rows = await pgQuery<TemplateRow>(
    "SELECT id, title, body FROM knowledge WHERE kind = 'template' ORDER BY created",
  );
  return (rows ?? []).flatMap((row) => {
    const template = parseBody(row);
    return template ? [template] : [];
  });
}

export async function saveTemplate(template: ReportTemplate): Promise<void> {
  const now = Date.now();
  const id = template.id.startsWith("user-") ? template.id : `tpl:${crypto.randomUUID()}`;
  const body = JSON.stringify({ shape: template.shape ?? "report", sections: template.sections });
  await pgQuery(
    `INSERT INTO knowledge (id, kind, title, body, status, tags, search_text, created, updated, occurred_at)
     VALUES ($1, 'template', $2, $3, 'done', '[]'::jsonb, $2, $4, $4, $4)
     ON CONFLICT (id) DO UPDATE SET title = $2, body = $3, updated = $4`,
    [id, template.name, body, now],
  );
}

export async function deleteTemplate(id: string): Promise<void> {
  await pgQuery("DELETE FROM knowledge WHERE id = $1 AND kind = 'template'", [id]);
}
