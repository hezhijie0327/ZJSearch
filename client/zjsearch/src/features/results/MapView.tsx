// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

/**
 * Interactive OSM map for map results.  OpenLayers is lazy-loaded only when
 * the user asks for the map (mirrors the upstream MapView client plugin).
 */

import { Crosshair, MapPin } from "lucide-react";
import type Feature from "ol/Feature.js";
import type BaseLayer from "ol/layer/Base.js";
import type { default as OlMap } from "ol/Map.js";
import type VectorSource from "ol/source/Vector.js";
import { useEffect, useRef, useState } from "react";
import { CopyButton } from "@/components/CopyButton.tsx";
import { useT } from "@/lib/i18n.ts";
import { reducedMotion } from "@/lib/motion.ts";

interface MapResultProps {
  longitude?: string;
  latitude?: string;
  boundingbox?: number[];
  geojson?: unknown;
  label: string;
  /** render the map expanded from the start (map-intent searches) */
  autoOpen?: boolean;
}

export function MapResult({ longitude, latitude, boundingbox, geojson, label, autoOpen = false }: MapResultProps) {
  const [open, setOpen] = useState(autoOpen);
  const t = useT();
  const containerRef = useRef<HTMLDivElement>(null);
  // recenter-to-location, wired by the map effect
  const restoreRef = useRef<(() => void) | null>(null);
  const hasMap = Boolean(longitude && latitude) || Boolean(boundingbox?.length) || Boolean(geojson);

  useEffect(() => {
    if (!open || !containerRef.current) {
      return;
    }
    let instance: OlMap | null = null;
    // the OpenLayers modules stream in over several awaits — a close during
    // that window must stop the boot (the map would otherwise mount onto the
    // detached container and leak)
    let cancelled = false;

    void (async () => {
      const container = containerRef.current;
      if (!container) {
        return;
      }
      // controls (zoom, attribution) render unstyled garbage without it
      await import("ol/ol.css");
      if (cancelled) {
        return;
      }
      const { default: OlMap } = await import("ol/Map.js");
      const { default: View } = await import("ol/View.js");
      const { default: TileLayer } = await import("ol/layer/Tile.js");
      const { default: OSM } = await import("ol/source/OSM.js");
      const { fromLonLat } = await import("ol/proj.js");
      if (cancelled) {
        return;
      }

      const layers: BaseLayer[] = [new TileLayer({ source: new OSM() })];
      let center = fromLonLat([0, 0]);
      let vectorSource: VectorSource<Feature> | null = null;

      if (geojson) {
        const { default: VectorLayer } = await import("ol/layer/Vector.js");
        const { default: VectorSource } = await import("ol/source/Vector.js");
        const { default: GeoJSON } = await import("ol/format/GeoJSON.js");
        const { default: StrokeStyle } = await import("ol/style/Stroke.js");
        const { default: FillStyle } = await import("ol/style/Fill.js");
        const { default: Style } = await import("ol/style/Style.js");
        if (cancelled) {
          return;
        }
        const format = new GeoJSON();
        vectorSource = new VectorSource({
          features: format.readFeatures(geojson, {
            dataProjection: "EPSG:4326",
            featureProjection: "EPSG:3857",
          }) as Feature[],
        });
        layers.push(
          new VectorLayer({
            source: vectorSource,
            style: new Style({
              // route/area colors are map graphics locked to the tile palette
              // (readable on every OSM style), not theme surfaces
              stroke: new StrokeStyle({ color: "#5457d6", width: 2 }),
              fill: new FillStyle({ color: "rgba(84, 87, 214, 0.15)" }),
            }),
          }),
        );
      }

      // resolve the point location once - view, marker and restore share it
      let pointLonLat: number[] | null = null;
      if (longitude && latitude) {
        const lon = Number(longitude);
        const lat = Number(latitude);
        if (Number.isFinite(lon) && Number.isFinite(lat)) {
          pointLonLat = fromLonLat([lon, lat]);
          center = pointLonLat;
        }
      }

      // point results get a location marker (accent dot, theme-styled)
      if (pointLonLat) {
        const [
          { default: Feature },
          { default: Point },
          { default: Style },
          { default: Fill },
          { default: Stroke },
          { default: CircleStyle },
          { default: VectorLayer },
          { default: VectorSource },
        ] = await Promise.all([
          import("ol/Feature.js"),
          import("ol/geom/Point.js"),
          import("ol/style/Style.js"),
          import("ol/style/Fill.js"),
          import("ol/style/Stroke.js"),
          import("ol/style/Circle.js"),
          import("ol/layer/Vector.js"),
          import("ol/source/Vector.js"),
        ]);
        if (cancelled) {
          return;
        }
        const marker = new Feature({ geometry: new Point(pointLonLat) });
        marker.setStyle(
          new Style({
            image: new CircleStyle({
              radius: 7,
              // accent-strong (marker) over ink (rim): matches the theme's
              // accent dot language; rims stay dark on any tile
              fill: new Fill({ color: "#fec843" }),
              stroke: new Stroke({ color: "#201d17", width: 2 }),
            }),
          }),
        );
        layers.push(new VectorLayer({ source: new VectorSource({ features: [marker] }) }));
      }

      const map = new OlMap({
        target: container,
        layers,
        view: new View({ center, zoom: 16, maxZoom: 16 }),
      });
      if (cancelled) {
        map.setTarget(undefined);
        return;
      }
      instance = map;

      // metric scale bar, bottom-left
      const { default: ScaleLine } = await import("ol/control/ScaleLine.js");
      if (!cancelled) {
        map.addControl(new ScaleLine({ units: "metric" }));
      }

      // restore-to-location for the recenter button (animated unless the
      // user prefers reduced motion)
      restoreRef.current = () => {
        const view = map.getView();
        const duration = reducedMotion() ? 0 : 400;
        if (pointLonLat) {
          view.animate({ center: pointLonLat, zoom: 16, duration });
        } else if (Array.isArray(boundingbox) && boundingbox.length === 4) {
          const [minLon, minLat, maxLon, maxLat] = boundingbox as [number, number, number, number];
          const min = fromLonLat([minLon, minLat]);
          const max = fromLonLat([maxLon, maxLat]);
          view.fit([min[0] ?? 0, min[1] ?? 0, max[0] ?? 0, max[1] ?? 0], {
            size: map.getSize(),
            padding: [24, 24, 24, 24],
            maxZoom: 16,
            duration,
          });
        }
      };

      const fitExtent = (extent: number[]) => {
        if (extent.length === 4 && extent.every((value) => Number.isFinite(value))) {
          map.getView().fit(extent, { size: map.getSize(), padding: [24, 24, 24, 24], maxZoom: 16 });
        }
      };

      if (boundingbox && boundingbox.length === 4) {
        const [minLon, minLat, maxLon, maxLat] = boundingbox as [number, number, number, number];
        const min = fromLonLat([minLon, minLat]);
        const max = fromLonLat([maxLon, maxLat]);
        fitExtent([Number(min[0]), Number(min[1]), Number(max[0]), Number(max[1])]);
      } else if (vectorSource) {
        const applyFit = () => {
          fitExtent(vectorSource?.getExtent() ?? []);
        };
        vectorSource.on("change", applyFit);
      }
    })();

    return () => {
      cancelled = true;
      restoreRef.current = null;
      instance?.setTarget(undefined);
    };
  }, [open, longitude, latitude, boundingbox, geojson]);

  if (!hasMap) {
    return null;
  }

  return (
    <div className="mt-2">
      <button
        aria-expanded={open}
        className="inline-flex items-center gap-1.5 rounded-full bg-surface-2 px-3 py-1.5 text-[13px] text-ink-2 transition-colors hover:text-ink"
        onClick={() => {
          setOpen((prev) => !prev);
        }}
        type="button"
      >
        <MapPin className="size-3.5" />
        {open ? t("hide_map") : label}
      </button>
      {open ? (
        <div className="relative mt-2">
          <div
            className="zjs-map h-72 w-full overflow-hidden rounded-2xl border border-line animate-fade-in"
            ref={containerRef}
          />
          {longitude && latitude ? (
            <CopyButton
              className="absolute end-2 top-2 z-10 bg-surface font-mono"
              icon={<MapPin className="size-3 shrink-0" />}
              label={`${Number(latitude).toFixed(4)}, ${Number(longitude).toFixed(4)}`}
              value={`${latitude}, ${longitude}`}
            />
          ) : null}
          {longitude && latitude ? (
            <button
              aria-label={t("recenter")}
              className="absolute left-[12px] top-[79px] z-10 grid size-9 place-items-center rounded-full border border-line bg-surface text-ink-2 transition-colors hover:bg-surface-2 hover:text-accent"
              onClick={() => {
                restoreRef.current?.();
              }}
              title={t("recenter")}
              type="button"
            >
              <Crosshair aria-hidden="true" className="size-4.5" />
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
