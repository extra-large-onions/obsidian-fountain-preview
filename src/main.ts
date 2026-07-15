import { App, Notice, Plugin, PluginSettingTab, Setting, SuggestModal, TFile, normalizePath } from 'obsidian';
import { FountainOutlineView, FOUNTAIN_OUTLINE_VIEW_TYPE } from './fountain-outline-view';
import { isFountainFile } from './fountain-stats';
import { fountainLang } from './fountain-lang';
import { fountainHighlightExtension } from './fountain-highlight';
import { FountainSuggest } from './fountain-suggest';
import { fountainLintExtension } from './fountain-lint';
import { fountainHoverExtension } from './fountain-hover';
import { buildFileIndex, emptyIndex, mergeIndex, FileIndex } from './fountain-index';
import {
    DEFAULT_HINTS, HintDictionary, STANDARD_TRANSITIONS,
    entryText, parseHintDictionary, serializeHints,
} from './fountain-hints';
import { buildStitchedPdf } from './fountain-pdf';

export interface FountainPluginSettings {
    /**
     * Default language (ISO-639-1) picked for single-language tasks like PDF export when the
     * vault holds several languages. Empty = no preference (first language found alphabetically).
     */
    primaryLanguage: string;
    /** Screenplay syntax highlighting in the native editor. */
    highlightScreenplay: boolean;
    /** Slash menu + character/location/time completion while typing. */
    enableAutocomplete: boolean;
    /** Character that opens the template menu at the start of a line. */
    suggestTrigger: string;
    /** Inline diagnostics (typo'd cues, unclosed boneyard, …). */
    enableLint: boolean;
    /** Hover tooltips with character / scene numbers. */
    enableHover: boolean;
    /** Cross-language drift diagnostics between translation-group siblings. */
    enableDriftLint: boolean;
    /** Editable slash-menu vocabulary (JSON of a HintDictionary). */
    hintsJson: string;
}

const DEFAULT_SETTINGS: FountainPluginSettings = {
    primaryLanguage: '',
    highlightScreenplay: true,
    enableAutocomplete: true,
    suggestTrigger: '/',
    enableLint: true,
    enableHover: true,
    enableDriftLint: true,
    hintsJson: serializeHints(DEFAULT_HINTS),
};

export default class FountainPlugin extends Plugin {
    settings: FountainPluginSettings = { ...DEFAULT_SETTINGS };

    /** Merged vocabulary (characters, locations, times, …) across every project .fountain file. */
    projectVocab: FileIndex = emptyIndex();
    /** Per-file index cache keyed by path → mtime, so a rebuild only re-reads changed files. */
    private vocabCache = new Map<string, { mtime: number; index: FileIndex }>();
    private vocabTimer: number | null = null;

    async onload() {
        await this.loadSettings();

        this.registerView(FOUNTAIN_OUTLINE_VIEW_TYPE, (leaf) => new FountainOutlineView(leaf, this));
        // .fountain opens in Obsidian's native markdown editor (CM6), which is what
        // lets the highlighter / autocomplete / lint / hover extensions attach.
        // The old plain-textarea FountainView is gone — see refactor.md Phase 1.
        this.registerExtensions(['fountain'], 'markdown');

        this.registerEditorExtension(fountainHighlightExtension(this));
        this.registerEditorExtension(fountainLintExtension(this));
        this.registerEditorExtension(fountainHoverExtension(this));
        this.registerEditorSuggest(new FountainSuggest(this));
        this.addSettingTab(new FountainSettingTab(this.app, this));
        this.warnAboutFountainEditorPlugin();

        this.addRibbonIcon('film', 'Open Fountain Outline', () => {
            this.activateOutlineView();
        });

        this.addCommand({
            id: 'open-fountain-outline',
            name: 'Open Fountain Outline',
            callback: () => this.activateOutlineView(),
        });

        this.addCommand({
            id: 'export-stitched-pdf',
            name: 'Export stitched PDF of stats folder',
            callback: () => { void this.exportStitchedPdf(); },
        });

        this.addCommand({
            id: 'export-stitched-pdf-language',
            name: 'Export stitched PDF for a specific language…',
            callback: () => { void this.exportStitchedPdfForLanguage(); },
        });

        // Keep the project-wide autocomplete vocabulary current: build once the
        // vault is ready, then rebuild (debounced) whenever a .fountain file changes.
        this.app.workspace.onLayoutReady(() => void this.rebuildProjectVocab());
        this.registerEvent(this.app.vault.on('modify', (f) => this.onVaultChange(f)));
        this.registerEvent(this.app.vault.on('create', (f) => this.onVaultChange(f)));
        this.registerEvent(this.app.vault.on('delete', (f) => this.onVaultChange(f)));
        this.registerEvent(this.app.vault.on('rename', (f, oldPath) => {
            this.vocabCache.delete(oldPath);
            this.onVaultChange(f);
        }));
    }

    onunload() {
        if (this.vocabTimer !== null) window.clearTimeout(this.vocabTimer);
    }

    // ─── Autocomplete vocabulary & dictionary ────────────────────────────────

    /** The parsed hint dictionary, falling back to defaults if the JSON is broken. */
    getHintDictionary(): HintDictionary {
        return parseHintDictionary(this.settings.hintsJson) ?? DEFAULT_HINTS;
    }

    /** Transitions the linter should treat as valid: standard + dictionary + project-used. */
    knownTransitions(): Set<string> {
        const set = new Set<string>(STANDARD_TRANSITIONS.map((t) => t.toUpperCase()));
        for (const cat of this.getHintDictionary().categories) {
            if (cat.id !== 'transition' && cat.insert !== 'transition') continue;
            for (const e of cat.entries) set.add(entryText(e).toUpperCase());
        }
        for (const t of this.projectVocab.transitions.keys()) set.add(t.toUpperCase());
        return set;
    }

    private onVaultChange(file: unknown): void {
        if (file instanceof TFile && isFountainFile(file)) {
            this.vocabCache.delete(file.path);
            this.scheduleVocabRebuild();
        }
    }

    scheduleVocabRebuild(): void {
        if (this.vocabTimer !== null) window.clearTimeout(this.vocabTimer);
        this.vocabTimer = window.setTimeout(() => {
            this.vocabTimer = null;
            void this.rebuildProjectVocab();
        }, 400);
    }

    /** Every .fountain file in the vault, sorted by path (stable stitch/scan order). */
    private gatherProjectFiles(): TFile[] {
        return this.app.vault.getFiles()
            .filter(isFountainFile)
            .sort((a, b) => a.path.localeCompare(b.path));
    }

    async rebuildProjectVocab(): Promise<void> {
        const files = this.gatherProjectFiles();
        const seen = new Set<string>();
        const merged = emptyIndex();
        for (const file of files) {
            seen.add(file.path);
            let hit = this.vocabCache.get(file.path);
            if (!hit || hit.mtime !== file.stat.mtime) {
                hit = { mtime: file.stat.mtime, index: buildFileIndex(await this.app.vault.cachedRead(file)) };
                this.vocabCache.set(file.path, hit);
            }
            mergeIndex(merged, hit.index);
        }
        for (const path of [...this.vocabCache.keys()]) if (!seen.has(path)) this.vocabCache.delete(path);
        this.projectVocab = merged;
    }

    /**
     * The external "Fountain Editor" plugin decorates the same lines this
     * plugin's in-house highlighter now paints — running both doubles up every
     * style. Nudge once per session if it's still enabled.
     */
    private warnAboutFountainEditorPlugin(): void {
        interface PluginRegistry { enabledPlugins?: Set<string> }
        const registry = (this.app as unknown as { plugins?: PluginRegistry }).plugins;
        if (registry?.enabledPlugins?.has('fountain-editor') && this.settings.highlightScreenplay) {
            new Notice(
                'Fountain: screenplay highlighting is now built in — disable the separate "Fountain Editor" plugin to avoid doubled styling.',
                10000,
            );
        }
    }

    async loadSettings(): Promise<void> {
        this.settings = { ...DEFAULT_SETTINGS, ...((await this.loadData()) as Partial<FountainPluginSettings> | null) };
    }

    async saveSettings(): Promise<void> {
        await this.saveData(this.settings);
    }

    // ─── PDF export ──────────────────────────────────────────────────────────

    /** Pick a language present in the vault, remember it, then export. */
    private async exportStitchedPdfForLanguage(): Promise<void> {
        const files = this.gatherProjectFiles();
        const langs = [...new Set(files.map((f) => fountainLang(f).lang).filter((l): l is string => l !== null))].sort();
        if (!langs.length) {
            new Notice('Fountain: no language-tagged files (e.g. "*.en.fountain") in this vault.');
            return;
        }
        new LanguageSuggestModal(this.app, langs, (lang) => {
            this.settings.primaryLanguage = lang;
            void this.saveSettings();
            void this.exportStitchedPdf(lang);
        }).open();
    }

    /**
     * Concatenate every .fountain file in the vault (sorted by path, each starting
     * on a fresh page) into one screenplay-formatted PDF. When the vault holds
     * several languages, only files for the target language (plus any untagged
     * .fountain files) are stitched, so translations don't interleave.
     */
    private async exportStitchedPdf(lang?: string): Promise<void> {
        let files = this.gatherProjectFiles();
        if (!files.length) {
            new Notice('Fountain: no .fountain files found in this vault.');
            return;
        }

        // Language filtering: use the requested language, else the saved primary,
        // else the first language present (alphabetical). Untagged files always pass.
        const present = new Set(files.map((f) => fountainLang(f).lang).filter((l) => l));
        let target = lang ?? this.settings.primaryLanguage ?? '';
        if (!target && present.size) target = [...present].sort()[0] ?? '';
        const suffix = target ? ` (${target})` : '';
        if (target) {
            files = files.filter((f) => {
                const l = fountainLang(f).lang;
                return l === target || l === null;
            });
        }

        const notice = new Notice(`Fountain: stitching ${files.length} file(s)${suffix} into a PDF…`, 0);
        try {
            const scripts: { name: string; content: string }[] = [];
            for (const file of files) {
                scripts.push({ name: file.basename, content: await this.app.vault.cachedRead(file) });
            }
            const pdf = buildStitchedPdf(scripts);
            const outName = target ? `stitched-screenplay.${target}.pdf` : 'stitched-screenplay.pdf';
            const outPath = normalizePath(outName);
            await this.app.vault.adapter.writeBinary(outPath, pdf);
            notice.hide();
            new Notice(`Fountain: wrote ${outPath} (${files.length} files).`);
        } catch (err) {
            notice.hide();
            console.error('Fountain: PDF export failed', err);
            new Notice('Fountain: PDF export failed — see developer console for details.');
        }
    }

    private async activateOutlineView(): Promise<void> {
        const { workspace } = this.app;

        const existing = workspace.getLeavesOfType(FOUNTAIN_OUTLINE_VIEW_TYPE);
        const existingLeaf = existing[0];
        if (existingLeaf) {
            workspace.revealLeaf(existingLeaf);
            return;
        }

        const leaf = workspace.getRightLeaf(false);
        if (leaf != null) {
            await leaf.setViewState({ type: FOUNTAIN_OUTLINE_VIEW_TYPE, active: true });
            workspace.revealLeaf(leaf);
        }
    }
}

class FountainSettingTab extends PluginSettingTab {
    constructor(app: App, private plugin: FountainPlugin) {
        super(app, plugin);
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        const save = () => void this.plugin.saveSettings();
        /** Editor extensions read settings lazily — poke open editors so toggles apply now. */
        const saveAndRefreshEditors = () => {
            save();
            this.app.workspace.updateOptions();
        };

        new Setting(containerEl)
            .setName('Primary language')
            .setDesc('Two-letter code (en, vi, …) preferred for single-language tasks like PDF export when the vault holds several translations.')
            .addText((text) => text
                .setPlaceholder('en')
                .setValue(this.plugin.settings.primaryLanguage)
                .onChange((value) => {
                    this.plugin.settings.primaryLanguage = value.trim().toLowerCase();
                    save();
                }));

        new Setting(containerEl).setName('Editor').setHeading();

        new Setting(containerEl)
            .setName('Screenplay highlighting')
            .setDesc('Style scene headings, cues, dialogue, transitions and formatting punctuation in the editor.')
            .addToggle((toggle) => toggle
                .setValue(this.plugin.settings.highlightScreenplay)
                .onChange((value) => {
                    this.plugin.settings.highlightScreenplay = value;
                    saveAndRefreshEditors();
                }));

        new Setting(containerEl)
            .setName('Autocomplete')
            .setDesc('Template menu at the start of a line, plus character, location and time-of-day completion while typing.')
            .addToggle((toggle) => toggle
                .setValue(this.plugin.settings.enableAutocomplete)
                .onChange((value) => {
                    this.plugin.settings.enableAutocomplete = value;
                    save();
                }));

        new Setting(containerEl)
            .setName('Menu trigger character')
            .setDesc('Typed at the start of a line to open the template menu. Change it if it collides with another plugin\'s slash commands.')
            .addText((text) => text
                .setPlaceholder('/')
                .setValue(this.plugin.settings.suggestTrigger)
                .onChange((value) => {
                    this.plugin.settings.suggestTrigger = value.slice(0, 1) || '/';
                    save();
                }));

        new Setting(containerEl)
            .setName('Inline diagnostics')
            .setDesc('Underline probable mistakes: typo\'d character names and transitions, cues with no dialogue, headings missing a time of day, unclosed notes and boneyards.')
            .addToggle((toggle) => toggle
                .setValue(this.plugin.settings.enableLint)
                .onChange((value) => {
                    this.plugin.settings.enableLint = value;
                    saveAndRefreshEditors();
                }));

        new Setting(containerEl)
            .setName('Translation drift diagnostics')
            .setDesc('Compare against sibling languages of the same script (bigfish.en.fountain vs bigfish.vi.fountain) and flag scene-count and cast differences.')
            .addToggle((toggle) => toggle
                .setValue(this.plugin.settings.enableDriftLint)
                .onChange((value) => {
                    this.plugin.settings.enableDriftLint = value;
                    saveAndRefreshEditors();
                }));

        new Setting(containerEl)
            .setName('Hover hints')
            .setDesc('Hold the pointer over a character cue or scene heading to see its numbers (scenes, words, pages).')
            .addToggle((toggle) => toggle
                .setValue(this.plugin.settings.enableHover)
                .onChange((value) => {
                    this.plugin.settings.enableHover = value;
                    save();
                }));

        // ── Editable autocomplete dictionary ─────────────────────────────────
        new Setting(containerEl).setName('Autocomplete dictionary').setHeading();

        const status = createDiv({ cls: 'fountain-hints-status' });
        const validate = (value: string) => {
            const ok = parseHintDictionary(value) !== null;
            status.setText(ok ? '' : '⚠ Invalid JSON — the previous valid dictionary is used until this parses.');
            status.toggleClass('is-error', !ok);
        };

        const dictSetting = new Setting(containerEl)
            .setName('Hint categories (JSON)')
            .setDesc('The curated vocabulary offered in the slash menu, grouped by category (transition, shot/angle, marker — add your own). Characters and locations are added automatically from every .fountain file in your project.');
        dictSetting.settingEl.addClass('fountain-hints-setting');

        dictSetting.addTextArea((ta) => {
            ta.setValue(this.plugin.settings.hintsJson);
            ta.inputEl.addClass('fountain-hints-editor');
            ta.inputEl.rows = 16;
            ta.inputEl.spellcheck = false;
            ta.onChange((value) => {
                this.plugin.settings.hintsJson = value;
                save();
                validate(value);
            });
        });
        dictSetting.addExtraButton((btn) => btn
            .setIcon('rotate-ccw')
            .setTooltip('Reset to defaults')
            .onClick(() => {
                this.plugin.settings.hintsJson = serializeHints(DEFAULT_HINTS);
                save();
                this.display();
            }));

        containerEl.appendChild(status);
        validate(this.plugin.settings.hintsJson);
    }
}

/** Quick picker over the languages found in the stats folder. */
class LanguageSuggestModal extends SuggestModal<string> {
    constructor(app: App, private langs: string[], private onChoose: (lang: string) => void) {
        super(app);
        this.setPlaceholder('Language to export (ISO-639-1 code)…');
    }

    getSuggestions(query: string): string[] {
        const q = query.toLowerCase();
        return this.langs.filter((l) => l.includes(q));
    }

    renderSuggestion(lang: string, el: HTMLElement): void {
        el.createEl('div', { text: lang.toUpperCase() });
    }

    onChooseSuggestion(lang: string): void {
        this.onChoose(lang);
    }
}
