// ─── Fountain syntax core ─────────────────────────────────────────────────────
//
// The single source of truth for "what Fountain element is this line?".
// The outline parser, the editor highlighter, the linter, the suggester and the
// file index all consume this module — there is deliberately no second regex
// table anywhere else in the plugin.
//
// Implemented from the Fountain spec (https://fountain.io/syntax), reusing the
// detection helpers this plugin has always shipped in fountain-parser.ts.

// ─── Element types ────────────────────────────────────────────────────────────

export type Element =
    | 'frontmatter'     // YAML frontmatter of a .fountain.md wrapper file
    | 'title_page'      // Title: / Credit: / Author: … block
    | 'section'         // # Act I
    | 'synopsis'        // = We meet our hero.
    | 'scene_heading'   // INT. HOUSE - DAY   or   .FORCED   or marker "OVER BLACK:"
    | 'transition'      // CUT TO:   or   > forced
    | 'character'       // BIG FISH   or   @McAVOY
    | 'parenthetical'   // (beat)
    | 'dialogue'
    | 'lyrics'          // ~ Willkommen, bienvenue…
    | 'centered'        // > THE END <
    | 'action'
    | 'note'            // continuation lines of a multi-line [[note]]
    | 'boneyard'        // lines inside /* … */
    | 'page_break'      // ===
    | 'blank';

/** A range of formatting punctuation (or inline note/boneyard) within the line. */
export interface LineMark {
    /** Char offset within the line (inclusive). */
    from: number;
    /** Char offset within the line (exclusive). */
    to: number;
    /**
     * What the range is:
     *   'forced-scene' | 'forced-character' | 'forced-transition' | 'forced-action'
     *   'section' | 'synopsis' | 'lyrics' | 'centered' | 'page-break'
     *   'scene-number' | 'character-extension' | 'dual'
     *   'note' | 'boneyard'
     */
    kind: string;
}

export interface LineClass {
    element: Element;
    marks?: LineMark[];
}

// ─── Detection helpers (moved here from fountain-parser.ts) ───────────────────

export function isAllCaps(trimmed: string): boolean {
    const alpha = trimmed.replace(/[^A-Za-z]/g, '');
    return alpha.length > 0 && alpha === alpha.toUpperCase();
}

const INT_EXT_PREFIX_RE = /^(INT\.?|EXT\.?|INT\.?\/EXT\.?|I\/E\.?|EST\.?)\s/i;

export function isSceneHeading(trimmed: string, prevBlank: boolean): boolean {
    if (!prevBlank || !trimmed) return false;
    if (trimmed.startsWith('.') && !trimmed.startsWith('..')) return true;
    if (!INT_EXT_PREFIX_RE.test(trimmed)) return false;
    return isAllCaps(trimmed);
}

export function isStandardTransition(trimmed: string, prevBlank: boolean): boolean {
    if (!prevBlank || !trimmed) return false;
    if (!isAllCaps(trimmed)) return false;
    if (trimmed.endsWith('TO:')) return true;
    if (/^FADE (IN|OUT)[.:]$/.test(trimmed)) return true;
    return false;
}

/**
 * ALL CAPS line ending with ":" that is not a transition — e.g. "OVER BLACK:",
 * "INTERCUT WITH:". Treated as a scene-level container so dialogue that follows
 * (before any real scene heading) nests under it in the outline.
 * Must be checked AFTER isStandardTransition so "CUT TO:" etc. win.
 */
export function isMarkerHeading(trimmed: string, prevBlank: boolean): boolean {
    if (!prevBlank || !trimmed.endsWith(':')) return false;
    return isAllCaps(trimmed);
}

export function isCharacterName(trimmed: string, prevBlank: boolean, nextLine: string): boolean {
    if (!prevBlank || !trimmed) return false;
    const forced = trimmed.startsWith('@');
    if (!forced) {
        if (!isAllCaps(trimmed)) return false;
        if (INT_EXT_PREFIX_RE.test(trimmed)) return false;
        if (isStandardTransition(trimmed, true)) return false;
    }
    const next = nextLine.trim();
    if (!next) return false;
    if (next.startsWith('(')) return true;
    const nextAlpha = next.replace(/[^A-Za-z]/g, '');
    return nextAlpha.length > 0 && nextAlpha !== nextAlpha.toUpperCase();
}

export function skipTitlePage(lines: string[]): number {
    const first = lines[0];
    if (!first || !/^[A-Za-z ]+\s*:/.test(first)) return 0;
    let lastNonIndented = true;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? '';
        if (line.trim() === '') {
            if (lastNonIndented) return i + 1;
        } else if (/^\s/.test(line)) {
            lastNonIndented = false;
        } else {
            lastNonIndented = true;
        }
    }
    return lines.length;
}

/** Lines of a leading YAML frontmatter block, including both `---` fences. 0 if none. */
export function skipFrontmatter(lines: string[]): number {
    if ((lines[0] ?? '').trim() !== '---') return 0;
    for (let i = 1; i < lines.length; i++) {
        const t = (lines[i] ?? '').trim();
        if (t === '---' || t === '...') return i + 1;
    }
    return 0; // unclosed — treat as content, not frontmatter
}

/** Fountain emphasis (**FADE IN:**, _OVER BLACK:_) stripped for transition/marker detection. */
export function stripEmphasis(trimmed: string): string {
    return trimmed.replace(/^[*_]+/, '').replace(/[*_]+$/, '').trim();
}

const INT_EXT_RE = /^(INT\.?\/EXT\.?|EXT\.?\/INT\.?|I\/E\.?|INT\.?|EXT\.?|EST\.?)\s+(.*)$/i;

/** "INT. WILL'S BEDROOM - NIGHT (1973)" → { intExt: "INT.", location: "WILL'S BEDROOM", timeOfDay: "NIGHT" } */
export function decomposeHeading(text: string): { intExt: string; location: string; timeOfDay: string } {
    const m = INT_EXT_RE.exec(text.trim());
    if (!m) return { intExt: 'OTHER', location: text.trim(), timeOfDay: '' };

    const prefix = (m[1] ?? '').toUpperCase().replace(/\s+/g, '');
    let intExt: string;
    if (/^(INT\.?\/EXT\.?|EXT\.?\/INT\.?|I\/E\.?)$/.test(prefix)) intExt = 'INT./EXT.';
    else if (prefix.startsWith('INT')) intExt = 'INT.';
    else if (prefix.startsWith('EXT')) intExt = 'EXT.';
    else intExt = 'EST.';

    const rest = (m[2] ?? '').trim();
    const dashIdx = rest.lastIndexOf(' - ');
    let location = rest;
    let timeOfDay = '';
    if (dashIdx >= 0) {
        location = rest.slice(0, dashIdx).trim();
        // "NIGHT (1973)" → "NIGHT"; "NIGHT [CONTINUOUS]" → "NIGHT"
        timeOfDay = rest.slice(dashIdx + 3).trim().replace(/\s*[([].*[)\]]\s*$/, '').toUpperCase();
    }
    return { intExt, location, timeOfDay };
}

// ─── Stateful line classifier ─────────────────────────────────────────────────

/**
 * Classifies one line at a time, carrying the cross-line state Fountain needs
 * (previous line blank? inside a dialogue block? inside /* boneyard or [[note]]?).
 * Feed lines strictly in document order, starting AFTER any frontmatter/title
 * page (classifyLines handles those; use it unless you need streaming).
 */
export class LineClassifier {
    private prevBlank = true;
    private inDialogue = false;
    private inBoneyard = false;
    private inNote = false;

    feed(raw: string, nextLine: string): LineClass {
        const trimmed = raw.trim();
        const marks: LineMark[] = [];

        // ── Boneyard continuation ────────────────────────────────────────────
        if (this.inBoneyard) {
            const close = raw.indexOf('*/');
            if (close >= 0) {
                this.inBoneyard = false;
                marks.push({ from: close, to: close + 2, kind: 'boneyard' });
            }
            // A boneyard line neither sets nor clears prevBlank (it's stripped text)
            return { element: 'boneyard', marks };
        }

        // ── Note continuation (ends at ]] or at a blank line) ────────────────
        if (this.inNote) {
            if (!trimmed) {
                this.inNote = false;
                this.prevBlank = true;
                this.inDialogue = false;
                return { element: 'blank' };
            }
            const close = raw.indexOf(']]');
            if (close >= 0) {
                this.inNote = false;
                marks.push({ from: close, to: close + 2, kind: 'note' });
            }
            return { element: 'note', marks };
        }

        // ── Blank line ───────────────────────────────────────────────────────
        if (!trimmed) {
            this.prevBlank = true;
            this.inDialogue = false;
            return { element: 'blank' };
        }

        // ── Inline notes and boneyard openers (marks on top of any element) ──
        this.collectInlineRanges(raw, marks);

        const prevBlank = this.prevBlank;
        this.prevBlank = false;

        // Whole line is a note / boneyard → the line IS that element
        const first = marks[0];
        if (first && (first.kind === 'note' || first.kind === 'boneyard')) {
            const indent = raw.length - raw.trimStart().length;
            if (first.from <= indent && first.to >= indent + trimmed.length) {
                return { element: first.kind === 'boneyard' ? 'boneyard' : 'note', marks };
            }
        }

        const cls = this.classifyContent(raw, trimmed, prevBlank, nextLine, marks);
        return marks.length ? { element: cls, marks } : { element: cls };
    }

    /** Find [[note]] and /* boneyard *​/ ranges; update multi-line state for unclosed openers. */
    private collectInlineRanges(raw: string, marks: LineMark[]): void {
        // Boneyard: /* … */ (possibly closing later in the document)
        let idx = 0;
        for (;;) {
            const open = raw.indexOf('/*', idx);
            if (open < 0) break;
            const close = raw.indexOf('*/', open + 2);
            if (close >= 0) {
                marks.push({ from: open, to: close + 2, kind: 'boneyard' });
                idx = close + 2;
            } else {
                marks.push({ from: open, to: raw.length, kind: 'boneyard' });
                this.inBoneyard = true;
                return;
            }
        }
        // Notes: [[ … ]] (a blank line cancels an unclosed note)
        idx = 0;
        for (;;) {
            const open = raw.indexOf('[[', idx);
            if (open < 0) break;
            const close = raw.indexOf(']]', open + 2);
            if (close >= 0) {
                marks.push({ from: open, to: close + 2, kind: 'note' });
                idx = close + 2;
            } else {
                marks.push({ from: open, to: raw.length, kind: 'note' });
                this.inNote = true;
                return;
            }
        }
    }

    private classifyContent(
        raw: string, trimmed: string, prevBlank: boolean, nextLine: string, marks: LineMark[],
    ): Element {
        const indent = raw.length - raw.trimStart().length;
        const at = (offInTrimmed: number) => indent + offInTrimmed;

        // ── Page break: === (3+) ─────────────────────────────────────────────
        if (/^===+$/.test(trimmed)) {
            this.inDialogue = false;
            marks.push({ from: at(0), to: at(trimmed.length), kind: 'page-break' });
            return 'page_break';
        }

        // ── Section: # Act I ─────────────────────────────────────────────────
        const sec = /^(#{1,6})\s+\S/.exec(raw);
        if (sec) {
            this.inDialogue = false;
            marks.push({ from: 0, to: (sec[1] ?? '#').length, kind: 'section' });
            return 'section';
        }

        // ── Synopsis: = text ─────────────────────────────────────────────────
        if (/^=\s+\S/.test(trimmed)) {
            this.inDialogue = false;
            marks.push({ from: at(0), to: at(1), kind: 'synopsis' });
            return 'synopsis';
        }

        // ── Centered: > text < ───────────────────────────────────────────────
        if (trimmed.startsWith('>') && trimmed.endsWith('<') && trimmed.length > 1) {
            this.inDialogue = false;
            marks.push({ from: at(0), to: at(1), kind: 'centered' });
            marks.push({ from: at(trimmed.length - 1), to: at(trimmed.length), kind: 'centered' });
            return 'centered';
        }

        // ── Forced transition: > CUT TO ──────────────────────────────────────
        if (trimmed.startsWith('>')) {
            this.inDialogue = false;
            marks.push({ from: at(0), to: at(1), kind: 'forced-transition' });
            return 'transition';
        }

        // ── Lyrics: ~ la la la ───────────────────────────────────────────────
        if (trimmed.startsWith('~')) {
            marks.push({ from: at(0), to: at(1), kind: 'lyrics' });
            return 'lyrics';
        }

        // ── Forced action: ! text ────────────────────────────────────────────
        if (trimmed.startsWith('!')) {
            this.inDialogue = false;
            marks.push({ from: at(0), to: at(1), kind: 'forced-action' });
            return 'action';
        }

        // ── Scene heading (forced "." or INT./EXT. …) ────────────────────────
        if (isSceneHeading(trimmed, prevBlank)) {
            this.inDialogue = false;
            if (trimmed.startsWith('.')) marks.push({ from: at(0), to: at(1), kind: 'forced-scene' });
            const num = /#([A-Za-z0-9.\-]+)#\s*$/.exec(trimmed);
            if (num) marks.push({ from: at(num.index), to: at(num.index + num[0].trimEnd().length), kind: 'scene-number' });
            return 'scene_heading';
        }

        const unstyled = stripEmphasis(trimmed);

        // ── Standard transition: CUT TO: / FADE OUT. ─────────────────────────
        if (isStandardTransition(unstyled, prevBlank)) {
            this.inDialogue = false;
            return 'transition';
        }

        // ── Character cue ────────────────────────────────────────────────────
        if (isCharacterName(trimmed, prevBlank, nextLine)) {
            this.inDialogue = true;
            if (trimmed.startsWith('@')) marks.push({ from: at(0), to: at(1), kind: 'forced-character' });
            if (trimmed.endsWith('^')) marks.push({ from: at(trimmed.length - 1), to: at(trimmed.length), kind: 'dual' });
            const ext = /\(([^)]*)\)/.exec(trimmed);
            if (ext) marks.push({ from: at(ext.index), to: at(ext.index + ext[0].length), kind: 'character-extension' });
            return 'character';
        }

        // ── Marker heading: OVER BLACK: (scene-level container) ──────────────
        if (isMarkerHeading(unstyled, prevBlank)) {
            this.inDialogue = false;
            return 'scene_heading';
        }

        // ── Inside a dialogue block ──────────────────────────────────────────
        if (this.inDialogue) {
            if (trimmed.startsWith('(') && trimmed.endsWith(')')) return 'parenthetical';
            return 'dialogue';
        }

        return 'action';
    }
}

// ─── Whole-document pass ──────────────────────────────────────────────────────

/**
 * Classify every line of a document: frontmatter and title page first, then the
 * stateful per-line pass. `result[i]` describes `lines[i]`.
 */
export function classifyLines(lines: string[]): LineClass[] {
    const out: LineClass[] = new Array<LineClass>(lines.length);

    const fmEnd = skipFrontmatter(lines);
    for (let i = 0; i < fmEnd; i++) {
        out[i] = { element: (lines[i] ?? '').trim() ? 'frontmatter' : 'blank' };
    }

    const body = fmEnd ? lines.slice(fmEnd) : lines;
    const tpEnd = fmEnd + skipTitlePage(body);
    for (let i = fmEnd; i < tpEnd; i++) {
        out[i] = { element: (lines[i] ?? '').trim() ? 'title_page' : 'blank' };
    }

    const clf = new LineClassifier();
    for (let i = tpEnd; i < lines.length; i++) {
        out[i] = clf.feed(lines[i] ?? '', lines[i + 1] ?? '');
    }
    return out;
}
