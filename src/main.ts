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
    ItemView,
    Notice
} from 'obsidian';
import which from 'which';
import { StateField, Extension, Range } from '@codemirror/state';
import { Decoration, DecorationSet, EditorView, WidgetType } from '@codemirror/view';
import path from 'path';

// 内部模块导入
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
import { BibManager } from './bib/bibManager';
import { CiteSuggest } from './citeSuggest/citeSuggest';
import { isZoteroRunning } from './bib/helpers';

// ============================================================
// #region 1. 常量与接口定义 (Constants & Interfaces)
// ============================================================

const FIGURE_PREFIX_DEFAULT = "图";
const TABLE_PREFIX_DEFAULT = "表";
const VIEW_TYPE_FIGURE_NAV = "pandoc-figure-navigator";

let pluginInstance: ReferenceList | null = null;

// 辅助获取前缀
function getFigurePrefix(): string { return pluginInstance?.settings.figurePrefix || FIGURE_PREFIX_DEFAULT; }
function getTablePrefix(): string { return pluginInstance?.settings.tablePrefix || TABLE_PREFIX_DEFAULT; }
function getTimestamp(): string {
    const now = new Date();
    return `${now.getFullYear()}${(now.getMonth()+1).toString().padStart(2,'0')}${now.getDate().toString().padStart(2,'0')}${now.getHours().toString().padStart(2,'0')}${now.getMinutes().toString().padStart(2,'0')}`;
}

// 核心数据结构：Pandoc 定义对象
interface PandocDef {
    id: string;          // 唯一ID (e.g. "my-fig")
    type: string;        // 类型: "fig" | "tbl"
    number: string;      // 编号: "1", "2"
    suffix: string;      // 后缀 (a, b...)
    caption: string;     // 标题文字
    fullLabel: string;   // 完整标签 (e.g. "图1")
    line: number;        // 所在行号 (0-based)
    usageCount: number;  // 被引用次数
}

interface ScanResult {
    defs: Map<string, PandocDef>;
    refIds: Set<string>;
}

// #endregion

// ============================================================
// #region 2. 核心渲染组件 (Widgets)
// ============================================================

/**
 * LabelWidget: 在编辑器中替代源码显示的组件 (例如显示为 "图1")
 */
class LabelWidget extends WidgetType {
    constructor(
        readonly displayText: string,
        readonly type: string,
        readonly isDef: boolean,
        readonly targetLine: number | null,
        readonly isError: boolean
    ) { super(); }

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

        // CSS 类名组合: pandoc-widget pandoc-fig pandoc-def
        span.className = `pandoc-widget pandoc-${this.type} pandoc-${this.isDef ? 'def' : 'ref'} ${errorClass}`;

        if (this.isError) {
            span.style.color = pluginInstance?.settings.errorColor || '#d32f2f';
            if (this.isDef) span.style.fontWeight = 'bold';
        }

        // 点击跳转逻辑 (仅针对引用)
        if (!this.isDef && this.targetLine !== null && pluginInstance?.settings.enableClickToJump) {
            span.style.cursor = "pointer";
            span.onmousedown = (e) => {
                e.preventDefault(); e.stopPropagation();
                const lineInfo = view.state.doc.line(this.targetLine + 1);
                view.dispatch({ effects: EditorView.scrollIntoView(lineInfo.from, { y: "center" }), selection: { anchor: lineInfo.from } });
            };
        }
        return span;
    }
}

// #endregion

// ============================================================
// #region 3. 文档扫描逻辑 (Scanner)
// ============================================================

/**
 * 扫描整个文档，提取 {#fig:id} 和 {#tbl:id} 定义以及引用
 */
function scanDocument(doc: any): ScanResult {
    const defMap = new Map<string, PandocDef>();
    const refIds = new Set<string>();
    let figCount = 0;
    let tblCount = 0;
    const figPrefix = getFigurePrefix();
    const tblPrefix = getTablePrefix();

    for (let i = 1; i <= doc.lines; i++) {
        const lineText = doc.line(i).text;

        // 匹配定义: {#type:id}
        const defRegex = /\{#(fig|tbl):([a-zA-Z0-9_\-]+)(?:\s+.*?)?\}([a-zA-Z])?/;
        const match = defRegex.exec(lineText);

        if (match) {
            const type = match[1];
            const id = match[2];
            const suffix = match[3] || "";
            let caption = "";

            if (type === 'fig') {
                // 图片标题提取: ![caption]
                const imgMatch = /!\[(.*?)\]/.exec(lineText);
                if (imgMatch) caption = imgMatch[1];
            } else {
                // 表格标题提取: : caption {#tbl:id}
                const tblMatch = /^\s*:?\s*(.*?)\s*\{#/.exec(lineText);
                if (tblMatch) caption = tblMatch[1];
            }

            // 计数逻辑
            let countStr = "";
            if (type === 'fig') { figCount++; countStr = `${figCount}`; }
            else { tblCount++; countStr = `${tblCount}`; }

            // 存入 Map
            defMap.set(id, {
                id, type, number: countStr, suffix, caption,
                fullLabel: `${(type === 'fig' ? figPrefix : tblPrefix)}${countStr}${suffix}`,
                line: i - 1,
                usageCount: 0
            });
        }

        // 统计引用: @fig:id 或 @tbl:id
        const refGlobalRegex = /@(fig|tbl):([a-zA-Z0-9_\-]+)/g;
        let refMatch;
        while ((refMatch = refGlobalRegex.exec(lineText)) !== null) {
            refIds.add(refMatch[2]);
        }
    }

    // 更新引用计数 (用于孤儿检测)
    refIds.forEach(refId => {
        if (defMap.has(refId)) defMap.get(refId)!.usageCount++;
    });

    return { defs: defMap, refIds };
}

// #endregion

// ============================================================
// #region 4. 编辑器扩展 (CodeMirror Extension)
// ============================================================

/**
 * 装饰器: 负责将源码替换为 Widget (Live Preview 核心逻辑)
 */
export const pandocFigTblField = StateField.define<DecorationSet>({
    create(state): DecorationSet { return Decoration.none; },
    update(oldDecorations, transaction): DecorationSet {
        // 性能优化: 只有文档变动或选区变动时才重绘
        if (!transaction.docChanged && !transaction.selection) return oldDecorations;
        if (!pluginInstance) return oldDecorations;

        const state = transaction.state;
        const widgets: Range<Decoration>[] = [];
        const { defs } = scanDocument(state.doc);
        const enableCheck = pluginInstance.settings.enableIntegrityCheck;
        const text = state.doc.toString();
        const selection = state.selection;

        // 辅助函数: 检查光标是否在范围内 (点击即展开)
        const isCursorInside = (from: number, to: number) => {
            return selection.ranges.some(range => range.from <= to && range.to >= from);
        };

        // --- A. 处理定义 (Definitions) ---
        const defRegex = /\{#(fig|tbl):([a-zA-Z0-9_\-]+)(?:\s+.*?)?\}([a-zA-Z])?/g;
        let m;
        while ((m = defRegex.exec(text)) !== null) {
            let start = m.index;
            const end = m.index + m[0].length;
            const type = m[1];
            const id = m[2];

            // 特殊处理: 表格需要把前面的 "冒号+标题" 也包含进隐藏范围
            if (type === 'tbl') {
                const lineObj = state.doc.lineAt(start);
                const textBefore = text.slice(lineObj.from, start);

                const colonIndex = textBefore.indexOf(':');
                if (colonIndex !== -1) {
                    start = lineObj.from + colonIndex;
                } else if (textBefore.trim().length > 0) {
                    start = lineObj.from + textBefore.search(/\S/);
                }
            }

            // 如果光标在范围内，不渲染 Widget (显示源码供编辑)
            if (isCursorInside(start, end)) continue;

            if (defs.has(id)) {
                const def = defs.get(id)!;
                widgets.push(Decoration.replace({
                    widget: new LabelWidget(
                        `${def.fullLabel} ${def.caption}`,
                        type, true, null,
                        enableCheck && def.usageCount === 0 // 孤儿检测
                    ),
                    inclusive: false
                }).range(start, end));
            }
        }

        // --- B. 处理引用 (References) ---
        const refRegex = /[(\uff08]\s*@(fig|tbl):([a-zA-Z0-9_\-]+)(.*?)[)\uff09]/g;
        while ((m = refRegex.exec(text)) !== null) {
            const start = m.index;
            const end = m.index + m[0].length;

            if (isCursorInside(start, end)) continue;

            const def = defs.get(m[2]);
            if (def) {
                // 正常引用
                widgets.push(Decoration.replace({
                    widget: new LabelWidget(`(${def.fullLabel}${m[3]||""})`, m[1], false, def.line, false),
                    inclusive: false
                }).range(start, end));
            } else {
                // 断链引用 (红色问号)
                widgets.push(Decoration.replace({
                    widget: new LabelWidget(
                        `(${m[1]==='fig'?getFigurePrefix():getTablePrefix()}?${m[3]||""})`,
                        m[1], false, null, enableCheck
                    ),
                    inclusive: false
                }).range(start, end));
            }
        }
        return Decoration.set(widgets.sort((a, b) => a.from - b.from));
    },
    provide: (field) => EditorView.decorations.from(field)
});

/**
 * 自动补全 Suggest
 */
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
        return Array.from(defs.values()).filter(d =>
            (`@${d.type}:${d.id} ${d.caption}`.toLowerCase()).includes(context.query.toLowerCase().replace('(',''))
        );
    }

    renderSuggestion(def: PandocDef, el: HTMLElement): void {
        el.createEl("span", { text: `${def.fullLabel} ${def.caption || ""} `, cls: "pandoc-suggest-label" });
        el.createEl("small", { text: `(${def.id})`, cls: "pandoc-suggest-id" });
    }

    selectSuggestion(def: PandocDef, evt: MouseEvent | KeyboardEvent): void {
        const useBrackets = this.plugin.settings.enableAutoBrackets;
        const insertText = (useBrackets) ? `(@${def.type}:${def.id})` : `@${def.type}:${def.id}`;
        this.context!.editor.replaceRange(insertText, this.context!.start, this.context!.end);
    }
}

// #endregion

// ============================================================
// #region 5. 侧边栏视图 (Sidebar View)
// ============================================================

class FigureNavigatorView extends ItemView {
    plugin: ReferenceList;
    constructor(leaf: WorkspaceLeaf, plugin: ReferenceList) { super(leaf); this.plugin = plugin; }

    getViewType() { return VIEW_TYPE_FIGURE_NAV; }
    getDisplayText() { return "Figures & Tables"; }
    getIcon() { return "image"; } // 侧边栏图标

    async onOpen() {
        this.updateView();
        // 注册事件监听，保持视图同步
        this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.updateView()));
        this.registerEvent(this.app.workspace.on('editor-change', debounce(() => this.updateView(), 300, true)));
        this.registerEvent(this.app.workspace.on('layout-change', () => this.updateView()));
    }

    updateView() {
        const container = this.contentEl;

        // 查找活跃视图逻辑 (fallback to first leaf if null)
        let activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!activeView) {
            const leaves = this.app.workspace.getLeavesOfType("markdown");
            if (leaves.length > 0) activeView = leaves[0].view as MarkdownView;
        }

        if (!activeView) {
            container.empty();
            container.createEl("div", { text: "Open a markdown file to see figures.", cls: "pandoc-no-content" });
            return;
        }

        // 重新扫描当前文档
        container.empty();
        const docShim = { lines: activeView.editor.lineCount(), line: (i: number) => ({ text: activeView.editor.getLine(i - 1) }) };
        const { defs } = scanDocument(docShim);

        if (defs.size === 0) {
            container.createEl("div", { text: "No figures or tables found.", cls: "pandoc-no-content" });
            return;
        }

        // 渲染列表
        const list = container.createDiv({ cls: "pandoc-nav-container" });
        const enableCheck = this.plugin.settings.enableIntegrityCheck;
        const errorColor = this.plugin.settings.errorColor;

        defs.forEach(def => {
            const item = list.createDiv({ cls: "pandoc-nav-item" });
            const isOrphan = enableCheck && def.usageCount === 0;

            if (isOrphan) {
                item.addClass("is-orphan");
                item.style.color = errorColor;
            }

            const textSpan = item.createSpan({ cls: "pandoc-nav-text" });
            textSpan.innerText = `${def.fullLabel} ${def.caption || ""}`;
            item.title = isOrphan ? "Unused Figure (Orphan)" : "Click to jump";

            // 点击跳转逻辑
            item.onclick = () => {
                const currentView = this.app.workspace.getActiveViewOfType(MarkdownView) || (this.app.workspace.getLeavesOfType("markdown")[0]?.view as MarkdownView);
                if (currentView) {
                    this.app.workspace.setActiveLeaf(currentView.leaf, { focus: true });
                    setTimeout(() => {
                        currentView.editor.setCursor(def.line, 0);
                        currentView.editor.scrollIntoView({
                            from: { line: def.line, ch: 0 },
                            to: { line: def.line, ch: 0 }
                        }, true);
                    }, 10);
                }
            };
        });
    }
    async onClose() {}
}

// #endregion

// ============================================================
// #region 6. 主插件类 (Main Plugin Class)
// ============================================================

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

        // 1. 加载设置与样式
        await this.loadSettings();
        this.applyCssStyles();
        this.injectCustomStyles(); // 注入侧边栏 CSS

        // 2. 注册视图
        this.registerView(viewType, (leaf: WorkspaceLeaf) => new ReferenceListView(leaf, this));
        this.registerView(VIEW_TYPE_FIGURE_NAV, (leaf: WorkspaceLeaf) => new FigureNavigatorView(leaf, this));

        // 3. 初始化管理器
        this.cacheDir = path.join(getVaultRoot(), '.pandoc');
        this.emitter = new Events();
        this.bibManager = new BibManager(this);

        this.initPromise.promise.then(() => {
            if (this.settings.pullFromZotero) return this.bibManager.loadAndRefreshGlobalZBib();
            else return this.bibManager.loadGlobalBibFile();
        }).finally(() => this.bibManager.initPromise.resolve());

        // 4. 注册界面组件
        this.addSettingTab(new ReferenceListSettingsTab(this));
        this.registerEditorSuggest(new CiteSuggest(app, this));
        this.registerEditorSuggest(new FigureTableSuggest(this));
        this.tooltipManager = new TooltipManager(this);
        this.registerMarkdownPostProcessor(processCiteKeys(this));

        // 5. 注册编辑器扩展
        this.registerEditorExtension([
            bibManagerField.init(() => this.bibManager),
            citeKeyCacheField,
            citeKeyPlugin,
            editorTooltipHandler(this.tooltipManager),
            pandocFigTblField
        ]);

        // 6. 系统路径修正与初始化
        fixPath().then(async () => {
            if (!this.settings.pathToPandoc) {
                try { const p = await which('pandoc'); this.settings.pathToPandoc = p; this.saveSettings(); } catch {}
            }
            this.initPromise.resolve();
            this.app.workspace.trigger('parse-style-settings');
        });

        // 7. 注册命令
        this.addCommand({ id: 'focus-reference-list-view', name: t('Show reference list'), callback: async () => this.initLeaf() });
        this.addCommand({ id: 'open-figure-navigator', name: 'Open Figure Navigator', callback: async () => this.initFigureLeaf() });
        this.addCommand({ id: 'insert-fig-timestamp', name: 'Insert Figure ID (Timestamp)', editorCallback: (e) => e.replaceSelection(`{#fig:${getTimestamp()}}`) });

        // 8. 全局事件监听
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
                    if (leaf.view instanceof MarkdownView) {
                        this.processReferences();
                    } else {
                        if (this.view && typeof this.view.setNoContentMessage === 'function') {
                            this.view.setNoContentMessage();
                        }
                    }
                }
            });
        }, 100, true)));

        // 9. 状态栏初始化
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
        const styleEl = document.getElementById('pandoc-ref-list-custom-styles');
        if (styleEl) styleEl.remove();
        this.app.workspace.getLeavesOfType(viewType).forEach((leaf) => leaf.detach());
        this.app.workspace.getLeavesOfType(VIEW_TYPE_FIGURE_NAV).forEach((leaf) => leaf.detach());
        this.bibManager.destroy();
    }

    // 注入动态侧边栏样式
    injectCustomStyles() {
        const styleId = 'pandoc-ref-list-custom-styles';
        if (document.getElementById(styleId)) return;
        const styleEl = document.createElement('style');
        styleEl.id = styleId;
        styleEl.textContent = `
            .pandoc-nav-container { padding: 10px; }
            .pandoc-nav-item { 
                padding: 4px 8px; cursor: pointer; border-radius: 4px; 
                display: flex; align-items: center; margin-bottom: 2px;
            }
            .pandoc-nav-item:hover { background-color: var(--background-modifier-hover); }
            .pandoc-nav-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
            .pandoc-no-content { padding: 20px; text-align: center; color: var(--text-muted); }
            .pandoc-error { text-decoration: underline wavy var(--pandoc-error-color); }
        `;
        document.head.appendChild(styleEl);
    }

    initStatusBar() {
        const ico = (this.statusBarIcon = this.addStatusBarItem());
        ico.addClass('pwc-status-icon', 'clickable-icon');
        ico.setAttr('aria-label', t('Pandoc reference list settings'));
        this.setStatusBarIdle();

        ico.addEventListener('click', (e) => {
            const menu = new Menu();
            menu.addItem((item) => item.setTitle("Reference List Settings").setIcon('settings').onClick(() => {
                // @ts-ignore
                this.app.setting.open();
                // @ts-ignore
                this.app.setting.openTabById(this.manifest.id);
            }));
            menu.addItem((item) => item.setTitle("Refresh Bibliography").setIcon('refresh-cw').onClick(() => {
                this.bibManager.reinit(true);
                this.processReferences();
                new Notice("Refreshed");
            }));
            menu.addItem((item) => item.setTitle("Show Figure Navigator").setIcon('image').onClick(() => this.initFigureLeaf()));
            menu.showAtPosition({ x: e.clientX, y: e.clientY });
        });

        ico.addEventListener('contextmenu', (e) => { e.preventDefault(); this.initLeaf(); });
    }

    setStatusBarLoading() { this.statusBarIcon.addClass('is-loading'); setIcon(this.statusBarIcon, 'lucide-loader'); }
    setStatusBarIdle() { this.statusBarIcon.removeClass('is-loading'); setIcon(this.statusBarIcon, 'lucide-at-sign'); }

    get view() { return this.app.workspace.getLeavesOfType(viewType)[0]?.view as ReferenceListView; }

    async initLeaf() {
        if (this.view) return this.revealLeaf(viewType);
        await this.app.workspace.getRightLeaf(false).setViewState({ type: viewType });
        this.revealLeaf(viewType);
        this.processReferences();
    }

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

    // 将设置应用到 CSS 变量
    applyCssStyles() {
        const root = document.body; const s = this.settings;

        // 1. Figure Styles
        root.style.setProperty('--pandoc-def-color', s.defColor);
        root.style.setProperty('--pandoc-def-weight', s.defBold ? 'bold' : 'normal');
        root.style.setProperty('--pandoc-def-align', s.defCenter ? 'center' : 'left');
        root.style.setProperty('--pandoc-def-offset', `${s.defVerticalOffset}px`);
        root.style.setProperty('--pandoc-img-top-offset', `${s.imageTopOffset}px`);
        root.style.setProperty('--pandoc-ref-color', s.refColor);
        root.style.setProperty('--pandoc-ref-weight', s.refBold ? 'bold' : 'normal');

        // 2. Table Styles
        root.style.setProperty('--pandoc-tbl-top-offset', `${s.tableTopOffset}px`);
        root.style.setProperty('--pandoc-tbl-caption-offset', `${s.tableCaptionOffset}px`);
        root.style.setProperty('--pandoc-tbl-def-color', s.tableDefColor);
        root.style.setProperty('--pandoc-tbl-def-weight', s.tableDefBold ? 'bold' : 'normal');
        root.style.setProperty('--pandoc-tbl-ref-color', s.tableRefColor);
        root.style.setProperty('--pandoc-tbl-ref-weight', s.tableRefBold ? 'bold' : 'normal');

        // 3. Error Styles
        root.style.setProperty('--pandoc-error-color', s.errorColor);
    }

    emitSettingsUpdate = debounce((cb?: () => void) => {
        if (this.initPromise.settled) {
            this.view?.contentEl.toggleClass('collapsed-links', !!this.settings.hideLinks);
            cb && cb();
            this.processReferences();
        }
    }, 5000, true);

    processReferences = async () => {
        const { settings, view } = this;
        if (!settings.pathToBibliography && !settings.pullFromZotero) {
            if (view && typeof view.setMessage === 'function') return view.setMessage(t('Please provide the path to your bibliography file.'));
            return;
        }

        const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (activeView) {
            try {
                const fileContent = await this.app.vault.cachedRead(activeView.file);
                const bib = await this.bibManager.getReferenceList(activeView.file, fileContent);
                const cache = this.bibManager.fileCache.get(activeView.file);
                if (!bib && cache?.source === this.bibManager && settings.pullFromZotero && !(await isZoteroRunning(settings.zoteroPort)) && this.bibManager.fileCache.get(activeView.file)?.keys.size) {
                    if (view && typeof view.setMessage === 'function') view.setMessage(t('Cannot connect to Zotero'));
                } else {
                    if (view && typeof view.setViewContent === 'function') view.setViewContent(bib);
                    else if (view && typeof (view as any).update === 'function') (view as any).update(bib);
                }
            } catch (e) { console.error(e); }
        } else {
            if (view && typeof view.setNoContentMessage === 'function') view.setNoContentMessage();
        }

        this.refreshLivePreview();
    };
}
// #endregion
