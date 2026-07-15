// ─── Fountain lint ────────────────────────────────────────────────────────────
//
// Inline diagnostics for screenplay structure, built on the shared classifier.
// Registered as a debounced @codemirror/lint source; squiggles show up in the
// native editor like any language server's would.
//
// Single-file rules:
//   near-dup character   A cue whose name is one edit away from a more frequent
//                        cast member — almost always a typo. (warning)
//   silent cue           An ALL-CAPS line matching a known character but with no
//                        dialogue after it, so Fountain reads it as action. (warning)
//   transition typo      One edit away from a standard transition. (warning)
//   missing time-of-day  Scene heading without a " - DAY/NIGHT/…" suffix. (info)
//   unclosed boneyard    /* without */ before end of file. (error)
//   unclosed note        [[ that never reaches ]] before a blank line. (warning)

import { linter, Diagnostic } from '@codemirror/lint';
import type { Extension } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import {
    classifyLines, decomposeHeading, isAllCaps, stripEmphasis, LineClass,
} from './fountain-syntax';
import { buildFileIndex, cueName } from './fountain-index';
import { diskTranslationGroup, fountainFileOf, fountainLang } from './fountain-lang';
import { STANDARD_TRANSITIONS } from './fountain-hints';
import type { TFile } from 'obsidian';
import type FountainPlugin from './main';

/** True when a and b are at most one insert/delete/replace apart (case-insensitive). */
export function withinOneEdit(a: string, b: string): boolean {
    a = a.toUpperCase(); b = b.toUpperCase();
    if (a === b) return true;
    if (Math.abs(a.length - b.length) > 1) return false;
    let i = 0, j = 0, edits = 0;
    while (i < a.length && j < b.length) {
        if (a[i] === b[j]) { i++; j++; continue; }
        if (++edits > 1) return false;
        if (a.length > b.length) i++;
        else if (b.length > a.length) j++;
        else { i++; j++; }
    }
    return edits + (a.length - i) + (b.length - j) <= 1;
}

interface Doc {
    lines: string[];
    classes: LineClass[];
    /** Char offset of the start of each line. */
    offsets: number[];
}

function lineRange(doc: Doc, line: number): { from: number; to: number } {
    const from = doc.offsets[line] ?? 0;
    return { from, to: from + (doc.lines[line]?.length ?? 0) };
}

function diag(doc: Doc, line: number, severity: Diagnostic['severity'], message: string): Diagnostic {
    return { ...lineRange(doc, line), severity, message };
}

// ─── Rules ────────────────────────────────────────────────────────────────────

function lintCharacters(doc: Doc, out: Diagnostic[]): void {
    // Collect cue lines per name
    const cues = new Map<string, number[]>();
    for (let i = 0; i < doc.lines.length; i++) {
        if (doc.classes[i]?.element !== 'character') continue;
        const name = cueName((doc.lines[i] ?? '').trim());
        if (!name) continue;
        const arr = cues.get(name) ?? [];
        arr.push(i);
        cues.set(name, arr);
    }

    // Near-duplicate names: flag every cue of the rarer spelling. A name that
    // speaks repeatedly is probably a real (similar-sounding) character — think
    // Big Fish's twins PING and JING — so only flag one-off or vastly rarer names.
    const names = [...cues.keys()];
    for (const rare of names) {
        if (rare.length < 3) continue;
        for (const common of names) {
            if (rare === common) continue;
            const rareCount = cues.get(rare)?.length ?? 0;
            const commonCount = cues.get(common)?.length ?? 0;
            if (rareCount > 1 && rareCount * 5 > commonCount) continue;
            if (rareCount >= commonCount) continue;
            if (!withinOneEdit(rare, common)) continue;
            for (const line of cues.get(rare) ?? []) {
                out.push(diag(doc, line, 'warning',
                    `"${rare}" is one letter away from "${common}" (${cues.get(common)?.length} cues) — typo?`));
            }
        }
    }

    // Silent cues: a known character's name standing alone with no dialogue after
    // it — Fountain classifies that as action, so the line is silently NOT a cue.
    const cast = new Set(names.map((n) => n.toUpperCase()));
    for (let i = 0; i < doc.lines.length; i++) {
        if (doc.classes[i]?.element !== 'action') continue;
        const trimmed = (doc.lines[i] ?? '').trim();
        if (!isAllCaps(trimmed) || trimmed.endsWith(':')) continue;
        const prevBlank = i === 0 || (doc.lines[i - 1] ?? '').trim() === '';
        const nextBlank = i === doc.lines.length - 1 || (doc.lines[i + 1] ?? '').trim() === '';
        if (prevBlank && nextBlank && cast.has(cueName(trimmed).toUpperCase())) {
            out.push(diag(doc, i, 'warning',
                `"${cueName(trimmed)}" reads as a character cue but has no dialogue after it, so Fountain treats it as action.`));
        }
    }
}

function lintTransitions(doc: Doc, out: Diagnostic[], known: Set<string>): void {
    for (let i = 0; i < doc.lines.length; i++) {
        const element = doc.classes[i]?.element;
        let text = stripEmphasis((doc.lines[i] ?? '').trim());

        // A typo'd transition usually stops LOOKING like a transition: "CUT TOO:"
        // ends up a marker-style scene heading. Check those too.
        if (element === 'transition') {
            if (text.startsWith('>')) text = text.slice(1).trim();
        } else if (element === 'scene_heading' && text.endsWith(':')) {
            if (decomposeHeading(text).intExt !== 'OTHER') continue;
        } else {
            continue;
        }

        // Known = standard + the user's dictionary + transitions used elsewhere in
        // the project, so a deliberate custom transition is never flagged.
        if (known.has(text.toUpperCase())) continue;
        const near = STANDARD_TRANSITIONS.find((t) => withinOneEdit(text, t));
        if (near) {
            out.push(diag(doc, i, 'warning', `"${text}" is one letter away from "${near}" — typo?`));
        }
    }
}

function lintSceneHeadings(doc: Doc, out: Diagnostic[]): void {
    for (let i = 0; i < doc.lines.length; i++) {
        if (doc.classes[i]?.element !== 'scene_heading') continue;
        let text = (doc.lines[i] ?? '').trim();
        if (text.startsWith('.') && !text.startsWith('..')) text = text.slice(1).trim();
        text = stripEmphasis(text.replace(/#[A-Za-z0-9.\-]+#\s*$/, '').trim());
        const { intExt, timeOfDay } = decomposeHeading(text);
        if (intExt === 'OTHER') continue; // markers like OVER BLACK: have no time
        if (!timeOfDay) {
            out.push(diag(doc, i, 'info', 'Scene heading has no " - TIME" suffix (DAY, NIGHT, …).'));
        }
    }
}

function lintUnclosed(doc: Doc, out: Diagnostic[]): void {
    for (let i = 0; i < doc.lines.length; i++) {
        const lineLen = (doc.lines[i] ?? '').length;
        for (const mark of doc.classes[i]?.marks ?? []) {
            if (mark.to !== lineLen) continue; // only openers that ran off the line
            if (mark.kind !== 'boneyard' && mark.kind !== 'note') continue;

            // Walk the continuation run and look for a closing mark
            const closeToken = mark.kind === 'boneyard' ? '*/' : ']]';
            let closed = false;
            for (let j = i + 1; j < doc.lines.length && doc.classes[j]?.element === mark.kind; j++) {
                if ((doc.lines[j] ?? '').includes(closeToken)) { closed = true; break; }
            }
            if (!closed) {
                out.push(mark.kind === 'boneyard'
                    ? diag(doc, i, 'error', 'Unclosed boneyard comment — "/*" without a matching "*/".')
                    : diag(doc, i, 'warning', 'Unclosed note — "[[" without a matching "]]" before a blank line.'));
            }
        }
    }
}

// ─── Bilingual drift (cross-file) ─────────────────────────────────────────────
//
// When a script exists in several languages (bigfish.en.fountain +
// bigfish.vi.fountain), the versions drift: a scene added in one but not the
// other, a character renamed in only one place. Compare this file against each
// sibling on disk and surface the differences as gentle `info` diagnostics.

/** Case- and diacritic-insensitive key so "EDWARD" matches "ÉDOUARD"-style accenting of the same name. */
function nameKey(name: string): string {
    return name.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
}

async function lintDrift(plugin: FountainPlugin, file: TFile, doc: Doc, out: Diagnostic[]): Promise<void> {
    if (fountainLang(file).lang === null) return; // untagged files have no counterparts

    const siblings = diskTranslationGroup(plugin.app, file)
        .filter((m) => m.file.path !== file.path && m.lang !== null && m.lang !== fountainLang(file).lang);
    if (!siblings.length) return;

    const mine = buildFileIndex(doc.lines.join('\n'));

    // First cue line per character, for anchoring cast-drift diagnostics
    const firstCue = new Map<string, number>();
    for (let i = 0; i < doc.lines.length; i++) {
        if (doc.classes[i]?.element !== 'character') continue;
        const key = nameKey(cueName((doc.lines[i] ?? '').trim()));
        if (!firstCue.has(key)) firstCue.set(key, i);
    }

    for (const sibling of siblings) {
        const theirs = buildFileIndex(await plugin.app.vault.cachedRead(sibling.file));
        const label = sibling.file.name;

        if (theirs.sceneCount !== mine.sceneCount) {
            const anchor = doc.classes.findIndex((c) => c.element === 'scene_heading');
            out.push(diag(doc, Math.max(0, anchor), 'info',
                `${mine.sceneCount} scenes here, ${theirs.sceneCount} in ${label} — the versions have drifted.`));
        }

        const theirCast = new Set([...theirs.characters.keys()].map(nameKey));
        for (const [name] of mine.characters) {
            if (theirCast.has(nameKey(name))) continue;
            out.push(diag(doc, firstCue.get(nameKey(name)) ?? 0, 'info',
                `"${name}" never speaks in ${label}.`));
        }
    }
}

// ─── Source ───────────────────────────────────────────────────────────────────

function makeDoc(content: string): Doc {
    const lines = content.split('\n');
    const offsets: number[] = new Array<number>(lines.length);
    let pos = 0;
    for (let i = 0; i < lines.length; i++) {
        offsets[i] = pos;
        pos += (lines[i] ?? '').length + 1;
    }
    return { lines, classes: classifyLines(lines), offsets };
}

function lintSingleFile(doc: Doc, knownTransitions: Set<string>): Diagnostic[] {
    const out: Diagnostic[] = [];
    lintCharacters(doc, out);
    lintTransitions(doc, out, knownTransitions);
    lintSceneHeadings(doc, out);
    lintUnclosed(doc, out);
    return out;
}

export function lintDocument(content: string, knownTransitions?: Set<string>): Diagnostic[] {
    const known = knownTransitions ?? new Set(STANDARD_TRANSITIONS.map((t) => t.toUpperCase()));
    return lintSingleFile(makeDoc(content), known).sort((a, b) => a.from - b.from);
}

export function fountainLintExtension(plugin: FountainPlugin): Extension {
    return linter(
        async (view: EditorView): Promise<Diagnostic[]> => {
            if (!plugin.settings.enableLint) return [];
            const file = fountainFileOf(view.state);
            if (!file) return [];

            const doc = makeDoc(view.state.doc.toString());
            const out = lintSingleFile(doc, plugin.knownTransitions());
            if (plugin.settings.enableDriftLint) {
                await lintDrift(plugin, file, doc, out);
            }
            return out.sort((a, b) => a.from - b.from);
        },
        { delay: 750 },
    );
}
