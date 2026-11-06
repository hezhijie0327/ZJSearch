// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

/** Maps a search category to its stroke icon — covers every known server
    category (settings engines, engine modules, searxng.msg); the fallback
    for unknown categories is the globe. */

import type { LucideIcon } from "lucide-react";
import {
  Archive,
  Banknote,
  Book,
  BookMarked,
  BookOpen,
  Boxes,
  Camera,
  Cloud,
  CloudRain,
  Code,
  FileText,
  Film,
  FlaskConical,
  Globe,
  HelpCircle,
  Image,
  Landmark,
  Languages,
  Layers,
  LayoutGrid,
  Library,
  MapPin,
  Mic,
  Music,
  Newspaper,
  Package,
  Palette,
  Play,
  Radio,
  Rss,
  ScrollText,
  Search,
  Shield,
  ShoppingBag,
  Tv,
  Users,
} from "lucide-react";

const CATEGORY_ICONS: Record<string, LucideIcon> = {
  apps: LayoutGrid,
  blogs: Rss,
  books: Library,
  cargo: Boxes,
  cloud: Cloud,
  code: Code,
  currency: Banknote,
  define: BookMarked,
  dictionaries: Book,
  files: FileText,
  general: Search,
  icons: Palette,
  images: Image,
  it: Layers,
  lyrics: Mic,
  map: MapPin,
  movies: Film,
  music: Music,
  news: Newspaper,
  onions: Shield,
  packages: Package,
  "q&a": HelpCircle,
  radio: Radio,
  repos: Archive,
  science: FlaskConical,
  "scientific publications": ScrollText,
  shopping: ShoppingBag,
  "social media": Users,
  "software wikis": BookOpen,
  "stock images": Camera,
  translate: Languages,
  tv: Tv,
  videos: Play,
  weather: CloudRain,
  web: Globe,
  wikimedia: Landmark,
};

export function CategoryIcon({ category, className }: { category: string; className?: string }) {
  const Icon = CATEGORY_ICONS[category] ?? Globe;
  return <Icon aria-hidden className={className} />;
}
