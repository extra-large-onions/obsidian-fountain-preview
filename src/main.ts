import { Plugin } from 'obsidian';
import { FountainView, FOUNTAIN_VIEW_TYPE } from './fountain-view';
import { FountainOutlineView, FOUNTAIN_OUTLINE_VIEW_TYPE } from './fountain-outline-view';

export default class FountainPlugin extends Plugin {
    async onload() {
        this.registerView(FOUNTAIN_VIEW_TYPE, (leaf) => new FountainView(leaf));
        this.registerView(FOUNTAIN_OUTLINE_VIEW_TYPE, (leaf) => new FountainOutlineView(leaf));
        this.registerExtensions(['fountain'], FOUNTAIN_VIEW_TYPE);

        this.addRibbonIcon('film', 'Open Fountain Outline', () => {
            this.activateOutlineView();
        });

        this.addCommand({
            id: 'open-fountain-outline',
            name: 'Open Fountain Outline',
            callback: () => this.activateOutlineView(),
        });
    }

    onunload() {}

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
