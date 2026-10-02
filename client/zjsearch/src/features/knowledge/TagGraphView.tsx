// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { Maximize2, Minimize2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useT } from "@/lib/i18n.ts";
import { graphSnapshot, type TagGraph } from "@/lib/knowledgeStore.ts";

/**
 * The knowledge page's TAG GRAPH (the GraphRAG view): nodes are concept
 * tags sized by use count, edges are co-occurrence within a knowledge
 * row -- the graph is a QUERY over the table (graphSnapshot), not a
 * store of its own.  The layout is a hand-rolled force simulation
 * (repulsion + springs + centering on a canvas, ~120 lines) -- d3-force's
 * algorithm without the dependency, per the no-new-deps budget.  A click
 * selects a tag (the parent filters the list to it) and highlights the
 * one-hop neighbors; the fullscreen toggle follows LobeHub's word-cloud
 * affordance.  Mounted lazily by the page (it only runs when open).
 */

interface SimNode {
  tag: string;
  uses: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  selected: boolean;
  neighbor: boolean;
}

export function TagGraphView({ onSelectTag }: { onSelectTag: (tag: string) => void }) {
  // eslint note: onSelectTag drives the parent filter on select (see onSelect)
  const t = useT();
  const [graph, setGraph] = useState<TagGraph | null>(null);
  const [error, setError] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const simRef = useRef<SimNode[]>([]);
  const edgesRef = useRef<TagGraph["edges"]>([]);
  const hoverRef = useRef<string | null>(null);
  const selectedRef = useRef<string | null>(null);
  const frameRef = useRef(0);

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

  // the simulation: re-seed the node positions whenever the graph lands
  // or the container resizes, run repulsion/spring/centering per frame,
  // cool down over ~6s then idle at low drift
  useEffect(() => {
    if (!graph || graph.nodes.length === 0) {
      return;
    }
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const width = canvas.clientWidth || 600;
    const height = canvas.clientHeight || 360;
    const maxUses = Math.max(...graph.nodes.map((node) => node.uses), 1);
    const rng = mulberry32(42);
    simRef.current = graph.nodes.map((node) => ({
      tag: node.tag,
      uses: node.uses,
      x: width / 2 + (rng() - 0.5) * width * 0.6,
      y: height / 2 + (rng() - 0.5) * height * 0.6,
      vx: 0,
      vy: 0,
      selected: false,
      neighbor: false,
    }));
    edgesRef.current = graph.edges;
    selectedRef.current = null;
    hoverRef.current = null;

    const index = new Map(simRef.current.map((node) => [node.tag, node]));
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return;
    }
    let alpha = 1;
    const step = () => {
      const nodes = simRef.current;
      // pair repulsion (O(n^2) is fine at <= 40 nodes)
      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i];
        if (!a) {
          continue;
        }
        for (let j = i + 1; j < nodes.length; j++) {
          const b = nodes[j];
          if (!b) {
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
          const force = (2200 * alpha) / dist2;
          const dist = Math.sqrt(dist2);
          a.vx -= (dx / dist) * force;
          a.vy -= (dy / dist) * force;
          b.vx += (dx / dist) * force;
          b.vy += (dy / dist) * force;
        }
      }
      // springs along the edges (weight = stiffness)
      for (const edge of edgesRef.current) {
        const a = index.get(edge.a);
        const b = index.get(edge.b);
        if (!a || !b) {
          continue;
        }
        const ddx = b.x - a.x;
        const ddy = b.y - a.y;
        const dist = Math.sqrt(ddx * ddx + ddy * ddy) || 1;
        const target = 120;
        const force = ((dist - target) / dist) * 0.02 * Math.min(edge.w, 6) * alpha;
        a.vx += ddx * force;
        a.vy += ddy * force;
        b.vx -= ddx * force;
        b.vy -= ddy * force;
      }
      // centering + damping + integrate
      for (const node of nodes) {
        node.vx += (width / 2 - node.x) * 0.002 * alpha;
        node.vy += (height / 2 - node.y) * 0.002 * alpha;
        node.vx *= 0.82;
        node.vy *= 0.82;
        node.x += Math.max(-8, Math.min(8, node.vx));
        node.y += Math.max(-8, Math.min(8, node.vy));
        node.x = Math.max(40, Math.min(width - 40, node.x));
        node.y = Math.max(24, Math.min(height - 24, node.y));
      }
      alpha = Math.max(0.15, alpha * 0.995);

      // draw
      const dpr = window.devicePixelRatio || 1;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      const styles = getComputedStyle(document.documentElement);
      const accent = styles.getPropertyValue("--accent-strong").trim() || "#8c6800";
      const line = styles.getPropertyValue("--line").trim() || "#ddd";
      const ink = styles.getPropertyValue("--ink").trim() || "#222";
      for (const edge of edgesRef.current) {
        const a = index.get(edge.a);
        const b = index.get(edge.b);
        if (!a || !b) {
          continue;
        }
        const active =
          selectedRef.current !== null && (edge.a === selectedRef.current || edge.b === selectedRef.current);
        ctx.strokeStyle = active ? accent : line;
        ctx.globalAlpha = active ? 0.8 : 0.35;
        ctx.lineWidth = Math.min(edge.w, 5) * 0.6;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      for (const node of nodes) {
        const scale = 0.7 + (node.uses / maxUses) * 0.9;
        const isHover = hoverRef.current === node.tag;
        const isSelected = selectedRef.current === node.tag;
        ctx.font = `${isSelected || isHover ? 600 : 400} ${Math.round(13 * scale)}px system-ui, sans-serif`;
        ctx.fillStyle = isSelected ? accent : isHover ? ink : node.neighbor ? accent : ink;
        ctx.globalAlpha = selectedRef.current !== null && !isSelected && !node.neighbor ? 0.35 : 1;
        ctx.fillText(node.tag, node.x, node.y);
        ctx.globalAlpha = 1;
      }
    };

    let last = performance.now();
    const loop = (time: number) => {
      if (time - last > 28) {
        // ~35fps: the layout is decorative once cooled -- no need to race
        step();
        last = time;
      }
      frameRef.current = requestAnimationFrame(loop);
    };
    frameRef.current = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(frameRef.current);
    };
  }, [graph]);

  const tagAt = (x: number, y: number): string | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const px = x - rect.left;
    const py = y - rect.top;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    const maxUses = Math.max(...simRef.current.map((node) => node.uses), 1);
    // top-down hit test over the rendered labels (approximate width)
    for (let i = simRef.current.length - 1; i >= 0; i--) {
      const node = simRef.current[i];
      if (!node) {
        continue;
      }
      const scale = 0.7 + (node.uses / maxUses) * 0.9;
      const width = ctx.measureText(node.tag).width || node.tag.length * 7;
      if (Math.abs(px - node.x) < width / 2 + 6 && Math.abs(py - node.y) < 9 * scale + 4) {
        return node.tag;
      }
    }
    return null;
  };

  const onSelect = (tag: string) => {
    const next = selectedRef.current === tag ? null : tag;
    selectedRef.current = next;
    setSelected(next);
    const neighbors = new Set<string>([tag]);
    for (const edge of edgesRef.current) {
      if (edge.a === selectedRef.current) neighbors.add(edge.b);
      if (edge.b === selectedRef.current) neighbors.add(edge.a);
    }
    for (const node of simRef.current) {
      node.selected = node.tag === selectedRef.current;
      node.neighbor = selectedRef.current !== null && neighbors.has(node.tag) && !node.selected;
    }
  };

  return (
    <div
      className={`relative overflow-hidden rounded-2xl border border-line bg-surface ${fullscreen ? "fixed inset-4 z-50" : ""}`}
    >
      <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
        <p className="text-xs text-ink-3">{t("knowledge_graph_hint")}</p>
        <button
          aria-label={t("knowledge_graph")}
          className="rounded-md p-1.5 text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink"
          onClick={() => setFullscreen((prev) => !prev)}
          type="button"
        >
          {fullscreen ? (
            <Minimize2 aria-hidden="true" className="size-4" />
          ) : (
            <Maximize2 aria-hidden="true" className="size-4" />
          )}
        </button>
      </div>
      {error ? (
        <p className="px-4 py-10 text-center text-sm text-ink-3">{t("knowledge_graph_empty")}</p>
      ) : !graph ? (
        <div className="h-[360px] space-y-3 p-4">
          {Array.from({ length: 5 }, (_, i) => (
            <span className="zjs-skeleton block h-6 rounded-lg" key={i} />
          ))}
        </div>
      ) : graph.nodes.length === 0 ? (
        <p className="px-4 py-16 text-center text-sm text-ink-3">{t("knowledge_graph_empty")}</p>
      ) : (
        <>
          {selected ? (
            <div className="flex flex-wrap items-center gap-1.5 border-b border-line px-4 py-2.5">
              <span className="rounded-full bg-accent-soft px-3 py-1 text-[13px] font-medium text-accent">
                {selected}
              </span>
              <button
                className="rounded-full bg-accent-strong px-3 py-1 text-[13px] font-medium text-accent-contrast transition-opacity hover:opacity-90"
                onClick={() => onSelectTag(selected)}
                type="button"
              >
                {t("knowledge_graph_filter")}
              </button>
              {graph.edges
                .filter((edge) => edge.a === selected || edge.b === selected)
                .slice(0, 8)
                .map((edge) => {
                  const neighbor = edge.a === selected ? edge.b : edge.a;
                  return (
                    <button
                      className="rounded-full border border-line px-3 py-1 text-[13px] text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink"
                      key={neighbor}
                      onClick={() => onSelect(neighbor)}
                      type="button"
                    >
                      {neighbor}
                    </button>
                  );
                })}
              <button
                aria-label={t("close")}
                className="ms-auto rounded-md p-1 text-ink-3 transition-colors hover:text-ink"
                onClick={() => onSelect(selected)}
                type="button"
              >
                <X aria-hidden="true" className="size-4" />
              </button>
            </div>
          ) : null}
          <canvas
            className="block h-[360px] w-full"
            height={720}
            onClick={(event) => {
              const tag = tagAt(event.clientX, event.clientY);
              if (tag) onSelect(tag);
            }}
            onDoubleClick={(event) => {
              const tag = tagAt(event.clientX, event.clientY);
              if (tag) onSelectTag(tag);
            }}
            onMouseMove={(event) => {
              const tag = tagAt(event.clientX, event.clientY);
              hoverRef.current = tag;
              const target = canvasRef.current;
              if (target) {
                target.style.cursor = tag ? "pointer" : "default";
              }
            }}
            ref={canvasRef}
            style={{ height: fullscreen ? "calc(100% - 45px)" : "360px", width: "100%" }}
            width={1280}
          />
        </>
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
