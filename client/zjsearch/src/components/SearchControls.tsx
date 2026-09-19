// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { Clock, Ellipsis, Languages, Shield } from "lucide-react";
import { type ReactNode, useLayoutEffect, useRef } from "react";
import { CategoryIcon } from "@/components/CategoryIcon.tsx";
import { CategoryTab } from "@/components/CategoryTab.tsx";
import type { DropdownOption } from "@/components/Dropdown.tsx";
import { Dropdown } from "@/components/Dropdown.tsx";
import { categoryLabel } from "@/lib/categories.ts";
import { languageOptions, useT } from "@/lib/i18n.ts";
import { scrollBehavior } from "@/lib/motion.ts";
import { useSettings } from "@/lib/settings.ts";
import { SCROLLBAR_NONE } from "@/lib/styles.ts";
import type { GlobalData } from "@/lib/types.ts";

interface CategoryTabsProps {
  globals: GlobalData;
  selected: string[];
  /** multi-selection changes (toggle) must reach the parent so that
      query submits (Enter / search box) use the up-to-date selection */
  onSelectionChange?: (categories: string[]) => void;
  onSearch: (categories: string[]) => void;
  /** wrap onto multiple lines (index hero) instead of scrolling one row */
  wrap?: boolean;
}

/**
 * Category pills.  With `search_on_category_select` a plain click immediately
 * searches the clicked category, shift+click toggles multi-selection.
 * Otherwise it behaves like toggling checkboxes and the magnifier submits.
 * Every category is laid out flat - narrow viewports scroll the row.
 */
export function CategoryTabs({ globals, selected, onSelectionChange, onSearch, wrap = false }: CategoryTabsProps) {
  const t = useT();
  const settings = useSettings();
  const scrollerRef = useRef<HTMLDivElement>(null);

  // Keep the active tab in view on narrow screens: landing on a category
  // whose tab sits beyond the first viewport-width otherwise reads as
  // "nothing selected".  Centering is a no-op while the row fits.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-center when the selection changes
  useLayoutEffect(() => {
    if (wrap) {
      return;
    }
    scrollerRef.current
      ?.querySelector('button[aria-pressed="true"]')
      ?.scrollIntoView({ block: "nearest", inline: "center", behavior: scrollBehavior() });
  }, [wrap, selected]);

  const toggle = (category: string) => {
    const next = selected.includes(category) ? selected.filter((item) => item !== category) : [...selected, category];
    onSelectionChange?.(next.length > 0 ? next : [globals.default_category]);
  };

  const onClick = (category: string, event: React.MouseEvent) => {
    if (event.shiftKey || !settings.search_on_category_select) {
      toggle(category);
      return;
    }
    onSearch([category]);
  };

  const tabs = globals.categories_as_tabs.length > 0 ? globals.categories_as_tabs : globals.categories;
  // config order decides visibility: up to seven tabs lay out flat (a
  // "more" trigger would only waste a slot); beyond that the first six stay
  // visible and the rest folds into the "more" menu.  When a folded
  // category is the active selection the trigger itself shows its name,
  // Google-style.
  const FLAT_TAB_LIMIT = 7;
  const visibleTabs = tabs.length <= FLAT_TAB_LIMIT ? tabs : tabs.slice(0, FLAT_TAB_LIMIT - 1);
  const overflowTabs = tabs.length <= FLAT_TAB_LIMIT ? [] : tabs.slice(FLAT_TAB_LIMIT - 1);
  const foldedSelected = overflowTabs.filter((category) => selected.includes(category));
  const label = (category: string) => categoryLabel(category, t);
  // trigger mirrors the folded selection: "更多" -> "科学" -> "科学 +1" (the
  // same +N language as the engine pills), accent while anything is selected
  const firstFolded = foldedSelected[0];
  const moreLabel =
    firstFolded === undefined
      ? t("more")
      : foldedSelected.length === 1
        ? label(firstFolded)
        : `${label(firstFolded)} +${foldedSelected.length - 1}`;

  const overflowPick = (value: string) => {
    if (settings.search_on_category_select) {
      onSearch([value]);
      return;
    }
    toggle(value);
  };

  return (
    <div className="flex items-center py-1">
      <div
        className={`min-w-0 flex flex-wrap items-center gap-x-1 gap-y-0.5 ${
          wrap
            ? "ps-2"
            : "-ms-4 sm:flex-nowrap sm:gap-y-0 sm:overflow-x-auto sm:pb-0.5 sm:[scrollbar-width:none] sm:[&::-webkit-scrollbar]:hidden sm:[&>*]:shrink-0"
        }`}
        ref={scrollerRef}
      >
        {visibleTabs.map((category) => (
          <CategoryTab
            category={category}
            key={category}
            label={label(category)}
            onClick={(event) => {
              onClick(category, event);
            }}
            selected={selected.includes(category)}
            title={settings.search_on_category_select ? undefined : t("search")}
          />
        ))}
        {overflowTabs.length > 0 ? (
          <Dropdown
            align="start"
            ariaLabel={t("more")}
            icon={
              firstFolded ? (
                <CategoryIcon category={firstFolded} className="size-3.5 shrink-0" />
              ) : (
                <Ellipsis className="size-3.5 shrink-0" />
              )
            }
            isSelected={(category) => selected.includes(category)}
            multiple={!settings.search_on_category_select}
            onChange={overflowPick}
            options={overflowTabs.map((category) => ({
              value: category,
              label: label(category),
              icon: <CategoryIcon category={category} className="size-3.5 shrink-0" />,
            }))}
            triggerClassName={foldedSelected.length > 0 ? "font-medium text-accent" : "text-ink-2 hover:text-ink"}
            triggerLabel={moreLabel}
            underline={foldedSelected.length > 0}
            value={foldedSelected[0] ?? ""}
          />
        ) : null}
      </div>
    </div>
  );
}

export interface FilterValues {
  language: string;
  time_range: string;
  safesearch: number;
  search_language?: string;
}

function SelectField({
  label,
  icon,
  value,
  options,
  onChange,
}: {
  label: string;
  icon?: ReactNode;
  value: string;
  options: DropdownOption[];
  onChange: (value: string) => void;
}) {
  return <Dropdown ariaLabel={label} icon={icon} onChange={onChange} options={options} value={value} />;
}

export function SearchFilters({
  globals,
  values,
  onChange,
}: {
  globals: GlobalData;
  values: FilterValues;
  onChange: (next: Partial<FilterValues>) => void;
}) {
  const t = useT();

  return (
    // single line at every width - narrow viewports scroll the row, exactly
    // like the category tab row above it; -ms-4 cancels the triggers' ps-4 so
    // their icons stay aligned with the tab icons and the meta line below
    <div className={`-ms-4 flex items-center gap-1 overflow-x-auto ${SCROLLBAR_NONE} [&>*]:shrink-0`}>
      <SelectField
        icon={<Languages className="size-3.5 shrink-0" />}
        label={t("search_language")}
        onChange={(language) => onChange({ language })}
        options={languageOptions(globals.locales, t, values.search_language || undefined)}
        value={values.language}
      />

      <SelectField
        icon={<Clock className="size-3.5 shrink-0" />}
        label={t("time_range")}
        onChange={(time_range) => {
          onChange({ time_range });
        }}
        options={[
          { value: "", label: t("anytime") },
          { value: "day", label: t("last_day") },
          { value: "week", label: t("last_week") },
          { value: "month", label: t("last_month") },
          { value: "year", label: t("last_year") },
        ]}
        value={values.time_range}
      />

      <SelectField
        icon={<Shield className="size-3.5 shrink-0" />}
        label={t("safesearch")}
        onChange={(value) => {
          onChange({ safesearch: Number(value) });
        }}
        options={[
          { value: "2", label: `${t("safesearch")}: ${t("strict")}` },
          { value: "1", label: `${t("safesearch")}: ${t("moderate")}` },
          { value: "0", label: `${t("safesearch")}: ${t("none")}` },
        ]}
        value={String(values.safesearch)}
      />
    </div>
  );
}

/** Filter values for a page that has no search payload yet (index page). */
export function defaultFilterValues(globals: GlobalData): FilterValues {
  return { language: globals.language || "all", time_range: "", safesearch: globals.safesearch };
}
