// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

/**
 * Custom dropdown menu (no native <select>): Kagi-style panel with a check
 * mark on the active option, full keyboard navigation and outside-click
 * dismissal.
 */

import { Check, ChevronDown } from "lucide-react";
import { type CSSProperties, type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export interface DropdownOption {
  value: string;
  label: string;
  /** optional icon rendered before the label in the menu */
  icon?: ReactNode;
}

export function Dropdown({
  value,
  options,
  onChange,
  ariaLabel,
  align = "start",
  variant = "bare",
  menuClassName = "",
  icon,
  iconOnly = false,
  triggerLabel,
  triggerClassName,
  multiple = false,
  isSelected,
  underline = false,
}: {
  value: string;
  options: DropdownOption[];
  onChange: (value: string) => void;
  ariaLabel?: string;
  /** which edge of the trigger the menu aligns to */
  align?: "start" | "end";
  /** bare: light text trigger (search filters); boxed: bordered control (preferences) */
  variant?: "bare" | "boxed";
  /** show this text on the trigger instead of the selected option label */
  triggerLabel?: string;
  /** extra classes for the trigger (active state styling etc.) */
  triggerClassName?: string;
  /** multi-select menu: picking toggles the option and keeps the menu open;
      option checks come from `isSelected` instead of `value` */
  multiple?: boolean;
  /** bare trigger only: render the tab-style active underline */
  underline?: boolean;
  isSelected?: (value: string) => boolean;
  menuClassName?: string;
  /** optional icon shown before the label in the trigger */
  icon?: ReactNode;
  /** trigger renders only the icon (kebab-style menus) */
  iconOnly?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const rootRef = useRef<HTMLDivElement>(null);
  const current = options.find((option) => option.value === value);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLUListElement>(null);
  const [menuStyle, setMenuStyle] = useState<CSSProperties | null>(null);

  // close on outside clicks (the portaled menu counts as inside)
  useEffect(() => {
    if (!open) {
      return;
    }
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !menuRef.current?.contains(target)) {
        setOpen(false);
      }
    };
    // a fixed-position menu cannot follow its trigger — close on scroll/resize,
    // but let the menu itself scroll (touch users browsing long menus)
    const onMove = (event: Event) => {
      if (menuRef.current?.contains(event.target as Node)) {
        return;
      }
      setOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", onMove);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", onMove);
    };
  }, [open]);

  const openMenu = () => {
    setActive(options.findIndex((option) => option.value === value));
    // the menu renders in a portal (fixed positioning) so overflow-x-auto
    // ancestors — the tab and filter rows — cannot clip it.  The position
    // is clamped so the menu never overflows the viewport (triggers near
    // the right edge would otherwise push it off-screen).
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) {
      const margin = 8;
      const minWidth = Math.max(rect.width, 176);
      const maxLeft = window.innerWidth - minWidth - margin;
      const left = Math.max(margin, Math.min(rect.left, maxLeft));
      setMenuStyle({
        position: "fixed",
        top: rect.bottom + 6,
        ...(align === "end" ? { right: Math.max(margin, window.innerWidth - rect.right) } : { left }),
        minWidth,
        maxWidth: window.innerWidth - margin * 2,
      });
    }
    setOpen(true);
  };

  const pick = (index: number) => {
    const option = options[index];
    if (option) {
      onChange(option.value);
    }
    if (!multiple) {
      setOpen(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (!open) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openMenu();
      }
      return;
    }
    switch (event.key) {
      case "Escape": {
        setOpen(false);
        break;
      }
      case "ArrowDown": {
        event.preventDefault();
        setActive((prev) => (prev + 1) % options.length);
        break;
      }
      case "ArrowUp": {
        event.preventDefault();
        setActive((prev) => (prev <= 0 ? options.length - 1 : prev - 1));
        break;
      }
      case "Enter": {
        event.preventDefault();
        if (active >= 0) {
          pick(active);
        }
        break;
      }
    }
  };

  return (
    <div className="relative" ref={rootRef}>
      <button
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={ariaLabel}
        className={
          iconOnly
            ? `flex size-9 items-center justify-center rounded-full transition-colors ${
                open ? "bg-surface-2 text-ink" : "text-ink-2 hover:bg-surface-2/70 hover:text-ink"
              }`
            : variant === "bare"
              ? `relative flex items-center gap-1.5 rounded-lg px-4 py-2 text-[13px] transition-colors ${
                  open
                    ? "bg-surface-2 text-ink"
                    : (triggerClassName ?? "text-ink-2 hover:bg-surface-2/70 hover:text-ink")
                }`
              : `flex h-9 w-full cursor-pointer items-center justify-between gap-2 rounded-xl border px-3 text-[13px] transition-colors ${
                  open ? "border-ink-3" : "border-line hover:border-ink-3"
                } bg-surface text-ink ${triggerClassName ?? ""}`
        }
        onClick={() => {
          if (open) {
            setOpen(false);
          } else {
            openMenu();
          }
        }}
        onKeyDown={onKeyDown}
        ref={triggerRef}
        role="combobox"
        type="button"
      >
        {icon}
        {iconOnly ? null : <span className="truncate">{triggerLabel ?? current?.label ?? value}</span>}
        {underline && !iconOnly ? (
          <span aria-hidden="true" className="absolute inset-x-4 -bottom-0.5 h-0.5 rounded-full bg-accent-strong" />
        ) : null}
        {iconOnly ? null : (
          <ChevronDown
            aria-hidden="true"
            className={`size-3.5 shrink-0 opacity-70 transition-transform ${open ? "rotate-180" : ""}`}
          />
        )}
      </button>

      {open && menuStyle
        ? createPortal(
            <ul
              aria-label={ariaLabel}
              className={`fixed z-50 max-h-80 overflow-auto rounded-2xl border border-line bg-surface py-1.5 shadow-pop animate-fade-in ${menuClassName}`}
              ref={menuRef}
              role="listbox"
              style={menuStyle}
            >
              {options.map((option, index) => {
                const selected = multiple ? (isSelected?.(option.value) ?? false) : option.value === value;
                return (
                  <li key={option.value}>
                    {/* the option role sits on the button itself: role=option
                        must not nest interactive descendants */}
                    <button
                      aria-selected={selected}
                      className={`flex w-full items-center justify-between gap-4 px-4 py-2 text-left text-[13px] ${
                        index === active ? "bg-surface-2" : ""
                      }`}
                      onClick={() => {
                        pick(index);
                      }}
                      onMouseEnter={() => {
                        setActive(index);
                      }}
                      role="option"
                      type="button"
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        {option.icon ? <span className="shrink-0 text-ink-3">{option.icon}</span> : null}
                        <span className={`truncate ${selected ? "font-medium text-ink" : "text-ink-2"}`}>
                          {option.label}
                        </span>
                      </span>
                      {selected ? <Check className="size-4 shrink-0 text-accent" /> : null}
                    </button>
                  </li>
                );
              })}
            </ul>,
            document.body,
          )
        : null}
    </div>
  );
}
