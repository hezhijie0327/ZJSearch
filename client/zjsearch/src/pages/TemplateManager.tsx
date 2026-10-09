// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { LoaderCircle, Plus, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { type ReportTemplate, validateTemplate } from "@/features/results/aiSearch/reportTemplates.ts";
import { useDialogFocus } from "@/lib/dialogFocus.ts";
import { useT } from "@/lib/i18n.ts";
import { deleteTemplate, listTemplates, saveTemplate } from "@/lib/kb/templates.ts";
import { ICON_BTN } from "@/lib/styles.ts";

interface EditingTemplate {
  id: string | null;
  name: string;
  sections: Array<{ title: string; brief: string; questions: string; optional: boolean }>;
}

/** The report-template MANAGER (the hero's 管理模板 dialog): user
    templates live as PGlite kind=template rows (lib/kb/templates.ts) --
    this edits them with a STRUCTURED form (name + section rows), not a
    JSON dump: add a section, retitle, mark optional, remove.  The saved
    shape is exactly what the request body carries, so an edited template
    and a preset reach the server through the same adaptation gate. */
export function TemplateManagerDialog({
  closing,
  onChanged,
  onClose,
}: {
  closing: boolean;
  onChanged: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const dialogRef = useDialogFocus<HTMLDivElement>(!closing);
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
      onChanged();
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
  return (
    <div
      aria-hidden={closing}
      className="fixed inset-0 z-[70] grid animate-fade-in place-items-center bg-black/60 p-4"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          onClose();
        }
      }}
      role="presentation"
    >
      <div
        aria-modal="true"
        className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-line bg-surface p-5 shadow-card"
        onMouseDown={(event) => {
          event.stopPropagation();
        }}
        ref={dialogRef}
        role="dialog"
      >
        <div className="flex items-center gap-2">
          <span className="text-base font-semibold text-ink">
            {editing ? t("template_edit") : t("template_manager")}
          </span>
          <button
            aria-label={t("close")}
            className={ICON_BTN + " ms-auto"}
            data-dialog-close=""
            onClick={onClose}
            type="button"
          >
            <X aria-hidden="true" className="size-4" />
          </button>
        </div>
        {editing ? (
          <div className="mt-3 space-y-2.5">
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
                    className="text-xs text-ink-3 transition-colors hover:text-danger"
                    onClick={() => {
                      setEditing({ ...editing, sections: editing.sections.filter((_, i) => i !== index) });
                    }}
                    title={t("close")}
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
        ) : (
          <div className="mt-3">
            <button
              className="mb-2 inline-flex h-8 items-center rounded-lg bg-accent-strong px-3 text-[13px] font-medium text-accent-contrast transition-colors hover:bg-accent-strong-hover"
              onClick={startNew}
              type="button"
            >
              <Plus aria-hidden="true" className="me-1 size-3.5" />
              {t("template_new")}
            </button>
            {loading ? (
              <p className="flex items-center gap-2 py-3 text-[13px] text-ink-3">
                <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" />
              </p>
            ) : templates.length === 0 ? (
              <p className="py-3 text-[13px] text-ink-3">{t("template_none")}</p>
            ) : (
              <ul className="divide-y divide-line">
                {templates.map((template) => (
                  <li className="flex items-center gap-2 py-2" key={template.id}>
                    <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{template.name}</span>
                    <span className="shrink-0 text-xs text-ink-3">{template.sections.length}</span>
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
                      className="text-xs text-ink-3 transition-colors hover:text-danger"
                      onClick={() => {
                        remove(template.id);
                      }}
                      title={t("close")}
                      type="button"
                    >
                      <Trash2 aria-hidden="true" className="size-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
