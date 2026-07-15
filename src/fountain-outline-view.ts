import { ItemView, MarkdownView, TFile, WorkspaceLeaf, setIcon } from 'obsidian';
import { parseFountainOutline, FountainNode } from './fountain-parser';
import {
    ScriptStats, ScriptStatsCache, emptyStats, mergeStats, statsFromNodes,
    isFountainFile,
} from './fountain-stats';
import { openTranslationGroup, OpenMember } from './fountain-lang';
import type FountainPlugin from './main';

export const FOUNTAIN_OUTLINE_VIEW_TYPE = 'fountain-outline';

function plural(n: number, word: string): string {
    return `${n} ${n === 1 ? word : word + 's'}`;
}

/**
 * Everything a render pass needs to draw one outline into one container. In
 * single-file mode there is one ctx targeting the whole list; in bilingual mode
 * there is one ctx per language column, each navigating its own file.
 */
interface OutlineCtx {
    listEl: HTMLElement;
    /** Namespaces collapse keys so the same scene in two columns collapses independently. */
    keyPrefix: string;
    navigate: (line: number) => void;
}

export class FountainOutlineView extends ItemView {
    private listEl: HTMLElement | null = null;
    private statsPanelEl: HTMLElement | null = null;
    private statsScopeEl: HTMLElement | null = null;
    private statsBodyEl: HTMLElement | null = null;
    private lastMarkdownView: MarkdownView | null = null;
    /** Scene keys whose character sub-list is collapsed. Survives refresh() re-renders. */
    private collapsedScenes = new Set<string>();
    /** Which stats subpanels are expanded. */
    private expandedStats = new Set<string>(['overview']);
    private statsCache = new ScriptStatsCache();

    constructor(leaf: WorkspaceLeaf, private plugin: FountainPlugin) {
        super(leaf);
    }

    getViewType(): string { return FOUNTAIN_OUTLINE_VIEW_TYPE; }
    getDisplayText(): string { return 'Fountain Outline'; }
    getIcon(): string { return 'list'; }

    async onOpen(): Promise<void> {
        this.contentEl.empty();
        this.contentEl.addClass('fountain-outline-view');
        this.listEl = this.contentEl.createDiv({ cls: 'fountain-outline-list' });
        this.buildStatsPanel();

        this.registerEvent(
            this.app.workspace.on('active-leaf-change', (leaf) => {
                const view = leaf?.view;
                if (view instanceof MarkdownView && isFountainFile(view.file)) {
                    this.lastMarkdownView = view;
                }
                // Don't refresh when the outline panel itself gains focus —
                // doing so destroys DOM elements mid-click (the flash bug).
                if (view === this) return;
                void this.refresh();
            })
        );

        this.registerEvent(this.app.workspace.on('file-open', () => void this.refresh()));
        // Opening/closing/moving a tab changes which language files are visible —
        // re-detect the translation group so bilingual columns appear and disappear
        // automatically, with no command to run.
        this.registerEvent(this.app.workspace.on('layout-change', () => void this.refresh()));
        // Live-update while editing a fountain file in the native markdown editor
        this.registerEvent(
            this.app.workspace.on('editor-change', (_editor, info) => {
                if (info instanceof MarkdownView && isFountainFile(info.file)) void this.refresh();
            })
        );
        this.registerEvent(
            this.app.vault.on('modify', (file) => {
                if (file instanceof TFile && isFountainFile(file)) void this.refresh();
            })
        );
        // Keep the folder-stats cache honest on delete/rename
        this.registerEvent(
            this.app.vault.on('delete', (file) => {
                this.statsCache.invalidate(file.path);
                if (file instanceof TFile && isFountainFile(file)) void this.refresh();
            })
        );
        this.registerEvent(
            this.app.vault.on('rename', (file, oldPath) => {
                this.statsCache.invalidate(oldPath);
                this.statsCache.invalidate(file.path);
                if (file instanceof TFile && isFountainFile(file)) void this.refresh();
            })
        );

        await this.refresh();
    }

    async onClose(): Promise<void> {
        this.listEl = null;
        this.statsPanelEl = null;
        this.statsScopeEl = null;
        this.statsBodyEl = null;
    }

    // ─── Refresh ─────────────────────────────────────────────────────────────

    private async refresh(): Promise<void> {
        if (!this.listEl) return;
        this.listEl.empty();
        this.listEl.removeClass('is-bilingual');

        let activeFile: TFile | null = this.app.workspace.getActiveFile();
        if (!isFountainFile(activeFile)) {
            activeFile = this.lastMarkdownView?.file ?? null;
        }

        // Bilingual mode: two or more members of this file's translation group are
        // open at once (e.g. script.en.fountain + script.vi.fountain), with at
        // least two distinct languages. Render one outline column per language.
        const group = isFountainFile(activeFile) ? openTranslationGroup(this.app, activeFile) : [];
        const distinctLangs = new Set(group.map((g) => g.lang).filter((l) => l !== null));
        const bilingual = group.length >= 2 && distinctLangs.size >= 2;

        let statsFile: TFile | null = activeFile;
        let statsNodes: FountainNode[] = [];

        if (bilingual) {
            await this.renderBilingual(group);
            // The stats panel stays single-scope: use the active file's outline.
            statsNodes = parseFountainOutline(await this.getLiveContent(activeFile!));
        } else if (isFountainFile(activeFile)) {
            const nodes = parseFountainOutline(await this.getLiveContent(activeFile));
            statsNodes = nodes;
            if (nodes.length) {
                this.renderNodes(this.singleCtx(), nodes);
            } else {
                this.listEl.createDiv({ cls: 'fountain-outline-empty', text: 'No scenes or sections found.' });
            }
        } else {
            statsFile = null;
            this.listEl.createDiv({ cls: 'fountain-outline-empty', text: 'Open a .fountain file to see its outline.' });
        }

        await this.renderStats(statsFile, statsNodes);
    }

    // ─── Bilingual (side-by-side) rendering ──────────────────────────────────

    private async renderBilingual(group: OpenMember[]): Promise<void> {
        if (!this.listEl) return;
        this.listEl.addClass('is-bilingual');
        const columns = this.listEl.createDiv({ cls: 'fountain-outline-columns' });

        for (const { lang, file } of group) {
            const col = columns.createDiv({ cls: 'fountain-outline-column' });

            const head = col.createDiv({ cls: 'fountain-outline-colhead' });
            head.createSpan({ cls: 'fountain-outline-collang', text: (lang ?? '—').toUpperCase() });
            head.createSpan({ cls: 'fountain-outline-colname', text: file.basename });

            const list = col.createDiv({ cls: 'fountain-outline-collist' });
            const nodes = parseFountainOutline(await this.getLiveContent(file));
            if (nodes.length) {
                this.renderNodes(
                    { listEl: list, keyPrefix: `${file.path}|`, navigate: (line) => this.navigateInFile(file, line) },
                    nodes,
                );
            } else {
                list.createDiv({ cls: 'fountain-outline-empty', text: 'No scenes or sections found.' });
            }
        }
    }

    /** Latest content for a file: the live editor buffer if it's open, else the saved file. */
    private async getLiveContent(file: TFile): Promise<string> {
        let live: string | null = null;
        this.app.workspace.iterateAllLeaves((leaf) => {
            if (live !== null) return;
            const view = leaf.view;
            if (view instanceof MarkdownView && view.file?.path === file.path) {
                live = view.editor.getValue();
            }
        });
        return live ?? await this.app.vault.cachedRead(file);
    }

    // ─── Outline rendering ───────────────────────────────────────────────────

    private singleCtx(): OutlineCtx {
        return { listEl: this.listEl!, keyPrefix: '', navigate: (line) => this.navigateTo(line) };
    }

    private renderNodes(ctx: OutlineCtx, nodes: FountainNode[]): void {
        let sectionLevel = 0;

        for (const node of nodes) {
            if (node.type === 'section') sectionLevel = node.level;
            const baseIndent = node.type === 'section'
                ? (node.level - 1) * 16
                : sectionLevel * 16;

            switch (node.type) {
                case 'section':       this.renderSection(ctx, node, baseIndent); break;
                case 'scene_heading': this.renderScene(ctx, node, baseIndent); break;
                case 'transition':    this.renderTransition(ctx, node, baseIndent); break;
                case 'synopsis':      this.renderSynopsis(ctx, node, baseIndent); break;
            }
        }
    }

    private renderSection(ctx: OutlineCtx, node: FountainNode, indent: number): void {
        const item = ctx.listEl.createDiv({ cls: 'fountain-outline-item fountain-outline-section' });
        item.style.paddingLeft = `${8 + indent}px`;
        item.addEventListener('click', () => ctx.navigate(node.line));
        setIcon(item.createSpan({ cls: 'fountain-outline-icon' }), 'hash');
        item.createSpan({ cls: 'fountain-outline-text', text: node.text });
    }

    /** Stable-ish identity for collapse state — survives re-parse on every keystroke. */
    private sceneKey(ctx: OutlineCtx, node: FountainNode): string {
        return `${ctx.keyPrefix}${node.marker ? 'marker' : node.sceneNumber ?? ''}|${node.text}`;
    }

    private renderScene(ctx: OutlineCtx, node: FountainNode, indent: number): void {
        const wrap = ctx.listEl.createDiv({ cls: 'fountain-scene-block' });
        const chars = node.characters ?? [];
        const key = this.sceneKey(ctx, node);
        if (this.collapsedScenes.has(key)) wrap.addClass('is-collapsed');

        // ── Scene heading row (click → navigate, chevron → collapse) ────────
        const item = wrap.createDiv({ cls: 'fountain-outline-item fountain-outline-scene_heading' });
        item.style.paddingLeft = `${8 + indent}px`;
        item.addEventListener('click', () => ctx.navigate(node.line));

        const chevron = item.createSpan({ cls: 'fountain-collapse-chevron' });
        if (chars.length) {
            setIcon(chevron, 'right-triangle');
            chevron.addEventListener('click', (e) => {
                e.stopPropagation();
                if (this.collapsedScenes.has(key)) this.collapsedScenes.delete(key);
                else this.collapsedScenes.add(key);
                wrap.toggleClass('is-collapsed', this.collapsedScenes.has(key));
            });
        } else {
            chevron.addClass('is-empty');
        }

        setIcon(item.createSpan({ cls: 'fountain-outline-icon' }), 'film');
        item.createSpan({ cls: 'fountain-outline-text', text: node.text });
        if (node.sceneNumber && !node.marker) {
            item.createSpan({ cls: 'fountain-scene-number', text: `#${node.sceneNumber}` });
        }

        // ── Stats row — right-aligned, spelled out ──────────────────────────
        if (node.stats) {
            const { lineCount, wordCount, startPage, pageEstimate } = node.stats;
            const parts = [
                `page ${startPage}`,
                plural(lineCount, 'line'),
                plural(wordCount, 'word'),
            ];
            if (pageEstimate >= 0.1) parts.push(`~${pageEstimate.toFixed(1)} pages`);
            const statsRow = wrap.createDiv({ cls: 'fountain-scene-stats' });
            statsRow.setText(parts.join(' · '));
        }

        // ── Character subheaders (collapsible, tabbed in) ───────────────────
        if (chars.length) {
            const children = wrap.createDiv({ cls: 'fountain-scene-children' });
            for (const char of chars) {
                const charItem = children.createDiv({ cls: 'fountain-outline-item fountain-outline-character' });
                charItem.style.paddingLeft = `${8 + indent + 24}px`;
                charItem.addEventListener('click', () => ctx.navigate(char.line));
                setIcon(charItem.createSpan({ cls: 'fountain-outline-icon' }), 'user');
                charItem.createSpan({ cls: 'fountain-outline-text', text: char.name });
            }
        }
    }

    private renderTransition(ctx: OutlineCtx, node: FountainNode, indent: number): void {
        const item = ctx.listEl.createDiv({ cls: 'fountain-outline-item fountain-outline-transition' });
        item.style.paddingLeft = `${8 + indent}px`;
        item.addEventListener('click', () => ctx.navigate(node.line));
        setIcon(item.createSpan({ cls: 'fountain-outline-icon' }), 'scissors');
        item.createSpan({ cls: 'fountain-outline-text', text: node.text });
    }

    private renderSynopsis(ctx: OutlineCtx, node: FountainNode, indent: number): void {
        const item = ctx.listEl.createDiv({ cls: 'fountain-outline-item fountain-outline-synopsis' });
        item.style.paddingLeft = `${8 + indent + 16}px`;
        item.addEventListener('click', () => ctx.navigate(node.line));
        setIcon(item.createSpan({ cls: 'fountain-outline-icon' }), 'align-left');
        item.createSpan({ cls: 'fountain-outline-text', text: node.text });
    }

    // ─── Navigation ──────────────────────────────────────────────────────────

    /** Single-file navigation — uses the last-focused fountain editor. */
    private navigateTo(line: number): void {
        if (this.lastMarkdownView?.editor) {
            this.app.workspace.revealLeaf(this.lastMarkdownView.leaf);
            const pos = { line, ch: 0 };
            this.lastMarkdownView.editor.setCursor(pos);
            this.lastMarkdownView.editor.scrollIntoView({ from: pos, to: pos }, true);
        }
    }

    /**
     * Bilingual navigation — finds whichever leaf is showing exactly `file` and
     * scrolls it, so each column drives its own language's editor independently.
     */
    private navigateInFile(file: TFile, line: number): void {
        let done = false;
        this.app.workspace.iterateAllLeaves((leaf) => {
            if (done) return;
            const view = leaf.view;
            if (view instanceof MarkdownView && view.file?.path === file.path) {
                this.app.workspace.revealLeaf(leaf);
                const pos = { line, ch: 0 };
                view.editor.setCursor(pos);
                view.editor.scrollIntoView({ from: pos, to: pos }, true);
                done = true;
            }
        });
    }

    // ─── Stats panel (sticky bottom, ≤ 25% height) ───────────────────────────

    private buildStatsPanel(): void {
        this.statsPanelEl = this.contentEl.createDiv({ cls: 'fountain-stats-panel' });

        // Header: title, scope, rescan button
        const header = this.statsPanelEl.createDiv({ cls: 'fountain-stats-header' });
        header.createSpan({ cls: 'fountain-stats-title', text: 'Statistics' });
        this.statsScopeEl = header.createSpan({ cls: 'fountain-stats-scope' });

        const rescanBtn = header.createSpan({ cls: 'fountain-stats-btn' });
        rescanBtn.setAttribute('aria-label', 'Rescan all files');
        setIcon(rescanBtn, 'refresh-cw');
        rescanBtn.addEventListener('click', () => {
            this.statsCache.clear();
            void this.refresh();
        });

        this.statsBodyEl = this.statsPanelEl.createDiv({ cls: 'fountain-stats-body' });
    }

    /**
     * Aggregate every .fountain file in the vault — cached per file, so only the
     * live active file is re-parsed per keystroke; the rest come from the mtime cache.
     */
    private async renderStats(activeFile: TFile | null, activeNodes: FountainNode[]): Promise<void> {
        if (!this.statsPanelEl || !this.statsBodyEl || !this.statsScopeEl) return;

        const files = this.app.vault.getFiles().filter(isFountainFile);
        let stats: ScriptStats | null = null;
        let scope = 'no .fountain files in vault';

        if (files.length) {
            stats = emptyStats();
            for (const file of files) {
                if (activeFile && file.path === activeFile.path) {
                    mergeStats(stats, statsFromNodes(activeNodes));
                } else {
                    mergeStats(stats, await this.statsCache.get(this.app, file));
                }
            }
            scope = `${plural(files.length, 'file')} in vault`;
        }

        this.statsScopeEl.setText(scope);
        this.statsBodyEl.empty();
        if (!stats) {
            this.statsPanelEl.removeClass('is-hidden');
            return;
        }
        this.statsPanelEl.removeClass('is-hidden');

        this.renderOverview(stats);
        this.renderIntExt(stats);
        this.renderLocations(stats);
        this.renderCharacters(stats);
    }

    private subpanel(id: string, title: string, summary: string): HTMLElement {
        const sub = this.statsBodyEl!.createDiv({ cls: 'fountain-stats-subpanel' });
        const head = sub.createDiv({ cls: 'fountain-stats-subheader' });
        const chevron = head.createSpan({ cls: 'fountain-collapse-chevron' });
        setIcon(chevron, 'right-triangle');
        head.createSpan({ cls: 'fountain-stats-subtitle', text: title });
        if (summary) head.createSpan({ cls: 'fountain-stats-subsummary', text: summary });

        const body = sub.createDiv({ cls: 'fountain-stats-subbody' });
        sub.toggleClass('is-collapsed', !this.expandedStats.has(id));
        head.addEventListener('click', () => {
            if (this.expandedStats.has(id)) this.expandedStats.delete(id);
            else this.expandedStats.add(id);
            sub.toggleClass('is-collapsed', !this.expandedStats.has(id));
        });
        return body;
    }

    private statRow(parent: HTMLElement, label: string, value: string): void {
        const row = parent.createDiv({ cls: 'fountain-stats-row' });
        row.createSpan({ cls: 'fountain-stats-label', text: label });
        row.createSpan({ cls: 'fountain-stats-value', text: value });
    }

    private renderOverview(stats: ScriptStats): void {
        const body = this.subpanel('overview', 'Overview', '');
        this.statRow(body, 'files', String(stats.files));
        this.statRow(body, 'scenes', String(stats.scenes));
        this.statRow(body, 'length', `~${stats.pages < 10 ? stats.pages.toFixed(1) : Math.round(stats.pages)} pages`);
        this.statRow(body, 'words', stats.words.toLocaleString());
        this.statRow(body, 'speaking characters', String(stats.characters.size));
    }

    private renderIntExt(stats: ScriptStats): void {
        const int = stats.intExt.get('INT.') ?? 0;
        const ext = stats.intExt.get('EXT.') ?? 0;
        const body = this.subpanel('intext', 'Interior / exterior', `${int} interior · ${ext} exterior`);

        const sorted = [...stats.intExt.entries()].sort((a, b) => b[1] - a[1]);
        for (const [kind, count] of sorted) {
            this.statRow(body, kind, plural(count, 'scene'));
        }

        const times = [...stats.timeOfDay.entries()].filter(([k]) => k).sort((a, b) => b[1] - a[1]);
        if (times.length) {
            body.createDiv({ cls: 'fountain-stats-divider' });
            for (const [time, count] of times) {
                this.statRow(body, time, plural(count, 'scene'));
            }
        }
    }

    private renderLocations(stats: ScriptStats): void {
        const body = this.subpanel('locations', 'Locations', `${stats.locations.size} unique`);
        const sorted = [...stats.locations.entries()].sort((a, b) => b[1] - a[1]);
        const TOP = 10;
        for (const [loc, count] of sorted.slice(0, TOP)) {
            this.statRow(body, loc, plural(count, 'scene'));
        }
        if (sorted.length > TOP) {
            body.createDiv({ cls: 'fountain-stats-more', text: `…and ${sorted.length - TOP} more locations` });
        }
    }

    private renderCharacters(stats: ScriptStats): void {
        const body = this.subpanel('characters', 'Characters', `${stats.characters.size} total`);
        const sorted = [...stats.characters.entries()].sort((a, b) => b[1].words - a[1].words);
        const TOP = 15;
        for (const [name, t] of sorted.slice(0, TOP)) {
            this.statRow(body, name, `${plural(t.scenes, 'scene')} · ${plural(t.words, 'word')}`);
        }
        if (sorted.length > TOP) {
            body.createDiv({ cls: 'fountain-stats-more', text: `…and ${sorted.length - TOP} more characters` });
        }
    }
}
