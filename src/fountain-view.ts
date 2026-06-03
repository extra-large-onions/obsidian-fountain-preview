import { TextFileView } from 'obsidian';

export const FOUNTAIN_VIEW_TYPE = 'fountain';

export class FountainView extends TextFileView {
    private textarea: HTMLTextAreaElement | null = null;

    getViewType(): string { return FOUNTAIN_VIEW_TYPE; }
    getDisplayText(): string { return this.file?.basename ?? 'Fountain'; }
    getIcon(): string { return 'film'; }

    getViewData(): string {
        return this.textarea?.value ?? this.data;
    }

    setViewData(data: string, _clear: boolean): void {
        this.data = data;
        if (this.textarea) this.textarea.value = data;
    }

    clear(): void {
        this.data = '';
        if (this.textarea) this.textarea.value = '';
    }

    async onOpen(): Promise<void> {
        this.contentEl.empty();
        this.contentEl.addClass('fountain-view-container');

        this.textarea = this.contentEl.createEl('textarea', { cls: 'fountain-editor' });

        this.textarea.addEventListener('input', () => {
            this.requestSave();
            this.app.workspace.trigger('fountain:content-changed');
        });
    }

    async onClose(): Promise<void> {
        this.textarea = null;
    }

    getCurrentContent(): string {
        return this.textarea?.value ?? this.data;
    }

    scrollToLine(lineNumber: number): void {
        const ta = this.textarea;
        if (!ta) return;

        const lines = ta.value.split('\n');
        const clampedLine = Math.max(0, Math.min(lineNumber, lines.length - 1));

        // Compute char offset of the target line
        let pos = 0;
        for (let i = 0; i < clampedLine; i++) pos += (lines[i]?.length ?? 0) + 1;

        const lineLen = lines[clampedLine]?.length ?? 0;
        ta.focus();
        ta.setSelectionRange(pos, pos + lineLen);

        // Scroll so the target line is near the top (with a 5-line margin)
        const lineHeight = ta.scrollHeight / Math.max(lines.length, 1);
        ta.scrollTop = Math.max(0, (clampedLine - 5) * lineHeight);
    }
}
