# obsidian-fountain — Architecture

## Overview

An Obsidian plugin that opens `.fountain` screenplay files in a custom editor and provides a sidebar outline panel. The outline mirrors Obsidian's native heading outline but is screenplay-aware: it shows scenes, characters, transitions, and per-scene statistics instead of markdown headings.

---

## File Structure

```
obsidian-fountain/
├── src/
│   ├── main.ts                  Plugin bootstrap
│   ├── fountain-parser.ts       Fountain → AST (single-pass + post-process)
│   ├── fountain-view.ts         TextFileView: textarea editor for .fountain files
│   └── fountain-outline-view.ts ItemView: sidebar outline panel
├── styles.css                   Scoped CSS for both views
├── manifest.json                Plugin id/name/version
└── architecture.md              This file
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
  if isStandardTransition():       → emit TRANSITION;          currentSpeaker ← null
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
   for each scene_heading:
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
| 6 | `transition` (standard) | `prevBlank` AND ALL CAPS AND (ends `TO:` OR matches `FADE (IN\|OUT)[.:]`) |
| 7 | character *(collected)* | `prevBlank` AND ALL CAPS AND next line is dialogue (mixed case) or parenthetical `(…)` |
| 8 | *(ignored)* | Action, dialogue, parenthetical — counted for word stats only |

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

## Fountain View (`fountain-view.ts`)

```typescript
class FountainView extends TextFileView
```

A plain textarea editor for `.fountain` files. Registered for the `fountain` file extension via `plugin.registerExtensions(['fountain'], FOUNTAIN_VIEW_TYPE)`.

| Method | Purpose |
|---|---|
| `getViewData()` | Returns `textarea.value` (Obsidian calls this to save) |
| `setViewData(data, clear)` | Populates textarea when a file is opened |
| `clear()` | Empties textarea |
| `getCurrentContent()` | Returns live textarea content (used by outline before file is saved) |
| `scrollToLine(n)` | Computes cumulative char offset, sets `selectionRange`, adjusts `scrollTop` |

On every `input` event the view calls `requestSave()` (Obsidian's debounced autosave) and broadcasts a custom workspace event `'fountain:content-changed'` so the outline panel can re-parse without waiting for disk write.

**Scrolling to a line:**

```typescript
scrollToLine(lineNumber: number): void {
    // 1. Sum lengths of all preceding lines (+1 for each newline character)
    // 2. setSelectionRange(pos, pos + lineLength) → moves cursor
    // 3. scrollTop = (lineNumber − 5) × (scrollHeight / totalLines)
    //    The −5 margin keeps context above the target line
}
```

---

## Outline View (`fountain-outline-view.ts`)

```typescript
class FountainOutlineView extends ItemView
```

A sidebar panel (right pane by default) that renders the AST returned by `parseFountainOutline`.

### State

```typescript
lastFountainView:  FountainView | null   // last active custom editor
lastMarkdownView:  MarkdownView | null   // last active .fountain.md editor
```

These are cached because clicking an outline item shifts focus to the outline panel itself, making `getActiveViewOfType()` return null at click-time.

### Event subscriptions

| Event | Handler |
|---|---|
| `workspace.on('active-leaf-change')` | Update `lastFountainView`/`lastMarkdownView`; refresh (skip if new leaf is the outline itself — see Flash Bug below) |
| `workspace.on('file-open')` | Refresh |
| `workspace.on('fountain:content-changed')` | Refresh (live update on every keystroke) |
| `vault.on('modify')` | Refresh when any fountain file is saved |

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
     → fall back to lastFountainView.file or lastMarkdownView.file

2. Get content:
     if a FountainView is open for this file → getCurrentContent() (live, unsaved)
     otherwise → vault.read(file) (saved content)

3. parseFountainOutline(content) → nodes[]

4. renderNodes(nodes)
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

| Node type | Indent formula | Sub-rows |
|---|---|---|
| `section` | `(level − 1) × 16 px` | — |
| `scene_heading` | `sectionLevel × 16 px` | stats row + character rows |
| `transition` | `sectionLevel × 16 px` | — |
| `synopsis` | `sectionLevel × 16 px + 16 px` | — |
| character (within scene) | `sceneIndent + 20 px` | — |

**Scene block layout:**

```
div.fountain-scene-block
  div.fountain-outline-item.fountain-outline-scene_heading   ← clickable, navigates to scene
    span.fountain-outline-icon   (film icon)
    span.fountain-outline-text   (heading text)
    span.fountain-scene-number   (#N, right-aligned)
  div.fountain-scene-stats       (p.N · N ln · N w · ~N.Np)
  div.fountain-outline-item.fountain-outline-character       ← one per speaker, clickable
    span.fountain-outline-icon   (user icon)
    span.fountain-outline-text   (character name)
    span.fountain-char-count     (×N speaking turns)
    span.fountain-char-words     (Nw total words)
```

### Navigation

```typescript
private navigateTo(line: number): void {
    if (lastFountainView):
        revealLeaf(lastFountainView.leaf)
        lastFountainView.scrollToLine(line)
    else if lastMarkdownView?.editor:
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
| View type `'fountain'` | `FountainView` |
| View type `'fountain-outline'` | `FountainOutlineView` |
| File extension `['fountain']` | `FountainView` |
| Ribbon icon `'film'` | Opens/focuses outline panel |
| Command `'open-fountain-outline'` | Same |

Opening the outline: checks `getLeavesOfType('fountain-outline')` first; if none, calls `getRightLeaf(false)` and sets its view state.

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

## What Is Not Parsed

These Fountain elements are intentionally ignored for the outline (they contribute to word/line counts but are not navigable nodes):

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
