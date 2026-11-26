// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { ArrowUp } from "lucide-react";
import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n.ts";
import { animateScroll } from "@/lib/motion.ts";
import { useExitPresence } from "@/lib/useExitPresence.ts";

/** The floating back-to-top chip -- PAGE-PRIVATE (this page is the only
    consumer; DESIGN.md §12 folds single-consumer components into their
    page).  The scroll watcher, the exit-presence fade and the animated
    scroll all ride the shared lib pieces.  `overChrome`: the AI page's
    floating bottom chrome (the follow-up composer, the browser wait
    bar) occupies this corner below lg -- the chip stands down there and
    stays lg+ only while such chrome lives (on lg+ the composer confines
    left of the sources rail, the wait bar never renders). */
export function BackToTop({ overChrome = false }: { overChrome?: boolean }) {
  const t = useT();
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const onScroll = () => {
      setShown(window.scrollY > 400);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
    };
  }, []);
  // the floating chip plays its -out animation instead of vanishing
  const { render: renderChip, closing } = useExitPresence(shown);
  if (!renderChip) {
    return null;
  }
  return (
    <button
      aria-label={t("back_to_top")}
      className={`zjs-print-hide fixed bottom-6 right-6 z-40 ${overChrome ? "hidden lg:grid" : "grid"} size-10 place-items-center rounded-full border border-line bg-surface text-ink-2 shadow-pop transition-colors hover:text-accent ${
        closing ? "animate-fade-out" : "animate-fade-in"
      }`}
      onClick={() => {
        animateScroll(window, { top: 0 });
      }}
      type="button"
    >
      <ArrowUp className="size-5" />
    </button>
  );
}
