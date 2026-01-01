import {
    Events,
    MarkdownView,
    Menu,
    Plugin,
    WorkspaceLeaf,
    debounce,
    setIcon,
    EditorSuggest,
    EditorPosition,
    Editor,
    EditorSuggestContext,
    EditorSuggestTriggerInfo,
    TFile,
    Notice
} from 'obsidian';
import which from 'which';

// === CodeMirror 6 Imports for Live Preview ===
import { StateField, EditorState, Extension } from '@codemirror/state';
import { Decoration, DecorationSet, EditorView, WidgetType } from '@codemirror/view';

// === Original Imports (Preserved) ===
import {
    citeKeyCacheField,
    citeKeyPlugin,
    bibManagerField,
    editorTooltipHandler,
} from './editorExtension';
import { t } from './lang/helpers';
import { processCiteKeys } from './markdownPostprocessor';
import {
    DEFAULT_SETTINGS,
    ReferenceListSettings,
    ReferenceListSettingsTab,
} from './settings';
import { TooltipManager } from './tooltip';
import { ReferenceListView, viewType } from './view';
import { PromiseCapability, fixPath, getVaultRoot } from './helpers';
import path from 'path';
import { BibManager } from './bib/bibManager';
import { CiteSuggest } from './citeSuggest/citeSuggest';
import { isZoteroRunning } from './bib/helpers';

// ============================================================
// PART A: Figure/Table Helper Logic (Ported to TypeScript)
// ============================================================

const FIGURE_PREFIX = "图";
const TABLE_PREFIX = "表";

let pluginInstance: ReferenceList | null = null;

function getFigurePrefix(): string {
    return pluginInstance?.settings.figurePrefix || "图";
}

function getTablePrefix(): string {
    return pluginInstance?.settings.tablePrefix || "表";
}

function getTimestamp(): string {
    const now = new Date();
    const Y = now.getFullYear();
    const M = (now.getMonth() + 1).toString().padStart(2, '0');
    const D = now.getDate().toString().padStart(2, '0');
    const h = now.getHours().toString().padStart(2, '0');
    const m = now.getMinutes().toString().padStart(2, '0');
    return `${Y}${M}${D}${h}${m}`;
}

// 1. Widget for Live Preview
class LabelWidget extends WidgetType {
    constructor(readonly text: string, readonly type: string, readonly isDef: boolean) {
        super();
    }

    toDOM(view: EditorView): HTMLElement {
        const span = document.createElement("span");
        span.innerText = this.text;
        // Note: Ensure your CSS classes (.pandoc-widget, etc.) are in the plugin's styles.css
        span.className = `pandoc-widget pandoc-${this.type} pandoc-${this.isDef ? 'def' : 'ref'}`;
        return span;
    }
}

// 2. Definition Scanner
interface PandocDef {
    id: string;
    type: string;
    label: string;
    fullId: string;
}

function scanDefinitions(text: string): PandocDef[] {
    const definitions: PandocDef[] = [];
    let figCount = 0;
    let tblCount = 0;

    // 获取当前设置的前缀
    const figPrefix = getFigurePrefix();
    const tblPrefix = getTablePrefix();

    const regex = /\{#(fig|tbl):([a-zA-Z0-9_\-]+)(?:\s+.*?)?\}/g;
    let match;

    while ((match = regex.exec(text)) !== null) {
        const type = match[1];
        const id = match[2];
        let label = "";

        if (type === 'fig') {
            figCount++;
            label = `${figPrefix}${figCount}`; // 使用动态前缀
        } else if (type === 'tbl') {
            tblCount++;
            label = `${tblPrefix}${tblCount}`; // 使用动态前缀
        }

        definitions.push({
            id: id,
            type: type,
            label: label,
            fullId: `${type}:${id}`
        });
    }
    return definitions;
}

// 3. StateField (Updated)
export const pandocFigTblField = StateField.define<DecorationSet>({
    create(state): DecorationSet {
        return Decoration.none;
    },
    update(oldDecorations, transaction): DecorationSet {
        if (!transaction.docChanged && !transaction.selection) return oldDecorations;

        // 确保插件实例已加载
        if (!pluginInstance) return oldDecorations;

        const state = transaction.state;
        const text = state.doc.toString();
        const widgets: any[] = [];
        const selectionRanges = state.selection.ranges;

        const defs = scanDefinitions(text);
        const figMap = new Map<string, string>();
        const tblMap = new Map<string, string>();

        const figPrefix = getFigurePrefix();
        const tblPrefix = getTablePrefix();

        defs.forEach(def => {
            if (def.type === 'fig') figMap.set(def.id, def.label.replace(figPrefix, ''));
            if (def.type === 'tbl') tblMap.set(def.id, def.label.replace(tblPrefix, ''));
        });

        function checkCursorOverlap(from: number, to: number): boolean {
            for (const range of selectionRanges) {
                if (range.from <= to && range.to >= from) return true;
            }
            return false;
        }

        function addDecoration(from: number, to: number, type: string, id: string, isDef: boolean) {
            if (checkCursorOverlap(from, to)) return;

            let number = "?";
            let prefix = "";

            if (type === 'fig') {
                prefix = figPrefix;
                if (figMap.has(id)) number = figMap.get(id) || "?";
            } else if (type === 'tbl') {
                prefix = tblPrefix;
                if (tblMap.has(id)) number = tblMap.get(id) || "?";
            }

            const displayText = `${prefix}${number}`;
            const deco = Decoration.replace({
                widget: new LabelWidget(displayText, type, isDef),
                inclusive: false
            }).range(from, to);
            widgets.push(deco);
        }

        const defRegex = /\{#(fig|tbl):([a-zA-Z0-9_\-]+)(?:\s+.*?)?\}/g;
        let defMatch;
        while ((defMatch = defRegex.exec(text)) !== null) {
            addDecoration(defMatch.index, defMatch.index + defMatch[0].length, defMatch[1], defMatch[2], true);
        }

        const refRegex = / ?@(fig|tbl):([a-zA-Z0-9_\-]+) ?/g;
        let refMatch;
        while ((refMatch = refRegex.exec(text)) !== null) {
            addDecoration(refMatch.index, refMatch.index + refMatch[0].length, refMatch[1], refMatch[2], false);
        }

        return Decoration.set(widgets.sort((a, b) => a.from - b.from));
    },
    provide: (field) => EditorView.decorations.from(field)
});
// 4. Editor Suggest for Figures/Tables (Trigger: Space + @)
class FigureTableSuggest extends EditorSuggest<PandocDef> {
    constructor(plugin: Plugin) {
        super(plugin.app);
    }

    onTrigger(cursor: EditorPosition, editor: Editor, file: TFile): EditorSuggestTriggerInfo | null {
        const line = editor.getLine(cursor.line);
        const sub = line.substring(0, cursor.ch);

        // Trigger only on Space + @ or Start of line + @
        // Matches: " @fig", " @tbl", or just " @"
        // Does NOT match "[@" (which is for citations)
        const match = sub.match(/(^|\s)@((fig|tbl)?:?([a-zA-Z0-9_\-]*))$/);

        if (match) {
            return {
                start: { line: cursor.line, ch: match.index! + match[1].length }, // Skip the space
                end: cursor,
                query: match[2] // content after @
            };
        }
        return null;
    }

    getSuggestions(context: EditorSuggestContext): PandocDef[] {
        const text = context.editor.getValue();
        const defs = scanDefinitions(text);
        const query = context.query.toLowerCase();

        // Filter: if user typed "@fig", show figs. If "@", show all figs/tbls.
        return defs.filter(def => {
            const suggestion = `@${def.type}:${def.id}`;
            return suggestion.toLowerCase().includes(query);
        });
    }

    renderSuggestion(suggestion: PandocDef, el: HTMLElement): void {
        el.createEl("span", { text: suggestion.label, cls: "pandoc-suggest-label" }); // e.g., 图1
        el.createEl("small", { text: ` (${suggestion.id})`, cls: "pandoc-suggest-id" }); // e.g., (2025...)
    }

    selectSuggestion(suggestion: PandocDef, evt: MouseEvent | KeyboardEvent): void {
        if (!this.context) return;
        const textToInsert = `@${suggestion.type}:${suggestion.id}`;
        this.context.editor.replaceRange(
            textToInsert,
            this.context.start,
            this.context.end
        );
    }
}

// ============================================================
// MAIN PLUGIN CLASS
// ============================================================

export default class ReferenceList extends Plugin {
    settings: ReferenceListSettings;
    emitter: Events;
    tooltipManager: TooltipManager;
    cacheDir: string;
    bibManager: BibManager;
    _initPromise: PromiseCapability<void>;

    get initPromise() {
        if (!this._initPromise) {
            return (this._initPromise = new PromiseCapability());
        }
        return this._initPromise;
    }

    async onload() {
        const { app } = this;

        // 【重要】初始化全局实例，让外部函数能读取设置
        pluginInstance = this;

        await this.loadSettings();

        // 1. Init Views and Managers (Original Logic)
        this.registerView(
            viewType,
            (leaf: WorkspaceLeaf) => new ReferenceListView(leaf, this)
        );

        this.cacheDir = path.join(getVaultRoot(), '.pandoc');
        this.emitter = new Events();
        this.bibManager = new BibManager(this);

        this.initPromise.promise
            .then(() => {
                if (this.settings.pullFromZotero) {
                    return this.bibManager.loadAndRefreshGlobalZBib();
                } else {
                    return this.bibManager.loadGlobalBibFile();
                }
            })
            .finally(() => this.bibManager.initPromise.resolve());

        this.addSettingTab(new ReferenceListSettingsTab(this));

        // 2. Register Suggests
        // A. The original Citation Suggest (Trigger: [@ )
        this.registerEditorSuggest(new CiteSuggest(app, this));
        // B. The NEW Figure/Table Suggest (Trigger: Space + @ )
        this.registerEditorSuggest(new FigureTableSuggest(this));

        this.tooltipManager = new TooltipManager(this);
        this.registerMarkdownPostProcessor(processCiteKeys(this));

        // 3. Register Editor Extensions (CodeMirror 6)
        this.registerEditorExtension([
            // Original extensions
            bibManagerField.init(() => this.bibManager),
            citeKeyCacheField,
            citeKeyPlugin,
            editorTooltipHandler(this.tooltipManager),
            // NEW Extension: Figure/Table Live Preview
            pandocFigTblField
        ]);

        // 4. Register New Commands for IDs
        this.addCommand({
            id: 'insert-fig-id-timestamp',
            name: 'Insert Figure ID (Timestamp)',
            editorCallback: (editor: Editor) => {
                editor.replaceSelection(`{#fig:${getTimestamp()}}`);
            }
        });

        this.addCommand({
            id: 'insert-tbl-id-timestamp',
            name: 'Insert Table ID (Timestamp)',
            editorCallback: (editor: Editor) => {
                editor.replaceSelection(`{#tbl:${getTimestamp()}}`);
            }
        });

        // 5. Existing Logic (Pandoc Path, Status Bar, etc.)
        fixPath().then(async () => {
            if (!this.settings.pathToPandoc) {
                try {
                    const pathToPandoc = await which('pandoc');
                    this.settings.pathToPandoc = pathToPandoc;
                    this.saveSettings();
                } catch {
                    // We can ignore any errors here
                }
            }

            this.initPromise.resolve();
            this.app.workspace.trigger('parse-style-settings');
        });

        this.addCommand({
            id: 'focus-reference-list-view',
            name: t('Show reference list'),
            callback: async () => {
                this.initLeaf();
            },
        });

        document.body.toggleClass(
            'pwc-tooltips',
            !!this.settings.showCitekeyTooltips
        );

        this.registerEvent(
            app.metadataCache.on(
                'changed',
                debounce(
                    async (file) => {
                        await this.initPromise.promise;
                        await this.bibManager.initPromise.promise;

                        const activeView = app.workspace.getActiveViewOfType(MarkdownView);
                        if (activeView && file === activeView.file) {
                            this.processReferences();
                        }
                    },
                    100,
                    true
                )
            )
        );

        this.registerEvent(
            app.workspace.on(
                'active-leaf-change',
                debounce(
                    async (leaf) => {
                        await this.initPromise.promise;
                        await this.bibManager.initPromise.promise;

                        app.workspace.iterateRootLeaves((rootLeaf) => {
                            if (rootLeaf === leaf) {
                                if (leaf.view instanceof MarkdownView) {
                                    this.processReferences();
                                } else {
                                    this.view?.setNoContentMessage();
                                }
                            }
                        });
                    },
                    100,
                    true
                )
            )
        );

        (async () => {
            this.initStatusBar();
            this.setStatusBarLoading();

            await this.initPromise.promise;
            await this.bibManager.initPromise.promise;

            this.setStatusBarIdle();
            this.processReferences();
        })();
    }

    onunload() {
        document.body.removeClass('pwc-tooltips');
        this.app.workspace
            .getLeavesOfType(viewType)
            .forEach((leaf) => leaf.detach());
        this.bibManager.destroy();
    }

    // ... (Rest of the class methods: statusBarIcon, initStatusBar, setStatusBarLoading, setStatusBarIdle, get view, initLeaf, revealLeaf, loadSettings, saveSettings, emitSettingsUpdate, processReferences)
    // These remain exactly the same as the original file, I just collapsed them here for brevity in display,
    // BUT YOU SHOULD KEEP THEM IN YOUR FILE.

    statusBarIcon: HTMLElement;
    initStatusBar() {
        const ico = (this.statusBarIcon = this.addStatusBarItem());
        ico.addClass('pwc-status-icon', 'clickable-icon');
        ico.setAttr('aria-label', t('Pandoc reference list settings'));
        ico.setAttr('data-tooltip-position', 'top');
        this.setStatusBarIdle();
        let isOpen = false;
        ico.addEventListener('click', () => {
            if (isOpen) return;
            const { settings } = this;
            const menu = (new Menu() as any)
                .addSections(['settings', 'actions'])
                .addItem((item: any) =>
                    item
                        .setSection('settings')
                        .setIcon('lucide-message-square')
                        .setTitle(t('Show citekey tooltips'))
                        .setChecked(!!settings.showCitekeyTooltips)
                        .onClick(() => {
                            this.settings.showCitekeyTooltips = !settings.showCitekeyTooltips;
                            this.saveSettings();
                        })
                )
                .addItem((item: any) =>
                    item
                        .setSection('settings')
                        .setIcon('lucide-at-sign')
                        .setTitle(t('Show citekey suggestions'))
                        .setChecked(!!settings.enableCiteKeyCompletion)
                        .onClick(() => {
                            this.settings.enableCiteKeyCompletion =
                                !settings.enableCiteKeyCompletion;
                            this.saveSettings();
                        })
                )
                .addItem((item: any) =>
                    item
                        .setSection('actions')
                        .setIcon('lucide-rotate-cw')
                        .setTitle(t('Refresh bibliography'))
                        .onClick(async () => {
                            const activeView =
                                this.app.workspace.getActiveViewOfType(MarkdownView);
                            if (activeView) {
                                const file = activeView.file;

                                if (this.bibManager.fileCache.has(file)) {
                                    const cache = this.bibManager.fileCache.get(file);
                                    if (cache.source !== this.bibManager) {
                                        this.bibManager.fileCache.delete(file);
                                        this.processReferences();
                                        return;
                                    }
                                }
                            }

                            this.bibManager.reinit(true);
                            await this.bibManager.initPromise.promise;
                            this.processReferences();
                        })
                );

            const rect = ico.getBoundingClientRect();
            menu.onHide(() => {
                isOpen = false;
            });
            menu.setParentElement(ico).showAtPosition({
                x: rect.x,
                y: rect.top - 5,
                width: rect.width,
                overlap: true,
                left: false,
            });
            isOpen = true;
        });
    }

    setStatusBarLoading() {
        this.statusBarIcon.addClass('is-loading');
        setIcon(this.statusBarIcon, 'lucide-loader');
    }

    setStatusBarIdle() {
        this.statusBarIcon.removeClass('is-loading');
        setIcon(this.statusBarIcon, 'lucide-at-sign');
    }

    get view() {
        const leaves = this.app.workspace.getLeavesOfType(viewType);
        if (!leaves?.length) return null;
        return leaves[0].view as ReferenceListView;
    }

    async initLeaf() {
        if (this.view) return this.revealLeaf();

        await this.app.workspace.getRightLeaf(false).setViewState({
            type: viewType,
        });

        this.revealLeaf();

        await this.initPromise.promise;
        await this.bibManager.initPromise.promise;

        const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (activeView) {
            this.processReferences();
        }
    }

    revealLeaf() {
        const leaves = this.app.workspace.getLeavesOfType(viewType);
        if (!leaves?.length) return;
        this.app.workspace.revealLeaf(leaves[0]);
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings(cb?: () => void) {
        document.body.toggleClass(
            'pwc-tooltips',
            !!this.settings.showCitekeyTooltips
        );

        // Refresh the reference list when settings change
        this.emitSettingsUpdate(cb);
        await this.saveData(this.settings);
    }

    emitSettingsUpdate = debounce(
        (cb?: () => void) => {
            if (this.initPromise.settled) {
                this.view?.contentEl.toggleClass(
                    'collapsed-links',
                    !!this.settings.hideLinks
                );

                cb && cb();

                this.processReferences();
            }
        },
        5000,
        true
    );

    processReferences = async () => {
        const { settings, view } = this;
        if (!settings.pathToBibliography && !settings.pullFromZotero) {
            return view?.setMessage(
                t(
                    'Please provide the path to your pandoc compatible bibliography file in the Pandoc Reference List plugin settings.'
                )
            );
        }

        const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (activeView) {
            try {
                const fileContent = await this.app.vault.cachedRead(activeView.file);
                const bib = await this.bibManager.getReferenceList(
                    activeView.file,
                    fileContent
                );
                const cache = this.bibManager.fileCache.get(activeView.file);

                if (
                    !bib &&
                    cache?.source === this.bibManager &&
                    settings.pullFromZotero &&
                    !(await isZoteroRunning(settings.zoteroPort)) &&
                    this.bibManager.fileCache.get(activeView.file)?.keys.size
                ) {
                    view?.setMessage(t('Cannot connect to Zotero'));
                } else {
                    view?.setViewContent(bib);
                }
            } catch (e) {
                console.error(e);
            }
        } else {
            view?.setNoContentMessage();
        }
    };
}
