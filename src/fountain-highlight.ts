// ─── Fountain syntax highlighting ─────────────────────────────────────────────
//
// A CM6 ViewPlugin that paints screenplay elements in the native markdown
// editor, replacing the external "Fountain Editor" plugin. Re-implemented from
// the Fountain spec on top of the shared classifier in fountain-syntax.ts —
// the same classification the outline, linter and suggester use.
//
// Class names follow the established `cm-fountain-*` convention so themes that
// target the old plugin keep working. All styling lives in styles.css.

import { RangeSetBuilder } from '@codemirror/state';
import {
    Decoration, DecorationSet, EditorView, PluginValue, ViewPlugin, ViewUpdate,
} from '@codemirror/view';
import type { Extension } from '@codemirror/state';
import { classifyLines, Element, LineClass } from './fountain-syntax';
import { fountainFileOf } from './fountain-lang';
import type FountainPlugin from './main';

/** The container class themes can scope on, set on .markdown-source-view. */
const CONTAINER_CLASS = 'is-fountain-script';

const LINE_DECO = new Map<Element, Decoration>();
function lineDeco(element: Element): Decoration {
    let deco = LINE_DECO.get(element);
    if (!deco) {
        deco = Decoration.line({ class: `cm-fountain-${element.replace(/_/g, '-')}` });
        LINE_DECO.set(element, deco);
    }
    return deco;
}

const MARK_DECO = new Map<string, Decoration>();
function markDeco(kind: string): Decoration {
    let deco = MARK_DECO.get(kind);
    if (!deco) {
        // Punctuation marks get the shared formatting class (hidden on inactive
        // lines); content ranges (notes, boneyard, character extensions, scene
        // numbers) stay visible and are styled directly.
        const content = kind === 'note' || kind === 'boneyard'
            || kind === 'character-extension' || kind === 'scene-number';
        const cls = content
            ? `cm-fountain-${kind}`
            : `cm-fountain-formatting cm-fountain-formatting-${kind}`;
        deco = Decoration.mark({ class: cls });
        MARK_DECO.set(kind, deco);
    }
    return deco;
}

class FountainHighlighter implements PluginValue {
    decorations: DecorationSet;
    /** Per-line classification of the whole document (null when not a fountain file). */
    private classes: LineClass[] | null = null;

    constructor(private view: EditorView, private plugin: FountainPlugin) {
        this.classes = this.classify(view);
        this.decorations = this.build(view);
        this.syncContainerClass(view);
    }

    update(update: ViewUpdate): void {
        if (update.docChanged || this.classes === null) {
            this.classes = this.classify(update.view);
        }
        if (update.docChanged || update.viewportChanged) {
            this.decorations = this.build(update.view);
        }
        this.syncContainerClass(update.view);
    }

    destroy(): void {
        this.view.dom.closest('.markdown-source-view')?.classList.remove(CONTAINER_CLASS);
    }

    private enabled(): boolean {
        return this.plugin.settings.highlightScreenplay;
    }

    private classify(view: EditorView): LineClass[] | null {
        if (!this.enabled() || !fountainFileOf(view.state)) return null;
        return classifyLines(view.state.doc.toString().split('\n'));
    }

    private build(view: EditorView): DecorationSet {
        const classes = this.classes;
        if (!classes) return Decoration.none;

        const builder = new RangeSetBuilder<Decoration>();
        const doc = view.state.doc;
        for (const range of view.visibleRanges) {
            const firstLine = doc.lineAt(range.from).number;
            const lastLine = doc.lineAt(range.to).number;
            for (let n = firstLine; n <= lastLine; n++) {
                const cls = classes[n - 1];
                if (!cls || cls.element === 'blank') continue;
                const line = doc.line(n);
                builder.add(line.from, line.from, lineDeco(cls.element));
                if (!cls.marks) continue;
                for (const mark of [...cls.marks].sort((a, b) => a.from - b.from)) {
                    const from = line.from + mark.from;
                    const to = Math.min(line.from + mark.to, line.to);
                    if (from < to) builder.add(from, to, markDeco(mark.kind));
                }
            }
        }
        return builder.finish();
    }

    /** Keep the scoping class on the editor container in step with fountain-ness. */
    private syncContainerClass(view: EditorView): void {
        const container = view.dom.closest('.markdown-source-view');
        container?.classList.toggle(CONTAINER_CLASS, this.classes !== null);
    }
}

export function fountainHighlightExtension(plugin: FountainPlugin): Extension {
    return ViewPlugin.define((view) => new FountainHighlighter(view, plugin), {
        decorations: (v) => v.decorations,
    });
}
