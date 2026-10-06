"""Offline regression test for the sidecar auxiliary-asset subsystem
(tapas.io + webtoons motion/audio faithful-archival, local feature branch).

Deterministic, no network — run from the repo root:
    python tools/_test_sidecar_aux.py

Covers the fiddly pure-logic pieces (the live handler I/O is smoke-tested
separately against tapas.io / webtoons.com):
  1. webtoons motion-toon manifest parsing — LineWebtoonSiteHandler.
     _extract_motion_toon_pages: `assets.image` (singular, BDCoMa ref) AND
     legacy `assets.images` (plural); every image entry becomes a page (the
     old `if "layer" not in key` filter dropped "0001-<name>" keys); sounds
     from `assets.sound` become audio_download specs; raw manifest + layer map
     captured.
  2. aux embedding pipeline — _materialize_chapter_aux fetches specs into
     in-memory (`_aio/<name>`, bytes) members + a CBZ-relative record; the
     members are written INSIDE the chapter CBZ; build_per_chapter_comic_info_xml
     embeds the record as <AioChapterResources>; build_cbz_from_content PRESERVES
     `_aio/` members (per-chapter namespaced, never renumbered into a page);
     _scan_chapter_cbz_aux reads the rollup back out of the CBZs;
     _patch_details_json_with_assets merges it into details.json;
     --refresh-rewrite-cbz preserves BOTH the `_aio/` files and the
     <AioChapterResources> pointer. No _assets/ dir, no assets.json.
  3. flatten guard — animated GIF/APNG survive recompress_chapter_images_to_webp
     and recompress_chapter_images_modern byte-for-byte;
     _warn_animated_flatten_once fires once.
  4. webtoons BGM resolution — episodeBgmList parse + AudioCloud token decode +
     has_bgm flag on the embedded record.

Cross-file: sites/base.py AssetSpec, sites/linewebtoon.py, aio-dl.py. See the
two "Sidecar auxiliary assets" / "Animated images" architectural invariants in
CLAUDE.md.
"""
from __future__ import annotations

import base64
import importlib
import io
import json
import os
import shutil
import sys
import tempfile
import contextlib

# Repo root on path so `import sites...` + the hyphenated aio-dl module load.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from PIL import Image  # noqa: E402
from sites.base import AssetSpec  # noqa: E402
from sites.linewebtoon import LineWebtoonSiteHandler  # noqa: E402

aio = importlib.import_module("aio-dl")


# ------------------------------------------------------------ 1. motion parsing
class _FakeResp:
    def __init__(self, obj):
        self._obj = obj
        self.content = json.dumps(obj).encode("utf-8")

    def json(self):
        return self._obj


def _run_motion(manifest):
    h = LineWebtoonSiteHandler()
    html = (
        "<div id='ozViewer'></div><script>var x={"
        "documentURL: 'https://web.cdn/doc/motion.json', "
        "jpg: 'https://web.cdn/doc/{=filename}'};</script>"
    )

    def make_request(url, scraper):
        return _FakeResp(manifest)

    chapter = {"chap": "5", "url": "https://www.webtoons.com/ep"}
    pages = h._extract_motion_toon_pages(html, None, make_request, chapter)
    return pages, chapter.get("_aux_assets") or []


def test_motion_toon_parsing():
    # Singular `image` + sounds.
    pages, aux = _run_motion({
        "assets": {
            "image": {"layer_002": "b.png", "layer_001": "a.png"},
            "sound": {"bgm.mp3": "sound/bgm.mp3"},
        }
    })
    assert pages == ["https://web.cdn/doc/a.png", "https://web.cdn/doc/b.png"], pages
    assert sum(1 for a in aux if a.type == "audio_download") == 1
    assert any(a.type == "motion_manifest" and a.data for a in aux)
    assert any(a.type == "motion_layer" for a in aux)

    # Legacy plural `images`, no sounds.
    pages, aux = _run_motion({"assets": {"images": {"layer_001": "x.png"}}})
    assert pages == ["https://web.cdn/doc/x.png"], pages
    assert sum(1 for a in aux if a.type == "audio_download") == 0

    # Realistic BDCoMa keys "NNNN-name", MIXED layer/non-layer — the old
    # "layer"-filter dropped 0001-v0l9owrjb1; assert ALL survive in index order.
    pages, aux = _run_motion({
        "assets": {
            "image": {
                "0001-v0l9owrjb1": "assets/motion/image/v0l9owrjb1.png",
                "0000-layerws528ac0a": "assets/motion/image/layerws528ac0a.jpg",
                "0002-abc": "assets/motion/image/abc.png",
            },
            "sound": {"audiozwfbkvj9c.mp3": "assets/motion/sound/audiozwfbkvj9c.mp3"},
        }
    })
    assert pages == [
        "https://web.cdn/doc/assets/motion/image/layerws528ac0a.jpg",
        "https://web.cdn/doc/assets/motion/image/v0l9owrjb1.png",
        "https://web.cdn/doc/assets/motion/image/abc.png",
    ], pages
    audio = [a for a in aux if a.type == "audio_download"]
    assert len(audio) == 1
    assert audio[0].source_url == "https://web.cdn/doc/assets/motion/sound/audiozwfbkvj9c.mp3"
    print("  [ok] motion-toon parsing (image/images, layer fallback, sounds)")


# ---------------------------------------------------- 2. aux embedding pipeline
def test_aux_embedding_pipeline():
    import zipfile
    tmp = tempfile.mkdtemp(prefix="aio_aux_")
    try:
        out_dir = os.path.join(tmp, "manga", "S")
        os.makedirs(out_dir, exist_ok=True)

        def fake_mr(url, scraper):
            class R:
                content = b"ID3\x03fakebytes"
                status_code = 200
            return R()

        specs = [
            AssetSpec(type="motion_manifest", data=b'{"a":1}', filename="motion.json"),
            AssetSpec(type="motion_layer", meta={"layers": [{"key": "0000-a", "page": 0}]}),
            AssetSpec(type="audio_download", source_url="https://cdn/bgm.mp3", filename="bgm.mp3"),
            AssetSpec(type="audio_reference", source_url="https://w.soundcloud.com/t/1",
                      meta={"provider": "soundcloud"}),
        ]

        # 2a. materialize -> (record, members): paths CBZ-relative _aio/…,
        #     members in-memory (arcname, bytes), NO loose _assets/ dir.
        rec, members = aio._materialize_chapter_aux(specs, None, fake_mr)
        member_map = dict(members)
        assert set(member_map) == {"_aio/motion.json", "_aio/bgm.mp3"}, member_map
        assert member_map["_aio/motion.json"] == b'{"a":1}'
        assert member_map["_aio/bgm.mp3"] == b"ID3\x03fakebytes"
        assert rec["motion_manifest"] == "_aio/motion.json"
        assert rec["audio"] == ["_aio/bgm.mp3"]
        assert rec["audio_refs"] == [{"url": "https://w.soundcloud.com/t/1", "provider": "soundcloud"}]
        assert rec["layers"] == [{"key": "0000-a", "page": 0}]
        assert not os.path.exists(os.path.join(out_dir, "_assets"))
        assert aio._materialize_chapter_aux([], None, fake_mr) == (None, [])

        # 2b. ComicInfo embeds the record; Aio elements present WITH aux (paths
        #     the CBZ-relative _aio/…), absent WITHOUT.
        import xml.dom.minidom as MD
        xml_aux = aio.build_per_chapter_comic_info_xml(
            series_title="S", chapter_title="Ep", chapter_num="5", volume=None,
            scanlator="T", web_url="u", uploaded_epoch=0,
            comic_info={"authors": [], "genres": []}, publishers=["T"], lang="en",
            page_count=1, aux_records=rec)
        MD.parseString(xml_aux)
        for tag in ("<AioChapterResources>", "<AioMotionManifest>",
                    "<AioAudioFile>_aio/bgm.mp3</AioAudioFile>",
                    "<AioAudioReference", 'provider="soundcloud"'):
            assert tag in xml_aux, tag
        xml_bare = aio.build_per_chapter_comic_info_xml(
            series_title="S", chapter_title="", chapter_num="1", volume=None,
            scanlator=None, web_url=None, uploaded_epoch=0,
            comic_info={"authors": [], "genres": []}, publishers=[], lang="en",
            page_count=1)
        MD.parseString(xml_bare)
        assert "Aio" not in xml_bare

        # 2c. Build a per-chapter CBZ the pipeline's way: image renumbered +
        #     _aio/ members verbatim + ComicInfo. Aux rides INSIDE the zip.
        page = os.path.join(tmp, "p.jpg")
        with open(page, "wb") as f:
            f.write(b"\xff\xd8\xff\xe0JFIFpage")
        cbz = os.path.join(out_dir, "Ch.0005.cbz")
        with zipfile.ZipFile(cbz, "w") as zf:
            zf.write(page, "0000.jpg")
            for arc, data in members:
                zf.writestr(arc, data)
            zf.writestr("ComicInfo.xml", xml_aux)
        with zipfile.ZipFile(cbz) as zf:
            assert set(zf.namelist()) == {
                "0000.jpg", "_aio/motion.json", "_aio/bgm.mp3", "ComicInfo.xml"}
            assert zf.read("_aio/bgm.mp3") == b"ID3\x03fakebytes"

        # 2d. _scan_chapter_cbz_aux reads the rollup back out of the CBZ (keyed by
        #     ComicInfo <Number>).
        scanned = aio._scan_chapter_cbz_aux(out_dir)
        assert set(scanned) == {"5"}, scanned
        assert scanned["5"]["audio"] == ["_aio/bgm.mp3"]

        # 2e. details.json rollup from the CBZ scan (preserves existing keys).
        dp = os.path.join(out_dir, "details.json")
        with open(dp, "w", encoding="utf-8") as f:
            json.dump({"title": "S", "anilist_id": None}, f)
        aio._patch_details_json_with_assets(out_dir, {"audio": True, "motion": True})
        with open(dp, encoding="utf-8") as f:
            d = json.load(f)
        assert d["has_motion"] is True and d["has_audio"] is True
        assert d["title"] == "S"  # preserved
        assert set(d["chapter_assets"]) == {"5"}
        assert d["chapter_assets"]["5"]["audio"] == ["_aio/bgm.mp3"]

        # 2f. Resume-safe: EMPTY aux_seen still re-scans the on-disk CBZ because
        #     details.json already carries the flags (had_flags gate).
        with open(dp, "w", encoding="utf-8") as f:
            json.dump({"title": "S", "has_audio": True}, f)
        aio._patch_details_json_with_assets(out_dir, {"audio": False, "motion": False})
        with open(dp, encoding="utf-8") as f:
            d2 = json.load(f)
        assert set(d2["chapter_assets"]) == {"5"}, d2.get("chapter_assets")

        # 2g. build_cbz_from_content PRESERVES _aio/ members (namespaced per
        #     chapter) and does NOT count them as pages; the image is renumbered.
        combined = os.path.join(tmp, "Combined.cbz")
        aio.build_cbz_from_content(
            [{"type": "cbz_cache", "path": cbz, "chap": 5}],
            combined, "S", {"authors": [], "genres": []}, [], "en")
        with zipfile.ZipFile(combined) as zf:
            names = set(zf.namelist())
            assert "0000.jpg" in names            # page renumbered
            assert "_aio/ch_5/bgm.mp3" in names    # aux preserved + namespaced
            assert "_aio/ch_5/motion.json" in names
            assert zf.read("_aio/ch_5/bgm.mp3") == b"ID3\x03fakebytes"
            ci = zf.read("ComicInfo.xml").decode("utf-8")
            assert "<PageCount>1</PageCount>" in ci  # _aio/ NOT counted as pages

        # 2h. Non-aux CBZ member-copies to the classic layout (no _aio/, no
        #     pollution) — proves zero blast radius on every normal download.
        plain_cache = os.path.join(tmp, "plain.cbz")
        with zipfile.ZipFile(plain_cache, "w") as zf:
            zf.write(page, "0000.jpg")
            zf.writestr("ComicInfo.xml", xml_bare)
        plain_combined = os.path.join(tmp, "PlainCombined.cbz")
        aio.build_cbz_from_content(
            [{"type": "cbz_cache", "path": plain_cache, "chap": 1}],
            plain_combined, "S", {"authors": [], "genres": []}, [], "en")
        with zipfile.ZipFile(plain_combined) as zf:
            assert set(zf.namelist()) == {"0000.jpg", "ComicInfo.xml"}

        # 2i. --refresh-rewrite-cbz preserves BOTH the _aio/ audio AND the
        #     <AioChapterResources> pointer (regression: the old flow dropped it).
        aio._rewrite_cbz_comicinfo(out_dir, {"authors": [], "genres": ["Action"]}, "S", "en")
        with zipfile.ZipFile(cbz) as zf:
            assert "_aio/bgm.mp3" in set(zf.namelist())  # audio survived
            ci = zf.read("ComicInfo.xml").decode("utf-8")
            assert "<AioChapterResources>" in ci          # pointer survived
            assert "<AioAudioFile>_aio/bgm.mp3</AioAudioFile>" in ci
            assert "<Genre>Action</Genre>" in ci          # enrichment applied

        # 2j. Aux-free series → details.json left clean (no scan, no keys).
        clean_dir = os.path.join(tmp, "Clean"); os.makedirs(clean_dir)
        cdp = os.path.join(clean_dir, "details.json")
        with open(cdp, "w", encoding="utf-8") as f:
            json.dump({"title": "Clean"}, f)
        aio._patch_details_json_with_assets(clean_dir, {"audio": False, "motion": False})
        with open(cdp, encoding="utf-8") as f:
            dc = json.load(f)
        assert "chapter_assets" not in dc and "has_audio" not in dc
        print("  [ok] aux embedding (materialize, CBZ embed, preserve, scan, details, refresh)")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


# ------------------------------------------------------------ 3. flatten guard
def test_flatten_guard():
    tmp = tempfile.mkdtemp(prefix="aio_flatten_")
    try:
        gif = os.path.join(tmp, "a.gif")
        apng = os.path.join(tmp, "a.png")
        static = os.path.join(tmp, "s.png")
        frames = [Image.new("RGB", (16, 16), (i * 80, 0, 0)) for i in range(3)]
        frames[0].save(gif, save_all=True, append_images=frames[1:], duration=80, loop=0)
        af = [Image.new("RGBA", (16, 16), (0, i * 80, 0, 255)) for i in range(3)]
        af[0].save(apng, save_all=True, append_images=af[1:], duration=80)
        Image.new("RGB", (16, 16), (10, 200, 10)).save(static)

        assert aio._is_animated_image(gif) is True
        assert aio._is_animated_image(apng) is True   # APNG reports format PNG
        assert aio._is_animated_image(static) is False

        def nframes(p):
            with Image.open(p) as im:
                return getattr(im, "n_frames", 1)

        d = os.path.join(tmp, "w"); os.makedirs(d)
        g2 = shutil.copy(gif, os.path.join(d, "a.gif"))
        out = aio.recompress_chapter_images_to_webp([g2], quality=85, method=4)
        assert out[0].endswith(".gif") and nframes(out[0]) == 3

        d2 = os.path.join(tmp, "m"); os.makedirs(d2)
        g3 = shutil.copy(gif, os.path.join(d2, "a.gif"))
        a3 = shutil.copy(apng, os.path.join(d2, "a.png"))
        out2 = aio.recompress_chapter_images_modern(
            [g3, a3], policy="auto", gray_quality=1.0, color_quality=90, min_saving=0.92)
        assert out2[0].endswith(".gif") and nframes(out2[0]) == 3
        assert out2[1].endswith(".png") and nframes(out2[1]) == 3

        if hasattr(aio._warn_animated_flatten_once, "_warned"):
            del aio._warn_animated_flatten_once._warned
        buf = io.StringIO()
        with contextlib.redirect_stderr(buf):
            aio._warn_animated_flatten_once([static, gif], "epub")
            aio._warn_animated_flatten_once([gif], "epub")
        assert buf.getvalue().count("Animated page") == 1
        print("  [ok] flatten guard (GIF/APNG preserved, warn-once)")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


# ------------------------------------------------------ 4. webtoons BGM resolve
class _FakeTokenResp:
    def __init__(self, status, payload):
        self.status_code = status
        self._payload = payload

    def json(self):
        if self._payload is None:
            raise ValueError("no json")
        return self._payload


class _FakeScraper:
    """Canned Naver AudioCloud token response for any .get() — no network.
    Mirrors the real shape: {"result":{"playToken": base64(json{audioInfo:{url,
    codec}})}}."""
    def __init__(self, status=200, url="https://cdn/x.m4a", codec="AAC",
                 include_token=True):
        self.status, self.url, self.codec = status, url, codec
        self.include_token = include_token
        self.calls = []

    def get(self, url, timeout=None):
        self.calls.append(url)
        if not self.include_token:
            return _FakeTokenResp(self.status, {"result": {}})
        inner = json.dumps({"audioInfo": {"url": self.url, "codec": self.codec}})
        tok = base64.b64encode(inner.encode()).decode()
        return _FakeTokenResp(self.status, {"result": {"playToken": tok}})


def test_bgm_resolution():
    h = LineWebtoonSiteHandler()

    # 1. episodeBgmList balanced-bracket extraction (present + absent).
    html = ('<script>window.__audioProperties__ = { staticUrl: "x", '
            'imageViewer: "#_imageList", episodeBgmList: '
            '[{"titleNo":679,"episodeNo":21,"sortOrder":1,'
            '"audioId":"ABC123","filePath":"679_21/x.mp3"}] };</script>')
    lst = h._extract_episode_bgm_list(html)
    assert len(lst) == 1 and lst[0]["audioId"] == "ABC123", lst
    assert h._extract_episode_bgm_list("<html>no audio here</html>") == []
    assert h._extract_episode_bgm_list("") == []

    # 2. audioId -> (url, codec); failures -> None (caller falls back).
    sc_ok = _FakeScraper(url="https://cdn/x.m4a", codec="AAC")
    assert h._resolve_audiocloud_url("ABC123", sc_ok) == ("https://cdn/x.m4a", "AAC")
    assert "ABC123" in sc_ok.calls[0] and "quality=MIDDLE" in sc_ok.calls[0]
    assert "acceptCodecs=AAC,MP3" in sc_ok.calls[0]
    assert h._resolve_audiocloud_url("ABC", _FakeScraper(status=400)) is None
    assert h._resolve_audiocloud_url("ABC", _FakeScraper(include_token=False)) is None

    # 3. end-to-end specs: one audio_download, named + flagged.
    specs = h._resolve_bgm_specs(html, _FakeScraper(url="https://cdn/x.m4a", codec="AAC"))
    assert len(specs) == 1
    s = specs[0]
    assert s.type == "audio_download" and s.source_url == "https://cdn/x.m4a"
    assert s.filename == "bgm_21_1.m4a", s.filename
    assert s.meta.get("has_bgm") is True and s.meta.get("audio_id") == "ABC123"
    # MP3 codec -> .mp3 extension.
    specs_mp3 = h._resolve_bgm_specs(html, _FakeScraper(codec="MP3"))
    assert specs_mp3[0].filename == "bgm_21_1.mp3", specs_mp3[0].filename
    # No episodeBgmList -> no specs (caller emits the presence marker).
    assert h._resolve_bgm_specs("<html/>", _FakeScraper()) == []

    # 4. the writer flags has_bgm from an audio_download meta (so a BGM chapter
    #    is marked even if the byte-download had failed) + lists the file.
    def fake_mr(url, scraper):
        class R:
            content = b"\x00\x00\x00\x18ftypM4A "
            status_code = 200
        return R()

    rec, members = aio._materialize_chapter_aux(
        [AssetSpec(type="audio_download", source_url="https://cdn/bgm.m4a",
                   filename="bgm_21_1.m4a",
                   meta={"provider": "webtoons_bgm", "has_bgm": True})],
        None, fake_mr)
    assert rec["has_bgm"] is True, rec  # from meta (set before the fetch)
    assert rec["audio"] == ["_aio/bgm_21_1.m4a"], rec["audio"]
    assert dict(members) == {"_aio/bgm_21_1.m4a": b"\x00\x00\x00\x18ftypM4A "}
    print("  [ok] BGM resolution (episodeBgmList parse, token decode, specs, has_bgm flag)")


if __name__ == "__main__":
    print("sidecar/aux offline regression:")
    test_motion_toon_parsing()
    test_aux_embedding_pipeline()
    test_flatten_guard()
    test_bgm_resolution()
    print("ALL PASSED")
