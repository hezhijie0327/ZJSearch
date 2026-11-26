// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import type { MouseEvent, ReactNode } from "react";
import { isModifiedClick, newTabLinkProps } from "@/lib/link.ts";
import { useRouter } from "@/lib/router.tsx";

/** Anchor that performs SPA navigation for internal URLs. */
export function Link({
  href,
  children,
  className,
  ariaLabel,
  title,
}: {
  href: string;
  children: ReactNode;
  className?: string;
  ariaLabel?: string;
  title?: string;
}) {
  const { navigate } = useRouter();
  const internal = href.startsWith("/");

  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (!internal || isModifiedClick(event)) {
      return;
    }
    event.preventDefault();
    navigate(href);
  };

  return (
    <a
      className={className}
      href={href}
      onClick={onClick}
      {...(ariaLabel ? { "aria-label": ariaLabel } : {})}
      {...(title ? { title } : {})}
      {...newTabLinkProps(undefined)}
    >
      {children}
    </a>
  );
}
