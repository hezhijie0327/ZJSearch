// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { useEffect, useRef } from "react";
import { useT } from "@/lib/i18n.ts";

export function InfiniteScrollSentinel({
  onNext,
  error,
  loading,
}: {
  onNext: () => void;
  error: boolean;
  loading: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const t = useT();
  useEffect(() => {
    const el = ref.current;
    if (!el) {
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          onNext();
        }
      },
      { rootMargin: "320px" },
    );
    observer.observe(el);
    return () => {
      observer.disconnect();
    };
  }, [onNext]);

  if (error) {
    return <p className="py-4 text-center text-sm text-danger">{t("error_loading_next_page")}</p>;
  }
  return (
    <div aria-busy={loading} className="flex justify-center py-6" ref={ref}>
      {/* the spinner only spins while a page is actually loading — an idle
          sentinel stays a quiet spacer so the eye isn't teased by a fake
          progress indicator */}
      {loading ? (
        <div className="size-6 animate-spin-slow rounded-full border-2 border-line border-t-accent-strong" />
      ) : null}
    </div>
  );
}
