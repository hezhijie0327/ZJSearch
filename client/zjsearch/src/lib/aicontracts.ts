// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

/** The AI-feature CONTRACT types the browser-local storage layer shares
    with the UI (the kb modules must not import from features/ -- the one
    dependency rule this file exists for).  The feature modules
    re-export them, so every existing import path keeps working. */

export interface AiSearchAttachment {
  /** "image" = data URL bytes; "file" = the document (md/txt as TEXT,
      pdf/docx/pptx/xlsx as base64 bytes -- the server converts) */
  kind: "image" | "file";
  mime: string;
  name?: string;
  bytes?: number;
  /** image: the compressed data URL; file: the document's text or its
      base64 bytes -- present in the live run and after the
      attachment-table join, absent from the folded event metadata */
  data?: string;
}

export interface ReportTemplateSection {
  title: string;
  brief: string;
  key_questions: string[];
  /** optional sections drop when the adaptation finds them irrelevant */
  optional?: boolean;
}

/** The output SHAPE a template is written for: "report" = document
    sections, "deck" = presentation chapters (each chapter renders as
    1-4 model-authored slides).  The server adapts either shape, so the
    field drives PICKER FILTERING only -- the request body carries it
    along and the server's whitelist ignores it. */
export type TemplateShape = "report" | "deck";

export interface ReportTemplate {
  /** stable picker id (the ?template= URL param value) */
  id: string;
  name: string;
  sections: ReportTemplateSection[];
  /** which output shape this template is offered for; absent on legacy
      user rows = "report" (the shape the manager shipped with) */
  shape?: TemplateShape;
}
