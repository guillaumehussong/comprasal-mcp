# COMPRASAL MCP

Query **El Salvador's public procurement data** straight from your AI assistant.

This is a [Model Context Protocol](https://modelcontextprotocol.io) server that wraps the public COMPRASAL API (`comprasal.gob.sv`) — the country's electronic public-purchasing system — so you can ask Claude (or any MCP client) things like:

> *"What did the Ministry of Health award in 2025, and for how much?"*
> *"Show me the latest public contracts and their suppliers."*
> *"Pull the full detail and stage calendar for process 83743."*

All data is public information published by the State under the LACAP procurement law. This server is **read-only**.

---

## What you can ask

Once connected, your assistant gains these tools:

| Tool | What it does |
|------|--------------|
| `search_procurement` | Search awarded processes by institution, year, modality, or free text. Returns supplier, amount, dates, code. |
| `get_process_detail` | Full detail of one process: amounts, dates, and the complete stage calendar. |
| `get_award_report` | Richest view: bidders, planned vs certified amounts, budget codes, signature date. |
| `get_supplier_contracts` | A supplier's public-sector track record: contracts won, by company name (bounded recent scan). |
| `list_institutions` | Resolve an institution name (e.g. "salud") into its id. |
| `list_modalities` / `list_states` / `list_years` | Catalogs for building precise filters. |

---

## Install

Requires [Node.js](https://nodejs.org) 18+.

```bash
git clone https://github.com/guillaumehussong/comprasal-mcp.git
cd comprasal-mcp
npm install
npm run build
npm test
```

## Connect to Cursor

This repo ships a project-level MCP config at `.cursor/mcp.json`. After `npm run build`:

1. Open this folder in Cursor.
2. Go to **Settings → MCP** and enable the **comprasal** server (or restart Cursor).
3. The assistant can call the COMPRASAL tools in Agent mode.

The config runs `node dist/index.js` against the live COMPRASAL API (cache off by default). To override globally, add the same block to your user MCP settings.

## Connect to Claude Desktop

Add this to your `claude_desktop_config.json`:

- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "comprasal": {
      "command": "node",
      "args": ["/absolute/path/to/comprasal-mcp/dist/index.js"]
    }
  }
}
```

Restart Claude Desktop. You'll see the COMPRASAL tools available. Ask it about El Salvador's public spending.

---

## Local cache (opt-in)

By default every request goes to the live COMPRASAL API — a fresh clone behaves identically for everyone. You may opt in to a **local, per-user** response cache to speed up repeated queries within a session:

| Variable | Default | Description |
|----------|---------|-------------|
| `COMPRASAL_CACHE_ENABLED` | `false` | Set to `true` to cache raw API responses on disk |
| `COMPRASAL_CACHE_DIR` | `.comprasal-cache` | Cache directory (gitignored, never committed) |
| `COMPRASAL_CACHE_TTL_MS` | `3600000` (1 hour) | Entry lifetime; expired entries are deleted on read |

The cache is **not** a shared or committed database — it is created at runtime on your machine only. After TTL expiry, the next request fetches live data again. Disable it anytime with `COMPRASAL_CACHE_ENABLED=false`.

---

## Tests

```bash
npm test              # unit + mocked integration only (no network)
npm run test:live     # optional smoke test against real COMPRASAL API (~7s)
```

Tests cover client-side filters, Zod argument validation, file cache behaviour, and mocked HTTP flows.

---

## Notes & caveats

**The upstream government API only filters reliably by institution.** This is the single most important thing to understand about this tool:

- `id_institucion` is the **only** server-side filter that works. Year, free-text search, and date range are **silently ignored** by the COMPRASAL backend.
- This server compensates by filtering **client-side** (over the real award date `fecha_adjudicacion` and text fields), scanning newest-first pages up to a bounded limit.
- **Consequence:** deep historical queries are not practical. Asking for "all contracts from supplier X since January 2025" or "institution Y in 2024" can require scanning thousands of records at ~7s/page — so those tools return a **bounded recent window** and clearly say so in a `coverage` / `filtering` block. A bounded result is never presented as exhaustive.
- **Backend latency is ~7s per request** (this is the government server, not the MCP). Tools make one request per page and cap how many pages they scan, so a call may take 10-50s.
- `get_supplier_contracts` cannot filter by supplier upstream, so it scans the most-recent global records and matches locally. Pass `id_institucion` when you know it — the scan becomes far faster and deeper.
- **Date filters** apply to the award date (`fecha_adjudicacion`) in this server, even though the raw upstream API filters on the process start date.
- `get_award_report` uses a different id than the other endpoints (a known upstream quirk). Prefer `get_process_detail` unless you specifically need the bidder/budget breakdown.
- The dataset holds ~100k+ awarded processes, current through 2026. Each process may appear as several rows (one per lot/supplier).
- Tool arguments are validated with **Zod** before any upstream call; invalid inputs return a clear error without hitting the API.

### Why no local database / committed cache?

This server queries the **live** public API so that **anyone who clones it gets identical results with zero setup** — no pre-scraped dataset, no shared state in the repo. A committed database would mean either hosting a central server (defeating the "run it yourself" model) or asking every user to scrape COMPRASAL first (hours of work).

An **optional, opt-in file cache** is available for convenience: it lives in `.comprasal-cache/` on your machine only (gitignored), expires after 1 hour, and is **off by default**. It does not change what a fresh clone returns on first run. A full local-database variant for deep historical analysis remains a possible separate, opt-in project.

## Data, source & legality

Data comes from the public COMPRASAL portal (`comprasal.gob.sv`), accessed through its public, unauthenticated REST API. Public procurement acts are public by law under the **LACAP** (Ley de Adquisiciones y Contrataciones de la Administración Pública). Public registries are excluded from the scope of El Salvador's Personal Data Protection Law (Decreto 144, 2024, art. 3). This project redistributes already-public information for transparency and research purposes and performs no scraping of authenticated areas.

## License

MIT. Not affiliated with or endorsed by the Government of El Salvador.
