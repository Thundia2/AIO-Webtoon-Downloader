from __future__ import annotations

import re
from typing import Dict, List
from urllib.parse import urlparse

from bs4 import BeautifulSoup

from .base import BaseSiteHandler, SiteComicContext

BASE_URL = "https://zeroscann.com"


class ZeroScansSiteHandler(BaseSiteHandler):
    name = "zeroscans"
    domains = ("zeroscann.com", "www.zeroscann.com", "zscans.com", "www.zscans.com")

    def configure_session(self, scraper, args) -> None:
        scraper.headers.update(
            {
                "Referer": f"{BASE_URL}/",
            }
        )

    # -- Base overrides ----------------------------------------------
    def fetch_comic_context(
        self, url: str, scraper, make_request
    ) -> SiteComicContext:
        # URL: https://zeroscann.com/manga/{slug}
        parsed = urlparse(url)
        path_parts = [p for p in parsed.path.split("/") if p]
        slug = path_parts[-1]

        resp = scraper.get(url)
        resp.raise_for_status()
        soup = BeautifulSoup(resp.text, "lxml")

        body = soup.find("body")
        comic_id = body.get("data-comic-id") if body else None
        title_tag = soup.find("h1")
        title = title_tag.get_text(strip=True) if title_tag else slug

        comic = {
            "slug": slug,
            "title": title,
            "_comic_id": comic_id,
            "_base_url": url.rstrip("/"),
        }

        return SiteComicContext(
            comic=comic,
            title=title,
            identifier=slug,
            soup=soup,
        )

    def _get_last_page(self, soup: BeautifulSoup) -> int:
        """Extract the last page number from the pagination buttons."""
        # Buttons use onclick="location.href='...?page=N'"
        page_nums = [
            int(m) for m in re.findall(r"\?page=(\d+)", soup.decode())
        ]
        return max(page_nums) if page_nums else 1

    def get_chapters(
        self, context: SiteComicContext, scraper, language: str, make_request
    ) -> List[Dict]:
        base_url = context.comic["_base_url"]
        chapters = []
        seen = set()

        last_page = self._get_last_page(context.soup)

        for page in range(1, last_page + 1):
            if page == 1:
                soup = context.soup
            else:
                resp = scraper.get(f"{base_url}?page={page}")
                resp.raise_for_status()
                soup = BeautifulSoup(resp.text, "lxml")

            links = soup.select("a[href*='/chapter-']")
            for a in links:
                href = a.get("href", "")
                if not href or href in seen:
                    continue
                seen.add(href)

                chap_id = a.get("data-chapter-id", "")
                m = re.search(r"/chapter-(\d+(?:\.\d+)?)$", href)
                num = m.group(1) if m else href.split("/chapter-")[-1]

                chapters.append({
                    "hid": chap_id or num,
                    "chap": num,
                    "title": f"Chapter {num}",
                    "url": href,
                })

        # Sort ascending by chapter number
        chapters.sort(key=lambda c: float(c["chap"]) if c["chap"].replace(".", "", 1).isdigit() else 0)
        return chapters

    def get_chapter_images(self, chapter: Dict, scraper, make_request) -> List[str]:
        url = chapter["url"]
        resp = scraper.get(url)
        resp.raise_for_status()
        soup = BeautifulSoup(resp.text, "lxml")

        images = []
        for img in soup.find_all("img"):
            src = img.get("src") or img.get("data-src") or ""
            if not src or src.startswith("data:"):
                continue
            # Filter to CDN image URLs (not site assets)
            if re.search(r"\.(jpg|jpeg|png|webp|gif)(\?|$)", src, re.I) and "zeroscann.com/assets" not in src:
                if src not in images:
                    images.append(src)

        return images
