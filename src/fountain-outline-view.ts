import { ItemView, MarkdownView, TFile, setIcon } from 'obsidian';
import { parseFountainOutline, FountainNode } from './fountain-parser';
import { FountainView } from './fountain-view';

export const FOUNTAIN_OUTLINE_VIEW_TYPE = 'fountain-outline';

function isFountainFile(file: TFile | null): file is TFile {
    if (!file) return false;
    return file.extension === 'fountain' || file.basename.endsWith('.fountain');
}

export class FountainOutlineView extends ItemView {
    private listEl: HTMLElement | null = null;
    private lastFountainView: FountainView | null = null;
    private lastMarkdownView: MarkdownView | null = null;

    getViewType(): string { return FOUNTAIN_OUTLINE_VIEW_TYPE; }
    getDisplayText(): string { return 'Fountain Outline'; }
    getIcon(): string { return 'list'; }

    async onOpen(): Promise<void> {
        this.contentEl.empty();
        this.contentEl.addClass('fountain-outline-view');
        this.listEl = this.contentEl.createDiv({ cls: 'fountain-outline-list' });

        this.registerEvent(
            this.app.workspace.on('active-leaf-change', (leaf) => {
                const view = leaf?.view;
                if (view instanceof FountainView) {
                    this.lastFountainView = view;
                    this.lastMarkdownView = null;
                } else if (view instanceof MarkdownView && isFountainFile(view.file)) {
                    this.lastMarkdownView = view;
                    this.lastFountainView = null;
                }
                // Don't refresh when the outline panel itself gains focus —
                // doing so destroys DOM elements mid-click (the flash bug).
                if (view === this) return;
                this.refresh();
            })
        );

        this.registerEvent(this.app.workspace.on('file-open', () => this.refresh()));
        this.registerEvent(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (this.app.workspace as any).on('fountain:content-changed', () => this.refresh())
        );
        this.registerEvent(
            this.app.vault.on('modify', (file: TFile) => {
                if (isFountainFile(file)) this.refresh();
            })
        );

        await this.refresh();
    }

    async onClose(): Promise<void> {
        this.listEl = null;
    }

    private async refresh(): Promise<void> {
        if (!this.listEl) return;
        this.listEl.empty();

        let activeFile: TFile | null = this.app.workspace.getActiveFile();
        if (!isFountainFile(activeFile)) {
            activeFile = this.lastFountainView?.file ?? this.lastMarkdownView?.file ?? null;
        }
        if (!isFountainFile(activeFile)) {
            this.listEl.createDiv({ cls: 'fountain-outline-empty', text: 'Open a .fountain file to see its outline.' });
            return;
        }

        const fv = this.app.workspace.getActiveViewOfType(FountainView) ?? this.lastFountainView;
        const content = (fv?.file?.path === activeFile.path)
            ? fv.getCurrentContent()
            : await this.app.vault.read(activeFile);

        const nodes = parseFountainOutline(content);
        if (!nodes.length) {
            this.listEl.createDiv({ cls: 'fountain-outline-empty', text: 'No scenes or sections found.' });
            return;
        }

        this.renderNodes(nodes);
    }

    private renderNodes(nodes: FountainNode[]): void {
        if (!this.listEl) return;
        let sectionLevel = 0;

        for (const node of nodes) {
            if (node.type === 'section') sectionLevel = node.level;
            const baseIndent = node.type === 'section'
                ? (node.level - 1) * 16
                : sectionLevel * 16;

            switch (node.type) {
                case 'section':       this.renderSection(node, baseIndent); break;
                case 'scene_heading': this.renderScene(node, baseIndent); break;
                case 'transition':    this.renderTransition(node, baseIndent); break;
                case 'synopsis':      this.renderSynopsis(node, baseIndent); break;
            }
        }
    }

    private renderSection(node: FountainNode, indent: number): void {
        const item = this.listEl!.createDiv({ cls: 'fountain-outline-item fountain-outline-section' });
        item.style.paddingLeft = `${8 + indent}px`;
        item.addEventListener('click', () => this.navigateTo(node.line));
        setIcon(item.createSpan({ cls: 'fountain-outline-icon' }), 'hash');
        item.createSpan({ cls: 'fountain-outline-text', text: node.text });
    }

    private renderScene(node: FountainNode, indent: number): void {
        const wrap = this.listEl!.createDiv({ cls: 'fountain-scene-block' });

        // ── Scene heading row ───────────────────────────────────────────────
        const item = wrap.createDiv({ cls: 'fountain-outline-item fountain-outline-scene_heading' });
        item.style.paddingLeft = `${8 + indent}px`;
        item.addEventListener('click', () => this.navigateTo(node.line));
        setIcon(item.createSpan({ cls: 'fountain-outline-icon' }), 'film');
        item.createSpan({ cls: 'fountain-outline-text', text: node.text });
        if (node.sceneNumber) {
            item.createSpan({ cls: 'fountain-scene-number', text: `#${node.sceneNumber}` });
        }

        // ── Stats row ───────────────────────────────────────────────────────
        if (node.stats) {
            const { lineCount, wordCount, startPage, pageEstimate } = node.stats;
            const pLen = pageEstimate >= 0.1 ? `~${pageEstimate.toFixed(1)}p` : '';
            const statsRow = wrap.createDiv({ cls: 'fountain-scene-stats' });
            statsRow.style.paddingLeft = `${8 + indent + 20}px`;
            statsRow.setText(`p.${startPage}  ·  ${lineCount} ln  ·  ${wordCount} w${pLen ? '  ·  ' + pLen : ''}`);
        }

        // ── Character sub-items ─────────────────────────────────────────────
        for (const char of node.characters ?? []) {
            const charItem = wrap.createDiv({ cls: 'fountain-outline-item fountain-outline-character' });
            charItem.style.paddingLeft = `${8 + indent + 20}px`;
            charItem.addEventListener('click', () => this.navigateTo(char.line));
            setIcon(charItem.createSpan({ cls: 'fountain-outline-icon' }), 'user');
            charItem.createSpan({ cls: 'fountain-outline-text', text: char.name });
            charItem.createSpan({ cls: 'fountain-char-count', text: `×${char.dialogueCount}` });
            if (char.wordCount > 0) {
                charItem.createSpan({ cls: 'fountain-char-words', text: `${char.wordCount}w` });
            }
        }
    }

    private renderTransition(node: FountainNode, indent: number): void {
        const item = this.listEl!.createDiv({ cls: 'fountain-outline-item fountain-outline-transition' });
        item.style.paddingLeft = `${8 + indent}px`;
        item.addEventListener('click', () => this.navigateTo(node.line));
        setIcon(item.createSpan({ cls: 'fountain-outline-icon' }), 'scissors');
        item.createSpan({ cls: 'fountain-outline-text', text: node.text });
    }

    private renderSynopsis(node: FountainNode, indent: number): void {
        const item = this.listEl!.createDiv({ cls: 'fountain-outline-item fountain-outline-synopsis' });
        item.style.paddingLeft = `${8 + indent + 16}px`;
        item.addEventListener('click', () => this.navigateTo(node.line));
        setIcon(item.createSpan({ cls: 'fountain-outline-icon' }), 'align-left');
        item.createSpan({ cls: 'fountain-outline-text', text: node.text });
    }

    private navigateTo(line: number): void {
        if (this.lastFountainView) {
            this.app.workspace.revealLeaf(this.lastFountainView.leaf);
            this.lastFountainView.scrollToLine(line);
            return;
        }
        if (this.lastMarkdownView?.editor) {
            this.app.workspace.revealLeaf(this.lastMarkdownView.leaf);
            const pos = { line, ch: 0 };
            this.lastMarkdownView.editor.setCursor(pos);
            this.lastMarkdownView.editor.scrollIntoView({ from: pos, to: pos }, true);
        }
    }
}
