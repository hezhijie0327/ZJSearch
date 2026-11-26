// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

// KaTeX typography for the math pipeline (lazy-loaded plugins, css is small
// enough to ride the results stylesheet; the woff2 fonts load on demand)
import "katex/dist/katex.min.css";

import { Copy } from "lucide-react";
import { type ReactNode, useEffect, useRef } from "react";
import { useCopyToast } from "@/lib/clipboard.ts";
import { useT } from "@/lib/i18n.ts";
import { HOVER_CHIP } from "@/lib/styles.ts";

/** The capped reasoning scroll area: while the stream runs it keeps the
    newest line in view (no-op once settled or folded). */
/** The streaming ANSWER's bounded pane: the growth lives INSIDE the
    scroll box (tail-follow like the think pane; scrolling back unpins,
    the bottom re-pins) -- an uncapped streaming card sits ABOVE the
    result list and pushed it down on every delta (the audit's CLS
    finding).  The cap matches the settled preview (OVERVIEW_PREVIEW_PX),
    so the settle hands over to ClampReveal without a jump. */
export function AnswerStreamPane({ active, children }: { active: boolean; children: ReactNode }) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pinnedRef = useRef(true);
  // re-follow after every render (no dependency array on purpose — the
  // pane is controlled, its content grows every streamed delta)
  useEffect(() => {
    const el = scrollRef.current;
    if (active && el && pinnedRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  });
  return (
    <div
      className="max-h-56 overflow-y-auto overscroll-contain"
      onScroll={() => {
        const el = scrollRef.current;
        if (el) {
          pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }
      }}
      ref={scrollRef}
    >
      {children}
    </div>
  );
}

export function ThinkScroll({ active, text }: { active: boolean; text: string }) {
  const t = useT();
  const copyToast = useCopyToast();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // tail-follow must not fight the reader: while streaming the tail is
  // followed ONLY until the user scrolls away from it; scrolling back to
  // the bottom re-pins (the classic live-log pattern)
  const pinnedRef = useRef(true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: follow the live stream tail
  useEffect(() => {
    const el = scrollRef.current;
    if (active && el && pinnedRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [active, text]);
  return (
    <div className="group relative">
      <div
        // the machine-voice chrome: the reasoning stream sits on the same
        // boxed ground as the reading pane and the args debug pane -- THINK
        // (12px ink-3 on surface-2) vs CONTENT (14px ink on the plain
        // ground) distinguishes at a glance
        className="max-h-40 overflow-y-auto overscroll-contain rounded-lg bg-surface-2/50 px-3 py-2 whitespace-pre-wrap break-words text-xs leading-relaxed text-ink-3"
        dir="auto"
        onScroll={() => {
          const el = scrollRef.current;
          if (el) {
            pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
          }
        }}
        ref={scrollRef}
      >
        {text.trim()}
      </div>
      {/* the corner copy chip (the CodeBlock pattern): the reasoning is
          feed material the user carries elsewhere */}
      <button
        aria-label={t("copy")}
        className={`absolute end-2 top-2 ${HOVER_CHIP}`}
        onClick={() => {
          copyToast(text.trim());
        }}
        title={t("copy")}
        type="button"
      >
        <Copy aria-hidden="true" className="size-3.5" />
      </button>
    </div>
  );
}
