// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

/** Maps a search category to its stroke icon; the fallback for unknown
    categories is the globe. */

import type { LucideIcon } from "lucide-react";
import {
  Book,
  FileText,
  FlaskConical,
  Globe,
  Image,
  Layers,
  LayoutGrid,
  MapPin,
  Music,
  Newspaper,
  Package,
  Play,
  Radio,
  Search,
  Tv,
  Users,
} from "lucide-react";

const CATEGORY_ICONS: Record<string, LucideIcon> = {
  apps: LayoutGrid,
  dictionaries: Book,
  files: FileText,
  general: Search,
  images: Image,
  it: Layers,
  map: MapPin,
  music: Music,
  news: Newspaper,
  packages: Package,
  radio: Radio,
  science: FlaskConical,
  "social media": Users,
  "stock images": Image,
  TV: Tv,
  videos: Play,
};

export function CategoryIcon({ category, className }: { category: string; className?: string }) {
  const Icon = CATEGORY_ICONS[category] ?? Globe;
  return <Icon aria-hidden className={className} />;
}
