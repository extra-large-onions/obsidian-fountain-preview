// ─── Hover type-hints ─────────────────────────────────────────────────────────
//
// Hold the pointer over a screenplay line and get its numbers:
//
//   character cue   →  scenes they speak in · cues · words · first appearance
//   scene heading   →  scene # · start page · length · speaking cast · how often
//                      this location is used
//
// Everything is derived from the outline AST and file index — the same numbers
// the outline panel's stats show.

import { hoverTooltip, Tooltip } from '@codemirror/view';
import type { Extension } from '@codemirror/state';
import { classifyLines, decomposeHeading } from './fountain-syntax';
import { parseFountainOutline } from './fountain-parser';
import { buildFileIndex, cueName } from './fountain-index';
import { fountainFileOf } from './fountain-lang';
import type FountainPlugin from './main';

function plural(n: number, word: string): string {
    return `${n} ${n === 1 ? word : word + 's'}`;
}

function tooltipDom(title: string, rows: string[]): HTMLElement {
    const dom = createDiv({ cls: 'fountain-hover-tooltip' });
    dom.createDiv({ cls: 'fountain-hover-title', text: title });
    for (const row of rows) dom.createDiv({ cls: 'fountain-hover-row', text: row });
    return dom;
}

function characterHover(content: string, name: string): HTMLElement | null {
    const nodes = parseFountainOutline(content);
    let scenes = 0, cues = 0, words = 0;
    let firstLine: number | null = null;
    for (const node of nodes) {
        if (node.type !== 'scene_heading') continue;
        for (const char of node.characters ?? []) {
            if (char.name.toUpperCase() !== name.toUpperCase()) continue;
            scenes++;
            cues += char.dialogueCount;
            words += char.wordCount;
            if (firstLine === null) firstLine = char.line;
        }
    }
    if (!scenes) return null;
    const firstPage = Math.max(1, Math.ceil((firstLine ?? 0) / 55));
    return tooltipDom(name, [
        `speaks in ${plural(scenes, 'scene')}`,
        `${plural(cues, 'cue')} · ${plural(words, 'word')}`,
        `first speaks on page ${firstPage}`,
    ]);
}

function sceneHover(content: string, line: number): HTMLElement | null {
    const nodes = parseFountainOutline(content);
    const node = nodes.find((n) => n.type === 'scene_heading' && n.line === line);
    if (!node) return null;

    const rows: string[] = [];
    if (node.stats) {
        const pages = node.stats.pageEstimate;
        rows.push(`page ${node.stats.startPage} · ~${pages < 10 ? pages.toFixed(1) : Math.round(pages)} pages`);
        rows.push(`${plural(node.stats.wordCount, 'word')} · ${plural(node.characters?.length ?? 0, 'speaking character')}`);
    }
    const { location } = decomposeHeading(node.text);
    if (location) {
        const uses = buildFileIndex(content).locations.get(location) ?? 0;
        if (uses > 1) rows.push(`location used in ${plural(uses, 'scene')}`);
    }

    const title = node.marker ? node.text : `#${node.sceneNumber ?? '?'} · ${node.text}`;
    return tooltipDom(title, rows);
}

export function fountainHoverExtension(plugin: FountainPlugin): Extension {
    return hoverTooltip((view, pos): Tooltip | null => {
        if (!plugin.settings.enableHover) return null;
        if (!fountainFileOf(view.state)) return null;

        const line = view.state.doc.lineAt(pos);
        if (!line.text.trim()) return null;

        const content = view.state.doc.toString();
        const classes = classifyLines(content.split('\n'));
        const element = classes[line.number - 1]?.element;

        let dom: HTMLElement | null = null;
        if (element === 'character') {
            dom = characterHover(content, cueName(line.text.trim()));
        } else if (element === 'scene_heading') {
            dom = sceneHover(content, line.number - 1);
        }
        if (!dom) return null;

        return {
            pos: line.from,
            end: line.to,
            above: true,
            create: () => ({ dom: dom }),
        };
    }, { hoverTime: 400 });
}
