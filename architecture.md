# obsidian-fountain — Architecture

## Overview

An Obsidian plugin that turns the native markdown editor into a **Fountain screenplay IDE**: `.fountain` files open in Obsidian's own CM6 editor with screenplay syntax highlighting, slash autocomplete, inline lint diagnostics, and hover type-hints — plus a sidebar outline panel showing scenes, characters, transitions and per-scene statistics, a vault-wide stats panel, and stitched PDF export. Multi-language screenplays (`bigfish.en.fountain` / `bigfish.vi.fountain`) get side-by-side outlines and cross-language drift diagnostics.

Everything user-facing scopes to the **whole vault** — there is no project/folder setting to configure (the stats panel, the PDF stitch, and the autocomplete vocabulary all scan every `.fountain` file in the vault). The editor and the exported PDF share one bundled screenplay font (**Cousine**, a Courier-metric typewriter face with full Vietnamese / Latin-Extended coverage) so non-Latin text renders correctly and identically on every machine.

Everything editor-facing is driven by **one shared line classifier** (`fountain-syntax.ts`) so the highlighter, linter, suggester, outline and PDF layout agree by construction. See `refactor.md` for the plan that produced this shape.

---

## File Structure

```
obsidian-fountain/
├── src/
│   ├── main.ts                  Plugin bootstrap, settings + settings tab, PDF-export commands
│   ├── fountain-syntax.ts       SYNTAX CORE: element types, detection helpers, stateful line classifier
│   ├── fountain-parser.ts       Fountain → outline AST (single-pass + post-process; helpers re-exported from core)
│   ├── fountain-index.ts        Per-file vocabulary: characters, locations, times, transitions
│   ├── fountain-highlight.ts    CM6 ViewPlugin: screenplay syntax highlighting (replaces the Fountain Editor plugin)
│   ├── fountain-suggest.ts      EditorSuggest: slash menu + character/location/time completion
│   ├── fountain-lint.ts         @codemirror/lint source: structural + typo + bilingual-drift diagnostics
│   ├── fountain-hover.ts        hoverTooltip: character / scene stat tooltips
│   ├── fountain-lang.ts         Language naming convention, translation groups, editor gating helpers
│   ├── fountain-stats.ts        Per-script stats, folder scanning, mtime cache
│   ├── fountain-pdf.ts          Stitch scripts → screenplay-formatted PDF (jsPDF), embedding Cousine
│   ├── fountain-pdf-font.ts     Cousine TTF (base64) embedded into the PDF for Unicode/Vietnamese
│   └── fountain-outline-view.ts ItemView: sidebar outline (single + bilingual) + stats panel
├── styles.css                   Editor highlighting + outline/stats/suggest/hover CSS + bundled Cousine @font-face
├── manifest.json                Plugin id/name/version
├── refactor.md                  The refactor plan this architecture came from
└── architecture.md              This file
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

## Data Model

All types are exported from `fountain-parser.ts`.

```
FountainNode                        top-level AST unit
  .type       FountainNodeType      'section' | 'scene_heading' | 'transition' | 'synopsis'
  .text       string                display text
  .level      number                1–6 for sections; 0 for everything else
  .line       number                0-indexed source line (used for navigation)
  .endLine?   number                last source line of this scene   [scene_heading only]
  .sceneNumber? string              "#42#" from heading, or "1"/"2"/… auto-assigned  [scene_heading only]
  .marker?    boolean               true for marker headings ("OVER BLACK:") — no scene number  [scene_heading only]
  .characters? FountainCharacter[]  speakers in order of first appearance            [scene_heading only]
  .stats?     FountainStats         line/word/page metrics                            [scene_heading only]

FountainCharacter
  .name           string    cleaned name (no extensions like V.O. or CONT'D)
  .line           number    source line of their first dialogue in this scene
  .dialogueCount  number    separate speaking turns in this scene
  .wordCount      number    total words spoken (dialogue only, no parentheticals)

FountainStats
  .lineCount      number    non-blank lines in scene range
  .wordCount      number    all words in scene range (action + dialogue)
  .pageEstimate   number    (endLine − startLine + 1) / 55  → fractional page length
  .startPage      number    Math.max(1, ceil(startLine / 55)) → approximate page in script
```

Characters are **never emitted as top-level nodes**. They are collected per scene and stored in `scene_heading.characters[]` so the outline can render them as indented sub-items without polluting the node list.

---

## Syntax Core (`fountain-syntax.ts`)

The single source of truth for "what Fountain element is this line?". Nothing else in the plugin owns a second regex table.

```typescript
type Element =
  | 'frontmatter' | 'title_page' | 'section' | 'synopsis' | 'scene_heading'
  | 'transition' | 'character' | 'parenthetical' | 'dialogue' | 'lyrics'
  | 'centered' | 'action' | 'note' | 'boneyard' | 'page_break' | 'blank';

interface LineClass {
    element: Element;
    marks?: { from: number; to: number; kind: string }[];   // formatting punctuation, notes, boneyard, scene numbers…
}

classifyLines(lines: string[]): LineClass[]   // whole document (frontmatter + title page + stateful body pass)
class LineClassifier { feed(line, nextLine): LineClass }   // the stateful engine (prevBlank, inDialogue, inBoneyard, inNote)
```

Also exported from here (and re-exported by `fountain-parser.ts` for compatibility): the detection helpers `isAllCaps`, `isSceneHeading`, `isStandardTransition`, `isMarkerHeading`, `isCharacterName`, `skipTitlePage`, `skipFrontmatter`, `stripEmphasis`, and `decomposeHeading`.

`marks` carries ranges the highlighter dims or hides: forced-element punctuation (`.` `@` `>` `~` `=` `!` `#`), centered `> <` pairs, `#N#` scene numbers, `(V.O.)` character extensions, dual-dialogue `^`, and inline `[[note]]` / `/* boneyard */` ranges (which may span lines — the classifier tracks that state).

Consumers: `fountain-parser` (helpers), `fountain-index`, `fountain-highlight`, `fountain-lint`, `fountain-hover` (all via `classifyLines`).

---

## Parser (`fountain-parser.ts`)

### Single exported function

```typescript
parseFountainOutline(content: string): FountainNode[]
```

### Two-phase algorithm

**Phase 1 — linear pass** over every source line:

```
state
  prevBlank      = true   (treat start-of-file as after a blank line)
  currentScene   = null   (last emitted scene_heading node)
  currentSpeaker = null   (name of character whose dialogue we are currently inside)
  sceneChars     = Map<name, { line, dialogueCount, wordCount }>

for each line i:
  if blank:
    prevBlank      ← true
    currentSpeaker ← null          ← blank line ends any dialogue block
    continue

  if line matches /^#{1,6} /:      → emit SECTION node;        currentSpeaker ← null
  if line matches /^= text/:       → emit SYNOPSIS node;       currentSpeaker ← null
  if line starts with '>' (not '> … <'):  → emit TRANSITION;  currentSpeaker ← null
  if isSceneHeading():             → finalizeScene(), emit SCENE_HEADING, currentScene ← node
  (strip surrounding **/_ emphasis before the next two checks — "**FADE IN:**" still counts)
  if isStandardTransition():       → emit TRANSITION;          currentSpeaker ← null
  if isMarkerHeading():            → finalizeScene(), emit SCENE_HEADING with marker=true, currentScene ← node
  if isCharacterName():            → sceneChars[name].dialogueCount++; currentSpeaker ← name
  else (dialogue / action / parenthetical):
    if currentSpeaker and not parenthetical:
      sceneChars[currentSpeaker].wordCount += countWords(line)

finalizeScene()   ← attach sceneChars entries to currentScene.characters[]
```

**Phase 2 — post-processing** over `nodes[]`:

```
1. endLine
   for each scene_heading[i]:
     endLine ← scene_heading[i+1].line − 1   (or last line of file)

2. scene numbers
   for each scene_heading (skipping marker headings):
     if no sceneNumber from "#N#" suffix → assign String(autoCounter++)

3. stats
   for each scene_heading:
     stats ← computeSceneStats(lines, node.line, node.endLine)
     (counts non-blank lines and words in that line range)
     startPage = max(1, ceil(node.line / 55))
     pageEstimate = (endLine − startLine + 1) / 55
```

### Detection rules (priority order)

| # | Type | Condition |
|---|---|---|
| 1 | *(skip)* | Title page — file starts with `Key: Value`; skip until first blank line |
| 2 | `section` | Raw line matches `/^#{1,6}\s+/` |
| 3 | `synopsis` | Trimmed line matches `/^=\s+/` |
| 4 | `transition` (forced) | Starts with `>` AND does not end with `<` |
| 5 | `scene_heading` | `prevBlank` AND (`.` force prefix OR `INT/EXT/INT./EXT./I/E/EST` prefix AND ALL CAPS) |
| 6 | `transition` (standard) | `prevBlank` AND ALL CAPS AND (ends `TO:` OR matches `FADE (IN\|OUT)[.:]`) — surrounding `**`/`_` emphasis stripped first |
| 7 | `scene_heading` (marker) | `prevBlank` AND ALL CAPS AND ends `:` — e.g. `OVER BLACK:`, `TITLE OVER:`, `INTERCUT WITH:`. A scene-level container (collects characters and stats) but gets **no scene number**. Checked after rule 6, so `TO:` transitions win |
| 8 | character *(collected)* | `prevBlank` AND ALL CAPS AND next line is dialogue (mixed case) or parenthetical `(…)` |
| 9 | *(ignored)* | Action, dialogue, parenthetical — counted for word stats only |

### ALL CAPS test

```typescript
function isAllCaps(trimmed: string): boolean {
    const alpha = trimmed.replace(/[^A-Za-z]/g, '');
    return alpha.length > 0 && alpha === alpha.toUpperCase();
}
```

Stripping non-alpha characters before comparing means `WILL'S DATE`, `EDWARD (V.O.)`, `CUT TO:` all pass, while `He walked.` fails.

### Character vs. action disambiguation

The critical heuristic: an ALL CAPS line is a **character** only when its immediate next line is non-blank and contains lowercase letters (dialogue) or starts with `(` (parenthetical). This correctly handles:

| Line | Followed by | Detected as |
|---|---|---|
| `EDWARD` | `"I didn't put any stock..."` | character ✓ |
| `EDWARD (V.O.)` | `"There are some fish..."` | character ✓ (extensions stripped → `EDWARD`) |
| `ON WILL AND SANDRA` | *(blank)* | ignored (action heading) ✓ |
| `TWO OVERSIZED HANDS` | *(blank)* | ignored ✓ |
| `THE BEAST.` | *(blank)* | ignored ✓ |
| `ANGLE ON Edward.` | — | ignored (contains lowercase) ✓ |

### Character name cleaning

```typescript
function extractCharacterName(text: string): string {
    let name = text.startsWith('@') ? text.slice(1).trim() : text;
    name = name.replace(/\s*\([^)]*\)/g, '').trim();
    return name;
}
```

`EDWARD (V.O.)(CONT'D)` → `EDWARD`.  All parenthetical groups are stripped globally.

### Scene number extraction

Fountain allows explicit scene numbers in `#N#` suffix format:

```
INT. BEDROOM - NIGHT #42#
```

```typescript
function splitSceneNumber(text: string): { text: string; sceneNumber?: string } {
    const m = /#([A-Za-z0-9.\-]+)#\s*$/.exec(text);
    if (m) return { text: text.slice(0, m.index).trim(), sceneNumber: m[1] };
    return { text };
}
```

If no explicit number is present, the post-processor assigns sequential integers (`"1"`, `"2"`, …).

### Page estimation

One page of standard screenplay = approximately 55 lines (Courier 12pt, industry standard). The plugin uses two page metrics:

- **`startPage`** — which page the scene starts on: `Math.max(1, Math.ceil(sceneHeadingLine / 55))`
- **`pageEstimate`** — how many pages the scene occupies: `(endLine − startLine + 1) / 55`

These are rough estimates. They do not differentiate action density, do not account for title page line offset, and do not match Final Draft's exact pagination. They are useful for orientation, not production scheduling.

---

## Editor Layer (native CM6)

`.fountain` opens in Obsidian's **native markdown editor** — `registerExtensions(['fountain'], 'markdown')` in `main.ts`. (The old plain-textarea `FountainView` is gone; the native editor supersedes it and is what lets every extension below attach. Links, embeds, frontmatter and other plugins' editor extensions now work in `.fountain` files.)

### Gating — which editors count as Fountain

All four extensions gate per-editor through `fountain-lang.ts`:

```typescript
fountainFileOf(state: EditorState): TFile | null      // via obsidian's editorInfoField
isFountainAuthoringFile(app, file): boolean           // the same rule for (app, file) callers
```

A file counts as Fountain when its **extension** is `fountain` (includes `x.en.fountain`), its **basename** ends `.fountain` (the `.fountain.md` / `.fountain.txt` wrappers), or its **frontmatter** `tags`/`cssclasses` include `fountain` (Fountain in a plain `.md`) — the same activation rules the external Fountain Editor plugin used.

### Highlighting (`fountain-highlight.ts`)

A `ViewPlugin` that runs `classifyLines` over the document (recomputed on `docChanged`, ~9 ms for a 4,600-line feature) and emits decorations **for the viewport only**: `Decoration.line` with `cm-fountain-<element>` per line plus `Decoration.mark` for the classifier's `marks`. Formatting punctuation gets `cm-fountain-formatting cm-fountain-formatting-<kind>` and is hidden on non-active lines (centered markers become `visibility: hidden` so the text doesn't shift); content ranges (notes, boneyard, `(V.O.)` extensions, scene numbers) get styled directly. The editor container is stamped `is-fountain-script` for CSS scoping, and screenplay lines render in **Cousine** (the bundled Courier-metric font, `@font-face` in `styles.css` — see PDF Export) with block indents (character 14ch, parenthetical 10ch, dialogue 6ch), **bold** character cues, right-aligned bold transitions and centered `> x <` — with the markdown blockquote chrome neutralized on `>`-forced lines. Re-implemented from the Fountain spec; class names follow the `cm-fountain-*` convention so themes targeting the old plugin keep working. If the external Fountain Editor plugin is still enabled, `main.ts` shows a one-time notice suggesting it be disabled to avoid doubled styling.

### Autocomplete (`fountain-suggest.ts` + `fountain-hints.ts`)

One `EditorSuggest` with three trigger contexts (`onTrigger` is line-local and cheap; `getSuggestions` merges the project vocabulary with the live buffer):

| Context | Trigger | Suggests |
|---|---|---|
| Slash menu | trigger char (default `/`, configurable) at column 0 | INT./EXT. skeletons, the **editable dictionary** (transitions, shots/angles, markers — grouped by category), project-used transitions/markers, characters from across the project, and section/synopsis/note/boneyard/centered/lyrics/page-break scaffolds |
| Character cue | ALL CAPS at column 0 after a blank line (≥ 2 chars) | Every character in the project by cue count; mixed-case names insert with forced `@` |
| Scene heading | typing after `INT. ` etc. | Locations used across the project; after ` - `, times of day (project's own + DAY/NIGHT/…) |

Autocomplete has two halves:

- **Curated dictionary** (`fountain-hints.ts`) — a `HintDictionary` of categories (`id`, `label`, `insert: 'plain' | 'transition'`, `entries`). Ships as `DEFAULT_HINTS` (transitions, shots/angles, markers), stored as JSON in `settings.hintsJson`, edited in the settings tab. `parseHintDictionary` returns `null` on any malformed edit so autocomplete silently falls back to the defaults — a broken JSON never breaks the menu. This is where the user adds their own vocabulary and categories.
- **Contextual vocabulary** (vault-wide) — characters, locations, times, transitions, markers aggregated from **every `.fountain` file in the vault** (`gatherProjectFiles()`). The plugin keeps this in `projectVocab: FileIndex`, rebuilt debounced (400 ms) on any fountain-file vault change, with a per-file `path → {mtime, index}` cache so only changed files re-parse. `getSuggestions` does `mergeIndex(cloneIndex(projectVocab), buildFileIndex(liveBuffer))` so unsaved local names and sibling-script names both appear.

**Accepting a suggestion** (`selectSuggestion`): completions that finish an element — character cues (→ dialogue follows), transitions, a time-of-day that finalizes a scene heading, and `===` page breaks — carry `newlineAfter`, so pressing Enter commits the text and drops the cursor to a fresh line (col 0) instead of leaving it on the same line, which would immediately re-trigger the same popup. Scaffolds you keep typing into (`INT. ⟨location⟩`, `⟨location⟩ - ⟨time⟩`, notes, sections, lyrics) leave the cursor in place, honoring `cursorOffset`.

`/*` (boneyard) is excluded from the slash trigger so typing a comment opener doesn't pop the menu. The linter's transition-typo rule reads `plugin.knownTransitions()` (standard + dictionary + project-used), so a deliberate custom transition is never flagged.

### Lint (`fountain-lint.ts`)

A debounced (750 ms) `@codemirror/lint` source. Single-file rules:

| Rule | Severity | Notes |
|---|---|---|
| Near-duplicate character | warning | Cue one edit away from a more frequent cast member. Frequency-ratio guard (flag only 1-cue names or ≥5× rarer) so real similar names — Big Fish's twins PING/JING — aren't flagged |
| Silent cue | warning | ALL-CAPS line matching a known character but with no dialogue after it → Fountain silently reads it as action |
| Transition typo | warning | One edit from a standard transition; also checks marker-style headings, since "CUT TOO:" stops *looking* like a transition and classifies as a marker |
| Missing time-of-day | info | Scene heading without a `" - TIME"` suffix |
| Unclosed boneyard / note | error / warning | `/*` without `*/`; `[[` that hits a blank line before `]]`. A closed opener's mark ends with its close token, so an inline `/*…*/` or `[[…]]` (even one ending exactly at end-of-line) is correctly treated as closed and not flagged |

**Bilingual drift** (separate toggle): when the file has a language infix, each on-disk sibling of its translation group is read (`vault.cachedRead` + `buildFileIndex`) and compared — scene-count mismatch (anchored on the first scene heading) and characters who never speak in the sibling (anchored on their first cue), as `info` diagnostics. Name comparison is case- and diacritic-insensitive.

### Hover type-hints (`fountain-hover.ts`)

`hoverTooltip` (400 ms): hovering a **character cue** shows scenes they speak in, cues, words, and first-appearance page; hovering a **scene heading** shows scene number, start page, estimated length, speaking-cast size, and how many scenes reuse the location. Derived from the outline AST + file index on demand.

**Tooltip theming.** Both these hover tooltips and the lint diagnostic tooltips are styled with Obsidian's CSS variables (`--background-secondary`, `--text-normal`, …) so they follow the active light/dark theme. CodeMirror's baseTheme paints `.cm-tooltip` white, and its hover host wraps the content in a `.cm-tooltip-section`, so the CSS matches `.cm-tooltip:has(.fountain-hover-tooltip)` (descendant, not direct child) plus `.cm-tooltip-lint` — without this the popups render as white slabs in dark mode.

### File index (`fountain-index.ts`)

```typescript
buildFileIndex(content): {
    characters: Map<name, cueCount>,  locations: Map<location, sceneCount>,
    timesOfDay: Map<time, sceneCount>, transitions: Map<text, useCount>,
    markers: Map<text, useCount>, sections: string[], sceneCount: number
}
```

Pure (no Obsidian imports); one `classifyLines` pass + `decomposeHeading` per scene heading; `cueName()` strips `@`, `^` and `(…)` extensions. Rebuilt on demand (~10 ms worst case) — no cache needed at current sizes.

---

## Outline View (`fountain-outline-view.ts`)

```typescript
class FountainOutlineView extends ItemView
```

A sidebar panel (right pane by default) that renders the AST returned by `parseFountainOutline`.

### Layout

`contentEl` is a flex column with two children:

```
div.fountain-outline-list   flex: 1, scrolls — the outline tree (current file)
div.fountain-stats-panel    flex-shrink: 0 — sticky bottom stats panel, max-height 25%
```

### State

```typescript
lastMarkdownView:  MarkdownView | null   // last active fountain editor
collapsedScenes:   Set<string>           // scenes whose character sub-list is folded
expandedStats:     Set<string>           // which stats subpanels are open (default: overview)
statsCache:        ScriptStatsCache      // per-file stats keyed by path + mtime
```

The view is cached because clicking an outline item shifts focus to the outline panel itself, making `getActiveViewOfType()` return null at click-time.

`collapsedScenes` persists collapse state across the re-render that happens on every keystroke. Scenes are keyed by `sceneNumber|text` (`marker|text` for marker headings), so the state survives re-parsing; renaming a heading resets that scene to expanded.

### Event subscriptions

| Event | Handler |
|---|---|
| `workspace.on('active-leaf-change')` | Update `lastMarkdownView`; refresh (skip if new leaf is the outline itself — see Flash Bug below) |
| `workspace.on('file-open')` | Refresh |
| `workspace.on('layout-change')` | Refresh (tab open/close/move — drives automatic bilingual columns) |
| `workspace.on('editor-change')` | Refresh while typing in a fountain file (live update per keystroke) |
| `vault.on('modify')` | Refresh when any fountain file is saved |
| `vault.on('delete'/'rename')` | Invalidate the stats cache entry; refresh |

### Flash bug — why `view === this` guard matters

When the user clicks an outline item, the event sequence is:

```
mousedown  →  focus shifts to outline panel
           →  active-leaf-change fires
           →  without the guard: refresh() runs, listEl.empty() destroys the DOM
mouseup    →  click fires on... the now-destroyed element → nothing happens
```

The guard `if (view === this) return;` stops the refresh when the outline itself gains focus. The DOM survives, the `click` event fires normally on the next `mouseup`.

### Refresh logic

```
1. Determine activeFile:
     workspace.getActiveFile()  (may be null if outline has focus)
     → fall back to lastMarkdownView.file

2. Get content via getLiveContent(file):
     the open editor's buffer (editor.getValue()) if the file is open in any leaf
     otherwise → vault.cachedRead(file)

3. parseFountainOutline(content) → nodes[]

4. renderNodes(ctx, nodes)  → outline tree (one ctx per column in bilingual mode)
   renderStats(...)         → sticky bottom panel
```

### File extension matching

```typescript
function isFountainFile(file): boolean {
    return file.extension === 'fountain'           // script.fountain
        || file.basename.endsWith('.fountain');    // script.fountain.txt / .fountain.md
}
```

Obsidian's `file.extension` is only the last dot-segment. `basename` is the filename without that last extension, so `script.fountain.txt` has `basename = "script.fountain"`.

### Rendering

Nodes are rendered in source order. `sectionLevel` tracks the last-seen section depth for indentation of all subsequent nodes.

The hierarchy is two levels deep: **headers** (sections, scene headings, marker headings like `OVER BLACK:`, transitions) at the top, and **character subheaders** folded under their scene/marker heading.

| Node type | Indent formula | Sub-rows |
|---|---|---|
| `section` | `(level − 1) × 16 px` | — |
| `scene_heading` (incl. markers) | `sectionLevel × 16 px` | stats row + collapsible character rows |
| `transition` | `sectionLevel × 16 px` | — |
| `synopsis` | `sectionLevel × 16 px + 16 px` | — |
| character (within scene) | `sceneIndent + 24 px` | — |

**Scene block layout:**

```
div.fountain-scene-block                       (.is-collapsed hides .fountain-scene-children)
  div.fountain-outline-item.fountain-outline-scene_heading   ← clickable, navigates to scene
    span.fountain-collapse-chevron  (▾ toggles collapse; stops click propagation;
                                     invisible spacer when the scene has no characters)
    span.fountain-outline-icon      (film icon)
    span.fountain-outline-text      (heading text)
    span.fountain-scene-number      (#N, right-aligned — omitted for marker headings)
  div.fountain-scene-stats          right-aligned, spelled out, unclickable:
                                    "page N · N lines · N words · ~N.N pages"
  div.fountain-scene-children       ← collapsible container
    div.fountain-outline-item.fountain-outline-character     ← one per speaker, clickable
      span.fountain-outline-icon    (user icon)
      span.fountain-outline-text    (character name — no inline stats)
```

**Stats panel (sticky bottom, ≤ 25% height):**

```
div.fountain-stats-panel                 ← below the scrolling list, display-only rows
  div.fountain-stats-header
    span.fountain-stats-title            ("Statistics")
    span.fountain-stats-scope            (scope: file name, or "N files in Folder/")
    span.fountain-stats-btn (folder)     toggles the path input row
    span.fountain-stats-btn (refresh-cw) clears the cache and rescans everything
  div.fountain-stats-pathrow             ← hidden until folder button clicked
    input                                folder path; validated on commit, saved to settings
  div.fountain-stats-body                ← scrolls; four collapsible subpanels:
    Overview             files · scenes · ~pages · words · speaking characters
    Interior / exterior  scene counts per INT./EXT./INT./EXT., then per time of day (DAY, NIGHT, …)
    Locations            top 10 locations by scene count (+ "…and N more")
    Characters           top 15 by words spoken: "N scenes · N words" (+ "…and N more")
```

Per-scene character rows carry **no stats** — a character row is purely a navigation subheader. All statistics live in this bottom panel.

**Scope:** the panel always aggregates every `.fountain` file in the **whole vault** (scope label `"N files in vault"`) while the outline above stays per-file. There is no folder/scope setting; the active file is scored from its live AST and every other file from cache, so a vault-wide refresh on each keystroke costs one parse (the live file), not N.

### Vault stats caching (`fountain-stats.ts`)

`ScriptStatsCache` maps `path → { mtime, ScriptStats }`. On each refresh (every keystroke), the **active file** is recomputed from its live AST and every other file is served from cache; a cached file only re-parses when its mtime changed, i.e. it was saved. Vault `delete`/`rename` events invalidate entries. The rescan button (`refresh-cw`) is a belt-and-braces `cache.clear()` — mtime + vault events already cover normal editing, so it should rarely be needed.

Scene headings are decomposed by `decomposeHeading()`:
`"INT. WILL'S BEDROOM - NIGHT (1973)"` → `{ intExt: "INT.", location: "WILL'S BEDROOM", timeOfDay: "NIGHT" }`
(prefix regex; location = text before the last `" - "`; time of day = the remainder, upper-cased, trailing `(…)`/`[…]` qualifiers stripped).

---

## Multi-language Support (`fountain-lang.ts`)

A screenplay can exist in several languages that form one **translation group**, named with a two-letter ISO-639-1 code between the stem and the extension:

```
bigfish.en.fountain    bigfish.vi.fountain    bigfish.fr.fountain
```

### Why the `stem.LANG.fountain` convention is backwards-compatible

Obsidian's `file.extension` is only the **last** dot-segment, so `bigfish.en.fountain` still has `extension === 'fountain'`. Every existing extension check therefore applies unchanged — the `.fountain` → `markdown` registration, the outline's `isFountainFile`, the PDF scan's `extension === 'fountain'`, and the in-house highlighter's activation. A `.en.fountain` opened on its own behaves exactly like any `.fountain`; a plain `.fountain` with no infix has `lang === null` and is completely untouched.

### API

```typescript
fountainLang(file): { key, lang }          // "bigfish.en.fountain" → { key:"bigfish", lang:"en" }
groupId(file): string                        // parent-folder + key (so same name in two folders ≠ same group)
openTranslationGroup(app, file): OpenMember[]    // group members currently open in a leaf, in tab (workspace-tree) order
openFountainLeaves(app): OpenMember[]        // every fountain file open in a MarkdownView
diskTranslationGroup(app, file): GroupMember[]   // group members on disk (open or not), sorted by language — feeds drift lint
fountainFileOf(state) / isFountainAuthoringFile(app, file)   // editor gating (see Editor Layer)
```

`fountainLang` strips a trailing `.md`/`.txt` wrapper first, so `x.en.fountain.md` decomposes like `x.en.fountain`.

### Bilingual outline mode (automatic)

There is a single outline view and **no command** — it switches itself into **side-by-side columns** whenever `openTranslationGroup(activeFile)` returns ≥ 2 members with ≥ 2 distinct languages (i.e. two or more sibling-language files are open at once), and back to one column when they aren't. Detection re-runs on `workspace.on('layout-change')` (fires on tab open/close/move) plus `active-leaf-change` and `file-open`, so opening the second language file makes the columns appear and closing it makes them disappear, hands-free. Any number of languages produces that many columns. Each column:

- is titled with its language code + basename (`.fountain-outline-colhead`),
- parses its own file's live content (`getLiveContent` reads the open editor buffer — `MarkdownView.editor.getValue()` — else the saved file),
- renders through the shared `renderNodes(ctx, …)` path with a per-column `OutlineCtx`:

```typescript
interface OutlineCtx {
    listEl: HTMLElement;
    keyPrefix: string;                 // namespaces collapse keys per column (path|…)
    navigate: (line: number) => void;  // single mode → navigateTo; bilingual → navigateInFile(file, …)
}
```

Clicking a header in a column calls `navigateInFile(file, line)`, which scans all leaves for the one showing exactly that file and scrolls it — so each language's outline drives only its own editor. There is intentionally **no continuous scroll sync**; heading-click jump is the only linkage.

The stats panel stays single-scope in bilingual mode (it reflects the active file). Live updates fire on `workspace.on('editor-change')` so editing a fountain file in the editor refreshes the outline.

> **Why native leaves, not an embedded editor?** Obsidian's workspace owns editor leaves; there is no stable public API to host a fully-featured `MarkdownView` (CodeMirror 6 + Obsidian's private extension stack) inside a custom `ItemView`. So the editors stay as ordinary side-by-side tabs the user opens themselves (each keeping *all* native features and this plugin's own editor extensions), and only the outline is bilingual-aware. The outline drives them by path via `navigateInFile`.

---

## PDF Export (`fountain-pdf.ts`)

Command **"Export stitched PDF of the whole vault"**. All `.fountain` files in the vault (`gatherProjectFiles()`, sorted by path) are concatenated — each starting on a fresh page — into `stitched-screenplay.pdf` written to the vault root.

**Language filtering.** When the vault holds a translation group, stitching every file would interleave languages, so the export picks one language: the requested one (from the **"Export stitched PDF for a specific language…"** command, which shows a picker over the languages present), else the saved `primaryLanguage`, else the first language alphabetically. Files with no language infix always pass through. The output is named `stitched-screenplay.<lang>.pdf` when a language is selected. Picking a language in the command also saves it as `primaryLanguage`.

Rendering uses **jsPDF** (bundled, ~800 KB). jsPDF's built-in `courier` is a standard-14 font locked to WinAnsi (Latin-1), which mangles anything outside Latin-1 (Vietnamese diacritics, etc.), so the exporter **embeds Cousine** — a Courier-metric TrueType face with full Vietnamese/Latin-Extended coverage (`fountain-pdf-font.ts`, base64, registered via `addFileToVFS`/`addFont`). Its advance width is exactly 0.6 em = 10 chars/inch at 12 pt, identical to Courier, so the layout math below is unchanged. US-Letter, 12 pt, 6 lines/inch, ~55 lines/page, page numbers top-right from page 2. (The same Cousine is used for the on-screen editor font, via `@font-face` in `styles.css`, so screen and print match.)

Per-line classifier (reuses the parser's exported detection helpers) → element layout:

| Element | Left | Wrap width |
|---|---|---|
| scene heading / action | 1.5″ | 60 chars |
| character | 3.7″ | — |
| parenthetical | 3.1″ | 25 chars |
| dialogue | 2.5″ | 35 chars |
| transition | right-aligned at 7.5″ | — |
| centered `> x <` | centered at 4.25″ | — |

Skipped in print: title pages, sections `#`, synopses `=`, notes `[[…]]`, boneyard `/* … */`. Emphasis markers (`**`, `*`, `_`) are stripped to plain text. `===` forces a page break. Keep-together rules: a character cue is never the last line of a page; a scene heading keeps ≥ 2 lines with it. Not implemented: (MORE)/(CONT'D) on dialogue split across pages, dual dialogue columns, exact Final Draft pagination.

### Navigation

```typescript
private navigateTo(line: number): void {
    if lastMarkdownView?.editor:
        revealLeaf(lastMarkdownView.leaf)
        editor.setCursor({ line, ch: 0 })
        editor.scrollIntoView(...)
}
```

Clicking a character item navigates to the character's **first** dialogue line in the scene (stored as `FountainCharacter.line`), not the scene heading. This allows jumping directly to where a character begins speaking.

---

## Plugin Bootstrap (`main.ts`)

```typescript
class FountainPlugin extends Plugin
```

| Registration | Value |
|---|---|
| File extension `['fountain']` | `'markdown'` — opens in the native CM6 editor |
| View type `'fountain-outline'` | `FountainOutlineView` (receives the plugin instance for settings access) |
| Editor extension | `fountainHighlightExtension` (highlighter ViewPlugin) |
| Editor extension | `fountainLintExtension` (`@codemirror/lint` source, debounced) |
| Editor extension | `fountainHoverExtension` (`hoverTooltip`) |
| Editor suggest | `FountainSuggest` (`EditorSuggest`) |
| Settings tab | `FountainSettingTab` |
| Ribbon icon `'film'` | Opens/focuses outline panel |
| Command `'open-fountain-outline'` | Same |
| Command `'export-stitched-pdf'` | Stitch every `.fountain` file in the vault into one PDF (primary language) |
| Command `'export-stitched-pdf-language'` | Same, after picking a language from those present |

**Settings** (persisted via `loadData`/`saveData`, all editable in the settings tab):
- `primaryLanguage: string` — default ISO-639-1 code for single-language tasks (PDF export). Empty means "first language found alphabetically". Also set implicitly by the language-picker export command.
- `highlightScreenplay: boolean` (default true) — the in-house syntax highlighting.
- `enableAutocomplete: boolean` (default true) + `suggestTrigger: string` (default `/`) — the slash/context suggester and its trigger character.
- `enableLint: boolean` (default true) — single-file diagnostics; `enableDriftLint: boolean` (default true) — cross-language diagnostics.
- `enableHover: boolean` (default true) — hover type-hints.

Editor extensions read settings lazily on each run, so toggling highlight/lint/drift in the settings tab calls `workspace.updateOptions()` to reconfigure open editors immediately.

Opening the outline: checks `getLeavesOfType('fountain-outline')` first; if none, calls `getRightLeaf(false)` and sets its view state.

On load, `warnAboutFountainEditorPlugin()` shows a one-time notice if the external Fountain Editor plugin is still enabled (its decorations would double up on the in-house highlighter's).

---

## Example Input → Output

### Input

```fountain
Title: Big Fish
Author: John August

====

INT.  WILL'S BEDROOM - NIGHT (1973)

WILL BLOOM, AGE 3, listens wide-eyed.

EDWARD
I didn't put any stock into such speculation.
(closer)
And on the day you were born, that was the day I finally caught him.

EXT.  CAMPFIRE - NIGHT (1977)

= Edward retells the Beast story to the Indian Guides.

LITTLE BRAVE
(confused)
Your finger?

EDWARD
Gold.

EDWARD
I tied my ring to the strongest line they made.

CUT TO:

INT.  BLOOM FRONT HALL - NIGHT (1987) #3#
```

### Output

```json
[
  {
    "type": "scene_heading",
    "text": "INT.  WILL'S BEDROOM - NIGHT (1973)",
    "level": 0,
    "line": 6,
    "endLine": 16,
    "sceneNumber": "1",
    "characters": [
      { "name": "EDWARD", "line": 10, "dialogueCount": 1, "wordCount": 22 }
    ],
    "stats": {
      "lineCount": 7,
      "wordCount": 42,
      "pageEstimate": 0.2,
      "startPage": 1
    }
  },
  {
    "type": "scene_heading",
    "text": "EXT.  CAMPFIRE - NIGHT (1977)",
    "level": 0,
    "line": 18,
    "endLine": 30,
    "sceneNumber": "2",
    "characters": [
      { "name": "LITTLE BRAVE", "line": 21, "dialogueCount": 1, "wordCount": 2 },
      { "name": "EDWARD",       "line": 24, "dialogueCount": 2, "wordCount": 14 }
    ],
    "stats": {
      "lineCount": 9,
      "wordCount": 51,
      "pageEstimate": 0.24,
      "startPage": 1
    }
  },
  {
    "type": "synopsis",
    "text": "Edward retells the Beast story to the Indian Guides.",
    "level": 0,
    "line": 20
  },
  {
    "type": "transition",
    "text": "CUT TO:",
    "level": 0,
    "line": 31
  },
  {
    "type": "scene_heading",
    "text": "INT.  BLOOM FRONT HALL - NIGHT (1987)",
    "level": 0,
    "line": 33,
    "endLine": 33,
    "sceneNumber": "3",
    "characters": [],
    "stats": {
      "lineCount": 1,
      "wordCount": 6,
      "pageEstimate": 0.02,
      "startPage": 1
    }
  }
]
```

*Note: `synopsis` nodes appear after the scene they annotate in the output array (matching source order). The outline renders them in the same order.*

---

## What Is Not in the Outline

These Fountain elements are **classified** by the syntax core (so the highlighter styles them and the linter/index see them) but are intentionally **not emitted as navigable outline nodes** — they contribute to word/line counts only:

| Element | Example | Reason |
|---|---|---|
| Action | `He walks to the door.` | Too numerous; clutters outline |
| Dialogue | `"I didn't put any stock..."` | Counted in character word totals |
| Parenthetical | `(closer)` | Excluded from word counts |
| Dual dialogue | `^` suffix | Treated as normal character |
| Lyrics | `~text~` | Treated as dialogue |
| Centered text | `> text <` | Cosmetic only |
| Page break | `===` | No semantic content |
| Notes | `[[text]]` | Editorial only |
| Boneyard | `/* text */` | Omitted content |

---

## Future: Shot List

The data required for a shot list is already present in the AST. A `"Fountain: Copy Shot List"` command could:

1. For each `scene_heading` node, parse the heading text into components:

```typescript
// "INT.  WILL'S BEDROOM - NIGHT (1973)"
const m = /^(INT\.?|EXT\.?|INT\.?\/EXT\.?|I\/E\.?)\s+(.+?)\s+-\s+(.+)$/i.exec(text);
// m[1] = "INT."  m[2] = "WILL'S BEDROOM"  m[3] = "NIGHT (1973)"
```

2. Build a markdown table and write it to the clipboard or a new note:

```markdown
| # | Int/Ext | Location | Day/Night | Characters | Pages |
|---|---|---|---|---|---|
| 1 | INT | WILL'S BEDROOM | NIGHT (1973) | EDWARD | p.1 ~0.3p |
| 2 | EXT | CAMPFIRE | NIGHT (1977) | LITTLE BRAVE, EDWARD | p.1 ~0.5p |
| 3 | INT | BLOOM FRONT HALL | NIGHT (1987) | EDWARD, WILL | p.2 ~1.2p |
```

This is a separate command; it does not need a new view.
