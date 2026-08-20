# Vendored wheels

One wheel, for one reason: **Chaquopy's package index publishes no `rapidfuzz`**
(`https://chaquo.com/pypi-13.1/rapidfuzz/` → 404), and PyPI publishes no
platform-independent one. Without it, cross-site search and AniList enrichment
raise `ImportError` on device while downloads keep working — see
`sites/external_metadata.py:_load_rapidfuzz`.

| File | Version | SHA-256 | Size |
|---|---|---|---|
| `rapidfuzz-3.14.5-py3-none-any.whl` | 3.14.5 | `a81737316526ca70207424ce9942f628efb358e6d641dd932cff2c9395b1ca3e` | 64 KB |

## What this wheel is

rapidfuzz's own **pure-Python build**, produced from the official PyPI sdist.
Not a fork, not a substitute matcher, not a repackage — the 37 `.py` files in it
are byte-identical to the ones in a normal desktop `pip install rapidfuzz==3.14.5`.

rapidfuzz ships two backends and picks whichever imports: a compiled `*_cpp`
extension, or the pure-Python `*_py` reference modules it falls back to. That
fallback is upstream's own supported configuration — `pyproject.toml` defaults
to `wheel.cmake = false` and prints *"CMake unavailable, falling back to pure
Python Extension"* — and it is what piwheels and conda-less builds use. So this
needs no NDK, no cross-compilation and no per-ABI artifact: `py3-none-any`
installs on any Python 3, which also means a Chaquopy Python bump does not
invalidate it.

**The two backends are not bit-identical.** `sites/fuzzy_match.py` normalizes
the three codepoints responsible and its header documents the residue;
`tests/test_fuzzy_match.py` re-derives the divergence from the installed
rapidfuzz and fails if it widens. Read that header before changing anything
here — every threshold in the matcher is calibrated to specific score numbers.

## Regenerating it

Any machine, no Android toolchain, but **no `cmake` on `PATH`** (with cmake
present, scikit-build-core would build a host-native extension and the wheel
would stop being portable — `--config-settings` forces the right path
regardless, but check the filename says `py3-none-any` before shipping):

```bash
pip wheel "rapidfuzz==3.14.5" --no-binary rapidfuzz --no-deps --config-settings=wheel.cmake=false -w android/wheels
```

Then verify it is what it claims to be:

```bash
python -c "import zipfile; z=zipfile.ZipFile('android/wheels/rapidfuzz-3.14.5-py3-none-any.whl'); assert not [n for n in z.namelist() if n.endswith(('.so','.pyd','.dll'))], 'native artifacts leaked in'; print(z.read('rapidfuzz-3.14.5.dist-info/WHEEL').decode())"
```

`Root-Is-Purelib: true` and `Tag: py3-none-any` are the two lines that matter.

## Why not build the native wheel

It was the original plan. The measured case against it: the compiled backend is
**16x faster**, which sounds decisive until you attach a unit — a full
search-plus-enrichment operation is ~1950 scorer calls, i.e. **4.9 ms compiled
vs 79 ms pure-Python**, inside a search that spends 60+ seconds on network I/O.
Against that, the native route costs an NDK toolchain, a cross-compiled
per-ABI binary committed to the repo, and a rebuild every time Chaquopy's
Python version moves.

If it is ever wanted anyway, Chaquopy's `server/pypi` build repo is the
documented path and rapidfuzz is a plausible target (Cython + header-only C++
over `rapidfuzz-cpp`, no external native deps). Dropping the built wheels in
here alongside this one and pinning them in `app/build.gradle.kts` is all the
wiring it needs — `fuzzy_match`'s normalization is correct either way, and its
`rapidfuzz_backend()` will start reporting `"cpp"` on device.
