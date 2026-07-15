// ─── Editable hint dictionary ─────────────────────────────────────────────────
//
// The static vocabulary offered in the slash menu: transitions, camera
// shots/angles, scene markers, and any category the user adds. Ships with
// useful defaults (below) and is editable as JSON in the settings tab.
//
// This is the *curated* half of autocomplete. The *contextual* half —
// characters, locations, times pulled from the project's .fountain files — is
// dynamic and lives in fountain-index.ts / the plugin's project vocabulary.

export interface HintEntry {
    /** Text inserted into the editor. */
    text: string;
    /** Optional note shown on the right of the menu row (overrides the category label). */
    desc?: string;
}

export interface HintCategory {
    /** Stable id, e.g. "transition", "shot", "marker". */
    id: string;
    /** Shown as the muted right-hand hint on each row of this category. */
    label: string;
    /**
     * How an entry is inserted:
     *   'plain'      — the text as written (default)
     *   'transition' — force with a leading "> " when it isn't already a
     *                  standard-form transition (so "TRANSITION TO:" becomes
     *                  "> TRANSITION TO:", but "CUT TO:" stays as-is)
     */
    insert?: 'plain' | 'transition';
    entries: (string | HintEntry)[];
}

export interface HintDictionary {
    categories: HintCategory[];
}

/** Canonical transitions — also the seed of the default "transition" category. */
export const STANDARD_TRANSITIONS = [
    'CUT TO:', 'SMASH CUT TO:', 'MATCH CUT TO:', 'DISSOLVE TO:', 'JUMP CUT TO:',
    'FADE IN:', 'FADE OUT.', 'FADE TO BLACK.',
];

export const DEFAULT_HINTS: HintDictionary = {
    categories: [
        {
            id: 'transition',
            label: 'transition',
            insert: 'transition',
            entries: [
                'CUT TO:', 'SMASH CUT TO:', 'MATCH CUT TO:', 'DISSOLVE TO:',
                'JUMP CUT TO:', 'TIME CUT TO:', 'FADE IN:', 'FADE OUT.',
                'FADE TO BLACK.', 'FADE TO:',
            ],
        },
        {
            id: 'shot',
            label: 'shot / angle',
            insert: 'plain',
            entries: [
                'EYE LEVEL', 'HIGH ANGLE', 'LOW ANGLE', 'DUTCH ANGLE',
                'OVER THE SHOULDER', 'POV', 'CLOSE ON', 'EXTREME CLOSE ON',
                'WIDE SHOT', 'MEDIUM SHOT', 'TWO SHOT', 'TRACKING SHOT',
                'FOLLOWING', 'DOLLY IN', 'DOLLY OUT', 'CRANE SHOT', 'AERIAL SHOT',
                'INSERT', 'ESTABLISHING SHOT', 'ANGLE ON', 'REVERSE ANGLE',
            ],
        },
        {
            id: 'marker',
            label: 'marker',
            insert: 'plain',
            entries: [
                'OVER BLACK:', 'TITLE OVER:', 'SUPER:', 'INTERCUT WITH:',
                'BACK TO SCENE', 'MONTAGE', 'END MONTAGE', 'SPLIT SCREEN:',
                'FLASHBACK', 'END FLASHBACK', 'DREAM SEQUENCE',
            ],
        },
    ],
};

export function entryText(e: string | HintEntry): string {
    return typeof e === 'string' ? e : e.text;
}

export function entryDesc(e: string | HintEntry): string | undefined {
    return typeof e === 'string' ? undefined : e.desc;
}

export function serializeHints(dict: HintDictionary): string {
    return JSON.stringify(dict, null, 2);
}

/**
 * Parse the user's JSON. Returns null on any structural error so the caller can
 * fall back to DEFAULT_HINTS — a broken edit never breaks autocomplete.
 */
export function parseHintDictionary(json: string): HintDictionary | null {
    let obj: unknown;
    try {
        obj = JSON.parse(json);
    } catch {
        return null;
    }
    const categoriesRaw = (obj as { categories?: unknown })?.categories;
    if (!Array.isArray(categoriesRaw)) return null;

    const categories: HintCategory[] = [];
    for (const c of categoriesRaw) {
        const cat = c as Partial<HintCategory>;
        if (typeof cat.id !== 'string' || !Array.isArray(cat.entries)) continue;
        categories.push({
            id: cat.id,
            label: typeof cat.label === 'string' ? cat.label : cat.id,
            insert: cat.insert === 'transition' ? 'transition' : 'plain',
            entries: cat.entries.filter(
                (e): e is string | HintEntry =>
                    typeof e === 'string' || (!!e && typeof (e as HintEntry).text === 'string'),
            ),
        });
    }
    return { categories };
}
