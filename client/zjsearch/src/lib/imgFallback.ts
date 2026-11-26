// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

/** The result-thumbnail fallback, hooked (cardParts.Favicon's pattern,
    repo-wide): a failed state seeded from src emptiness and flipped by
    the img's own onError -- remote images die at the source, volatile
    bytes die on replay; every image site renders its own fallback shape
    through this one door.  Returns [isFailed, markFailed]. */
import { useState } from "react";

export function useImgFallback(src: string | undefined | null): [boolean, () => void] {
  const [failed, setFailed] = useState(!src);
  return [failed || !src, () => setFailed(true)];
}
