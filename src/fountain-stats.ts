import { App, TFile, TFolder, normalizePath } from 'obsidian';
import { parseFountainOutline, FountainNode } from './fountain-parser';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CharacterTotals {
    scenes: number;
    dialogues: number;
    words: number;
}

/** Screenplay statistics for one file (or an aggregate of many). */
export interface ScriptStats {
    files: number;
    scenes: number;          // numbered scenes only (markers excluded)
    words: number;           // all words across scene ranges
    pages: number;           // sum of per-scene pageEstimate
    intExt: Map<string, number>;      // "INT." / "EXT." / "INT./EXT." → scene count
    timeOfDay: Map<string, number>;   // "DAY" / "NIGHT" / … → scene count
    locations: Map<string, number>;   // location → scene count
    characters: Map<string, CharacterTotals>;
}

export function emptyStats(): ScriptStats {
    return {
        files: 0, scenes: 0, words: 0, pages: 0,
        intExt: new Map(), timeOfDay: new Map(),
        locations: new Map(), characters: new Map(),
    };
}

// ─── Scene heading decomposition ──────────────────────────────────────────────
//
// Lives in the syntax core with the rest of the line grammar; re-exported here
// so existing importers keep working.

import { decomposeHeading } from './fountain-syntax';
export { decomposeHeading };

// ─── Per-file stats ───────────────────────────────────────────────────────────

function bump(map: Map<string, number>, key: string, by = 1): void {
    if (!key) return;
    map.set(key, (map.get(key) ?? 0) + by);
}

export function computeScriptStats(content: string): ScriptStats {
    return statsFromNodes(parseFountainOutline(content));
}

/** Same as computeScriptStats but reuses an already-parsed AST (e.g. the outline's). */
export function statsFromNodes(nodes: FountainNode[]): ScriptStats {
    const stats = emptyStats();
    stats.files = 1;

    for (const node of nodes) {
        if (node.type !== 'scene_heading') continue;

        stats.words += node.stats?.wordCount ?? 0;
        stats.pages += node.stats?.pageEstimate ?? 0;

        if (!node.marker) {
            stats.scenes++;
            const { intExt, location, timeOfDay } = decomposeHeading(node.text);
            bump(stats.intExt, intExt);
            bump(stats.timeOfDay, timeOfDay);
            bump(stats.locations, location);
        }

        for (const char of node.characters ?? []) {
            const t = stats.characters.get(char.name) ?? { scenes: 0, dialogues: 0, words: 0 };
            t.scenes++;
            t.dialogues += char.dialogueCount;
            t.words += char.wordCount;
            stats.characters.set(char.name, t);
        }
    }
    return stats;
}

export function mergeStats(into: ScriptStats, from: ScriptStats): void {
    into.files += from.files;
    into.scenes += from.scenes;
    into.words += from.words;
    into.pages += from.pages;
    for (const [k, v] of from.intExt) bump(into.intExt, k, v);
    for (const [k, v] of from.timeOfDay) bump(into.timeOfDay, k, v);
    for (const [k, v] of from.locations) bump(into.locations, k, v);
    for (const [name, t] of from.characters) {
        const dst = into.characters.get(name) ?? { scenes: 0, dialogues: 0, words: 0 };
        dst.scenes += t.scenes;
        dst.dialogues += t.dialogues;
        dst.words += t.words;
        into.characters.set(name, dst);
    }
}

// ─── Vault helpers ────────────────────────────────────────────────────────────

export function isFountainFile(file: TFile | null): file is TFile {
    if (!file) return false;
    return file.extension === 'fountain' || file.basename.endsWith('.fountain');
}

/** All .fountain files under folderPath (recursive), sorted by path. */
export function listFountainFiles(app: App, folderPath: string): TFile[] {
    const folder = app.vault.getAbstractFileByPath(normalizePath(folderPath || '/'));
    if (!(folder instanceof TFolder)) return [];
    const out: TFile[] = [];
    const walk = (dir: TFolder) => {
        for (const child of dir.children) {
            if (child instanceof TFolder) walk(child);
            else if (child instanceof TFile && isFountainFile(child)) out.push(child);
        }
    };
    walk(folder);
    return out.sort((a, b) => a.path.localeCompare(b.path));
}

// ─── Cache ────────────────────────────────────────────────────────────────────

/**
 * Per-file stats cache keyed by path + mtime. A file is only re-parsed when its
 * mtime changes (i.e. it was saved), so folder-wide refreshes triggered by every
 * keystroke in the active file cost one parse (the live file), not N.
 */
export class ScriptStatsCache {
    private cache = new Map<string, { mtime: number; stats: ScriptStats }>();

    invalidate(path: string): void {
        this.cache.delete(path);
    }

    clear(): void {
        this.cache.clear();
    }

    async get(app: App, file: TFile): Promise<ScriptStats> {
        const hit = this.cache.get(file.path);
        if (hit && hit.mtime === file.stat.mtime) return hit.stats;
        const content = await app.vault.cachedRead(file);
        const stats = computeScriptStats(content);
        this.cache.set(file.path, { mtime: file.stat.mtime, stats });
        return stats;
    }
}
