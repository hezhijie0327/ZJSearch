// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { LoaderCircle, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Card, SectionLabel } from "@/components/SettingParts.tsx";
import { type ReportTemplate, validateTemplate } from "@/features/results/aiSearch/reportTemplates.ts";
import { useT } from "@/lib/i18n.ts";
import { deleteTemplate, listTemplates, saveTemplate } from "@/lib/kb/templates.ts";

interface EditingTemplate {
  id: string | null;
  name: string;
  sections: Array<{ title: string; brief: string; questions: string; optional: boolean }>;
}

/** The report-template MANAGER (the knowledge drawer's 模板 tab): user
    templates live as PGlite kind=template rows (lib/kb/templates.ts) --
    this edits them with a STRUCTURED form (name + section rows), not a
    JSON dump: add a section, retitle, mark optional, remove.  The saved
    shape is exactly what the request body carries, so an edited template
    and a preset reach the server through the same adaptation gate.  (The
    PICK itself is the run rail's 输出结构 card -- management is library
    work, the pick is a run-time decision.) */
export function TemplateManagerPanel({ onChanged }: { onChanged?: () => void }) {
  const t = useT();
  const [templates, setTemplates] = useState<ReportTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<EditingTemplate | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void listTemplates().then((rows) => {
      if (!cancelled) {
        setTemplates(rows);
        setLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);
  const refresh = () => {
    void listTemplates().then((rows) => {
      setTemplates(rows);
      onChanged?.();
    });
  };
  const remove = (id: string) => {
    void deleteTemplate(id).then(refresh);
  };
  const startNew = () => {
    setError(null);
    setEditing({ id: null, name: "", sections: [{ title: "", brief: "", questions: "", optional: false }] });
  };
  const startEdit = (template: ReportTemplate) => {
    setError(null);
    setEditing({
      id: template.id,
      name: template.name,
      sections: template.sections.map((section) => ({
        title: section.title,
        brief: section.brief,
        questions: section.key_questions.join("、"),
        optional: Boolean(section.optional),
      })),
    });
  };
  const save = () => {
    if (!editing) {
      return;
    }
    const sections = editing.sections
      .map((section) => ({
        title: section.title.trim(),
        brief: section.brief.trim(),
        key_questions: section.questions
          .split(/[、,，]/)
          .map((q) => q.trim())
          .filter(Boolean),
        optional: section.optional,
      }))
      .filter((section) => section.title);
    const template = validateTemplate({ sections }, editing.name);
    if (!template) {
      setError(t("template_invalid"));
      return;
    }
    const persisted = editing.id ? { ...template, id: editing.id } : template;
    void saveTemplate(persisted).then(() => {
      setEditing(null);
      refresh();
    });
  };
  if (editing) {
    return (
      <div className="space-y-6 animate-fade-in">
        <Card>
          <div className="space-y-2.5 px-5 py-4 sm:px-6">
            <input
              className="h-9 w-full rounded-lg border border-line bg-surface px-3 text-[13px] text-ink outline-none focus:border-accent-strong"
              onChange={(event) => {
                setEditing({ ...editing, name: event.target.value });
              }}
              placeholder={t("template_name_ph")}
              value={editing.name}
            />
            {editing.sections.map((section, index) => (
              <div className="space-y-1.5 rounded-xl border border-line p-2.5" key={index}>
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[11px] text-ink-3">{index + 1}</span>
                  <input
                    className="h-8 min-w-0 flex-1 rounded-lg border border-line bg-surface px-2 text-[13px] text-ink outline-none focus:border-accent-strong"
                    onChange={(event) => {
                      const sections = [...editing.sections];
                      sections[index] = { ...section, title: event.target.value };
                      setEditing({ ...editing, sections });
                    }}
                    placeholder={t("template_section_title_ph")}
                    value={section.title}
                  />
                  <button
                    aria-label={t("knowledge_menu_delete")}
                    className="text-xs text-ink-3 transition-colors hover:text-danger"
                    onClick={() => {
                      setEditing({ ...editing, sections: editing.sections.filter((_, i) => i !== index) });
                    }}
                    title={t("knowledge_menu_delete")}
                    type="button"
                  >
                    <Trash2 aria-hidden="true" className="size-3.5" />
                  </button>
                </div>
                <input
                  className="h-8 w-full rounded-lg border border-line bg-surface px-2 text-[13px] text-ink outline-none focus:border-accent-strong"
                  onChange={(event) => {
                    const sections = [...editing.sections];
                    sections[index] = { ...section, brief: event.target.value };
                    setEditing({ ...editing, sections });
                  }}
                  placeholder={t("template_section_brief_ph")}
                  value={section.brief}
                />
                <input
                  className="h-8 w-full rounded-lg border border-line bg-surface px-2 text-[13px] text-ink outline-none focus:border-accent-strong"
                  onChange={(event) => {
                    const sections = [...editing.sections];
                    sections[index] = { ...section, questions: event.target.value };
                    setEditing({ ...editing, sections });
                  }}
                  placeholder={t("template_questions_ph")}
                  value={section.questions}
                />
                <label className="flex items-center gap-1.5 text-xs text-ink-3">
                  <input
                    checked={section.optional}
                    onChange={(event) => {
                      const sections = [...editing.sections];
                      sections[index] = { ...section, optional: event.target.checked };
                      setEditing({ ...editing, sections });
                    }}
                    type="checkbox"
                  />
                  {t("template_optional")}
                </label>
              </div>
            ))}
            <button
              className="inline-flex h-8 items-center rounded-lg border border-line px-3 text-[13px] text-ink-2 transition-colors hover:text-ink disabled:opacity-40"
              disabled={editing.sections.length >= 10}
              onClick={() => {
                setEditing({
                  ...editing,
                  sections: [...editing.sections, { title: "", brief: "", questions: "", optional: false }],
                });
              }}
              type="button"
            >
              <Plus aria-hidden="true" className="me-1 size-3.5" />
              {t("template_add_section")}
            </button>
            {error ? <p className="text-xs text-danger">{error}</p> : null}
            <div className="flex items-center justify-end gap-2 pt-1">
              <button
                className="h-8 rounded-lg border border-line px-3 text-[13px] text-ink-2 transition-colors hover:text-ink"
                onClick={() => {
                  setEditing(null);
                }}
                type="button"
              >
                {t("close")}
              </button>
              <button
                className="h-8 rounded-lg bg-accent-strong px-4 text-[13px] font-medium text-accent-contrast transition-colors hover:bg-accent-strong-hover"
                onClick={save}
                type="button"
              >
                {t("template_save")}
              </button>
            </div>
          </div>
        </Card>
      </div>
    );
  }
  return (
    <div className="space-y-6 animate-fade-in">
      <Card>
        <SectionLabel label={t("template_library")} />
        <button
          className="flex w-full items-center gap-1.5 px-5 py-3 text-[13px] font-medium text-accent transition-colors hover:bg-surface-2/40 sm:px-6"
          onClick={startNew}
          type="button"
        >
          <Plus aria-hidden="true" className="size-3.5" />
          {t("template_new")}
        </button>
        {loading ? (
          <p className="flex items-center gap-2 px-5 py-3 text-[13px] text-ink-3 sm:px-6">
            <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" />
          </p>
        ) : templates.length === 0 ? (
          <p className="px-5 py-3 text-[13px] text-ink-3 sm:px-6">{t("template_none")}</p>
        ) : (
          templates.map((template) => (
            <div
              className="flex items-center gap-2 px-5 py-3 transition-colors hover:bg-surface-2/40 sm:px-6"
              key={template.id}
            >
              <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{template.name}</span>
              <span className="shrink-0 text-xs text-ink-3">
                {template.sections.length} {t("knowledge_tab_sections")}
              </span>
              <button
                className="text-xs text-accent underline-offset-2 hover:underline"
                onClick={() => {
                  startEdit(template);
                }}
                type="button"
              >
                {t("template_edit")}
              </button>
              <button
                aria-label={t("knowledge_menu_delete")}
                className="text-xs text-ink-3 transition-colors hover:text-danger"
                onClick={() => {
                  remove(template.id);
                }}
                title={t("knowledge_menu_delete")}
                type="button"
              >
                <Trash2 aria-hidden="true" className="size-3.5" />
              </button>
            </div>
          ))
        )}
      </Card>
    </div>
  );
}
