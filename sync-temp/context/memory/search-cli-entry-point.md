---
name: search-cli-entry-point
description: "Cross-site search runs via `aio-dl.py --search`, NOT `python aio_search_cli.py` directly (no __main__ → silent exit 0, empty stdout AND stderr)"
metadata: 
  node_type: memory
  type: reference
  originSessionId: 96100b5c-6ff9-4200-8ae1-efea8c7250bd
---

`aio_search_cli.py` is a **library module with no `__main__` block**. Running
`python aio_search_cli.py --search "<q>" --search-json` just imports it and
exits 0 with **zero stdout and zero stderr** — it looks like a hang or a "search
produces no output" bug, and is easy to misread as "my change broke search."
It didn't; you used the wrong entry point.

Real entry: **`python aio-dl.py --search "<query-or-URL>" [--search-json | --auto-pick]`**.
`aio-dl.py:main()` (grep `if getattr(args, "search"`, ~line 8539) dispatches to
`aio_search_cli.run_search_mode`. That function's docstring even says "Entry
point called by aio-dl.py when args.search is set." A full run hits ~220 sites +
a ~240s image-quality probe phase, so budget minutes and give it a long timeout.

To test JUST URL-seed resolution without the full cross-site run, call
`aio_search_cli._try_extract_seed_hit("<url>")` in Python — one HTTP GET,
returns a `SearchHit` or None. URL-seed hosts live in `_URL_SEED_HOSTS`
(mangafire.to, comix.to). See the "fix comix" pointer in CLAUDE.md for why comix
keyword search is dead and URL-seed is the usable path.
