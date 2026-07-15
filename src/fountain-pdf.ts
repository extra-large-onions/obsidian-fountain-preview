import { jsPDF } from 'jspdf';
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

interface ElementLayout { left: number; width: number; } // width in characters

const LAYOUT = {
    scene:         { left: 1.5, width: 60 } as ElementLayout,
    action:        { left: 1.5, width: 60 } as ElementLayout,
    character:     { left: 3.7, width: 33 } as ElementLayout,
    parenthetical: { left: 3.1, width: 25 } as ElementLayout,
    dialogue:      { left: 2.5, width: 35 } as ElementLayout,
};

type ElementType = keyof typeof LAYOUT | 'transition' | 'centered';

// ─── Text helpers ─────────────────────────────────────────────────────────────

/** Strip fountain inline syntax that has no plain-text meaning: emphasis, notes, lyrics tilde. */
function stripInline(text: string): string {
    return text
        .replace(/\[\[[^\]]*\]\]/g, '')   // [[notes]]
        .replace(/\*+/g, '')              // **bold** *italic*
        .replace(/(^|\s)_|_(\s|$)/g, '$1$2') // _underline_ markers
        .replace(/^~/, '')                // ~lyrics
        .trimEnd();
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

interface PrintElement { type: ElementType | 'blank' | 'pagebreak'; text: string; }

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
            out.push({ type: 'centered', text: stripInline(trimmed.slice(1, -1).trim()) });
            prevBlank = false;
            continue;
        }

        // Forced transition  > text
        if (trimmed.startsWith('>')) {
            out.push({ type: 'transition', text: stripInline(trimmed.slice(1).trim()).toUpperCase() });
            prevBlank = false;
            continue;
        }

        const unstyled = trimmed.replace(/^[*_]+/, '').replace(/[*_]+$/, '').trim();

        if (isSceneHeading(unstyled, prevBlank)) {
            const text = (unstyled.startsWith('.') && !unstyled.startsWith('..'))
                ? unstyled.slice(1).trim()
                : unstyled;
            out.push({ type: 'scene', text: stripInline(text).toUpperCase() });
            prevBlank = false;
            inDialogue = false;
            continue;
        }

        if (isStandardTransition(unstyled, prevBlank)) {
            out.push({ type: 'transition', text: unstyled });
            prevBlank = false;
            inDialogue = false;
            continue;
        }

        if (isMarkerHeading(unstyled, prevBlank)) {
            out.push({ type: 'scene', text: unstyled });
            prevBlank = false;
            inDialogue = false;
            continue;
        }

        if (isCharacterName(trimmed, prevBlank, lines[i + 1] ?? '')) {
            const name = trimmed.startsWith('@') ? trimmed.slice(1).trim() : trimmed;
            out.push({ type: 'character', text: stripInline(name).replace(/\s*\^\s*$/, '') });
            prevBlank = false;
            inDialogue = true;
            continue;
        }

        if (inDialogue) {
            out.push({
                type: trimmed.startsWith('(') ? 'parenthetical' : 'dialogue',
                text: stripInline(trimmed),
            });
            prevBlank = false;
            continue;
        }

        out.push({ type: 'action', text: stripInline(trimmed) });
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
    doc.setFont('courier', 'normal');
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

    const put = (text: string, x: number, align?: 'right' | 'center') => {
        if (align === 'right') doc.text(text, x, y, { align: 'right' });
        else if (align === 'center') doc.text(text, x, y, { align: 'center' });
        else doc.text(text, x, y);
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
                    put(el.text, RIGHT_EDGE, 'right');
                    break;

                case 'centered':
                    ensureRoom(1);
                    put(el.text, 4.25, 'center');
                    break;

                case 'character': {
                    ensureRoom(2);   // keep the cue with its first dialogue line
                    put(el.text, LAYOUT.character.left);
                    break;
                }

                case 'scene':
                case 'action':
                case 'parenthetical':
                case 'dialogue': {
                    const layout = LAYOUT[el.type];
                    if (el.type === 'scene') ensureRoom(3);   // keep heading with following content
                    for (const line of wrap(el.text, layout.width)) {
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
export const _internal = { classifyScript, wrap, CHAR_WIDTH };
