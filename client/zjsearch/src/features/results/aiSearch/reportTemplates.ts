// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

// The report/deck TEMPLATE PRESETS: fixed outline skeletons the run's
// outline gate must honor ("generate per the template" -- the structure
// is the user's contract, the wording is the desk's).  Preset CONTENT
// lives per catalog tag in lib/i18n/templatePresets.ts (the one home of
// preset wording); templatePresets(tag) resolves the picker's library.
// The SELECTED template rides the run request body as plain JSON and the
// server adapts it to the question (runs/report/outline.py's
// build_outline_from_template) -- the server stays stateless and knows
// no preset registry.  The adaptation pass re-titles every section with
// the question's actual entities in the report's language, so the preset
// wording is guidance material, never verbatim copy.
//
// SHAPE SPLIT: a preset's `shape` fixes the output format it is offered
// for -- "report" sections are document sections, "deck" sections are
// PRESENTATION CHAPTERS (each renders as 1-4 model-authored slides, the
// sub-page content is the model's).  User templates carry the same
// field (set in the manager); legacy rows read as "report".

import { FileText, Presentation } from "lucide-react";
import type { ReportTemplate, ReportTemplateSection, TemplateShape } from "@/lib/aicontracts.ts";
import { TEMPLATE_PRESETS_BY_TAG } from "@/lib/i18n/templatePresets.ts";
import type { CatalogTag } from "@/lib/i18n.ts";

export type { ReportTemplate, ReportTemplateSection, TemplateShape };

/** The locked report/deck ICON split -- every template surface (the
    run rail's picker, the manager's rows and editor) draws the shape
    from HERE so a template never changes icon between surfaces. */
export const TEMPLATE_SHAPE_ICONS = { report: FileText, deck: Presentation } as const;

/** The picker's preset library in the UI locale: the content table lives
    in lib/i18n/templatePresets.ts (one row per shipped catalog tag);
    unknown tags fall back to English (the same two-language rule the
    catalogs follow). */
export function templatePresets(tag: CatalogTag): readonly ReportTemplate[] {
  return TEMPLATE_PRESETS_BY_TAG[tag === "zh-CN" ? "zh-CN" : "en"];
}

/** Validate an arbitrary parsed JSON against the template shape: 2-10
    titled sections; returns the normalized template (a fresh user- id)
    or null.  The structured editor and a pasted JSON both land here. */
export function validateTemplate(value: unknown, name: string, shape: TemplateShape = "report"): ReportTemplate | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const rawSections = (value as { sections?: unknown }).sections;
  if (!Array.isArray(rawSections)) {
    return null;
  }
  const sections: ReportTemplateSection[] = [];
  for (const raw of rawSections.slice(0, 10)) {
    if (typeof raw !== "object" || raw === null) {
      continue;
    }
    const title = String((raw as { title?: unknown }).title ?? "").trim();
    if (!title) {
      continue;
    }
    sections.push({
      title: title.slice(0, 120),
      brief: String((raw as { brief?: unknown }).brief ?? "")
        .trim()
        .slice(0, 300),
      key_questions: Array.isArray((raw as { key_questions?: unknown }).key_questions)
        ? (raw as { key_questions: unknown[] }).key_questions
            .map((q) => String(q).trim().slice(0, 200))
            .filter(Boolean)
            .slice(0, 3)
        : [],
      optional: Boolean((raw as { optional?: unknown }).optional),
    });
  }
  if (sections.length < 2) {
    return null;
  }
  return {
    id: `user-${Date.now().toString(36)}`,
    name: name.trim().slice(0, 40) || "Template",
    shape,
    sections,
  };
}
