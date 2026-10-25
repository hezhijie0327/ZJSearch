// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { PanelSearch } from "@/components/PanelSearch.tsx";
import { PaperEmpty } from "@/components/PaperEmpty.tsx";
import { KNOWLEDGE_KIND_ICONS } from "@/features/knowledge/sections.tsx";
import { formatDate } from "@/lib/format.ts";
import { useT } from "@/lib/i18n.ts";
import { graphSnapshot, itemsByTag, type TagGraph } from "@/lib/kb/recall.ts";
import type { KnowledgeItem } from "@/lib/kb/shared.ts";

/**
 * The knowledge page's TAG GRAPH (the GraphRAG view): nodes are concept
 * tags sized by use count, edges are co-occurrence within a knowledge
 * row -- the graph is a QUERY over the table (graphSnapshot), not a
 * store of its own.  The layout is a hand-rolled force simulation
 * (repulsion + springs + centering on a canvas) -- d3-force's algorithm
 * without the dependency, per the no-new-deps budget.
 *
 * Interaction: wheel zooms around the cursor, dragging empty space pans,
 * dragging a tag moves it, a click selects it -- selection opens the
 * LOCATE PANEL: the content carrying the tag (runs / answers / sources /
 * documents, each clickable to its thread or reading pane) plus the
 * one-hop neighbor chips and the filter action.  Double-click applies
 * the filter directly.  Colors ride the theme tokens (edges ink-3, the
 * selection accent-strong) at canvas-tuned alphas.
 */

const LAYOUT_W = 1200;
const LAYOUT_H = 700;

interface SimNode {
  tag: string;
  uses: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  pinned: boolean;
  /** the node's CONSTELLATION center -- connected components sit in their
      own grid slot and the weak pull keeps them there, so unrelated
      themes never intermingle into one hairball */
  cx: number;
  cy: number;
}

const KIND_LABEL: Record<
  string,
  "knowledge_kind_run" | "knowledge_kind_source" | "knowledge_kind_document" | "knowledge_kind_memory"
> = {
  run: "knowledge_kind_run",
  source: "knowledge_kind_source",
  document: "knowledge_kind_document",
  memory: "knowledge_kind_memory",
};

export function TagGraphView({
  onSelectTag,
  onOpenInspector,
  onOpenThread,
}: {
  onSelectTag: (tag: string) => void;
  onOpenInspector: (item: KnowledgeItem) => void;
  onOpenThread: (id: string) => void;
}) {
  const t = useT();
  const [graph, setGraph] = useState<TagGraph | null>(null);
  const [search, setSearch] = useState("");
  const [error, setError] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedItems, setSelectedItems] = useState<KnowledgeItem[] | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const simRef = useRef<SimNode[]>([]);
  const edgesRef = useRef<TagGraph["edges"]>([]);
  const hoverRef = useRef<string | null>(null);
  const selectedRef = useRef<string | null>(null);
  const frameRef = useRef(0);
  /** wakes the simulation loop after it settled (see the sleep below) --
      the interaction effect's handlers and the focus/select paths call it */
  const wakeRef = useRef<() => void>(() => undefined);
  // the view transform: layout coords -> canvas css coords
  const viewRef = useRef({ panX: 0, panY: 0, zoom: 1 });
  const fitRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    let cancelled = false;
    graphSnapshot(40)
      .then((value) => {
        if (!cancelled) setGraph(value);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // selecting a tag loads its content (the locate panel)
  const firstSelect = useRef(true);
  useEffect(() => {
    if (firstSelect.current) {
      firstSelect.current = false;
      return;
    }
    if (!selected) {
      setSelectedItems(null);
      return;
    }
    let cancelled = false;
    itemsByTag(selected, 20)
      .then((rows) => {
        if (!cancelled) setSelectedItems(rows);
      })
      .catch(() => {
        if (!cancelled) setSelectedItems([]);
      });
    return () => {
      cancelled = true;
    };
  }, [selected]);

  const select = useCallback((tag: string | null) => {
    const next = selectedRef.current === tag ? null : tag;
    if (next !== selectedRef.current) {
      selectedRef.current = next;
      // the highlight state changed -- a sleeping graph must redraw
      wakeRef.current();
    }
    setSelected(next);
  }, []);

  // the search box: pan/zoom the view onto the picked node and open its
  // locate panel -- the canvas equivalent of the listings' search box
  const focusNode = useCallback(
    (tag: string) => {
      const node = simRef.current.find((n) => n.tag === tag);
      const canvas = canvasRef.current;
      if (!node || !canvas) {
        return;
      }
      wakeRef.current();
      const cw = canvas.clientWidth || 700;
      const ch = canvas.clientHeight || 420;
      const zoom = Math.max(viewRef.current.zoom, 0.9);
      viewRef.current = { zoom, panX: cw / 2 - node.x * zoom, panY: ch / 2 - node.y * zoom };
      select(tag);
    },
    [select],
  );

  // ── the simulation + render loop ─────────────────────────────────────
  useEffect(() => {
    if (!graph || graph.nodes.length === 0) {
      return;
    }
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const rng = mulberry32(42);
    const maxUses = Math.max(...graph.nodes.map((node) => node.uses), 1);
    // THE CONSTELLATION LAYOUT: connected components (over the co-occurrence
    // edges) are the graph's real themes -- each gets its own grid slot as
    // a center, members initialize around it, and the weak pull keeps the
    // constellation there.  Unrelated themes (WoW vs LobeHub vs nginx)
    // read as separate sky regions instead of one hairball.
    const parent = new Map<string, string>();
    const find = (tag: string): string => {
      const root = parent.get(tag) ?? tag;
      if (root !== tag) {
        parent.set(tag, find(root));
        return parent.get(tag) as string;
      }
      return root;
    };
    for (const node of graph.nodes) {
      parent.set(node.tag, node.tag);
    }
    for (const edge of graph.edges) {
      if (!parent.has(edge.a) || !parent.has(edge.b)) {
        continue;
      }
      const ra = find(edge.a);
      const rb = find(edge.b);
      if (ra !== rb) {
        parent.set(ra, rb);
      }
    }
    const components = new Map<string, string[]>();
    for (const node of graph.nodes) {
      const root = find(node.tag);
      const list = components.get(root) ?? [];
      list.push(node.tag);
      components.set(root, list);
    }
    const ordered = [...components.values()].sort(
      (a, b) =>
        b.reduce((sum, t) => sum + (graph.nodes.find((n) => n.tag === t)?.uses ?? 0), 0) -
        a.reduce((sum, t) => sum + (graph.nodes.find((n) => n.tag === t)?.uses ?? 0), 0),
    );
    const cols = Math.max(1, Math.ceil(Math.sqrt(ordered.length)));
    const cellW = LAYOUT_W / cols;
    const cellH = LAYOUT_H / Math.max(1, Math.ceil(ordered.length / cols));
    const centers = new Map<string, { x: number; y: number; spread: number }>();
    ordered.forEach((members, index) => {
      const gx = index % cols;
      const gy = Math.floor(index / cols);
      const uses = members.reduce((sum, t) => sum + (graph.nodes.find((n) => n.tag === t)?.uses ?? 0), 0);
      const spread =
        Math.min(cellW, cellH) * (0.22 + 0.12 * Math.min(1, members.length / 8) + 0.1 * Math.min(1, uses / 40));
      for (const member of members) {
        centers.set(member, { x: cellW * (gx + 0.5), y: cellH * (gy + 0.5), spread });
      }
    });
    simRef.current = graph.nodes.map((node) => {
      const home = centers.get(node.tag) ?? { x: LAYOUT_W / 2, y: LAYOUT_H / 2, spread: 120 };
      return {
        tag: node.tag,
        uses: node.uses,
        x: home.x + (rng() - 0.5) * home.spread * 2,
        y: home.y + (rng() - 0.5) * home.spread * 2,
        vx: 0,
        vy: 0,
        pinned: false,
        cx: home.x,
        cy: home.y,
      };
    });
    edgesRef.current = graph.edges;
    selectedRef.current = null;
    setSelected(null);
    // fit the fixed layout into the canvas
    const cw = canvas.clientWidth || 700;
    const ch = canvas.clientHeight || 420;
    viewRef.current = {
      panX: (cw - LAYOUT_W) / 2,
      panY: (ch - LAYOUT_H) / 2,
      zoom: Math.min(cw / LAYOUT_W, ch / LAYOUT_H) * 1.05,
    };

    const index = new Map(simRef.current.map((node) => [node.tag, node]));
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return;
    }

    let alpha = 1;
    let framesSinceFit = 0;
    const fitToContent = () => {
      // center + zoom on the nodes' bounding box (the settled graph is
      // smaller than the fixed layout -- fit-zoom alone leaves it adrift)
      const nodes = simRef.current;
      if (nodes.length === 0) {
        return;
      }
      let minX = Infinity,
        minY = Infinity,
        maxX = -Infinity,
        maxY = -Infinity;
      for (const node of nodes) {
        minX = Math.min(minX, node.x);
        minY = Math.min(minY, node.y);
        maxX = Math.max(maxX, node.x);
        maxY = Math.max(maxY, node.y);
      }
      const cw = canvas.clientWidth || 700;
      const ch = canvas.clientHeight || 420;
      const pad = 50;
      const zoom = Math.min(2.2, Math.min(cw / (maxX - minX + pad * 2), ch / (maxY - minY + pad * 2)));
      viewRef.current = {
        zoom,
        panX: (cw - (minX + maxX) * zoom) / 2,
        panY: (ch - (minY + maxY) * zoom) / 2,
      };
    };
    fitRef.current = fitToContent;
    const step = () => {
      const nodes = simRef.current;
      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i];
        if (!a || a.pinned) {
          continue;
        }
        for (let j = i + 1; j < nodes.length; j++) {
          const b = nodes[j];
          if (!b || b.pinned) {
            continue;
          }
          let dx = b.x - a.x;
          let dy = b.y - a.y;
          let dist2 = dx * dx + dy * dy;
          if (dist2 < 1) {
            dx = rng() - 0.5;
            dy = rng() - 0.5;
            dist2 = 1;
          }
          const force = (6800 * alpha) / dist2;
          const dist = Math.sqrt(dist2);
          a.vx -= (dx / dist) * force;
          a.vy -= (dy / dist) * force;
          b.vx += (dx / dist) * force;
          b.vy += (dy / dist) * force;
        }
      }
      for (const edge of edgesRef.current) {
        const a = index.get(edge.a);
        const b = index.get(edge.b);
        if (!a || !b) {
          continue;
        }
        const ddx = b.x - a.x;
        const ddy = b.y - a.y;
        const dist = Math.sqrt(ddx * ddx + ddy * ddy) || 1;
        const target = 150;
        const force = ((dist - target) / dist) * 0.02 * Math.min(edge.w, 6) * alpha;
        a.vx += ddx * force;
        a.vy += ddy * force;
        b.vx -= ddx * force;
        b.vy -= ddy * force;
      }
      // THE COLLISION PASS: a label is the widest part of a node -- pairs
      // closer than the sum of their label radii are pushed apart until
      // they clear (two relaxations).  The old params let high-degree
      // hubs (the spring pull of a dozen edges) compress labels into an
      // unreadable ball the pairwise repulsion alone could not open.
      for (let pass = 0; pass < 2; pass++) {
        for (let i = 0; i < nodes.length; i++) {
          const a = nodes[i];
          if (!a || a.pinned) {
            continue;
          }
          const ra = a.tag.length * 3.4 + 8;
          for (let j = i + 1; j < nodes.length; j++) {
            const b = nodes[j];
            if (!b || b.pinned) {
              continue;
            }
            const rb = b.tag.length * 3.4 + 8;
            const dx = b.x - a.x;
            const dy = b.y - a.y;
            const dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
            const min = ra + rb;
            if (dist >= min) {
              continue;
            }
            const push = ((min - dist) / dist) * 0.5;
            a.x -= dx * push;
            a.y -= dy * push;
            b.x += dx * push;
            b.y += dy * push;
          }
        }
      }
      const anyPinned = nodes.some((node) => node.pinned);
      for (const node of nodes) {
        if (node.pinned) {
          continue;
        }
        // the constellation pull: home in on the component's own slot --
        // weak enough that springs shape the cluster, strong enough that
        // neighboring themes never drift into one blob
        node.vx += (node.cx - node.x) * 0.012 * alpha;
        node.vy += (node.cy - node.y) * 0.012 * alpha;
        node.vx *= 0.82;
        node.vy *= 0.82;
        node.x += Math.max(-8, Math.min(8, node.vx));
        node.y += Math.max(-8, Math.min(8, node.vy));
        node.x = Math.max(30, Math.min(LAYOUT_W - 30, node.x));
        node.y = Math.max(20, Math.min(LAYOUT_H - 20, node.y));
      }
      alpha = Math.max(0.12, alpha * 0.995);
      if (!anyPinned) {
        framesSinceFit += 1;
        if (framesSinceFit > 90) {
          framesSinceFit = 0;
          fitToContent();
        }
      }
    };

    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      const cw = canvas.clientWidth || 700;
      const ch = canvas.clientHeight || 420;
      // the buffer tracks CSS x dpr -- a fixed buffer only clears in its
      // top-left corner and the stale remainder scales into every frame
      // as ghost trails (shipped bug)
      const bw = Math.round(cw * dpr);
      const bh = Math.round(ch * dpr);
      if (canvas.width !== bw || canvas.height !== bh) {
        canvas.width = bw;
        canvas.height = bh;
      }
      const { panX, panY, zoom } = viewRef.current;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cw, ch);
      ctx.translate(panX, panY);
      ctx.scale(zoom, zoom);
      const styles = getComputedStyle(document.documentElement);
      const ink = styles.getPropertyValue("--ink").trim() || "#222";
      const ink3 = styles.getPropertyValue("--ink-3").trim() || "#8a8a8a";
      const accentStrong = styles.getPropertyValue("--accent-strong").trim() || "#8c6800";
      const accent = styles.getPropertyValue("--accent").trim() || "#8c6800";
      const sel = selectedRef.current;
      const nodes = simRef.current;
      for (const edge of edgesRef.current) {
        const a = index.get(edge.a);
        const b = index.get(edge.b);
        if (!a || !b) {
          continue;
        }
        const active = sel !== null && (edge.a === sel || edge.b === sel);
        ctx.strokeStyle = active ? accentStrong : ink3;
        ctx.globalAlpha = active ? 0.85 : 0.5;
        ctx.lineWidth = active ? 2 : 0.7 + Math.min(edge.w, 6) * 0.4;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      for (const node of nodes) {
        const scale = 0.72 + (node.uses / maxUses) * 0.9;
        const isHover = hoverRef.current === node.tag;
        const isSelected = sel === node.tag;
        const isNeighbor =
          sel !== null &&
          !isSelected &&
          edgesRef.current.some(
            (edge) => (edge.a === sel && edge.b === node.tag) || (edge.b === sel && edge.a === node.tag),
          );
        ctx.font = `${isSelected || isHover ? 600 : 500} ${Math.round(13 * scale)}px system-ui, sans-serif`;
        ctx.fillStyle = isSelected ? accentStrong : isNeighbor || isHover ? accent : ink;
        ctx.globalAlpha = sel !== null && !isSelected && !isNeighbor && !isHover ? 0.25 : 1;
        ctx.fillText(node.tag, node.x, node.y);
        ctx.globalAlpha = 1;
      }
    };

    // settle the seed headless: the first visible frame is already
    // near-equilibrium (no clump-then-spread on entry) -- the collision
    // pass needs the extra iterations to open the initial blob
    for (let i = 0; i < 160; i++) {
      step();
    }
    fitToContent();
    let last = performance.now();
    // THE SLEEP: a force graph at equilibrium renders nothing new -- the
    // old loop stepped + redrew at ~35fps FOREVER, an invisible permanent
    // animation that starves screenshot-pipeline / occluded-webview
    // compositors (the documented jam feeder).  The loop now stops once
    // the layout settles (total node speed under threshold for a full
    // second) and anything that changes the picture (pointer, wheel,
    // resize, visibility) wakes it through wakeRef.
    let asleep = false;
    let quietFrames = 0;
    const wake = () => {
      if (!asleep) {
        return;
      }
      asleep = false;
      quietFrames = 0;
      last = performance.now();
      draw();
      frameRef.current = requestAnimationFrame(loop);
    };
    wakeRef.current = wake;
    const loop = (time: number) => {
      if (document.hidden) {
        // an occluded pane never paints; stepping is pure waste -- park
        // the loop and let the visibility handler restart it
        asleep = true;
        return;
      }
      if (time - last > 28) {
        last = time;
        step();
        draw();
        // the sleep gate: forces floor at alpha 0.12 so the settled graph
        // hums rather than stops -- require a sustained quiet stretch
        let speed = 0;
        for (const node of simRef.current) {
          if (!node.pinned) {
            speed += Math.min(8, Math.hypot(node.vx, node.vy));
          }
        }
        quietFrames = speed < 0.5 ? quietFrames + 1 : 0;
        if (quietFrames > 34) {
          asleep = true;
          return;
        }
      }
      frameRef.current = requestAnimationFrame(loop);
    };
    frameRef.current = requestAnimationFrame(loop);
    const onVisibility = () => {
      if (!document.hidden) {
        wake();
      }
    };
    const onResize = () => {
      // the buffer re-fits on the next draw; a resize may expose clipped
      // nodes, so the periodic fit re-runs from a fresh wake
      framesSinceFit = 90;
      wake();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("resize", onResize);
    return () => {
      cancelAnimationFrame(frameRef.current);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("resize", onResize);
      wakeRef.current = () => undefined;
    };
  }, [graph]);

  // ── hit testing + pointer interaction (zoom / pan / drag / select) ───
  const toLayout = useCallback((clientX: number, clientY: number): { x: number; y: number } | null => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return null;
    }
    const rect = canvas.getBoundingClientRect();
    const { panX, panY, zoom } = viewRef.current;
    return { x: (clientX - rect.left - panX) / zoom, y: (clientY - rect.top - panY) / zoom };
  }, []);

  const tagAt = useCallback(
    (clientX: number, clientY: number): string | null => {
      const point = toLayout(clientX, clientY);
      const canvas = canvasRef.current;
      if (!point || !canvas) {
        return null;
      }
      const ctx = canvas.getContext("2d");
      const maxUses = Math.max(...simRef.current.map((node) => node.uses), 1);
      for (let i = simRef.current.length - 1; i >= 0; i--) {
        const node = simRef.current[i];
        if (!node) {
          continue;
        }
        const scale = 0.72 + (node.uses / maxUses) * 0.9;
        const halfWidth =
          ((ctx?.measureText(node.tag).width ?? node.tag.length * 7) / 2) * scale + 8 / viewRef.current.zoom;
        if (
          Math.abs(point.x - node.x) < halfWidth &&
          Math.abs(point.y - node.y) < 11 * scale + 6 / viewRef.current.zoom
        ) {
          return node.tag;
        }
      }
      return null;
    },
    [toLayout],
  );

  useEffect(() => {
    // the canvas element exists only once the graph data landed -- re-bind
    // the interaction when it appears (a mount-time bind silently no-ops)
    if (!graph) {
      return;
    }
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const drag = {
      mode: "none" as "none" | "pan" | "node",
      tag: null as string | null,
      lastX: 0,
      lastY: 0,
      moved: 0,
    };

    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      wakeRef.current();
      const rect = canvas.getBoundingClientRect();
      const mx = event.clientX - rect.left;
      const my = event.clientY - rect.top;
      const { panX, panY, zoom } = viewRef.current;
      const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
      const nextZoom = Math.max(0.4, Math.min(3.5, zoom * factor));
      // keep the cursor's point fixed under the zoom
      viewRef.current = {
        zoom: nextZoom,
        panX: mx - ((mx - panX) * nextZoom) / zoom,
        panY: my - ((my - panY) * nextZoom) / zoom,
      };
    };

    const onPointerDown = (event: PointerEvent) => {
      wakeRef.current();
      const tag = tagAt(event.clientX, event.clientY);
      drag.mode = tag ? "node" : "pan";
      drag.tag = tag;
      drag.lastX = event.clientX;
      drag.lastY = event.clientY;
      drag.moved = 0;
      canvas.setPointerCapture(event.pointerId);
    };

    const onPointerMove = (event: PointerEvent) => {
      if (drag.mode === "none") {
        // hover cursor + highlight (a hover change redraws -- a hover over
        // a SLEEPING graph must wake it)
        const tag = tagAt(event.clientX, event.clientY);
        if (tag !== hoverRef.current) {
          hoverRef.current = tag;
          wakeRef.current();
        }
        canvas.style.cursor = tag ? "pointer" : "grab";
        return;
      }
      wakeRef.current();
      const dx = event.clientX - drag.lastX;
      const dy = event.clientY - drag.lastY;
      drag.lastX = event.clientX;
      drag.lastY = event.clientY;
      drag.moved += Math.abs(dx) + Math.abs(dy);
      if (drag.mode === "pan") {
        viewRef.current.panX += dx;
        viewRef.current.panY += dy;
      } else if (drag.mode === "node" && drag.tag) {
        const point = toLayout(event.clientX, event.clientY);
        const node = simRef.current.find((candidate) => candidate.tag === drag.tag);
        if (point && node) {
          node.x = point.x;
          node.y = point.y;
          node.vx = 0;
          node.vy = 0;
          node.pinned = drag.moved > 12; // a real drag pins the node for the rest of the gesture
        }
      }
    };

    const onPointerUp = (event: PointerEvent) => {
      if (drag.mode === "node" && drag.moved < 5) {
        select(drag.tag); // a click, not a drag: select + open the locate panel
      } else if (drag.mode === "pan" && drag.moved < 5) {
        select(null); // a click on empty space clears the selection
      }
      for (const node of simRef.current) {
        node.pinned = false;
      }
      // unpinning releases every node back into the force field -- the
      // graph re-settles, so the loop must be awake to run it
      wakeRef.current();
      drag.mode = "none";
      drag.tag = null;
      void event;
    };

    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    return () => {
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
    };
  }, [graph, tagAt, toLayout, select]);

  return (
    <div>
      <PanelSearch
        ariaLabel={t("knowledge_graph_search")}
        onChange={(value) => setSearch(value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            setSearch("");
          }
          if (event.key === "Enter") {
            const q = search.trim().toLowerCase();
            const hit = graph?.nodes
              .filter((node) => node.tag.toLowerCase().includes(q))
              .map((node) => node.tag)
              .find(Boolean);
            if (hit) {
              focusNode(hit);
              setSearch("");
            }
          }
        }}
        placeholder={t("knowledge_graph_search")}
        value={search}
      />
      {search.trim() ? (
        <div className="absolute inset-x-0 top-full z-10 mt-1 overflow-hidden rounded-xl border border-line bg-surface py-1 shadow-pop">
          {(() => {
            const q = search.trim().toLowerCase();
            const hits = (graph?.nodes ?? []).filter((node) => node.tag.toLowerCase().includes(q)).slice(0, 6);
            if (hits.length === 0) {
              return <p className="px-3 py-2 text-xs text-ink-3">{t("knowledge_thread_no_match")}</p>;
            }
            return hits.map((node) => (
              <button
                className="block w-full truncate px-3 py-1.5 text-start text-[13px] text-ink transition-colors hover:bg-surface-2"
                key={node.tag}
                onClick={() => {
                  focusNode(node.tag);
                  setSearch("");
                }}
                type="button"
              >
                {node.tag}
                <span className="ms-1.5 text-ink-3">{node.uses}</span>
              </button>
            ));
          })()}
        </div>
      ) : null}
      {error ? (
        <div className="mt-3 rounded-2xl border border-line bg-surface px-4 py-10 text-center text-sm text-ink-3">
          {t("knowledge_graph_error")}
        </div>
      ) : !graph ? (
        <div className="mt-3 h-[420px] space-y-3 rounded-2xl border border-line bg-surface p-4">
          {Array.from({ length: 5 }, (_, i) => (
            <span className="zjs-skeleton block h-6 rounded-lg" key={i} />
          ))}
        </div>
      ) : graph.nodes.length === 0 ? (
        // the ONE empty-state language (the AGENTS.md contract): icon disc
        // + title + guidance on the torn note -- not a bare paragraph
        <PaperEmpty
          className="mt-3"
          icon={KNOWLEDGE_KIND_ICONS.graph}
          line={t("knowledge_graph_empty_line")}
          title={t("knowledge_graph_empty")}
        />
      ) : (
        <div className="relative mt-3 overflow-hidden rounded-2xl border border-line bg-surface">
          {/* the ONE band language: a "graph · N" label band over the canvas
              (the tabs' bodies all open with a labeled band) */}
          <div className="flex items-center gap-2 bg-surface-2/60 px-5 py-2.5 sm:px-6">
            <p className="text-xs font-medium text-ink-3">
              {t("knowledge_graph")} · {graph.nodes.length}
            </p>
          </div>
          <canvas
            className="block h-[420px] w-full touch-none"
            ref={canvasRef}
            style={{ height: "420px", width: "100%" }}
          />
          {/* the locate panel: the content carrying the selected tag */}
          {selected ? (
            <div className="absolute bottom-3 end-3 top-3 z-10 flex w-72 flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-pop">
              <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
                <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-accent">{selected}</span>
                <button
                  className="shrink-0 rounded-full bg-accent-strong px-2.5 py-1 text-[13px] font-medium text-accent-contrast transition-opacity hover:opacity-90"
                  onClick={() => onSelectTag(selected)}
                  type="button"
                >
                  {t("knowledge_graph_filter")}
                </button>
                <button
                  aria-label={t("close")}
                  className="shrink-0 rounded-md p-1 text-ink-3 transition-colors hover:text-ink"
                  onClick={() => select(null)}
                  type="button"
                >
                  <X aria-hidden="true" className="size-4" />
                </button>
              </div>
              <div className="flex flex-wrap items-center gap-1 border-b border-line px-3 py-2">
                {graph.edges
                  .filter((edge) => edge.a === selected || edge.b === selected)
                  .slice(0, 8)
                  .map((edge) => {
                    const neighbor = edge.a === selected ? edge.b : edge.a;
                    return (
                      <button
                        className="rounded-full border border-line px-2 py-0.5 text-xs text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink"
                        key={neighbor}
                        onClick={() => select(neighbor)}
                        type="button"
                      >
                        {neighbor}
                      </button>
                    );
                  })}
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto">
                <p className="px-3 pb-1 pt-2 text-xs text-ink-3">{t("knowledge_graph_items")}</p>
                {selectedItems === null ? (
                  <p className="px-3 py-3 text-[13px] text-ink-3">…</p>
                ) : selectedItems.length === 0 ? (
                  <p className="px-3 py-3 text-[13px] text-ink-3">{t("knowledge_kind_empty")}</p>
                ) : (
                  selectedItems.map((item) => (
                    <button
                      className="flex w-full flex-col gap-0.5 border-b border-line px-3 py-2 text-start transition-colors hover:bg-surface-2"
                      key={item.id}
                      onClick={() => {
                        if (item.kind === "source" || item.kind === "document") {
                          onOpenInspector(item);
                          return;
                        }
                        if (item.threadId) {
                          onOpenThread(item.threadId);
                        }
                      }}
                      type="button"
                    >
                      <span className="line-clamp-2 text-[13px] font-medium leading-snug text-ink">
                        {item.title || item.body.slice(0, 60) || item.url}
                      </span>
                      <span className="text-xs text-ink-3">
                        {t(KIND_LABEL[item.kind] ?? "knowledge_kind_source")}
                        {" · "}
                        {formatDate(new Date(item.updated).toISOString())}
                      </span>
                    </button>
                  ))
                )}
              </div>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

/** Deterministic PRNG (the layout seeds identically per render pass). */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
