// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { LoaderCircle, Search, X } from "lucide-react";
import { type FormEvent, type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { fetchJson } from "@/lib/http.ts";
import { useT } from "@/lib/i18n.ts";
import { useRouter } from "@/lib/router.tsx";
import { useSettings } from "@/lib/settings.ts";
import { ICON_BTN } from "@/lib/styles.ts";
import { useExitPresence } from "@/lib/useExitPresence.ts";

interface Suggestion {
  text: string;
}

async function fetchSuggestions(q: string, signal: AbortSignal): Promise<string[]> {
  // silent failure by design: suggestions are best-effort
  try {
    // absolute path: the box also renders on nested routes (info pages),
    // where a relative URL would resolve against the current directory
    const payload = await fetchJson<unknown>(`/autocompleter?q=${encodeURIComponent(q)}`, { signal });
    // server answers with [prefix, [suggestions], [], [], relevances] or a plain array
    if (Array.isArray(payload) && Array.isArray(payload[1])) {
      return (payload[1] as unknown[]).filter((item): item is string => typeof item === "string");
    }
    if (Array.isArray(payload)) {
      return payload.filter((item): item is string => typeof item === "string");
    }
  } catch {
    /* aborted or failed - keep previous suggestions */
  }
  return [];
}

export function SearchBox({
  initialQuery,
  query: controlledQuery,
  onQueryChange,
  variant = "compact",
  onSubmitQuery,
}: {
  initialQuery: string;
  /** Optional controlled mode (used on the index page). */
  query?: string;
  onQueryChange?: (q: string) => void;
  variant?: "hero" | "compact";
  onSubmitQuery: (q: string) => void;
}) {
  const t = useT();
  const { loading } = useRouter();
  const settings = useSettings();
  const listboxId = useId();
  const [innerQuery, setInnerQuery] = useState(initialQuery);
  const query = controlledQuery ?? innerQuery;
  /** the text the user actually typed — the autocomplete baseline and the
      restore point when arrow-key navigation wraps back past the list */
  const [typed, setTyped] = useState(initialQuery);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  const setQuery = (value: string) => {
    setInnerQuery(value);
    onQueryChange?.(value);
  };

  // keep the input in sync with server-provided queries (back/forward)
  useEffect(() => {
    setInnerQuery(initialQuery);
    setTyped(initialQuery);
  }, [initialQuery]);

  // debounced autocompleter — keyed on the TYPED text: arrow-key navigation
  // rewrites the input with suggestion texts and must not re-fetch
  useEffect(() => {
    if (!settings.autocomplete) {
      return;
    }
    const trimmed = typed.trim();
    if (trimmed.length < (settings.autocomplete_min || 2)) {
      setSuggestions([]);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void fetchSuggestions(trimmed, controller.signal)
        .then((items) => {
          setSuggestions(items.map((text) => ({ text })));
          setActive(-1);
        })
        .catch(() => {
          /* aborted or failed - keep previous suggestions */
        });
    }, 300);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [typed, settings.autocomplete, settings.autocomplete_min]);

  // close the dropdown on outside clicks
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!boxRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
    };
  }, []);

  const submit = (value: string) => {
    const trimmed = value.trim();
    setOpen(false);
    inputRef.current?.blur();
    if (trimmed) {
      onSubmitQuery(trimmed);
    }
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    submit(query);
  };

  /** select the completion part of a navigated-to suggestion (Google
      behaviour): the typed prefix stays free, continued typing replaces the
      selected suffix; restoring the typed text puts the caret at the end */
  const selectCompletion = (text: string) => {
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (el && document.activeElement === el) {
        el.setSelectionRange(typed.length, text.length);
      }
    });
  };

  /** ArrowDown/Up walk suggestions.length + 1 slots: the +1 slot is the
      typed query itself, so navigating past the ends lands back on what
      the user typed (Google behaviour). */
  const navigateSelection = (delta: 1 | -1) => {
    const count = suggestions.length + 1;
    if (count <= 1) {
      return;
    }
    const slot = (((active + delta) % count) + count) % count;
    if (slot === suggestions.length) {
      setActive(-1);
      setQuery(typed);
      selectCompletion(typed);
      return;
    }
    const suggestion = suggestions[slot];
    if (!suggestion) {
      return;
    }
    setActive(slot);
    setQuery(suggestion.text);
    selectCompletion(suggestion.text);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // IME composition (e.g. pinyin candidates) owns Enter and the arrows —
    // handling them here would submit mid-composition or break candidate
    // navigation
    if (event.nativeEvent.isComposing) {
      return;
    }
    if (event.key === "Enter") {
      // some embedded browsers never run the implicit form submission, so
      // Enter is always handled explicitly here
      event.preventDefault();
      if (open && active >= 0 && suggestions[active]) {
        const selected = suggestions[active];
        setQuery(selected.text);
        submit(selected.text);
      } else {
        setOpen(false);
        submit(query);
      }
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      navigateSelection(1);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      navigateSelection(-1);
      return;
    }
    if (!open || suggestions.length === 0) {
      return;
    }
    if (event.key === "Escape") {
      // restore the typed query first (a selection rewrites the input)
      if (active >= 0) {
        setActive(-1);
        setQuery(typed);
      }
      setOpen(false);
      return;
    }
  };

  const showDropdown = open && suggestions.length > 0;
  /** the navigated suggestion split for the ghost layer: typed prefix solid,
      completion muted (null when no suggestion is actively selected, or the
      suggestion doesn't extend the typed prefix — then nothing is ghosted
      and the input keeps its plain ink text) */
  const ghost =
    open && active >= 0 && suggestions[active]?.text.startsWith(typed)
      ? { typed, completion: suggestions[active].text.slice(typed.length) }
      : null;
  // the list stays mounted through its fade-out window; render the last
  // non-empty suggestion set so a mid-exit fetch clearing `suggestions`
  // cannot collapse the fading panel into an empty bordered box
  const { render: renderSuggest, closing: suggestClosing } = useExitPresence(showDropdown);
  const lastSuggestions = useRef(suggestions);
  if (suggestions.length > 0) {
    lastSuggestions.current = suggestions;
  }
  const exitSuggestions = lastSuggestions.current;

  return (
    <div className="relative w-full" ref={boxRef}>
      <form
        className={`flex w-full items-center gap-1 rounded-full border border-line bg-surface transition-shadow ${
          variant === "hero"
            ? "h-14 ps-6 pe-2.5 shadow-card focus-within:border-ink-3/40 focus-within:shadow-pop"
            : "h-12 ps-5 pe-2 shadow-card focus-within:border-ink-3/40"
        }`}
        onSubmit={onSubmit}
        role="search"
      >
        <div className="relative min-w-0 flex-1">
          {/* ghost layer for the navigated suggestion: the typed prefix keeps
              its ink colour, the completion renders muted — a purely visual
              "this part is the suggestion" cue (the real input's text is
              transparent while the ghost shows; the caret stays visible via
              caret-ink).  whitespace-pre + same font metrics keep the mirror
              aligned with the input's single line. */}
          {ghost ? (
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 flex items-center overflow-hidden whitespace-pre text-base"
            >
              <span className="text-ink">{ghost.typed}</span>
              <span className="text-ink-3">{ghost.completion}</span>
            </div>
          ) : null}
          <input
            aria-activedescendant={active >= 0 && suggestions[active] ? `${listboxId}-${active}` : undefined}
            aria-autocomplete="list"
            aria-controls={showDropdown ? listboxId : undefined}
            aria-expanded={showDropdown}
            aria-label={t("search")}
            autoCapitalize="none"
            autoComplete="off"
            className={`relative w-full bg-transparent text-base outline-none placeholder:text-ink-3 ${
              ghost ? "text-transparent caret-ink selection:bg-transparent" : ""
            }`}
            dir="auto"
            name="q"
            onChange={(event) => {
              const value = event.target.value;
              setQuery(value);
              setTyped(value);
              setActive(-1); // fresh typing clears the suggestion selection
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            onKeyDown={onKeyDown}
            placeholder={t("search_placeholder")}
            ref={inputRef}
            role="combobox"
            spellCheck={false}
            type="text"
            value={query}
          />
        </div>
        {query ? (
          <button
            aria-label={t("clear")}
            className={ICON_BTN}
            onClick={() => {
              setQuery("");
              inputRef.current?.focus();
            }}
            type="button"
          >
            <X className="size-4.5" />
          </button>
        ) : null}
        <button
          aria-label={t("search")}
          className="grid size-9 shrink-0 place-items-center rounded-full bg-accent-strong text-accent-contrast transition-colors hover:bg-accent-strong-hover disabled:opacity-70"
          disabled={loading}
          type="submit"
        >
          {loading ? <LoaderCircle className="size-4.5 animate-spin-slow" /> : <Search className="size-4.5" />}
        </button>
      </form>

      {renderSuggest && exitSuggestions.length > 0 ? (
        <ul
          aria-label={t("search_suggestions")}
          className={`absolute inset-x-0 top-full z-30 mt-2 max-h-80 overflow-auto rounded-2xl border border-line bg-surface py-1.5 shadow-pop ${
            suggestClosing ? "pointer-events-none animate-fade-out" : "animate-fade-in"
          }`}
          id={listboxId}
          inert={suggestClosing || undefined}
          role="listbox"
        >
          {exitSuggestions.map((suggestion, index) => (
            <li key={suggestion.text}>
              {/* option role on the button: role=option must not nest
                  interactive descendants (activedescendant targets this id) */}
              <button
                aria-selected={index === active}
                className={`flex w-full items-center gap-2.5 px-4 py-2 text-left text-[13px] ${
                  index === active ? "bg-surface-2" : ""
                } hover:bg-surface-2/70`}
                id={`${listboxId}-${index}`}
                onMouseDown={(event) => {
                  // prevent blur before submit
                  event.preventDefault();
                  setQuery(suggestion.text);
                  submit(suggestion.text);
                }}
                onMouseEnter={() => {
                  setActive(index);
                }}
                role="option"
                type="button"
              >
                <Search className="size-3.5 shrink-0 text-ink-3" />
                <span className="truncate" dir="auto">
                  {suggestion.text}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
