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
    Notice,
    ItemView
} from 'obsidian';
import which from 'which';

import { StateField, EditorState, Extension, Range, Transaction } from '@codemirror/state';
import { Decoration, DecorationSet, EditorView, WidgetType } from '@codemirror/view';

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
// PART A: 核心逻辑
// ============================================================

const FIGURE_PREFIX_DEFAULT = "图";
const TABLE_PREFIX_DEFAULT = "表";
const VIEW_TYPE_FIGURE_NAV = "pandoc-figure-navigator";

let pluginInstance: ReferenceList | null = null;

function getFigurePrefix(): string {
    return pluginInstance?.settings.figurePrefix || FIGURE_PREFIX_DEFAULT;
}
function getTablePrefix(): string {
    return pluginInstance?.settings.tablePrefix || TABLE_PREFIX_DEFAULT;
}
function getTimestamp(): string {
    const now = new Date();
    return `${now.getFullYear()}${(now.getMonth()+1).toString().padStart(2,'0')}${now.getDate().toString().padStart(2,'0')}${now.getHours().toString().padStart(2,'0')}${now.getMinutes().toString().padStart(2,'0')}`;
}

interface PandocDef {
    id: string;
    type: string;
    number: string;
    suffix: string;
    caption: string;
    fullLabel: string;
    line: number;
    usageCount: number;
}

interface ScanResult {
    defs: Map<string, PandocDef>;
    refIds: Set<string>;
}

// --- Widget 定义 ---
class LabelWidget extends WidgetType {
    constructor(
        readonly displayText: string,
        readonly type: string,
        readonly isDef: boolean,
        readonly targetLine: number | null,
        readonly isError: boolean
    ) {
        super();
    }

    eq(other: LabelWidget) {
        return other.displayText === this.displayText &&
            other.type === this.type &&
            other.isDef === this.isDef &&
            other.targetLine === this.targetLine &&
            other.isError === this.isError;
    }

    toDOM(view: EditorView): HTMLElement {
        const span = document.createElement("span");
        span.innerText = this.displayText;

        const errorClass = this.isError ? 'pandoc-error' : '';
        span.className = `pandoc-widget pandoc-${this.type} pandoc-${this.isDef ? 'def' : 'ref'} ${errorClass}`;

        if (!this.isDef && this.targetLine !== null && pluginInstance?.settings.enableClickToJump) {
            span.onmousedown = (e) => {
                e.preventDefault();
                e.stopPropagation();
                const lineInfo = view.state.doc.line(this.targetLine + 1);
                view.dispatch({
                    effects: EditorView.scrollIntoView(lineInfo.from, { y: "center" }),
                    selection: { anchor: lineInfo.from }
                });
            };
            span.title = "Click to jump to definition";
            span.style.cursor = "pointer";
        } else {
            span.style.cursor = this.isError ? "help" : "text";
            if (this.isError) {
                span.title = this.isDef ? "Warning: Image defined but never cited" : "Error: Citation ID not found";
            }
        }
        return span;
    }
}

// --- 扫描器 ---
function scanDocument(doc: any): ScanResult {
    const defMap = new Map<string, PandocDef>();
    const refIds = new Set<string>();

    let figCount = 0;
    let tblCount = 0;
    const figPrefix = getFigurePrefix();
    const tblPrefix = getTablePrefix();

    for (let i = 1; i <= doc.lines; i++) {
        const lineText = doc.line(i).text;

        const defRegex = /\{#(fig|tbl):([a-zA-Z0-9_\-]+)(?:\s+.*?)?\}([a-zA-Z])?/;
        const match = defRegex.exec(lineText);

        if (match) {
            const type = match[1];
            const id = match[2];
            const suffix = match[3] || "";
            let caption = "";
            const imgMatch = /!\[(.*?)\]/.exec(lineText);
            if (imgMatch) caption = imgMatch[1];

            let countStr = "";
            if (type === 'fig') { figCount++; countStr = `${figCount}`; }
            else { tblCount++; countStr = `${tblCount}`; }

            const prefix = (type === 'fig') ? figPrefix : tblPrefix;
            const fullLabel = `${prefix}${countStr}${suffix}`;

            defMap.set(id, {
                id, type, number: countStr, suffix, caption, fullLabel,
                line: i - 1,
                usageCount: 0
            });
        }

        const refGlobalRegex = /@(fig|tbl):([a-zA-Z0-9_\-]+)/g;
        let refMatch;
        while ((refMatch = refGlobalRegex.exec(lineText)) !== null) {
            refIds.add(refMatch[2]);
        }
    }

    refIds.forEach(refId => {
        if (defMap.has(refId)) {
            defMap.get(refId)!.usageCount++;
        }
    });

    return { defs: defMap, refIds };
}

// --- 装饰器 ---
export const pandocFigTblField = StateField.define<DecorationSet>({
    create(state): DecorationSet { return Decoration.none; },
    update(oldDecorations, transaction): DecorationSet {
        if (!transaction.docChanged && !transaction.selection) return oldDecorations;
        if (!pluginInstance) return oldDecorations;

        const state = transaction.state;
        const widgets: Range<Decoration>[] = [];
        const selectionRanges = state.selection.ranges;
        const { defs } = scanDocument(state.doc);
        const enableCheck = pluginInstance.settings.enableIntegrityCheck;

        function checkCursorOverlap(from: number, to: number): boolean {
            for (const range of selectionRanges) {
                if (range.from <= to && range.to >= from) return true;
            }
            return false;
        }

        const text = state.doc.toString();

        const defRegex = /\{#(fig|tbl):([a-zA-Z0-9_\-]+)(?:\s+.*?)?\}([a-zA-Z])?/g;
        let m;
        while ((m = defRegex.exec(text)) !== null) {
            const start = m.index;
            const end = m.index + m[0].length;
            if (checkCursorOverlap(start, end)) continue;

            const type = m[1];
            const id = m[2];
            if (defs.has(id)) {
                const def = defs.get(id)!;
                const displayText = def.caption ? `${def.fullLabel} ${def.caption}` : `${def.fullLabel}`;
                const isOrphan = enableCheck && (def.usageCount === 0);
                widgets.push(Decoration.replace({
                    widget: new LabelWidget(displayText, type, true, null, isOrphan),
                    inclusive: false
                }).range(start, end));
            }
        }

        const refRegex = /[(\uff08]\s*@(fig|tbl):([a-zA-Z0-9_\-]+)(.*?)[)\uff09]/g;
        while ((m = refRegex.exec(text)) !== null) {
            const start = m.index;
            const end = m.index + m[0].length;
            if (checkCursorOverlap(start, end)) continue;

            const type = m[1];
            const id = m[2];
            const manualSuffix = (m[3] || "").trim();

            if (defs.has(id)) {
                const def = defs.get(id)!;
                const displayText = `(${def.fullLabel}${manualSuffix})`;
                widgets.push(Decoration.replace({
                    widget: new LabelWidget(displayText, type, false, def.line, false),
                    inclusive: false
                }).range(start, end));
            } else {
                const prefix = type === 'fig' ? getFigurePrefix() : getTablePrefix();
                widgets.push(Decoration.replace({
                    widget: new LabelWidget(`(${prefix}?${manualSuffix})`, type, false, null, enableCheck),
                    inclusive: false
                }).range(start, end));
            }
        }
        return Decoration.set(widgets.sort((a, b) => a.from - b.from));
    },
    provide: (field) => EditorView.decorations.from(field)
});

// --- 自动补全 ---
class FigureTableSuggest extends EditorSuggest<PandocDef> {
    plugin: ReferenceList;
    constructor(plugin: ReferenceList) { super(plugin.app); this.plugin = plugin; }

    onTrigger(cursor: EditorPosition, editor: Editor, file: TFile): EditorSuggestTriggerInfo | null {
        const line = editor.getLine(cursor.line);
        const sub = line.substring(0, cursor.ch);
        const match = sub.match(/(@(fig|tbl)?:?([a-zA-Z0-9_\-]*))$/);
        if (match) return { start: { line: cursor.line, ch: match.index! }, end: cursor, query: match[0] };
        return null;
    }

    getSuggestions(context: EditorSuggestContext): PandocDef[] {
        const text = context.editor.getValue();
        const lines = text.split('\n');
        const docShim = { lines: lines.length, line: (i: number) => ({ text: lines[i-1] }) };
        const { defs } = scanDocument(docShim);
        const query = context.query.toLowerCase();
        const results: PandocDef[] = [];
        for (const def of defs.values()) {
            const searchKey = `@${def.type}:${def.id} ${def.caption}`.toLowerCase();
            if (searchKey.includes(query.replace('(', ''))) results.push(def);
        }
        return results;
    }

    renderSuggestion(def: PandocDef, el: HTMLElement): void {
        const left = el.createEl("span", { cls: "pandoc-suggest-label" });
        left.innerText = `${def.fullLabel} ${def.caption || ""}`;
        el.createEl("small", { text: ` (${def.id})`, cls: "pandoc-suggest-id" });
    }

    selectSuggestion(def: PandocDef, evt: MouseEvent | KeyboardEvent): void {
        if (!this.context) return;
        const useBrackets = this.plugin.settings.enableAutoBrackets;
        const cursor = this.context.editor.getCursor();
        const line = this.context.editor.getLine(cursor.line);
        const prefix = line.substring(0, this.context.start.ch);
        const hasOpenParen = /[\(\uff08]\s*$/.test(prefix);

        let textToInsert = `@${def.type}:${def.id}`;
        if (useBrackets && !hasOpenParen) textToInsert = `(@${def.type}:${def.id})`;
        this.context.editor.replaceRange(textToInsert, this.context.start, this.context.end);
    }
}

// --- 侧边栏视图 ---
class FigureNavigatorView extends ItemView {
    plugin: ReferenceList;
    constructor(leaf: WorkspaceLeaf, plugin: ReferenceList) { super(leaf); this.plugin = plugin; }
    getViewType() { return VIEW_TYPE_FIGURE_NAV; }
    getDisplayText() { return "Figures & Tables"; }
    getIcon() { return "image"; }

    async onOpen() {
        this.updateView();
        this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.updateView()));
        this.registerEvent(this.app.workspace.on('editor-change', debounce(() => this.updateView(), 300, true)));
        this.registerEvent(this.app.workspace.on('file-open', () => this.updateView()));
    }

    updateView() {
        const container = this.contentEl;
        container.empty();

        let activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!activeView) {
            const leaves = this.app.workspace.getLeavesOfType("markdown");
            if (leaves.length > 0) activeView = leaves[0].view as MarkdownView;
        }

        if (!activeView) {
            container.createEl("div", { text: "No active markdown editor.", cls: "pandoc-no-content" });
            return;
        }

        const docShim = {
            lines: activeView.editor.lineCount(),
            line: (i: number) => ({ text: activeView.editor.getLine(i - 1) })
        };
        const { defs } = scanDocument(docShim);
        const enableCheck = this.plugin.settings.enableIntegrityCheck;

        if (defs.size === 0) {
            container.createEl("div", { text: "No figures or tables found.", cls: "pandoc-no-content" });
            return;
        }

        const listDiv = container.createDiv({ cls: "pandoc-nav-container" });

        defs.forEach((def) => {
            const item = listDiv.createDiv({ cls: "pandoc-nav-item" });
            if (enableCheck && def.usageCount === 0) item.addClass("is-orphan");

            const textSpan = item.createSpan({ cls: "pandoc-nav-text" });
            textSpan.innerText = `${def.fullLabel} ${def.caption || ""}`;

            item.onclick = () => {
                this.app.workspace.setActiveLeaf(activeView!.leaf, { focus: true });
                activeView!.editor.setCursor(def.line, 0);
                activeView!.editor.scrollIntoView({ from: { line: def.line, ch: 0 }, to: { line: def.line, ch: 0 } }, true);
            };
        });
    }

    async onClose() {}
}

export default class ReferenceList extends Plugin {
    settings: ReferenceListSettings;
    emitter: Events;
    tooltipManager: TooltipManager;
    cacheDir: string;
    bibManager: BibManager;
    _initPromise: PromiseCapability<void>;
    statusBarIcon: HTMLElement;

    get initPromise() { if (!this._initPromise) return (this._initPromise = new PromiseCapability()); return this._initPromise; }

    async onload() {
        const { app } = this;
        pluginInstance = this;
        await this.loadSettings();
        this.applyCssStyles();

        this.registerView(viewType, (leaf: WorkspaceLeaf) => new ReferenceListView(leaf, this));
        this.registerView(VIEW_TYPE_FIGURE_NAV, (leaf: WorkspaceLeaf) => new FigureNavigatorView(leaf, this));

        this.cacheDir = path.join(getVaultRoot(), '.pandoc');
        this.emitter = new Events();
        this.bibManager = new BibManager(this);

        this.initPromise.promise.then(() => {
            if (this.settings.pullFromZotero) return this.bibManager.loadAndRefreshGlobalZBib();
            else return this.bibManager.loadGlobalBibFile();
        }).finally(() => this.bibManager.initPromise.resolve());

        this.addSettingTab(new ReferenceListSettingsTab(this));
        this.registerEditorSuggest(new CiteSuggest(app, this));
        this.registerEditorSuggest(new FigureTableSuggest(this));
        this.tooltipManager = new TooltipManager(this);
        this.registerMarkdownPostProcessor(processCiteKeys(this));

        this.registerEditorExtension([
            bibManagerField.init(() => this.bibManager),
            citeKeyCacheField,
            citeKeyPlugin,
            editorTooltipHandler(this.tooltipManager),
            pandocFigTblField
        ]);

        this.addCommand({ id: 'insert-fig-id-timestamp', name: 'Insert Figure ID (Timestamp)', editorCallback: (editor: Editor) => { editor.replaceSelection(`{#fig:${getTimestamp()}}`); } });
        this.addCommand({ id: 'insert-tbl-id-timestamp', name: 'Insert Table ID (Timestamp)', editorCallback: (editor: Editor) => { editor.replaceSelection(`{#tbl:${getTimestamp()}}`); } });
        this.addCommand({ id: 'focus-reference-list-view', name: 'Show reference list', callback: async () => { this.initLeaf(); }, });
        this.addCommand({ id: 'open-figure-navigator', name: 'Open Figure & Table Navigator', callback: async () => { this.initFigureLeaf(); }, });

        fixPath().then(async () => {
            if (!this.settings.pathToPandoc) {
                try {
                    const pathToPandoc = await which('pandoc');
                    this.settings.pathToPandoc = pathToPandoc;
                    this.saveSettings();
                } catch { }
            }
            this.initPromise.resolve();
            this.app.workspace.trigger('parse-style-settings');
        });

        document.body.toggleClass('pwc-tooltips', !!this.settings.showCitekeyTooltips);
        this.registerEvent(app.metadataCache.on('changed', debounce(async (file) => {
            await this.initPromise.promise; await this.bibManager.initPromise.promise;
            const activeView = app.workspace.getActiveViewOfType(MarkdownView);
            if (activeView && file === activeView.file) this.processReferences();
        }, 100, true)));
        this.registerEvent(app.workspace.on('active-leaf-change', debounce(async (leaf) => {
            await this.initPromise.promise; await this.bibManager.initPromise.promise;
            app.workspace.iterateRootLeaves((rootLeaf) => {
                if (rootLeaf === leaf) {
                    if (leaf.view instanceof MarkdownView) this.processReferences();
                    else this.view?.setNoContentMessage();
                }
            });
        }, 100, true)));

        (async () => {
            this.initStatusBar(); this.setStatusBarLoading();
            await this.initPromise.promise; await this.bibManager.initPromise.promise;
            this.setStatusBarIdle(); this.processReferences();
        })();
    }

    onunload() {
        document.body.removeClass('pwc-tooltips');
        this.app.workspace.getLeavesOfType(viewType).forEach((leaf) => leaf.detach());
        this.app.workspace.getLeavesOfType(VIEW_TYPE_FIGURE_NAV).forEach((leaf) => leaf.detach());
        this.bibManager.destroy();
    }

    initStatusBar() { const ico = (this.statusBarIcon = this.addStatusBarItem()); ico.addClass('pwc-status-icon', 'clickable-icon'); this.setStatusBarIdle(); }
    setStatusBarLoading() { this.statusBarIcon.addClass('is-loading'); setIcon(this.statusBarIcon, 'lucide-loader'); }
    setStatusBarIdle() { this.statusBarIcon.removeClass('is-loading'); setIcon(this.statusBarIcon, 'lucide-at-sign'); }
    get view() { return this.app.workspace.getLeavesOfType(viewType)[0]?.view as ReferenceListView; }
    async initLeaf() { if (this.view) return this.revealLeaf(viewType); await this.app.workspace.getRightLeaf(false).setViewState({ type: viewType }); this.revealLeaf(viewType); }
    async initFigureLeaf() {
        const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_FIGURE_NAV);
        if (leaves.length > 0) { this.app.workspace.revealLeaf(leaves[0]); return; }
        await this.app.workspace.getRightLeaf(false).setViewState({ type: VIEW_TYPE_FIGURE_NAV });
        this.app.workspace.revealLeaf(this.app.workspace.getLeavesOfType(VIEW_TYPE_FIGURE_NAV)[0]);
    }
    revealLeaf(type: string) { const leaves = this.app.workspace.getLeavesOfType(type); if(leaves.length) this.app.workspace.revealLeaf(leaves[0]); }
    async loadSettings() { this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData()); }
    async saveSettings(cb?: () => void) {
        document.body.toggleClass('pwc-tooltips', !!this.settings.showCitekeyTooltips);
        this.emitSettingsUpdate(cb);
        this.applyCssStyles();
        this.refreshLivePreview();
        await this.saveData(this.settings);
    }
    refreshLivePreview() {
        this.app.workspace.iterateAllLeaves((leaf) => {
            if (leaf.view instanceof MarkdownView) {
                // @ts-ignore
                const cm = leaf.view.editor.cm as EditorView;
                if(cm) cm.dispatch({ effects: [] });
            }
        });
    }
    applyCssStyles() {
        const root = document.body; const s = this.settings;
        root.style.setProperty('--pandoc-def-color', s.defColor);
        root.style.setProperty('--pandoc-def-weight', s.defBold ? 'bold' : 'normal');
        root.style.setProperty('--pandoc-def-align', s.defCenter ? 'center' : 'left');
        root.style.setProperty('--pandoc-def-offset', `${s.defVerticalOffset}px`);
        root.style.setProperty('--pandoc-ref-color', s.refColor);
        root.style.setProperty('--pandoc-ref-weight', s.refBold ? 'bold' : 'normal');
        root.style.setProperty('--pandoc-error-color', s.errorColor);
        // 【核心修改】：注入图片上方偏移变量
        root.style.setProperty('--pandoc-img-top-offset', `${s.imageTopOffset}px`);
    }
    emitSettingsUpdate = debounce((cb) => { if (this.initPromise.settled) { cb && cb(); this.processReferences(); } }, 5000, true);
    processReferences = async () => { /* ... */ };
}
