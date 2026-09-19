// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { memo } from "react";
import type { CardProps } from "@/features/results/cardParts.tsx";
import { CodeCard } from "@/features/results/cards/CodeCard.tsx";
import { DefaultCard } from "@/features/results/cards/DefaultCard.tsx";
import { FileCard } from "@/features/results/cards/FileCard.tsx";
import { KeyValueCard } from "@/features/results/cards/KeyValueCard.tsx";
import { MapCard } from "@/features/results/cards/MapCard.tsx";
import { PackageCard } from "@/features/results/cards/PackageCard.tsx";
import { PaperCard } from "@/features/results/cards/PaperCard.tsx";
import { ProductCard } from "@/features/results/cards/ProductCard.tsx";
import { TorrentCard } from "@/features/results/cards/TorrentCard.tsx";
import { VideoCard } from "@/features/results/cards/VideoCard.tsx";

/** Per-template card dispatch for list views: one memoized component so
    re-renders from hotkey navigation skip unchanged rows. */
export const ResultCard = memo(function ResultCard(props: CardProps) {
  const { result } = props;
  switch (result.template) {
    case "images":
      return <DefaultCard {...props} />;
    case "videos":
      return <VideoCard {...props} />;
    case "torrent":
      return <TorrentCard {...props} />;
    case "map":
      return <MapCard {...props} />;
    case "paper":
      return <PaperCard {...props} />;
    case "packages":
      return <PackageCard {...props} />;
    case "code":
      return <CodeCard {...props} />;
    case "file":
      return <FileCard {...props} />;
    case "keyvalue":
      return <KeyValueCard {...props} />;
    case "products":
      return <ProductCard {...props} />;
    default:
      return <DefaultCard {...props} />;
  }
});
// memo: list items only change selection styling on their wrapper (the page
// renders the ring there), so unchanged props let hotkey navigation skip the
// whole card subtree
