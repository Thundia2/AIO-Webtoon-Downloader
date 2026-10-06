---
name: app-design-language
description: "The Electron UI's design system — shadcn-style HSL-token primitives, DM Sans / JetBrains Mono, blue primary + status tokens, left icon-rail shell; where the tokens and primitives live"
metadata:
  node_type: memory
  type: project
  originSessionId: ad75891c-9519-409e-9289-851928c39a0f
---

The desktop UI (`UI-source/`, React + Vite + Tailwind in an Electron shell) is a
hand-rolled **shadcn/ui-style** system. Match this language when adding UI.

**Tokens (single source of truth):** `src/styles/globals.css` defines every color
as an HSL triple on `:root` (light) and `.dark` (dark); `tailwind.config.js` maps
them to Tailwind color names. Never hardcode hex — use the token classes.
- Core: `background`/`foreground`, `card`, `primary` (a blue — light 220 75% 50%,
  dark 217 75% 58%), `secondary`, `muted`, `accent`, `destructive`, `border`,
  `input`, `ring`. Radius via `--radius` (0.5rem) → Tailwind `rounded-lg/md/sm`.
- Status: `success` (green ~142), `warning` (amber ~38), `info` (blue ~200),
  `destructive` (red). Use `text-warning` / `bg-success/15` / `border-warning/40`,
  etc. (One inconsistency: `Badge` in primitives hardcodes `green-500`/`yellow-500`/
  `red-500` for its success/warning/destructive variants instead of the tokens.)
- Fonts: **DM Sans** (UI, `font-sans`), **JetBrains Mono / Cascadia Code**
  (logs/code, `font-mono` + the `.log-text` 12px utility).

**Theme:** light is the default; dark activates when Electron main adds
`class="dark"` to `<html>` from the Windows system theme (`App.jsx` →
`electronAPI.getTheme` / `onThemeChanged`). Browser dev-mode forces dark. Every
component must read correctly in BOTH — use `dark:` variants or tokens; there's a
native-`<select>`-option dark-mode fallback already in globals.css.

**Shared primitives:** `src/components/ui/primitives.jsx` — `Button` (variants
default/secondary/destructive/ghost/outline; sizes default/sm/lg/icon), `Input`,
`Textarea`, `Label`, `Switch`, `Slider`, `Select`, `Checkbox`, `Card`
(`rounded-lg border bg-card shadow-sm`), `Badge` (rounded-full pill),
`SectionHeader` (uppercase tracking-wider muted label + hairline rule),
`Collapsible`. All take `className` and compose via `cn()` from `@/lib/utils`
(the `@/` alias = `src/`). Prefer these over ad-hoc markup; tab-specific pieces
(e.g. `TapasPremiumCallout` in DownloadTab) live inline in their tab file.
`SettingsTab.jsx` is a two-pane left-category-nav layout — to add a setting,
write a `render*` closure + one `SECTIONS` entry (count badge/routing auto-derive).

**Shell (`App.jsx`):** a 64px left **icon rail** (`w-16`, `bg-card/50`) with
lucide-react icons; tabs = New / Search / Queue / Logs / Settings, plus Library
via the app-icon button. Active tab = `bg-primary/10 text-primary` + a 3px left
indicator bar (`bg-primary rounded-r-full`); queue count is a primary pill badge,
a recent error shows a red dot on Logs. Header bar is `px-5 py-3 border-b
bg-card/30` with a `text-sm font-semibold tracking-wide` h1; a `ResumeBar` is
pinned at the bottom.

**Motion & feel:** subtle only. `animate-slide-in` (0.2s), `animate-slide-up`
(0.15s), `animate-pulse-subtle` (2s) from the tailwind config; callouts fade
between status states (`transition-colors duration-300`) with gradient tints
(`bg-gradient-to-br from-warning/10`). Focus is a 2px `ring` outline; scrollbars
are a themed 8px webkit style; `.glass-panel` (card/0.8 + backdrop-blur) exists
for panels. Helper/hint text is small and quiet (`text-[10px]`/`text-xs`,
`text-muted-foreground`, `leading-snug`).

To verify visuals, run the Vite dev server and drive it (Playwright/preview) in
BOTH themes rather than eyeballing one; `npm run build` from `UI-source/` must
stay clean (~1265 modules).
