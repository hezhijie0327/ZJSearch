// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { useEffect, useState } from "react";

/**
 * Thumbnail load state with a 12s hung-request grace timer: `failed`
 * covers missing, broken AND stalled sources (the caller renders its
 * placeholder).  Shared by the grid tiles, the image masonry and the
 * text-card thumbnails.
 */
export function useGraceThumb(src: string | undefined) {
  const [failed, setFailed] = useState(!src);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (loaded || failed) {
      return;
    }
    const timer = window.setTimeout(() => setFailed(true), 12000);
    return () => window.clearTimeout(timer);
  }, [failed, loaded]);
  return { failed, loaded, setFailed, setLoaded };
}
