# Project conventions

## Commands

- **Dev server**: `deno task dev`
- **Build**: `deno run -A npm:vite build` (run from `map/`)
- **Full build**: `deno task build` — runs tsc then vite build
- All commands runnable from repo root; internally delegate to `map/`

## TypeScript

- Strict mode, no unused locals/parameters, no implicit returns
- Module resolution: bundler, ESNext modules
- Build with `noEmit: true` — Vite handles bundling
- Do NOT use comments in production code unless asked

## Map app structure (`map/`)

- `src/main.ts` — entry point, UI handlers, search, precache
- `src/map.ts` — OpenLayers map setup, tile sources, popup, region overlay
- `src/markers.ts` — NPC and teleport marker rendering, connection lines
- `src/navmesh.ts` — navmesh display (world PMTiles + dungeon static images)
- `src/navlink.ts` — navigation linkage download/cache (IndexedDB)
- `src/navlink_viz.ts` — NavLink graph visualization (nodes as dots, walk/teleport edges as lines, filtered by current layer)
- `src/coord.ts` — coordinate system (SRO ↔ map sector)
- `src/styles.ts` — marker styles, connection styles, layer URLs
- `src/pmtiles_db.ts` — IndexedDB blob cache for PMTiles and other binary assets
- `index.html` — UI layout with material-design panels
- `public/assets/` — static assets (PMTiles, JSON data, icons, map images)

## Python scripts (`scripts/`)

- Run with `uv run scripts/<name>.py` (Python 3.10+)
- Dependencies managed via `uv` (not pip)

## Database

- IndexedDB store name: `archives`, key path: store name is `OpenSilkroadMapPMTilesCache`
- `PMTilesDB.get(key)`, `PMTilesDB.set(key, blob)`, `PMTilesDB.has(key)`
- localStorage keys used for UI state persistence (toggles, layer selection)

## Libraries

- OpenLayers 9.x (`ol/`) — map rendering
- PMTiles 3.x (`pmtiles`) — tile archive format
- Vite 5.x — bundler/dev server (via npm: compatibility in Deno)
- Deno runtime — build tooling
