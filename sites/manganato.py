from __future__ import annotations

from typing import Dict, List, Optional
from urllib.parse import urljoin, urlparse

from bs4 import BeautifulSoup, FeatureNotFound

from .base import BaseSiteHandler, SiteComicContext


_MANGANATO_DOMAINS = (
    "mangabats.com",
    "www.mangabats.com",
    "mangakakalot.fan",
    "www.mangakakalot.fan",
    "mangakakalot.gg",
    "www.mangakakalot.gg",
    "mangakakalove.com",
    "www.mangakakalove.com",
    "manganato.gg",
    "www.manganato.gg",
    "natomanga.com",
    "www.natomanga.com",
    "nelomanga.com",
    "www.nelomanga.com",
    "nelomanga.net",
    "www.nelomanga.net",
    "zazamanga.com",
    "www.zazamanga.com",
    "zinmanga.net",
    "www.zinmanga.net",
    "mangakakalot.com",
    "www.mangakakalot.com",
    "manganelo.com",
    "www.manganelo.com",
)


class ManganatoSiteHandler(BaseSiteHandler):
    name = "manganato"
    domains = _MANGANATO_DOMAINS

    _BASE_URL = "https://www.manganato.gg"

    def __init__(self) -> None:
        try:
            import lxml  # type: ignore  # noqa: F401

            self._parser = "lxml"
        except Exception:
            self._parser = "html.parser"

    # ------------------------------------------------------------------ helpers
    def _make_soup(self, html: str) -> BeautifulSoup:
        try:
            return BeautifulSoup(html, self._parser)
        except FeatureNotFound:
            return BeautifulSoup(html, "html.parser")

    def _slug_from_url(self, url: str) -> str:
        parsed = urlparse(url)
        parts = [p for p in parsed.path.split("/") if p]
        if not parts:
            raise RuntimeError("Invalid Manganato URL.")
        if parts[0] != "manga" and parts[0] != "chapter":
             # Mangakakalot uses /chapter/ sometimes? No, usually /manga/ or /read-
             # Actually, Mangakakalot URLs: https://mangakakalot.com/manga/read_one_piece_manga_online_free4
             # Manganelo: https://manganelo.com/manga/read_one_piece_manga_online_free4
             # Manganato: https://manganato.com/manga-bn978870
             # So /manga/ is common.
             pass
        # Relax check for now or improve it
        if len(parts) < 2:
             raise RuntimeError("Invalid Manganato/Mangakakalot URL.")
        return parts[1]

    def _absolute(self, base: str, href: Optional[str]) -> Optional[str]:
        if not href:
            return None
        href = href.strip()
        if not href:
            return None
        if href.startswith("//"):
            return "https:" + href
        if href.startswith("http"):
            return href
        return urljoin(base, href)

    def _extract_text(self, soup: BeautifulSoup, selectors: List[str]) -> Optional[str]:
        for selector in selectors:
            node = soup.select_one(selector)
            if node:
                text = node.get_text(strip=True)
                if text:
                    return text
        return None

    def _collect_chapter_rows(self, soup: BeautifulSoup, page_url: str) -> List[Dict]:
        results: List[Dict] = []
        selectors = [
            ".list-chapter li a",
            ".chapter-list li a",
            ".row-content-chapter li a",
            ".chapter-list .row a",
        ]
        seen = set()
        for selector in selectors:
            for anchor in soup.select(selector):
                href = anchor.get("href")
                if not href:
                    continue
                absolute = self._absolute(page_url, href) or self._absolute(self._BASE_URL, href)
                if not absolute or absolute in seen:
                    continue
                seen.add(absolute)
                title = anchor.get_text(strip=True)
                date_node = anchor.find_next("span")
                uploaded = date_node.get_text(strip=True) if date_node else None
                results.append(
                    {
                        "title": title or absolute.rsplit("/", 1)[-1],
                        "url": absolute,
                        "uploaded": uploaded,
                    }
                )
        return results

    def _chapter_number(self, title: str) -> str:
        for token in title.replace("#", " ").split():
            if token.replace(".", "", 1).isdigit():
                return token
        return title

    # ----------------------------------------------------------- Base overrides
    def configure_session(self, scraper, args) -> None:
        scraper.headers.setdefault("Referer", self._BASE_URL + "/")

    def _impit_get(self, url: str, referer: str = "") -> str:
        """Fetch via impit (handles zstd/brotli that cloudscraper cannot)."""
        from .crawlee_utils import fetch_html_impit
        headers = {"Referer": referer} if referer else {}
        return fetch_html_impit(url, browser="chrome", headers=headers)

    def fetch_comic_context(self, url: str, scraper, make_request) -> SiteComicContext:
        slug = self._slug_from_url(url)
        try:
            html = self._impit_get(url, referer=self._BASE_URL + "/")
        except Exception:
            html = make_request(url, scraper).text
        soup = self._make_soup(html)

        title = self._extract_text(soup, ["h1.manga-info-title", ".manga-info-text h1", "h1"])
        if not title:
            title = slug.replace("-", " ").title()

        cover = None
        cover_img = soup.select_one(".manga-info-pic img, .info-image img, .manga-info-image img")
        if cover_img:
            cover = self._absolute(url, cover_img.get("data-src") or cover_img.get("data-original") or cover_img.get("src"))

        description = self._extract_text(
            soup,
            [
                "#summary",
                "#noidungm",
                ".description",
                ".manga-info-content",
            ],
        )

        authors: List[str] = []
        for item in soup.select(".manga-info-text li"):
            label = item.find("h2")
            if not label:
                continue
            label_text = label.get_text(strip=True).lower()
            if "author" in label_text:
                content = item.get_text(" ", strip=True)
                parts = content.split(":", 1)
                if len(parts) == 2:
                    authors = [a.strip() for a in parts[1].split(",") if a.strip()]
                break

        genres = [
            a.get_text(strip=True)
            for a in soup.select(".manga-info-text a[href*='/genre/'], .manga-info-genres a")
            if a.get_text(strip=True)
        ]

        comic: Dict[str, object] = {
            "hid": slug,
            "title": title,
            "desc": description,
            "cover": cover,
            "authors": authors,
            "genres": genres,
            "url": url,
        }
        return SiteComicContext(comic=comic, title=title, identifier=slug, soup=soup)

    def _fetch_chapters_api(self, slug: str, series_url: str) -> List[Dict]:
        """Use the manganato.gg JSON API to get all chapters."""
        import json as _json
        from .crawlee_utils import fetch_html_impit
        api_url = f"{self._BASE_URL}/api/manga/{slug}/chapters?limit=-1"
        raw = fetch_html_impit(api_url, browser="chrome", headers={"Referer": series_url})
        data = _json.loads(raw)
        chapters_data = data.get("data", {}).get("chapters", [])
        chapters: List[Dict] = []
        for ch in chapters_data:
            ch_slug = ch.get("chapter_slug", "")
            ch_url = f"{series_url.rstrip('/')}/{ch_slug}" if ch_slug else ""
            num = str(ch.get("chapter_num", ""))
            name = ch.get("chapter_name", ch_slug)
            chapters.append({
                "hid": ch_url,
                "chap": num,
                "title": name,
                "url": ch_url,
                "uploaded": ch.get("updated_at"),
            })
        return chapters

    def get_chapters(self, context: SiteComicContext, scraper, language: str, make_request) -> List[Dict]:
        slug = context.identifier
        source_url = context.comic.get("url") or f"{self._BASE_URL}/manga/{slug}"

        # Primary: use the JSON API (works with impit, handles zstd)
        try:
            chapters = self._fetch_chapters_api(slug, source_url)
            if chapters:
                chapters.sort(key=lambda c: float(c.get("chap") or 0), reverse=True)
                return chapters
        except Exception:
            pass

        # Fallback: parse HTML (works on legacy mangakakalot domains)
        soup = context.soup
        if soup is None:
            try:
                html = self._impit_get(source_url, referer=self._BASE_URL + "/")
            except Exception:
                html = make_request(source_url, scraper).text
            soup = self._make_soup(html)
        chapter_rows = self._collect_chapter_rows(soup, source_url)
        chapters = []
        for row in chapter_rows:
            number = self._chapter_number(row["title"])
            chapters.append({
                "hid": row["url"],
                "chap": number,
                "title": row["title"],
                "url": row["url"],
                "uploaded": row.get("uploaded"),
            })
        chapters.sort(key=lambda c: float(c.get("chap") or 0), reverse=True)
        if not chapters:
            raise RuntimeError("No chapters found for this Manganato title.")
        return chapters

    def get_chapter_images(self, chapter: Dict, scraper, make_request) -> List[str]:
        url = chapter.get("url")
        if not isinstance(url, str):
            raise RuntimeError("Chapter URL missing for Manganato.")
        try:
            html = self._impit_get(url, referer=self._BASE_URL + "/")
        except Exception:
            html = make_request(url, scraper).text
        soup = self._make_soup(html)
        images: List[str] = []
        for img in soup.select("#chapter-content img, .reading-detail img, .page_chapter img, .container-chapter-reader img"):
            src = img.get("data-src") or img.get("data-original") or img.get("src")
            absolute = self._absolute(url, src)
            if absolute and absolute not in images:
                images.append(absolute)
        if not images:
            raise RuntimeError("Unable to locate Manganato chapter images.")
        return images


__all__ = ["ManganatoSiteHandler"]
