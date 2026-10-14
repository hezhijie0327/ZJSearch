// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { ArrowUp } from "lucide-react";
import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n.ts";
import { animateScroll } from "@/lib/motion.ts";
import { useExitPresence } from "@/lib/useExitPresence.ts";

export function BackToTop() {
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
      className={`zjs-print-hide fixed bottom-6 right-6 z-40 grid size-10 place-items-center rounded-full border border-line bg-surface text-ink-2 shadow-pop transition-colors hover:text-accent ${
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
