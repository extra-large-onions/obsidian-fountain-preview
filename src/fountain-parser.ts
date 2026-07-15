// ─── Types ────────────────────────────────────────────────────────────────────

export type FountainNodeType = 'section' | 'scene_heading' | 'transition' | 'synopsis';

export interface FountainCharacter {
    name: string;
    line: number;           // first line they speak in this scene
    dialogueCount: number;  // separate speaking turns
    wordCount: number;      // total words spoken
}

export interface FountainStats {
    lineCount: number;      // non-blank lines in scene range
    wordCount: number;      // all words in scene range (action + dialogue)
    pageEstimate: number;   // (endLine − startLine + 1) / 55  — fractional pages
    startPage: number;      // approximate page number in the script
}

export interface FountainNode {
    type: FountainNodeType;
    text: string;
    /** 1–6 for sections, 0 for all other types */
    level: number;
    /** 0-indexed source line */
    line: number;
    /** Last source line of this scene (scene_heading only, set in post-processing) */
    endLine?: number;
    /** Explicit #N# from heading, or auto-assigned "1","2",… (scene_heading only) */
    sceneNumber?: string;
    /** True for marker headings like "OVER BLACK:" — scene-level containers with no scene number */
    marker?: boolean;
    /** Unique speakers, in first-appearance order (scene_heading only) */
    characters?: FountainCharacter[];
    /** Line/word/page stats (scene_heading only) */
    stats?: FountainStats;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
//
// Line detection lives in the syntax core (fountain-syntax.ts) so the parser,
// highlighter, linter and suggester all agree by construction. Re-exported here
// so existing importers keep working.

import {
    isAllCaps, isSceneHeading, isStandardTransition, isMarkerHeading,
    isCharacterName, skipTitlePage, stripEmphasis,
} from './fountain-syntax';

export {
    isAllCaps, isSceneHeading, isStandardTransition, isMarkerHeading,
    isCharacterName, skipTitlePage,
};

function countWords(text: string): number {
    return text.trim().split(/\s+/).filter(w => w.length > 0).length;
}

/** Extract optional #N# scene number suffix from a scene heading text. */
function splitSceneNumber(text: string): { text: string; sceneNumber?: string } {
    const m = /#([A-Za-z0-9.\-]+)#\s*$/.exec(text);
    if (m) return { text: text.slice(0, m.index).trim(), sceneNumber: m[1] };
    return { text };
}

function extractCharacterName(text: string): string {
    let name = text.startsWith('@') ? text.slice(1).trim() : text;
    name = name.replace(/\s*\([^)]*\)/g, '').trim();
    return name;
}

function computeSceneStats(lines: string[], startLine: number, endLine: number): FountainStats {
    let lineCount = 0;
    let wordCount = 0;
    for (let i = startLine; i <= endLine; i++) {
        const line = (lines[i] ?? '').trim();
        if (line) {
            lineCount++;
            wordCount += countWords(line);
        }
    }
    return {
        lineCount,
        wordCount,
        pageEstimate: (endLine - startLine + 1) / 55,
        startPage: Math.max(1, Math.ceil(startLine / 55)),
    };
}

// ─── Main export ──────────────────────────────────────────────────────────────

export function parseFountainOutline(content: string): FountainNode[] {
    const lines = content.split('\n');
    const nodes: FountainNode[] = [];
    const start = skipTitlePage(lines);

    let prevBlank = true;
    let currentScene: FountainNode | null = null;
    let currentSpeaker: string | null = null;

    // name → { first line, speaking turns, word count }
    const sceneChars = new Map<string, { line: number; dialogueCount: number; wordCount: number }>();

    const finalizeScene = () => {
        if (currentScene) {
            currentScene.characters = [...sceneChars.entries()].map(([name, e]) => ({
                name, line: e.line, dialogueCount: e.dialogueCount, wordCount: e.wordCount,
            }));
        }
        sceneChars.clear();
        currentSpeaker = null;
    };

    for (let i = start; i < lines.length; i++) {
        const raw = lines[i] ?? '';
        const trimmed = raw.trim();

        // ── Blank line ──────────────────────────────────────────────────────
        if (!trimmed) {
            prevBlank = true;
            currentSpeaker = null;
            continue;
        }

        // ── Section ─────────────────────────────────────────────────────────
        const secMatch = /^(#{1,6})\s+(.+)/.exec(raw);
        if (secMatch) {
            currentSpeaker = null;
            nodes.push({ type: 'section', text: (secMatch[2] ?? '').trim(), level: (secMatch[1] ?? '').length, line: i });
            prevBlank = false; continue;
        }

        // ── Synopsis ────────────────────────────────────────────────────────
        const synMatch = /^=\s+(.+)/.exec(trimmed);
        if (synMatch) {
            currentSpeaker = null;
            nodes.push({ type: 'synopsis', text: (synMatch[1] ?? '').trim(), level: 0, line: i });
            prevBlank = false; continue;
        }

        // ── Forced transition ───────────────────────────────────────────────
        if (trimmed.startsWith('>') && !trimmed.endsWith('<')) {
            currentSpeaker = null;
            nodes.push({ type: 'transition', text: trimmed.slice(1).trim(), level: 0, line: i });
            prevBlank = false; continue;
        }

        // ── Scene heading ───────────────────────────────────────────────────
        if (isSceneHeading(trimmed, prevBlank)) {
            finalizeScene();
            const raw2 = (trimmed.startsWith('.') && !trimmed.startsWith('..')) ? trimmed.slice(1).trim() : trimmed;
            const { text, sceneNumber } = splitSceneNumber(raw2);
            const node: FountainNode = { type: 'scene_heading', text, level: 0, line: i, sceneNumber };
            nodes.push(node);
            currentScene = node;
            prevBlank = false; continue;
        }

        // Fountain emphasis (**FADE IN:**, _OVER BLACK:_) still counts for
        // transition/marker detection — strip surrounding * and _ first.
        const unstyled = stripEmphasis(trimmed);

        // ── Standard transition ─────────────────────────────────────────────
        if (isStandardTransition(unstyled, prevBlank)) {
            currentSpeaker = null;
            nodes.push({ type: 'transition', text: unstyled, level: 0, line: i });
            prevBlank = false; continue;
        }

        // ── Marker heading (OVER BLACK:, INTERCUT WITH:, …) ─────────────────
        if (isMarkerHeading(unstyled, prevBlank)) {
            finalizeScene();
            const node: FountainNode = { type: 'scene_heading', text: unstyled, level: 0, line: i, marker: true };
            nodes.push(node);
            currentScene = node;
            prevBlank = false; continue;
        }

        // ── Character name (collected, not emitted) ─────────────────────────
        if (isCharacterName(trimmed, prevBlank, lines[i + 1] ?? '')) {
            const name = extractCharacterName(trimmed);
            if (!sceneChars.has(name)) {
                sceneChars.set(name, { line: i, dialogueCount: 0, wordCount: 0 });
            }
            const entry = sceneChars.get(name)!;
            entry.dialogueCount++;
            currentSpeaker = name;
            prevBlank = false; continue;
        }

        // ── Dialogue / action / parenthetical ───────────────────────────────
        if (currentSpeaker) {
            const entry = sceneChars.get(currentSpeaker);
            // Count words only for dialogue lines, not parentheticals
            if (entry && !trimmed.startsWith('(')) {
                entry.wordCount += countWords(trimmed);
            }
        }
        prevBlank = false;
    }

    finalizeScene();

    // ── Post-processing ─────────────────────────────────────────────────────

    // 1. endLine per scene heading
    const sceneNodes = nodes.filter(n => n.type === 'scene_heading');
    for (let i = 0; i < sceneNodes.length; i++) {
        const scene = sceneNodes[i];
        if (!scene) continue;
        const next = sceneNodes[i + 1];
        scene.endLine = next ? next.line - 1 : lines.length - 1;
    }

    // 2. Auto-assign scene numbers for headings that don't have #N#
    //    (markers like "OVER BLACK:" are containers, not numbered scenes)
    let autoNum = 1;
    for (const node of nodes) {
        if (node.type === 'scene_heading' && !node.marker) {
            if (!node.sceneNumber) node.sceneNumber = String(autoNum);
            autoNum++;
        }
    }

    // 3. Compute stats for each scene
    for (const node of nodes) {
        if (node.type === 'scene_heading' && node.endLine !== undefined) {
            node.stats = computeSceneStats(lines, node.line, node.endLine);
        }
    }

    return nodes;
}
