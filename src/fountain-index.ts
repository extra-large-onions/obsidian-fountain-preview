// ─── Per-file vocabulary index ────────────────────────────────────────────────
//
// Everything the autocomplete, linter and hover layers want to know about one
// screenplay: which characters speak, which locations and times of day the
// headings use, which transitions appear. Built from the shared classifier —
// no scanning regexes of its own.

import { classifyLines, decomposeHeading, stripEmphasis } from './fountain-syntax';

// The whole-project aggregation of these indexes (mergeIndex/cloneIndex below)
// lives in the plugin (main.ts) so this module stays Obsidian-free and unit-testable.

export interface FileIndex {
    /** Character name (canonical casing) → number of cues. */
    characters: Map<string, number>;
    /** Location (as written in headings, minus INT./EXT. and time) → scene count. */
    locations: Map<string, number>;
    /** Time of day (DAY, NIGHT, …) → scene count. */
    timesOfDay: Map<string, number>;
    /** Transition text (CUT TO:, FADE OUT.) → use count. */
    transitions: Map<string, number>;
    /** Marker headings (OVER BLACK:, INTERCUT WITH:) → use count. */
    markers: Map<string, number>;
    /** Section titles in document order. */
    sections: string[];
    sceneCount: number;
}

function bump(map: Map<string, number>, key: string): void {
    if (!key) return;
    map.set(key, (map.get(key) ?? 0) + 1);
}

export function emptyIndex(): FileIndex {
    return {
        characters: new Map(), locations: new Map(), timesOfDay: new Map(),
        transitions: new Map(), markers: new Map(), sections: [], sceneCount: 0,
    };
}

export function cloneIndex(src: FileIndex): FileIndex {
    return {
        characters: new Map(src.characters), locations: new Map(src.locations),
        timesOfDay: new Map(src.timesOfDay), transitions: new Map(src.transitions),
        markers: new Map(src.markers), sections: [...src.sections], sceneCount: src.sceneCount,
    };
}

function mergeCounts(into: Map<string, number>, from: Map<string, number>): void {
    for (const [k, v] of from) into.set(k, (into.get(k) ?? 0) + v);
}

/** Fold `from` into `into` (used to aggregate a whole project's vocabulary). */
export function mergeIndex(into: FileIndex, from: FileIndex): FileIndex {
    mergeCounts(into.characters, from.characters);
    mergeCounts(into.locations, from.locations);
    mergeCounts(into.timesOfDay, from.timesOfDay);
    mergeCounts(into.transitions, from.transitions);
    mergeCounts(into.markers, from.markers);
    for (const s of from.sections) if (!into.sections.includes(s)) into.sections.push(s);
    into.sceneCount += from.sceneCount;
    return into;
}

/** "@McAVOY (V.O.) ^" → "McAVOY" — the bare character name of a cue line. */
export function cueName(trimmed: string): string {
    let name = trimmed.startsWith('@') ? trimmed.slice(1) : trimmed;
    name = name.replace(/\^\s*$/, '');
    name = name.replace(/\s*\([^)]*\)/g, '');
    return name.trim();
}

/** Scene heading text minus the forced "." prefix and the trailing #N# number. */
function headingText(trimmed: string): string {
    let text = (trimmed.startsWith('.') && !trimmed.startsWith('..')) ? trimmed.slice(1) : trimmed;
    text = text.replace(/#[A-Za-z0-9.\-]+#\s*$/, '');
    return stripEmphasis(text.trim());
}

export function buildFileIndex(content: string): FileIndex {
    const lines = content.split('\n');
    const classes = classifyLines(lines);

    const index: FileIndex = {
        characters: new Map(),
        locations: new Map(),
        timesOfDay: new Map(),
        transitions: new Map(),
        markers: new Map(),
        sections: [],
        sceneCount: 0,
    };

    for (let i = 0; i < lines.length; i++) {
        const trimmed = (lines[i] ?? '').trim();
        switch (classes[i]?.element) {
            case 'character':
                bump(index.characters, cueName(trimmed));
                break;
            case 'scene_heading': {
                const text = headingText(trimmed);
                const { intExt, location, timeOfDay } = decomposeHeading(text);
                if (intExt === 'OTHER' && text.endsWith(':')) {
                    bump(index.markers, text);
                } else {
                    index.sceneCount++;
                    bump(index.locations, location);
                    bump(index.timesOfDay, timeOfDay);
                }
                break;
            }
            case 'transition': {
                let text = stripEmphasis(trimmed);
                if (text.startsWith('>')) text = text.slice(1).trim();
                bump(index.transitions, text);
                break;
            }
            case 'section': {
                const m = /^#{1,6}\s+(.*)$/.exec(trimmed);
                if (m) index.sections.push((m[1] ?? '').trim());
                break;
            }
        }
    }
    return index;
}
