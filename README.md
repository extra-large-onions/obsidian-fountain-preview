# Fountain

A screenplay **IDE** for Obsidian. `.fountain` files open in Obsidian's own editor with screenplay syntax highlighting, slash autocomplete, inline lint, and hover hints — plus a screenplay-aware outline panel, vault-wide statistics, stitched PDF export, and side-by-side support for multi-language scripts.

## Features

### In the editor
- **Syntax highlighting** — scene headings, character cues, dialogue, parentheticals, transitions, sections, synopses, notes and boneyard, all styled in the native editor. Formatting punctuation (`.` `@` `>` `~` `=` `!`) hides itself when the cursor leaves the line.
- **Autocomplete** — type `/` at the start of a line for a menu of transitions, camera shots/angles, scene markers and structure scaffolds. The vocabulary is an **editable dictionary** (Settings → Fountain → Autocomplete dictionary, plain JSON grouped by category — add your own). Characters and locations are pulled in automatically from **every `.fountain` file in your project**, so a character named in one script is offered everywhere. Inside `INT. `/`EXT. ` the location and time-of-day complete from what you've used; typing a name in caps completes against your cast. The trigger character is configurable.
- **Inline lint** — underlines probable mistakes: a cue one letter off from an existing character, a cue with no dialogue after it (which Fountain silently reads as action), a transition typo, a heading with no time of day, an unclosed `/* boneyard */` or `[[note]]`.
- **Hover hints** — hover a character cue or scene heading to see its numbers (scenes, cues, words, pages).

### Outline & stats
- A sidebar **outline** of scenes, characters, transitions and synopses, with per-scene page/line/word stats and collapsible character lists.
- A **statistics** panel — for the current file, or aggregated across a whole folder (INT/EXT split, times of day, top locations, top characters).
- **Stitched PDF export** of every script in a folder, in industry-standard screenplay format.

### Multi-language screenplays
Name a script's translations `stem.LANG.fountain` with a two-letter code:

```
bigfish.en.fountain    bigfish.vi.fountain
```

Open two of them at once and the outline automatically shows **side-by-side columns**, one per language, each driving its own editor. **Drift lint** compares a script against its siblings on disk and flags scene-count mismatches and characters who appear in one language but not another.

Because Obsidian only looks at the last dot-segment, `bigfish.en.fountain` still has extension `fountain` — so a language-tagged file behaves exactly like a plain `.fountain` everywhere, and a plain `.fountain` with no language code is untouched.

## Migration note (v1.0)

`.fountain` files now open in Obsidian's **native markdown editor** (previously a plain textarea). This is what enables highlighting, autocomplete, lint and hover — and it means wiki-links, embeds and frontmatter now work inside `.fountain` files too.

If you previously used the separate **Fountain Editor** plugin for highlighting, **disable it** — this plugin now highlights screenplays in-house, and running both doubles up the styling. (The plugin shows a one-time reminder if it detects Fountain Editor still enabled.) You can also turn any individual feature on or off in **Settings → Fountain**.

You can still write Fountain in a plain `.md` note: add `fountain` to the note's `cssclasses` or `tags` frontmatter and the editor features switch on.

## Comments

Use Fountain's own **boneyard** for comments you want every Fountain tool (and this plugin's PDF export and outline) to omit:

```
/* This note is omitted from the printed script and the outline. */
```

Use **notes** for author annotations (also omitted from print, kept for you):

```
[[ check this beat against the treatment ]]
```

Both are highlighted (dimmed), span multiple lines, and are portable — a standalone Fountain parser understands them too. Avoid Obsidian's `%%…%%` comments here: they hide in Obsidian's preview but *aren't* Fountain, so any other Fountain tool (and the PDF export) would print them as plain text.

## Settings

Settings → Fountain: primary language (for PDF export), the editable autocomplete dictionary, and toggles for highlighting, autocomplete (with trigger character), inline diagnostics, translation-drift diagnostics, and hover hints. (Statistics, PDF stitching, and autocomplete all scope to the whole vault — nothing to configure.)

## Development

```
npm install
npm run dev      # watch build
npm run build    # typecheck + production bundle
```

Architecture is documented in [`architecture.md`](architecture.md); the refactor that produced the current shape is in [`refactor.md`](refactor.md).
