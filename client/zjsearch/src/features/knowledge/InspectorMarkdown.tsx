// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import type { ReactNode } from "react";
import Markdown from "react-markdown";
import remarkDeflist from "remark-deflist";
import remarkGfm from "remark-gfm";
import { CODE_CHIP } from "@/lib/styles.ts";

/**
 * The knowledge inspector's markdown renderer (overview answers + archived
 * reader full texts): the same element styling language as the AI answer
 * card, minus the citation chips / mermaid machinery the run timeline
 * needs -- [n] stays plain text here (the cited sources live in the 来源
 * corpus one tab over).
 */

const HEADING = "mt-3 text-base font-semibold text-ink first:mt-0";
const CODE_BLOCK = "mt-2 overflow-x-auto rounded-xl bg-surface-2 p-3 font-mono text-xs leading-relaxed text-ink";

type MdProps = { children?: ReactNode; className?: string; href?: string; alt?: string; src?: string };

const components: Record<string, (props: MdProps) => ReactNode> = {
  a: ({ children, href }) => (
    <a
      className="text-accent underline-offset-2 transition-colors hover:text-accent-hover hover:underline"
      href={href}
      rel="noreferrer"
      target="_blank"
    >
      {children}
    </a>
  ),
  blockquote: ({ children }) => (
    <blockquote className="my-2 border-s-2 border-line ps-3 text-ink-2">{children}</blockquote>
  ),
  code: ({ className, children }) =>
    className ? <code className={className}>{children}</code> : <code className={CODE_CHIP}>{children}</code>,
  dd: ({ children }) => <dd className="ms-5 text-ink-2">{children}</dd>,
  dt: ({ children }) => <dt className="mt-2 font-medium text-ink">{children}</dt>,
  h1: ({ children }) => (
    <h3 className={HEADING} dir="auto">
      {children}
    </h3>
  ),
  h2: ({ children }) => (
    <h3 className={HEADING} dir="auto">
      {children}
    </h3>
  ),
  h3: ({ children }) => (
    <h3 className={HEADING} dir="auto">
      {children}
    </h3>
  ),
  h4: ({ children }) => (
    <h4 className="mt-3 text-[13px] font-semibold text-ink first:mt-0" dir="auto">
      {children}
    </h4>
  ),
  hr: () => <hr className="my-3 border-line" />,
  img: ({ alt, src }) => (
    <img alt={alt ?? ""} className="my-2 max-w-full rounded-xl border border-line" loading="lazy" src={src} />
  ),
  li: ({ children }) => (
    <li className="break-words marker:text-accent" dir="auto">
      {children}
    </li>
  ),
  ol: ({ children }) => <ol className="my-2 list-decimal space-y-1 ps-5 first:mt-0">{children}</ol>,
  p: ({ children }) => (
    <p className="my-2 break-words first:mt-0" dir="auto">
      {children}
    </p>
  ),
  pre: ({ children }) => <pre className={CODE_BLOCK}>{children}</pre>,
  table: ({ children }) => (
    <div className="zjs-md-table my-2 overflow-x-auto" dir="auto">
      <table className="w-full border-collapse text-xs">{children}</table>
    </div>
  ),
  td: ({ children }) => <td className="break-words border border-line px-2 py-1 align-top">{children}</td>,
  th: ({ children }) => (
    <th className="break-words border border-line bg-surface-2 px-2 py-1 text-start font-medium text-ink">
      {children}
    </th>
  ),
  ul: ({ children }) => <ul className="my-2 list-disc space-y-1 ps-5 first:mt-0">{children}</ul>,
};

export function InspectorMarkdown({ text }: { text: string }) {
  return (
    <div className="text-[13px] leading-relaxed">
      <Markdown components={components} remarkPlugins={[remarkGfm, remarkDeflist]}>
        {text}
      </Markdown>
    </div>
  );
}
