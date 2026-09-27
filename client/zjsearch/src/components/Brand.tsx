// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { Link } from "@/components/Shell.tsx";
import type { GlobalData } from "@/lib/types.ts";

/** The geometric gold period that closes the wordmark (DESIGN.md §2.2) —
    one definition for every surface that typesets the brand (header rows,
    hero). `em`-sized so it scales with the wordmark it closes. */
export function BrandDot() {
  return <span aria-hidden="true" className="ms-0.5 inline-block size-[0.25em] rounded-full bg-accent-strong" />;
}

/** The header wordmark: instance name + BrandDot, linking home. The size
    lives in the caller's className (results header 2xl, AI takeover xl). */
export function Brand({
  globals,
  className,
}: {
  globals: GlobalData;
  /** font size / tracking tier of the wordmark text */
  className: string;
}) {
  return (
    <Link
      ariaLabel={globals.instance_name}
      className={`shrink-0 select-none font-serif font-semibold tracking-tight text-ink ${className}`}
      href="/"
      title={globals.instance_name}
    >
      {globals.instance_name}
      <BrandDot />
    </Link>
  );
}
