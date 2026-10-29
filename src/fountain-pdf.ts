import { jsPDF } from 'jspdf';
import { COUSINE_TTF_BASE64 } from './fountain-pdf-font';
import { COUSINE_BOLD_TTF_BASE64, COUSINE_ITALIC_TTF_BASE64, COUSINE_BOLD_ITALIC_TTF_BASE64 } from './fountain-pdf-font-styles';
import {
    skipTitlePage,
    isSceneHeading,
    isStandardTransition,
    isMarkerHeading,
    isCharacterName,
} from './fountain-parser';

// ─── Screenplay layout (US Letter, Courier 12pt, 6 lines per inch) ────────────
// All positions in inches from the page's top-left corner.

const LINE_HEIGHT = 1 / 6;
const CHAR_WIDTH = 0.1;          // Courier 12pt = 10 characters per inch
const FIRST_LINE_Y = 1.0;
const LAST_LINE_Y = 10.0;
const PAGE_NUM_Y = 0.6;
const RIGHT_EDGE = 7.5;
const UNDERLINE_DROP = 0.025;    // below the baseline
const UNDERLINE_WIDTH = 0.01;    // ~0.7pt

interface ElementLayout { left: number; width: number; } // width in characters

const LAYOUT = {
    scene:         { left: 1.5, width: 60 } as ElementLayout,
    action:        { left: 1.5, width: 60 } as ElementLayout,
    character:     { left: 3.7, width: 33 } as ElementLayout,
    parenthetical: { left: 3.1, width: 25 } as ElementLayout,
    dialogue:      { left: 2.5, width: 35 } as ElementLayout,
};

type ElementType = keyof typeof LAYOUT | 'transition' | 'centered';

// ─── Unicode font ───────────────────────────────────────────────────────────────

// jsPDF's built-in 'courier' is a standard-14 font restricted to WinAnsi (Latin-1),
// so anything outside Latin-1 (Vietnamese diacritics, etc.) renders mangled. We embed
// Cousine — a Courier-metric-compatible monospace with full Vietnamese/Latin-Extended
// coverage — and use it instead. Registered once per document.
const SCRIPT_FONT = 'Cousine';

function registerScriptFont(doc: jsPDF): void {
    const faces: [string, string, string][] = [
        ['Cousine-Regular.ttf', COUSINE_TTF_BASE64, 'normal'],
        ['Cousine-Bold.ttf', COUSINE_BOLD_TTF_BASE64, 'bold'],
        ['Cousine-Italic.ttf', COUSINE_ITALIC_TTF_BASE64, 'italic'],
        ['Cousine-BoldItalic.ttf', COUSINE_BOLD_ITALIC_TTF_BASE64, 'bolditalic'],
    ];
    for (const [file, data, style] of faces) {
        doc.addFileToVFS(file, data);
        doc.addFont(file, SCRIPT_FONT, style);
    }
}

// ─── Text helpers ─────────────────────────────────────────────────────────────

/** Remove fountain syntax that never prints: [[notes]] and the ~ lyrics marker. */
function cleanInline(text: string): string {
    return text
        .replace(/\[\[[^\]]*\]\]/g, '')   // [[notes]]
        .replace(/^~/, '')                // ~lyrics
        .normalize('NFC')                 // one character per letter, so widths count right
        .trimEnd();
}

/** Plain text with the emphasis markers taken out. */
function stripInline(text: string): string {
    return parseEmphasis(text).chars.join('');
}

interface Emphasis { b: boolean; i: boolean; u: boolean; }
/** Characters (one per code point) and the emphasis of each. */
interface StyledText { chars: string[]; styles: Emphasis[]; }

const sameEmphasis = (a: Emphasis | undefined, b: Emphasis) => !!a && a.b === b.b && a.i === b.i && a.u === b.u;
const isWordChar = (c: string | undefined) => !!c && /[\p{L}\p{N}]/u.test(c);

/**
 * Fountain emphasis: *italic*, **bold**, ***bold italic***, _underline_ (a run
 * like __x__ counts as one marker). They nest: _**bold underlined**_. \* and \_
 * print as typed, and so does a marker with no partner later in the line.
 */
function parseEmphasis(text: string, upper = false): StyledText {
    const src = Array.from(cleanInline(text));
    const chars: string[] = [];
    const styles: Emphasis[] = [];
    const st: Emphasis = { b: false, i: false, u: false };
    const runAt = (k: number, c: string) => { let n = 0; while (src[k + n] === c) n++; return n; };
    /** Is there a later run of at least `n` stars? */
    const starsLater = (from: number, n: number) => {
        for (let k = from; k < src.length; k++) {
            if (src[k] === '\\') { k++; continue; }
            if (src[k] === '*') { const m = runAt(k, '*'); if (m >= n) return true; k += m - 1; }
        }
        return false;
    };
    /** Is there a later underscore run that can close (not followed by a letter)? */
    const underscoreLater = (from: number) => {
        for (let k = from; k < src.length; k++) {
            if (src[k] === '\\') { k++; continue; }
            if (src[k] === '_') { const m = runAt(k, '_'); if (!isWordChar(src[k + m])) return true; k += m - 1; }
        }
        return false;
    };
    const push = (c: string) => { chars.push(upper ? c.toUpperCase() : c); styles.push({ ...st }); };

    for (let k = 0; k < src.length; k++) {
        const c = src[k] ?? '';
        if (c === '\\' && (src[k + 1] === '*' || src[k + 1] === '_')) { push(src[k + 1] ?? ''); k++; continue; }
        if (c === '*') {
            const n = runAt(k, '*');
            let left = n;
            if (st.b && left >= 2) { st.b = false; left -= 2; }
            if (st.i && left >= 1) { st.i = false; left -= 1; }
            if (left >= 3 && !st.b && !st.i && starsLater(k + n, 3)) { st.b = true; st.i = true; left -= 3; }
            if (left >= 2 && !st.b && starsLater(k + n, 2)) { st.b = true; left -= 2; }
            if (left >= 1 && !st.i && starsLater(k + n, 1)) { st.i = true; left -= 1; }
            for (let j = 0; j < left; j++) push('*');
            k += n - 1;
            continue;
        }
        if (c === '_') {
            const n = runAt(k, '_');
            if (st.u && !isWordChar(src[k + n])) st.u = false;
            else if (!st.u && !isWordChar(src[k - 1]) && underscoreLater(k + n)) st.u = true;
            else for (let j = 0; j < n; j++) push('_');
            k += n - 1;
            continue;
        }
        push(c);
    }
    // trim the end (markers can leave trailing spaces)
    while (chars.length && /\s/.test(chars[chars.length - 1] ?? '')) { chars.pop(); styles.pop(); }
    return { chars, styles };
}

/** Word-wrap styled text to `width` characters, the same way as `wrap`. */
function wrapStyled(t: StyledText, width: number): StyledText[] {
    const words: [number, number][] = [];
    for (let k = 0; k < t.chars.length;) {
        while (k < t.chars.length && /\s/.test(t.chars[k] ?? '')) k++;
        const a = k;
        while (k < t.chars.length && !/\s/.test(t.chars[k] ?? '')) k++;
        if (k > a) words.push([a, k]);
    }
    if (!words.length) return [{ chars: [], styles: [] }];
    const slice = (a: number, b: number): StyledText => ({ chars: t.chars.slice(a, b), styles: t.styles.slice(a, b) });
    const plain: Emphasis = { b: false, i: false, u: false };
    const lines: StyledText[] = [];
    let cur: StyledText | null = null;
    for (const [start, b] of words) {
        let a = start;
        while (b - a > width) {   // hard-break pathological words
            if (cur) { lines.push(cur); cur = null; }
            lines.push(slice(a, a + width));
            a += width;
        }
        if (!cur) cur = slice(a, b);
        else if (cur.chars.length + 1 + (b - a) <= width) {
            // the space keeps the style it had (an underline runs across it)
            cur.chars.push(' ');
            cur.styles.push(a > 0 ? { ...(t.styles[a - 1] ?? plain) } : plain);
            const w = slice(a, b);
            cur.chars.push(...w.chars);
            cur.styles.push(...w.styles);
        } else { lines.push(cur); cur = slice(a, b); }
    }
    if (cur) lines.push(cur);
    return lines;
}

function wrap(text: string, width: number): string[] {
    const words = text.split(/\s+/).filter(w => w.length > 0);
    if (!words.length) return [''];
    const lines: string[] = [];
    let cur = '';
    for (let word of words) {
        while (word.length > width) {   // hard-break pathological words
            if (cur) { lines.push(cur); cur = ''; }
            lines.push(word.slice(0, width));
            word = word.slice(width);
        }
        if (!cur) cur = word;
        else if (cur.length + 1 + word.length <= width) cur += ' ' + word;
        else { lines.push(cur); cur = word; }
    }
    if (cur) lines.push(cur);
    return lines;
}

// ─── Classifier ───────────────────────────────────────────────────────────────

/** `text` keeps the fountain emphasis markers; `upper` prints it in capitals. */
interface PrintElement { type: ElementType | 'blank' | 'pagebreak'; text: string; upper?: boolean; }

/** Classify one script's lines into printable screenplay elements. */
function classifyScript(content: string): PrintElement[] {
    const lines = content.split('\n');
    const out: PrintElement[] = [];
    const start = skipTitlePage(lines);

    let prevBlank = true;
    let inDialogue = false;
    let inBoneyard = false;

    for (let i = start; i < lines.length; i++) {
        let raw = lines[i] ?? '';

        // Boneyard /* … */ — line-granular approximation
        if (inBoneyard) {
            const end = raw.indexOf('*/');
            if (end < 0) continue;
            raw = raw.slice(end + 2);
            inBoneyard = false;
        }
        const boneStart = raw.indexOf('/*');
        if (boneStart >= 0) {
            const boneEnd = raw.indexOf('*/', boneStart + 2);
            if (boneEnd >= 0) raw = raw.slice(0, boneStart) + raw.slice(boneEnd + 2);
            else { raw = raw.slice(0, boneStart); inBoneyard = true; }
        }

        const trimmed = raw.trim();

        if (!trimmed) {
            out.push({ type: 'blank', text: '' });
            prevBlank = true;
            inDialogue = false;
            continue;
        }

        // Page break
        if (/^={3,}$/.test(trimmed)) {
            out.push({ type: 'pagebreak', text: '' });
            prevBlank = true;
            inDialogue = false;
            continue;
        }

        // Sections and synopses are organizational — never printed
        if (/^#{1,6}\s/.test(raw) || /^=\s/.test(trimmed)) {
            prevBlank = false;
            continue;
        }

        // Centered  > text <
        if (trimmed.startsWith('>') && trimmed.endsWith('<')) {
            out.push({ type: 'centered', text: trimmed.slice(1, -1).trim() });
            prevBlank = false;
            continue;
        }

        // Forced transition  > text
        if (trimmed.startsWith('>')) {
            out.push({ type: 'transition', text: trimmed.slice(1).trim(), upper: true });
            prevBlank = false;
            continue;
        }

        const unstyled = trimmed.replace(/^[*_]+/, '').replace(/[*_]+$/, '').trim();

        if (isSceneHeading(unstyled, prevBlank)) {
            // drop a forcing '.', keeping any emphasis markers around it
            const text = (unstyled.startsWith('.') && !unstyled.startsWith('..'))
                ? trimmed.replace(/^([*_]*)\./, '$1')
                : trimmed;
            out.push({ type: 'scene', text, upper: true });
            prevBlank = false;
            inDialogue = false;
            continue;
        }

        if (isStandardTransition(unstyled, prevBlank)) {
            out.push({ type: 'transition', text: trimmed });
            prevBlank = false;
            inDialogue = false;
            continue;
        }

        if (isMarkerHeading(unstyled, prevBlank)) {
            out.push({ type: 'scene', text: trimmed });
            prevBlank = false;
            inDialogue = false;
            continue;
        }

        if (isCharacterName(trimmed, prevBlank, lines[i + 1] ?? '')) {
            const name = trimmed.startsWith('@') ? trimmed.slice(1).trim() : trimmed;
            out.push({ type: 'character', text: name.replace(/\s*\^\s*$/, '') });
            prevBlank = false;
            inDialogue = true;
            continue;
        }

        if (inDialogue) {
            out.push({
                type: trimmed.startsWith('(') ? 'parenthetical' : 'dialogue',
                text: trimmed,
            });
            prevBlank = false;
            continue;
        }

        out.push({ type: 'action', text: trimmed });
        prevBlank = false;
    }

    return out;
}

// ─── Renderer ─────────────────────────────────────────────────────────────────

/**
 * Stitch several fountain scripts (in the given order, each starting on a fresh
 * page) into a single US-Letter screenplay PDF. Returns the PDF bytes.
 */
export function buildStitchedPdf(scripts: { name: string; content: string }[]): ArrayBuffer {
    const doc = new jsPDF({ orientation: 'portrait', unit: 'in', format: 'letter' });
    registerScriptFont(doc);
    doc.setFont(SCRIPT_FONT, 'normal');
    doc.setFontSize(12);

    let pageNum = 1;
    let y = FIRST_LINE_Y;
    let lastWasBlank = true;   // suppress blanks at the top of a page

    const newPage = () => {
        doc.addPage();
        pageNum++;
        doc.text(`${pageNum}.`, RIGHT_EDGE, PAGE_NUM_Y, { align: 'right' });
        y = FIRST_LINE_Y;
        lastWasBlank = true;
    };

    const ensureRoom = (linesNeeded: number) => {
        if (y + (linesNeeded - 1) * LINE_HEIGHT > LAST_LINE_Y) newPage();
    };

    /** One line, each run of the same emphasis in its own font face; underline as a rule. */
    const put = (line: StyledText, x: number, align?: 'right' | 'center') => {
        const len = line.chars.length;
        const x0 = align === 'right' ? x - len * CHAR_WIDTH : align === 'center' ? x - (len * CHAR_WIDTH) / 2 : x;
        for (let k = 0; k < len;) {
            const s = line.styles[k] ?? { b: false, i: false, u: false };
            let e = k + 1;
            while (e < len && sameEmphasis(line.styles[e], s)) e++;
            doc.setFont(SCRIPT_FONT, s.b && s.i ? 'bolditalic' : s.b ? 'bold' : s.i ? 'italic' : 'normal');
            doc.text(line.chars.slice(k, e).join(''), x0 + k * CHAR_WIDTH, y);
            if (s.u) {
                doc.setLineWidth(UNDERLINE_WIDTH);
                doc.line(x0 + k * CHAR_WIDTH, y + UNDERLINE_DROP, x0 + e * CHAR_WIDTH, y + UNDERLINE_DROP);
            }
            k = e;
        }
        doc.setFont(SCRIPT_FONT, 'normal');
        y += LINE_HEIGHT;
        lastWasBlank = false;
    };

    for (let s = 0; s < scripts.length; s++) {
        const script = scripts[s];
        if (!script) continue;
        if (s > 0) newPage();   // every file starts on a fresh page

        const elements = classifyScript(script.content);

        for (let e = 0; e < elements.length; e++) {
            const el = elements[e];
            if (!el) continue;

            switch (el.type) {
                case 'blank':
                    if (!lastWasBlank && y <= LAST_LINE_Y) { y += LINE_HEIGHT; lastWasBlank = true; }
                    break;

                case 'pagebreak':
                    newPage();
                    break;

                case 'transition':
                    ensureRoom(1);
                    put(parseEmphasis(el.text, el.upper), RIGHT_EDGE, 'right');
                    break;

                case 'centered':
                    ensureRoom(1);
                    put(parseEmphasis(el.text, el.upper), 4.25, 'center');
                    break;

                case 'character': {
                    ensureRoom(2);   // keep the cue with its first dialogue line
                    put(parseEmphasis(el.text, el.upper), LAYOUT.character.left);
                    break;
                }

                case 'scene':
                case 'action':
                case 'parenthetical':
                case 'dialogue': {
                    const layout = LAYOUT[el.type];
                    if (el.type === 'scene') ensureRoom(3);   // keep heading with following content
                    for (const line of wrapStyled(parseEmphasis(el.text, el.upper), layout.width)) {
                        ensureRoom(1);
                        put(line, layout.left);
                    }
                    break;
                }
            }
        }
    }

    return doc.output('arraybuffer');
}

/** Rough character-width sanity: exported for tests. */
export const _internal = { classifyScript, wrap, wrapStyled, parseEmphasis, stripInline, CHAR_WIDTH };
