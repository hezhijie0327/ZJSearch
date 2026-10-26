// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { type ComponentProps, useEffect, useRef } from "react";

type NativeTextareaProps = Omit<ComponentProps<"textarea">, "className" | "rows" | "style">;

/**
 * The ask-pane textarea: grows with its content up to `maxHeight` (default
 * 12rem — about eight lines), then scrolls internally.  One line tall at
 * rest, so a short ask renders exactly like the single-line input it
 * replaced; a pasted research brief stays readable instead of hiding in a
 * one-line scroll box.
 */
export function AutoGrowTextarea({
  className = "",
  maxHeight = 192,
  ref,
  value,
  ...rest
}: NativeTextareaProps & {
  className?: string;
  maxHeight?: number;
  /** React 19 ref-as-prop — the callers drive focus/blur/selection */
  ref?: ComponentProps<"textarea">["ref"];
}) {
  const innerRef = useRef<HTMLTextAreaElement | null>(null);
  const setRef = (el: HTMLTextAreaElement | null) => {
    innerRef.current = el;
    if (typeof ref === "function") {
      ref(el);
    } else if (ref) {
      ref.current = el;
    }
  };
  // re-measure after every render (no dependency array on purpose — the
  // pane is controlled, its parent re-renders on every keystroke): collapse
  // to one line, then grow to the content (scrollHeight includes padding,
  // the cap keeps it scrolling)
  useEffect(() => {
    const el = innerRef.current;
    if (!el) {
      return;
    }
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
  });
  return (
    <textarea
      className={`resize-none overflow-y-auto ${className}`}
      ref={setRef}
      rows={1}
      style={{ maxHeight }}
      value={value}
      {...rest}
    />
  );
}
