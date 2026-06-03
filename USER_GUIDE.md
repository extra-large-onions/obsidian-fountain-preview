# obsidian-fountain — User Guide

## Opening the Outline

- **Ribbon icon**: Click the **film** icon in the left sidebar to open the Fountain Outline panel.
- **Command palette**: Run **Fountain: Open Fountain Outline**.
- The outline panel appears on the right side and updates automatically as you type or switch files.

## What the Outline Shows

The outline panel displays a screenplay-aware structure for any open `.fountain` file (or `.fountain.md` file). It shows:

- **Sections** — Markdown-style headings (`# Act 1`, `## Sequence A`, etc.)
- **Scene Headings** — `INT.`, `EXT.`, `INT./EXT.`, or `I/E.` lines
- **Transitions** — `CUT TO:`, `FADE OUT.`, etc.
- **Synopses** — Notes starting with `=`
- **Characters per scene** — Automatically collected under each scene heading

## What the Numbers Mean

### Scene Numbers (`#1`, `#2`, `#42`)

Each scene heading shows a number on the right side.

- If you write an explicit scene number in Fountain format, it is used:  
  `INT. BEDROOM - NIGHT #42#` → shows **#42**
- Otherwise, scenes are numbered automatically in order: **#1**, **#2**, **#3**, etc.

### Scene Stats Row

Under every scene heading, you will see a stats line that looks like this:

```
p.1  ·  12 ln  ·  85 w  ·  ~0.4p
```

| Symbol | Meaning |
|--------|---------|
| `p.1` | **Start page** — approximate page where the scene begins (based on 55 lines per page). |
| `12 ln` | **Line count** — number of non-blank lines in the scene. |
| `85 w` | **Word count** — total words in the scene (action + dialogue). |
| `~0.4p` | **Page estimate** — how many pages the scene occupies. Scenes shorter than 0.1 pages omit this value. |

> **Note:** Page numbers are rough estimates (standard screenplay = ~55 lines per page). They are useful for orientation, not exact production pagination.

### Character Numbers

Under each scene heading, every speaking character is listed with two numbers:

```
EDWARD   ×3   22w
```

| Symbol | Meaning |
|--------|---------|
| `×3` | **Dialogue count** — how many separate speaking turns the character has in this scene. |
| `22w` | **Word count** — total words spoken by that character (dialogue only; parentheticals are excluded). |

Clicking a character jumps directly to their **first line of dialogue** in that scene.

## Navigation

- Click any **section**, **scene heading**, **transition**, **synopsis**, or **character** in the outline to jump to that line in the editor.
- The outline stays in sync as you type (live update) and when you save the file.

## File Support

The outline works with:
- `.fountain` files
- `.fountain.txt` files
- `.fountain.md` files (Obsidian markdown files with Fountain content)

If no outline appears, make sure you have a Fountain file open in the active editor.

## Quick Tips

- Use `=` lines (synopses) to add scene summaries — they appear indented under the scene in the outline.
- Use `#` headings to organize your script into acts or sequences; scenes underneath are indented accordingly.
- The outline is read-only — it is generated from your script and updates automatically.
