// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

// User-defined REPORT TEMPLATES: knowledge rows of kind "template" (the
// browser-local PGlite store -- the owner's call: templates live in the
// same store as the research memory, not localStorage).  Body = the
// sections JSON (the exact shape the presets use and the request body
// carries); title = the template's name; search_text = the name.

import type { ReportTemplate, ReportTemplateSection } from "@/lib/aicontracts.ts";
import { pgQuery } from "@/lib/pg.ts";

interface TemplateRow {
  id: string;
  title: string;
  body: string;
}

/** The saved user templates, oldest first (stable picker order). */
export async function listTemplates(): Promise<ReportTemplate[]> {
  const rows = await pgQuery<TemplateRow>(
    "SELECT id, title, body FROM knowledge WHERE kind = 'template' ORDER BY created",
  );
  return (rows ?? []).flatMap((row) => {
    try {
      const sections = JSON.parse(row.body) as ReportTemplateSection[];
      if (!Array.isArray(sections) || sections.length < 2) {
        return [];
      }
      return [{ id: row.id, name: row.title, sections }];
    } catch {
      return [];
    }
  });
}

export async function saveTemplate(template: ReportTemplate): Promise<void> {
  const now = Date.now();
  const id = template.id.startsWith("user-") ? template.id : `tpl:${crypto.randomUUID()}`;
  await pgQuery(
    `INSERT INTO knowledge (id, kind, title, body, status, tags, search_text, created, updated, occurred_at)
     VALUES ($1, 'template', $2, $3, 'done', '[]'::jsonb, $2, $4, $4, $4)
     ON CONFLICT (id) DO UPDATE SET title = $2, body = $3, updated = $4`,
    [id, template.name, JSON.stringify(template.sections), now],
  );
}

export async function deleteTemplate(id: string): Promise<void> {
  await pgQuery("DELETE FROM knowledge WHERE id = $1 AND kind = 'template'", [id]);
}
