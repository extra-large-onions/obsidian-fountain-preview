import { App, MarkdownView, TFile, WorkspaceLeaf, editorInfoField } from 'obsidian';
import type { EditorState } from '@codemirror/state';
import { isFountainFile } from './fountain-stats';

// ─── Language naming convention ────────────────────────────────────────────────
//
// A screenplay can exist in several languages that share one "translation group":
//
//     bigfish.en.fountain   bigfish.vi.fountain   bigfish.fr.fountain
//
// The language is a two-letter ISO-639-1 code sitting between the stem and the
// `.fountain` extension. Because Obsidian's `file.extension` is only the last
// dot-segment, every one of these still has `extension === 'fountain'`, so they
// behave exactly like a plain `.fountain` to every existing extension check
// (the view registration, the outline, the PDF scan, the Fountain Editor plugin).
// A plain `bigfish.fountain` with no infix has `lang === null` and is untouched.

// ─── Editor gating ─────────────────────────────────────────────────────────────

/**
 * The fountain file behind a CM6 editor state, or null when the editor isn't
 * showing Fountain. All editor extensions (highlight, lint, hover, suggest)
 * gate on this. A file counts as Fountain when:
 *   - its extension is `fountain` (includes `x.en.fountain`), or
 *   - its basename ends in `.fountain` (the `.fountain.md` / `.fountain.txt` wrappers), or
 *   - its frontmatter `tags` / `cssclasses` include "fountain" (Fountain in a plain .md).
 */
export function fountainFileOf(state: EditorState): TFile | null {
    const info = state.field(editorInfoField, false);
    const file = info?.file;
    if (!file) return null;
    return isFountainAuthoringFile(info.app, file) ? file : null;
}

/** Same rule as fountainFileOf, for callers that hold an (app, file) pair. */
export function isFountainAuthoringFile(app: App, file: TFile | null): file is TFile {
    if (!file) return false;
    if (isFountainFile(file)) return true;

    const fm = app.metadataCache.getFileCache(file)?.frontmatter;
    if (!fm) return false;
    for (const key of ['tags', 'cssclasses']) {
        const v: unknown = fm[key];
        const arr = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : [];
        if (arr.some((t) => String(t).trim().toLowerCase() === 'fountain')) return true;
    }
    return false;
}

export interface FountainLang {
    /** Filename minus the ".LANG.fountain" (or ".fountain") suffix — identifies a translation group. */
    key: string;
    /** ISO-639-1 language code, or null for a plain .fountain with no language infix. */
    lang: string | null;
}

/** Strip a trailing .md/.txt wrapper so `x.en.fountain.md` decomposes like `x.en.fountain`. */
function fountainName(file: TFile): string {
    return file.name.replace(/\.(md|txt)$/i, '');
}

/** `bigfish.en.fountain` → { key: "bigfish", lang: "en" };  `bigfish.fountain` → { key: "bigfish", lang: null }. */
export function fountainLang(file: TFile): FountainLang {
    const name = fountainName(file);
    const m = /^(.*?)\.([a-z]{2})\.fountain$/i.exec(name);
    if (m) return { key: m[1] ?? '', lang: (m[2] ?? '').toLowerCase() };
    const m2 = /^(.*?)\.fountain$/i.exec(name);
    if (m2) return { key: m2[1] ?? '', lang: null };
    return { key: name, lang: null };
}

/**
 * Group identity = parent folder path + stem, so `a/script.en.fountain` and
 * `b/script.vi.fountain` (same name, different folders) are NOT merged.
 */
export function groupId(file: TFile): string {
    return `${file.parent?.path ?? ''}::${fountainLang(file).key}`;
}

export interface GroupMember {
    lang: string | null;
    file: TFile;
}

export interface OpenMember extends GroupMember {
    leaf: WorkspaceLeaf;
}

/**
 * The members of `file`'s translation group that exist ON DISK (same folder,
 * same stem, any language), whether or not they're open. Sorted by language so
 * output is stable. Used by the bilingual drift lint.
 */
export function diskTranslationGroup(app: App, file: TFile): GroupMember[] {
    const gid = groupId(file);
    const out: GroupMember[] = [];
    for (const child of file.parent?.children ?? []) {
        if (child instanceof TFile && isFountainFile(child) && groupId(child) === gid) {
            out.push({ lang: fountainLang(child).lang, file: child });
        }
    }
    return out.sort((a, b) => (a.lang ?? '').localeCompare(b.lang ?? ''));
}

/** All fountain files currently open in an editor leaf. */
export function openFountainLeaves(app: App): OpenMember[] {
    const out: OpenMember[] = [];
    app.workspace.iterateAllLeaves((leaf) => {
        const view = leaf.view;
        const file = view instanceof MarkdownView ? view.file : null;
        if (file && isFountainFile(file)) {
            out.push({ lang: fountainLang(file).lang, file, leaf });
        }
    });
    return out;
}

/**
 * The members of `file`'s translation group that are currently OPEN in a leaf,
 * de-duplicated by path. Order follows `iterateAllLeaves` — i.e. the workspace
 * tree order, so the columns line up left-to-right with the editor tabs rather
 * than being re-sorted by language. Used by the outline to decide whether to
 * switch into side-by-side bilingual mode.
 */
export function openTranslationGroup(app: App, file: TFile): OpenMember[] {
    const gid = groupId(file);
    const seen = new Set<string>();
    const out: OpenMember[] = [];
    for (const m of openFountainLeaves(app)) {
        if (groupId(m.file) !== gid || seen.has(m.file.path)) continue;
        seen.add(m.file.path);
        out.push(m);
    }
    return out;
}
