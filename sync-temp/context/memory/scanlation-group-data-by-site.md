---
name: scanlation-group-data-by-site
description: "Which sites actually expose scanlation-group data and in what shape — the atsu.moe allChapters/scanlators pairing, MangaDex's inline group flags + its pages:0 external-chapter trap, and the sites that genuinely have no groups; the live-probe recipe for all of it"
metadata: 
  node_type: memory
  type: reference
  originSessionId: ab484533-fd11-4e35-bf1f-b4e30970523b
  modified: 2026-08-02T09:19:55.073Z
---

The **ranker design** (composite tuple, MTL rules, census, `--mtl`/`--exclude-group`)
lives in the repo's `CLAUDE.md` architectural invariant — grep
`select_best_chapter_version` there. Don't re-derive it from here. What follows is
the part that is NOT in the codebase: what each site's API actually gives you, which
is what decides whether a handler *can* have group detection at all.

## atsu.moe (atsumaru) — groups exist, but only on ONE of three endpoints

Three chapter endpoints, and they are not interchangeable:

| Endpoint | Rows (Solo Leveling `oZOG5`) | `scanlationMangaId` | `pageCount` |
|---|---|---|---|
| `/api/manga/allChapters?mangaId=<slug>` | **802** | yes | yes |
| `/api/manga/chapters?id=<slug>&filter=all&sort=desc&page=N` | **601** | **no** | yes |
| `/api/manga/page?id=<slug>` (`mangaPage.chapters`) | first batch only | yes | yes |

The scanlator **names** live nowhere in the chapter rows — only in
`mangaPage.scanlators` = `[{id, name}]`, which you join to each chapter's
`scanlationMangaId`. Solo Leveling returns 4: Alpha, Flame, Asura, Dusk, and all
201 of its distinct chapter numbers have 2–4 competing versions.

**There is no server-side scanlator filter** — `filter=<scanlator id>` answers
HTTP 400. You must pull every version and rank client-side.

Page counts differ legitimately between groups because long-strip chapters are
sliced differently: ch.1 is Alpha 22 / Asura 22 / Flame 19 / Dusk 14 and **all four
are complete**. That measurement is why page count is only ever a stub detector,
never a "more is better" signal.

## MangaDex — the flags are already in the response you're making

`includes[]=scanlation_group` returns a relationship whose `attributes` carry
`official`, `verified`, `inactive`, `description`, `exLicensed`, `focusedLanguages`,
`publishDelay` alongside `name`. No second request needed — a per-group `/group/{id}`
fetch would burn the 40 req/min budget for data already in hand.

**The trap:** licensed publishers (MangaPlus, Viz…) publish chapters that live on
*their* site — `pages: 0` plus `externalUrl` set. `/at-home/server` returns no images,
so the download raises `"MangaDex chapter has no pages."` Live check: **every one of
One Piece's 8 English chapters is that shape.** So "prefer official" must be gated on
downloadability, and these must be **ranked down, never filtered out** — filtering
empties the series entirely.

MTL groups self-identify readily here: `GET /group?name=MTL` returns **52** groups
("MTL Sans", "100% MTL", "Machine Translated", "AI Translations"), and descriptions
like "all the manga here is machine translated" are common. That, plus the inline
`description`, is why regex-over-name+description works without a curated catalog.

## Sites with genuinely no group data — don't try to add it

**weebcentral** credits no scanlator anywhere in its chapter markup. It once derived
one from an inline `svg[stroke]` hex; current markup is `<img src=".../chapter-badge.svg">`
with no inline SVG, so that code matched nothing and returned `None` for every
chapter. Deleted, not repaired — there is no name to recover. **asura** and
**mangareader** likewise. **tapas** and **linewebtoon** have a single constant
per-series label, not per-chapter groups.

## Probing any of it live

No auth needed for either API; plain `urllib` works, atsu.moe just wants a
`Referer: https://atsu.moe/` header. For weebcentral use `curl_cffi` with
`impersonate="chrome124"` (zstd + bot checks); its chapter list is a separate
document at `/series/<id>/full-chapter-list`, and series ids come from
`POST /search/simple?location=main` with form field `text`.

Exercise the parsed result end to end with `aio-dl.py <url> --list-chapters`, whose
JSON now carries a `groups` rollup (name, chapter count, `is_official`, `mtl`,
`missing_count`/`missing_sample`). That rollup is deliberately the *inverted* form —
which chapters a group is MISSING — because a full per-chapter group map is a second
copy of the chapter list, and the UI runs this for every library series on an update
check. See [[search-cli-entry-point]] for exercising a handler by hand and
[[manhuaplus-dead-wordpress-image-host]] for the other class of
site-lies-to-you problem.
