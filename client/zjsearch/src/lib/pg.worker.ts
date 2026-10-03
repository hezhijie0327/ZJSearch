// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

/** The PGlite WEB WORKER entry: the database engine (the ~3MB WASM plus
    its data extensions) lives here, off the page's main thread -- a boot
    or a heavy query can no longer eat the render budget (the AI surfaces'
    Lighthouse floors paid for exactly that).  The main thread talks to it
    through the `PGliteWorker` relay (pg.ts) -- same query/transaction/live
    surface, zero call-site changes.

    Only the DATA extensions ride inside the worker (vector / pg_textsearch
    / pg_trgm); the LIVE plugin runs main-side (its polling wraps the
    relayed queries).  The IndexedDB dataDir is worker-accessible (same
    origin), and the worker holds the ONLY connection to it -- the main
    thread never opens a competing handle. */

import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { worker } from "@electric-sql/pglite/worker";
import { pg_textsearch } from "@electric-sql/pglite-pg_textsearch";
import { vector } from "@electric-sql/pglite-pgvector";

worker({
  init: async (options) => {
    const pg = new PGlite(options.dataDir ?? "idb://zjs-ai", {
      ...options,
      extensions: { vector, pg_textsearch, pg_trgm },
    });
    // the extensions register their SQL side here, INSIDE the worker (the
    // main thread never holds a competing connection)
    await pg.query("CREATE EXTENSION IF NOT EXISTS vector");
    await pg.query("CREATE EXTENSION IF NOT EXISTS pg_textsearch");
    await pg.query("CREATE EXTENSION IF NOT EXISTS pg_trgm");
    return pg;
  },
});
