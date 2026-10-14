// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

/**
 * Shared category vocabulary.  Server categories are open-ended strings
 * (engines declare their own), so there is no closed union type — these
 * constants only pin down the names the client special-cases.
 */

import { cap } from "@/lib/format.ts";
import type { StringKey, Translate } from "@/lib/i18n.ts";

/** Pseudo category of engine-bang searches (`!imdb bat`): the results carry
    their real category and the page inherits its presentation from them. */
export const NO_CATEGORY = "none";

/** In mixed searches the packages results are presented inside the it block. */
export const PACKAGES_BLOCK_CATEGORY = "it";

/** Server group id for engines that fit none of the tab's sub-categories. */
const NO_SUBGROUPING = "without further subgrouping";

/** Localized label for a category id (`cat_<id>` in the i18n catalogs).  The
    theme owns its category labels — the server ships ids only.  Unknown ids
    fall back to the prettified id. */
export function categoryLabel(category: string, t: Translate): string {
  const key = `cat_${category.replaceAll(" ", "_")}` as StringKey;
  const label = t(key);
  return label === key ? cap(category) : label;
}

/** Localized label for an engine subgroup id inside a preferences engine tab. */
export function engineGroupLabel(group: string, t: Translate): string {
  if (group === NO_SUBGROUPING) {
    const label = t("group_unsubgrouped");
    return label === "group_unsubgrouped" ? group : label;
  }
  return categoryLabel(group, t);
}
