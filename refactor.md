# obsidian-fountain — Refactor Plan

Status: **Phases 0–7 complete (2026-07-13)** · Owner: Khan · Companion to `architecture.md` (current state)

> All eight phases below are implemented and building clean (typecheck + production build). The syntax core, native-editor flip, in-house highlighter (Fountain Editor merged in), autocomplete, lint, hover, bilingual drift lint and settings tab all landed. `architecture.md` documents the resulting shape. This file is kept as the record of *why*; see the checkboxes for what shipped.

## Vision

Turn the plugin from "outline + stats + PDF over a textarea" into a cohesive **Fountain IDE** inside Obsidian's native editor: syntax highlighting, slash autocomplete, inline lint, and hover type-hints — all driven by **one shared line classifier**, plus the outline/stats/PDF/bilingual features that already exist.

This refactor **absorbs the external "Fountain Editor" plugin's highlighting in-house** (the merge). Once done, that plugin can be disabled; everything lives here, keyed off one activation rule and one settings surface, with no cross-plugin version skew.

## Why merge (recap of the re-decision)

The earlier advice ("keep Fountain Editor, don't replicate") assumed we only wanted highlighting. We now want a whole authoring layer, and:

1. Highlight, autocomplete, lint, and hover are **all CM6 extensions on the same native editor** — committing to one commits to all.
2. They **all want the same line classification**. Today classification is duplicated: this plugin's parser detection helpers *and* Fountain Editor's regexes. Owning one classifier makes highlight/lint/suggest/outline agree by construction, and lets highlighting react to *semantic* signals (e.g. tint an undeclared character cue — the same signal lint uses).

**License note:** re-implement the highlighter from the Fountain spec using our existing detection helpers. Do **not** copy Fountain Editor's source; check its LICENSE before reusing even small pieces. We already own most of the detection logic.

## Guiding principles

- **One syntax core.** A single module classifies a line into a Fountain element; the parser, highlighter, linter, and suggester all consume it. No second regex table.
- **Native editor only.** Every new feature is a CM6 editor extension / `EditorSuggest`. The textarea can host none of them, so it goes (or becomes opt-in).
- **Reuse, don't re-derive.** The parser already extracts scenes, characters, locations, INT/EXT, times-of-day. The file index and suggestions read from that, not new scanners.
- **Backwards compatible content.** `.fountain`, `.LANG.fountain`, and `.fountain.md` all keep working; only *how the editor opens* changes.
- **Ship in slices.** Each phase is independently useful and leaves the plugin working.

---

## Target module map

```
src/
  fountain-syntax.ts     NEW  Canonical element types + stateful line classifier (the syntax core)
  fountain-parser.ts          Outline AST — refactored to build on fountain-syntax
  fountain-index.ts      NEW  buildFileIndex(content) → { characters, locations, times, transitions, sections }
  fountain-highlight.ts  NEW  CM6 ViewPlugin: decorations from the classifier (replaces Fountain Editor)
  fountain-suggest.ts    NEW  EditorSuggest: slash / context autocomplete
  fountain-lint.ts       NEW  @codemirror/lint linter(): structural + typo + bilingual-drift diagnostics
  fountain-hover.ts      NEW  hoverTooltip: per-cue / per-scene stat tooltips
  fountain-lang.ts            Translation-group discovery (unchanged; feeds bilingual lint)
  fountain-stats.ts           Stats + ScriptStatsCache (index cache can mirror this pattern)
  fountain-pdf.ts             PDF export (unchanged)
  fountain-outline-view.ts    Outline (unchanged behavior; drops FountainView-specific paths)
  fountain-view.ts       DEL? Textarea view — removed, or kept as opt-in secondary view
  main.ts                     Bootstrap: registers extensions, editor extensions, suggester, settings tab
```

### Data flow

```
file content ──▶ fountain-syntax.classifyLines ──▶ parser (AST) ──▶ outline / stats / pdf
                          │                          │
                          │                          └─▶ fountain-index (characters, locations, …)
                          ├─▶ fountain-highlight (decorations)                 │
                          ├─▶ fountain-lint (diagnostics) ◀────────────────────┘
                          └─▶ fountain-hover (tooltips)   ◀── stats/index
       user typing ─▶ fountain-suggest ◀── fountain-index (per-file vocabulary)
```

---

## The syntax core (`fountain-syntax.ts`) — heart of the merge

A canonical element enum and a **stateful** classifier (Fountain needs cross-line state: in-dialogue, in-boneyard, prev-blank).

```typescript
export type Element =
  | 'title_page' | 'section' | 'synopsis' | 'scene_heading' | 'transition'
  | 'character' | 'parenthetical' | 'dialogue' | 'lyrics' | 'centered'
  | 'action' | 'note' | 'boneyard' | 'page_break';

export interface LineClass {
  element: Element;
  /** ranges of formatting punctuation to dim/hide (e.g. the leading '.', '~', '@', '=' , '>' '<') */
  marks?: { from: number; to: number; kind: string }[];
}

/** Whole-document pass (parser, index, lint use this). */
export function classifyLines(lines: string[]): LineClass[];

/** Incremental classifier for CM6 (highlighter feeds visible lines, carrying state). */
export class LineClassifier {
  feed(lineText: string, prevBlank: boolean, nextLine: string): LineClass;
}
```

Built on the **already-exported** helpers in `fountain-parser.ts`: `isSceneHeading`, `isStandardTransition`, `isMarkerHeading`, `isCharacterName`, `isAllCaps`, `skipTitlePage`. Phase 0 extracts these into the core and has the parser call the core (no behavior change — verified against existing outline output).

---

## Phased roadmap

Each phase is shippable. Check off as done.

### Phase 0 — Syntax core (no user-visible change)
- [x] Create `fountain-syntax.ts`: `Element`, `LineClass`, `classifyLines`, `LineClassifier`.
- [x] Move/adapt detection helpers from `fountain-parser.ts` into the core; parser imports them back.
- [x] Refactor `parseFountainOutline` to consume `classifyLines` (or at least share helpers).
- [x] Verify: outline + stats output identical on existing test scripts (diff the parsed AST before/after).

### Phase 1 — Native editor default (the gating step)
- [x] `main.ts`: `registerExtensions(['fountain'], 'markdown')` so `.fountain` opens in CM6.
- [x] Remove `FountainView` (or keep as opt-in secondary view — see Open Decisions).
- [x] Outline cleanup: drop `FountainView`/`getCurrentContent`/`scrollToLine`/`fountain:content-changed` paths; `navigateTo`/`navigateInFile` keep only the `MarkdownView` branch (`getLiveContent` already prefers editor buffer).
- [x] Confirm links/embeds/frontmatter now work in `.fountain` files; outline still updates on `editor-change`.
- [x] Migration note in README: `.fountain` now opens as native markdown; disable Fountain Editor after Phase 2.

### Phase 2 — In-house highlighter (merge)
- [x] `fountain-highlight.ts`: CM6 `ViewPlugin` → `Decoration.line` per element + `Decoration.mark` for formatting punctuation, from `LineClassifier`. Viewport-only for perf.
- [x] CSS in `styles.css`: `.cm-fountain-scene-heading`, `-character`, `-dialogue`, `-parenthetical`, `-transition`, `-section`, `-synopsis`, `-boneyard`, `-centered`, `-lyrics` (+ formatting-char dimming). Theme-aware (light/dark).
- [x] Activation parity with Fountain Editor: highlight when `extension === 'fountain'` **or** basename ends `.fountain` **or** frontmatter `tags`/`cssclasses` include `fountain` (lets people write Fountain in plain `.md`).
- [ ] Settings parity worth keeping: "prefer Obsidian blockquote over forced transition" toggle. *(Not built. Instead the CSS unconditionally neutralizes blockquote chrome on `>`-forced transition/centered lines. Add the toggle only if someone wants real blockquotes inside a screenplay.)*
- [x] Retire the external dependency (docs tell the user to disable Fountain Editor to avoid double decorations).

### Phase 3 — File index + autocomplete
- [x] `fountain-index.ts`: `buildFileIndex(content)` → characters, locations, times-of-day, transitions, sections; cache by path+mtime (mirror `ScriptStatsCache`).
- [x] `fountain-suggest.ts`: `EditorSuggest` — `onTrigger` detects context (slash token or ALL-CAPS cue); `getSuggestions` reads the index; `selectSuggestion` inserts.
  - `/scene`/`INT`/`EXT` → heading skeleton, location autocompletes from used locations, time from DAY/NIGHT/…
  - `/char` or column-0 caps → existing characters (dedup casing), else new.
  - `/transition` → standard vocabulary.
  - `/synopsis`, `/section`, `/note`.
- [x] Trigger char configurable (avoid clash with core Slash Commands — see Risks).

### Phase 4 — Lint
- [x] `fountain-lint.ts`: `@codemirror/lint` `linter()` → `Diagnostic[]`, registered as editor extension.
- [x] Rules: character typo/near-dup (Levenshtein ≤1 vs. cast); cue not followed by dialogue; heading missing INT/EXT or time-of-day; unknown transition; unclosed boneyard/note/centered.

### Phase 5 — Hover type-hints
- [x] `fountain-hover.ts`: `hoverTooltip` — cue → "N scenes · N words · first p.X"; scene → "#N · p.X · ~Yp · N speaking"; location → "N scenes". Reuses stats/index.

### Phase 6 — Bilingual drift lint
- [x] Cross-file diagnostics between translation-group members (`fountain-lang` already finds them): scene-count mismatch, character present in one language but not its counterpart, heading missing in a version.

### Phase 7 — Polish
- [x] Settings tab (consolidate: stats folder, primary language, highlight/lint toggles, suggest trigger).
- [x] Update `architecture.md` to fold in the new modules; retire `refactor.md` or mark phases done.

---

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Registering `.fountain` → `'markdown'` behaves oddly on some vaults | Common pattern; test open/save/rename. Fallback: keep `FountainView` as opt-in and add an "open in native editor" command. |
| Double highlighting while Fountain Editor still enabled | Ship Phase 2 with a clear "disable Fountain Editor" note; detect and warn if it's active. |
| `/` collides with core Slash Commands | Make trigger configurable; scope `onTrigger` to fountain context + block start. |
| Per-keystroke classification cost on big scripts | CM6 decorations are viewport-only; index cached by mtime; lint debounced. |
| Losing textarea users' muscle memory | Native editor is a superset; if needed keep textarea as a switchable view (Open Decisions). |
| Parser refactor (Phase 0) regressions | Gate on an AST diff against current output before/after. |

## Open decisions — resolved

1. **Keep `FountainView` textarea as opt-in, or delete it?** → **Deleted.** `fountain-view.ts` is gone; `.fountain` opens in the native editor. No opt-in textarea shipped.
2. **Suggest trigger char** → `/` at column 0, configurable via `suggestTrigger` in the settings tab. Character cues also fuzzy-match on ALL-CAPS at column 0. `/*` excluded so boneyard openers don't trigger the menu.
3. **How far to unify the parser in Phase 0** → **Shared helpers only.** `parseFountainOutline` keeps its own two-phase algorithm and imports the detection helpers (now in the core); `decomposeHeading` also moved to the core. The parser was *not* rewritten on top of `classifyLines` — the AST-diff gate confirmed byte-identical output, so a deeper rewrite wasn't worth the risk. It remains a possible future cleanup.

### Still open / future

- **Dual dialogue / (MORE)/(CONT'D)** — still out of scope (also unimplemented in PDF). The classifier tags the `^` dual-dialogue mark but nothing consumes it yet.
- **Parser-on-core rewrite** — optional; see decision 3.
- **Blockquote-vs-transition toggle** — see the unchecked Phase 2 item.
- **Index caching** — `buildFileIndex` is recomputed on demand (~10 ms). If large-vault lint/hover ever feels heavy, mirror `ScriptStatsCache` (path+mtime).

## Done already (context)

- Bilingual outline (automatic, columns follow tab order), translation-group discovery (`fountain-lang.ts`), language-filtered PDF. See `architecture.md` → "Multi-language Support".
