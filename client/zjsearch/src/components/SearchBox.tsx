// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { LoaderCircle, Search, X } from "lucide-react";
import { type FormEvent, type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { fetchJson } from "@/lib/http.ts";
import { useT } from "@/lib/i18n.ts";
import { useRouter } from "@/lib/router.tsx";
import { useSettings } from "@/lib/settings.ts";
import { ICON_BTN } from "@/lib/styles.ts";

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
  }, [initialQuery]);

  // debounced autocompleter
  useEffect(() => {
    if (!settings.autocomplete) {
      return;
    }
    const trimmed = query.trim();
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
  }, [query, settings.autocomplete, settings.autocomplete_min]);

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

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
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
    if (!open || suggestions.length === 0) {
      return;
    }
    if (event.key === "Escape") {
      setOpen(false);
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((prev) => (prev + 1) % suggestions.length);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((prev) => (prev <= 0 ? suggestions.length - 1 : prev - 1));
    }
  };

  const showDropdown = open && suggestions.length > 0;

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
        <input
          aria-activedescendant={active >= 0 && suggestions[active] ? `${listboxId}-${active}` : undefined}
          aria-autocomplete="list"
          aria-controls={showDropdown ? listboxId : undefined}
          aria-expanded={showDropdown}
          aria-label={t("search")}
          autoCapitalize="none"
          autoComplete="off"
          className="min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-ink-3"
          dir="auto"
          name="q"
          onChange={(event) => {
            setQuery(event.target.value);
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

      {showDropdown ? (
        <ul
          aria-label={t("search_suggestions")}
          className="absolute inset-x-0 top-full z-30 mt-2 max-h-80 overflow-auto rounded-2xl border border-line bg-surface py-1.5 shadow-pop animate-fade-in"
          id={listboxId}
          role="listbox"
        >
          {suggestions.map((suggestion, index) => (
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
