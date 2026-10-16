// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

/** The boot-ghost building blocks: the exact markup mirror of
    skeleton.html's shapes, styled by the shared `.zjs-boot*` geometry in
    styles/boot.css.  The server shell renders the same classes, and the
    client ghosts here (PageFallback in app.tsx, the overlay PanelSkeleton,
    ThreadGhost, the knowledge loading rows) assemble from these blocks —
    one CSS family keeps every boot handover shift-free.  Bars only: the
    labels are locale-owned, the geometry is not. */

/** ghost HeaderActions: the 36px circles of the real icon buttons */
export function BootActions() {
  return (
    <div aria-hidden="true" className="zjs-boot-actions">
      <span className="zjs-skeleton zjs-boot-action" />
      <span className="zjs-skeleton zjs-boot-action" />
      <span className="zjs-skeleton zjs-boot-action" />
    </div>
  );
}

/** the segment-tab card (knowledge's 8-way tablist, preferences' tabs) */
export function BootTabCard({ tabs = 5 }: { tabs?: number }) {
  return (
    <div aria-hidden="true" className="zjs-boot-k-tabs">
      {Array.from({ length: tabs }, (_, i) => (
        <span className="zjs-skeleton zjs-boot-k-tab" key={i} />
      ))}
    </div>
  );
}

/** the knowledge search box (rounded-2xl card, h-7 input line) */
export function BootSearchCard() {
  return (
    <div aria-hidden="true" className="zjs-boot-k-search">
      <span className="zjs-skeleton zjs-boot-k-q" />
    </div>
  );
}

/** the directory-row card: the thread rows' anatomy (py-5 rows over a
    divide-y rounded-2xl card) — serves the knowledge directory, the
    hybrid-search hits and the memory timeline alike while they load */
export function BootRowsCard({ rows = 4 }: { rows?: number }) {
  return (
    <div aria-busy="true" className="zjs-boot-k-rows">
      {Array.from({ length: rows }, (_, i) => (
        <div className="zjs-boot-k-row" key={i}>
          <span className="zjs-skeleton zjs-boot-k-row-title" />
          <span className="zjs-skeleton zjs-boot-k-row-sub" />
          <span className="zjs-skeleton zjs-boot-k-row-meta" />
        </div>
      ))}
    </div>
  );
}

/** preferences' setting rows: label + boxed control */
export function BootPrefsRows() {
  return (
    <div aria-hidden="true" className="zjs-boot-prefs-rows">
      {Array.from({ length: 5 }, (_, i) => (
        <div className="zjs-boot-prefs-row" key={i}>
          <span className="zjs-skeleton zjs-boot-prefs-label" />
          <span className="zjs-skeleton zjs-boot-prefs-control" />
        </div>
      ))}
    </div>
  );
}

/** the engine-stats table ghost (4 fixed-ish columns, hairline rows) */
export function BootStatsTable() {
  return (
    <div aria-hidden="true" className="zjs-boot-stats">
      {Array.from({ length: 7 }, (_, i) => (
        <div className="zjs-boot-stats-row" key={i}>
          <span className="zjs-skeleton zjs-boot-stats-cell is-w1" />
          <span className="zjs-skeleton zjs-boot-stats-cell is-w2" />
          <span className="zjs-skeleton zjs-boot-stats-cell is-w3" />
          <span className="zjs-skeleton zjs-boot-stats-cell is-w4" />
        </div>
      ))}
    </div>
  );
}

/** the doc heading bar + prose lines (InfoPage's article rhythm) */
export function BootDocTitle() {
  return <span className="zjs-skeleton zjs-boot-doc-title" />;
}

export function BootProse() {
  return (
    <div aria-hidden="true" className="zjs-boot-doc-rows">
      <span className="zjs-skeleton zjs-boot-doc-line" />
      <span className="zjs-skeleton zjs-boot-doc-line" />
      <span className="zjs-skeleton zjs-boot-doc-line" />
      <span className="zjs-skeleton zjs-boot-doc-line" />
      <span className="zjs-skeleton zjs-boot-doc-line" />
    </div>
  );
}

/** the AI run head: the real title when it is known at boot (the
    takeover's query), a holding bar otherwise (the thread page restores
    its title from the browser store) */
export function BootRunHead({ title }: { title?: string }) {
  return (
    <div className="zjs-boot-ai-head">
      {title !== undefined ? (
        <div className="zjs-boot-ai-title">{title}</div>
      ) : (
        <span className="zjs-skeleton zjs-boot-ai-title-bar" />
      )}
      <div aria-hidden="true" className="zjs-boot-ai-process">
        <span className="zjs-skeleton zjs-boot-ai-glyph" />
        <span className="zjs-skeleton zjs-boot-ai-label" />
        <span className="zjs-skeleton zjs-boot-ai-count" />
      </div>
      {/* the phase strip's ghost: THREE segments (规划→检索→撰写) */}
      <div aria-hidden="true" className="zjs-boot-ai-phases">
        {[0, 1, 2].map((i) => (
          <span className="zjs-boot-ai-phase" key={i}>
            <span className="zjs-boot-ai-phase-dot" />
            <span className="zjs-skeleton zjs-boot-ai-phase-bar" />
          </span>
        ))}
      </div>
      {/* the research box at zero events holds ONLY the planning note */}
      <div aria-hidden="true" className="zjs-boot-ai-box">
        <span className="zjs-skeleton zjs-boot-ai-note" />
      </div>
    </div>
  );
}

/** the run's sources rail: AiSearchSourcesSkeleton's exact footprint —
    ONE column of four 188px cells at every width */
export function BootSourceRail() {
  return (
    <div aria-hidden="true" className="zjs-boot-ai-side">
      <div className="zjs-boot-ai-src-head">
        <span className="zjs-skeleton zjs-boot-ai-src-glyph" />
        <span className="zjs-skeleton zjs-boot-ai-src-title" />
      </div>
      {[0, 1, 2, 3].map((i) => (
        <span className="zjs-skeleton zjs-boot-ai-src" key={i} />
      ))}
    </div>
  );
}

/** the run ghost's two-column band: head full-width, then the rail level
    with the (empty) lead column from lg — the real run section's layout */
export function BootRunBody({ title }: { title?: string }) {
  return (
    <>
      <BootRunHead title={title} />
      <div aria-hidden="true" className="zjs-boot-ai-cols">
        <div className="zjs-boot-ai-lead" />
        <BootSourceRail />
      </div>
    </>
  );
}
