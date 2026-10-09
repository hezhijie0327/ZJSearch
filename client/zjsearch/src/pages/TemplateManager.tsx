// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { Check, LoaderCircle, Pencil, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Card } from "@/components/SettingParts.tsx";
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
export function TemplateManagerPanel({ onChanged, search }: { onChanged?: () => void; search?: string }) {
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
          {/* the band carries the actions: a long form keeps 保存 reachable
              without scrolling to its tail */}
          <div className="flex items-center gap-2 bg-surface-2/60 px-5 py-2.5 sm:px-6">
            <p className="text-xs font-medium text-ink-3">{editing.id ? t("template_edit") : t("template_new")}</p>
            <div className="ms-auto flex items-center gap-2">
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
          <div className="space-y-3 px-5 py-4 sm:px-6">
            <input
              className="h-9 w-full rounded-lg border border-line bg-surface px-3 text-[13px] text-ink outline-none focus:border-accent-strong"
              onChange={(event) => {
                setEditing({ ...editing, name: event.target.value });
              }}
              placeholder={t("template_name_ph")}
              value={editing.name}
            />
            <div className="space-y-2.5">
              {editing.sections.map((section, index) => (
                <div className="space-y-2 rounded-xl border border-line p-3" key={index}>
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[11px] tabular-nums text-ink-3">{index + 1}</span>
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
                      aria-pressed={section.optional}
                      className={`flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] transition-colors ${
                        section.optional
                          ? "border-accent-strong bg-accent-soft text-accent"
                          : "border-line text-ink-3 hover:text-ink"
                      }`}
                      onClick={() => {
                        const sections = [...editing.sections];
                        sections[index] = { ...section, optional: !section.optional };
                        setEditing({ ...editing, sections });
                      }}
                      type="button"
                    >
                      <Check aria-hidden="true" className="size-3" />
                      {t("template_optional_short")}
                    </button>
                    <button
                      aria-label={t("knowledge_menu_delete")}
                      className="grid size-7 shrink-0 place-items-center rounded-full text-ink-3 transition-colors hover:bg-surface-2 hover:text-danger"
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
                </div>
              ))}
            </div>
            <button
              className="flex h-9 w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-line text-[13px] text-ink-3 transition-colors hover:border-accent/50 hover:text-ink disabled:opacity-40"
              disabled={editing.sections.length >= 10}
              onClick={() => {
                setEditing({
                  ...editing,
                  sections: [...editing.sections, { title: "", brief: "", questions: "", optional: false }],
                });
              }}
              type="button"
            >
              <Plus aria-hidden="true" className="size-3.5" />
              {t("template_add_section")}
            </button>
            {error ? <p className="text-xs text-danger">{error}</p> : null}
          </div>
        </Card>
      </div>
    );
  }
  const needle = (search ?? "").trim().toLowerCase();
  const shown = needle ? templates.filter((template) => template.name.toLowerCase().includes(needle)) : templates;
  return (
    <div className="space-y-6 animate-fade-in">
      <Card>
        {/* the band carries the NEW action (a whole row for one button read
            as waste): label left, count + new right */}
        <div className="flex items-center gap-2 bg-surface-2/60 px-5 py-2.5 sm:px-6">
          <p className="text-xs font-medium text-ink-3">{t("template_library")}</p>
          <span className="text-xs tabular-nums text-ink-3">{shown.length}</span>
          <button
            className="ms-auto flex items-center gap-1 text-xs font-medium text-accent transition-colors hover:text-accent-hover"
            onClick={startNew}
            type="button"
          >
            <Plus aria-hidden="true" className="size-3.5" />
            {t("template_new")}
          </button>
        </div>
        {loading ? (
          <p className="flex items-center gap-2 px-5 py-4 text-[13px] text-ink-3 sm:px-6">
            <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" />
          </p>
        ) : shown.length === 0 ? (
          <p className="px-5 py-4 text-[13px] text-ink-3 sm:px-6">
            {templates.length === 0 ? t("template_none") : t("no_results_found")}
          </p>
        ) : (
          <div className="grid gap-2.5 p-3 sm:grid-cols-2">
            {shown.map((template) => (
              <div
                className="group relative flex flex-col gap-1 rounded-xl border border-line bg-surface p-3.5 pe-14 transition-colors hover:border-accent/40"
                key={template.id}
              >
                <div className="flex items-baseline gap-1.5">
                  <span className="min-w-0 truncate text-[13px] font-medium text-ink">{template.name}</span>
                  <span className="shrink-0 text-[11px] tabular-nums text-ink-3">
                    {template.sections.length} {t("knowledge_tab_sections")}
                  </span>
                </div>
                <p className="line-clamp-2 text-[11px] leading-relaxed text-ink-3">
                  {template.sections.map((section) => section.title).join(" / ")}
                </p>
                {/* the actions OVERLAY the top-right corner on hover -- in-flow
                    actions reserved an empty line in every tile */}
                <div className="absolute end-1.5 top-1.5 flex items-center gap-0.5 rounded-full bg-surface/90 p-0.5 opacity-0 shadow-sm transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                  <button
                    aria-label={t("template_edit")}
                    className="grid size-7 place-items-center rounded-full text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink"
                    onClick={() => {
                      startEdit(template);
                    }}
                    title={t("template_edit")}
                    type="button"
                  >
                    <Pencil aria-hidden="true" className="size-3.5" />
                  </button>
                  <button
                    aria-label={t("knowledge_menu_delete")}
                    className="grid size-7 place-items-center rounded-full text-ink-3 transition-colors hover:bg-surface-2 hover:text-danger"
                    onClick={() => {
                      remove(template.id);
                    }}
                    title={t("knowledge_menu_delete")}
                    type="button"
                  >
                    <Trash2 aria-hidden="true" className="size-3.5" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
