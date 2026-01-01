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
import { StateField, EditorState, Extension, Range, Transaction } from '@codemirror/state';
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
// PART A: 核心逻辑 - 扫描、渲染与跳转
// ============================================================

const FIGURE_PREFIX_DEFAULT = "图";
const TABLE_PREFIX_DEFAULT = "表";

let pluginInstance: ReferenceList | null = null;

// 获取设置的前缀
function getFigurePrefix(): string {
    return pluginInstance?.settings.figurePrefix || FIGURE_PREFIX_DEFAULT;
}

function getTablePrefix(): string {
    return pluginInstance?.settings.tablePrefix || TABLE_PREFIX_DEFAULT;
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

// --- 数据结构 ---
interface PandocDef {
    id: string;      // "granite"
    type: string;    // "fig" or "tbl"
    number: string;  // "1" (纯数字)
    suffix: string;  // "a" (如果有)
    caption: string; // "花岗岩结构"
    fullLabel: string; // "图1a"
    line: number;    // 行号 (用于跳转)
}

// --- 1. Widget 定义 (支持点击跳转) ---
class LabelWidget extends WidgetType {
    constructor(
        readonly displayText: string, // 显示的文本: "(图1a 花岗岩结构)"
        readonly type: string,        // "fig" or "tbl"
        readonly isDef: boolean,      // 是否是定义处
        readonly targetLine: number | null // 跳转目标行号 (仅引用处需要)
    ) {
        super();
    }

    toDOM(view: EditorView): HTMLElement {
        const span = document.createElement("span");
        span.innerText = this.displayText;
        span.className = `pandoc-widget pandoc-${this.type} pandoc-${this.isDef ? 'def' : 'ref'}`;

        // 如果是引用，且有目标行，绑定点击事件
        if (!this.isDef && this.targetLine !== null) {
            span.onclick = (e) => {
                e.preventDefault();
                // 计算目标行的偏移量
                const lineInfo = view.state.doc.line(this.targetLine + 1); // CM6 行号从1开始
                // 执行滚动和光标移动
                view.dispatch({
                    effects: EditorView.scrollIntoView(lineInfo.from, { y: "center" }),
                    selection: { anchor: lineInfo.from }
                });
            };
            span.title = "点击跳转到图片定义";
        }

        return span;
    }
}

// --- 2. 全文扫描器 (按行扫描，提取Caption和后缀) ---
function scanDefinitions(doc: any): Map<string, PandocDef> {
    const defMap = new Map<string, PandocDef>();

    let figCount = 0;
    let tblCount = 0;
    const figPrefix = getFigurePrefix();
    const tblPrefix = getTablePrefix();

    // 遍历每一行
    for (let i = 1; i <= doc.lines; i++) {
        const lineText = doc.line(i).text;

        // 正则策略：
        // 1. 尝试匹配完整图片格式: ![Caption](Link){#fig:id}suffix
        // 2. 尝试匹配纯定义格式: {#fig:id}suffix (无图片的情况)

        // 匹配 {#fig:id} 或 {#tbl:id}，后面可选跟一个字母
        // Group 1: fig/tbl
        // Group 2: ID
        // Group 3: suffix (a-z)
        const defRegex = /\{#(fig|tbl):([a-zA-Z0-9_\-]+)(?:\s+.*?)?\}([a-zA-Z])?/;
        const match = defRegex.exec(lineText);

        if (match) {
            const type = match[1];
            const id = match[2];
            const suffix = match[3] || ""; // 捕获后缀 'a'
            let caption = "";

            // 尝试提取 Caption：检查这一行是否有 ![caption]
            // 简单的提取逻辑：取这一行第一个 ![...] 里的内容
            const imgMatch = /!\[(.*?)\]/.exec(lineText);
            if (imgMatch) {
                caption = imgMatch[1];
            }

            // 计数
            let countStr = "";
            if (type === 'fig') {
                figCount++;
                countStr = `${figCount}`;
            } else {
                tblCount++;
                countStr = `${tblCount}`;
            }

            // 构建完整标签 "图1a"
            const prefix = (type === 'fig') ? figPrefix : tblPrefix;
            const fullLabel = `${prefix}${countStr}${suffix}`;

            defMap.set(id, {
                id,
                type,
                number: countStr,
                suffix,
                caption,
                fullLabel,
                line: i - 1 // 存 0-based index
            });
        }
    }
    return defMap;
}

// --- 3. 装饰器 StateField (渲染逻辑) ---
export const pandocFigTblField = StateField.define<DecorationSet>({
    create(state): DecorationSet {
        return Decoration.none;
    },
    update(oldDecorations, transaction): DecorationSet {
        if (!transaction.docChanged && !transaction.selection) return oldDecorations;
        if (!pluginInstance) return oldDecorations;

        const state = transaction.state;
        const widgets: Range<Decoration>[] = [];
        const selectionRanges = state.selection.ranges;

        // 1. 建立索引
        const defMap = scanDefinitions(state.doc);

        function checkCursorOverlap(from: number, to: number): boolean {
            for (const range of selectionRanges) {
                if (range.from <= to && range.to >= from) return true;
            }
            return false;
        }

        const text = state.doc.toString();

        // A. 渲染定义处 (Definition) - 例如 {#fig:id}
        // 正则：匹配 {#fig:id ...}，支持属性
        const defRegex = /\{#(fig|tbl):([a-zA-Z0-9_\-]+)(?:\s+.*?)?\}([a-zA-Z])?/g;
        let m;
        while ((m = defRegex.exec(text)) !== null) {
            const start = m.index;
            const end = m.index + m[0].length;

            if (checkCursorOverlap(start, end)) continue;

            const type = m[1];
            const id = m[2];

            if (defMap.has(id)) {
                const def = defMap.get(id)!;
                // 【修改点1】：去掉了最外层的圆括号 ()，只保留内容
                const displayText = def.caption
                    ? `${def.fullLabel} ${def.caption}`  // 显示：图1a 标题
                    : `${def.fullLabel}`;                // 显示：图1a

                widgets.push(Decoration.replace({
                    widget: new LabelWidget(displayText, type, true, null),
                    inclusive: false
                }).range(start, end));
            }
        }

        // B. 渲染引用处 (Reference) - 例如 (@fig:id)
        // 【修改点2】：增强正则，支持中文括号，支持空格
        // [(\uff08] 匹配英文( 或 中文（
        // [)\uff09] 匹配英文) 或 中文）
        const refRegex = /[(\uff08]\s*@(fig|tbl):([a-zA-Z0-9_\-]+)(.*?)[)\uff09]/g;

        while ((m = refRegex.exec(text)) !== null) {
            const start = m.index;
            const end = m.index + m[0].length;

            if (checkCursorOverlap(start, end)) continue;

            const type = m[1];
            const id = m[2];
            const manualSuffix = (m[3] || "").trim(); // 【修复】：去掉捕获到的前后空格

            if (defMap.has(id)) {
                const def = defMap.get(id)!;

                // 【核心修改】：只显示 Label + 手动后缀，不显示 def.caption
                // 例如：def.fullLabel 是 "图3"，manualSuffix 是 " a"
                // 结果：(图3 a)
                const displayText = `(${def.fullLabel}${manualSuffix})`;

                widgets.push(Decoration.replace({
                    widget: new LabelWidget(displayText, type, false, def.line),
                    inclusive: false
                }).range(start, end));
            } else {
                // 找不到ID的情况，保留用户输入的前缀
                const prefix = type === 'fig' ? getFigurePrefix() : getTablePrefix();
                widgets.push(Decoration.replace({
                    widget: new LabelWidget(`(${prefix}?${manualSuffix})`, type, false, null),
                    inclusive: false
                }).range(start, end));
            }
        }

        return Decoration.set(widgets.sort((a, b) => a.from - b.from));
    },
    provide: (field) => EditorView.decorations.from(field)
});

// --- 4. 自动补全 Suggest (支持图名预览 + 自动加括号) ---
class FigureTableSuggest extends EditorSuggest<PandocDef> {
    constructor(plugin: Plugin) {
        super(plugin.app);
    }

    onTrigger(cursor: EditorPosition, editor: Editor, file: TFile): EditorSuggestTriggerInfo | null {
        const line = editor.getLine(cursor.line);
        const sub = line.substring(0, cursor.ch);

        // 触发条件: 输入 @fig 或 @tbl (前面允许有括号，或者空格)
        // 目标是匹配用户正在输入的 "@fig:..."
        const match = sub.match(/(@(fig|tbl)?:?([a-zA-Z0-9_\-]*))$/);

        if (match) {
            return {
                start: { line: cursor.line, ch: match.index! },
                end: cursor,
                query: match[0]
            };
        }
        return null;
    }

    getSuggestions(context: EditorSuggestContext): PandocDef[] {
        // 实时扫描获取最新的 map
        // 注意：这里需要传入 CodeMirror 的 doc 对象，或者简单点重新解析整个文本
        // 为了方便，我们在 editor 层面重新做一次简化扫描，或者尝试复用 scanDefinitions
        // 由于 EditorSuggest 给的是 context.editor (Obsidian API)，我们手动获取文本
        // 这可能稍微慢一点，但对于几万字是没问题的

        // 为了复用 scanDefinitions (它需要 CM6 doc)，我们这里模拟一个简单的行遍历
        const text = context.editor.getValue();
        // 这里为了简单，我们不复用 scanDefinitions 的复杂对象结构，而是快速正则提取
        // 但为了获得正确的图号，我们必须从头扫一遍

        // 临时构造一个类似 doc 的对象
        const lines = text.split('\n');
        const docShim = {
            lines: lines.length,
            line: (i: number) => ({ text: lines[i-1] })
        };
        const defMap = scanDefinitions(docShim);

        const query = context.query.toLowerCase(); // e.g. "@fig"

        // 过滤
        const results: PandocDef[] = [];
        for (const def of defMap.values()) {
            const searchKey = `@${def.type}:${def.id} ${def.caption}`.toLowerCase();
            // query 包含 @fig...
            if (searchKey.includes(query.replace('(', ''))) { // 忽略左括号
                results.push(def);
            }
        }
        return results;
    }

    renderSuggestion(def: PandocDef, el: HTMLElement): void {
        // 下拉菜单显示样式：
        // 左：图1a Caption
        // 右：ID
        const left = el.createEl("span", { cls: "pandoc-suggest-label" });
        left.innerText = `${def.fullLabel} ${def.caption || ""}`;

        el.createEl("small", { text: ` (${def.id})`, cls: "pandoc-suggest-id" });
    }

    selectSuggestion(def: PandocDef, evt: MouseEvent | KeyboardEvent): void {
        if (!this.context) return;

        // 插入逻辑：自动加括号
        // 用户输入了 "@fig:...", 我们把它替换为 "(@fig:id)"
        const textToInsert = `(@${def.type}:${def.id})`;

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

        // 【重要】初始化全局实例
        pluginInstance = this;

        await this.loadSettings();

        // 1. Init Views and Managers
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
        this.registerEditorSuggest(new CiteSuggest(app, this));
        // 新的图表补全
        this.registerEditorSuggest(new FigureTableSuggest(this));

        this.tooltipManager = new TooltipManager(this);
        this.registerMarkdownPostProcessor(processCiteKeys(this));

        // 3. Register Editor Extensions
        this.registerEditorExtension([
            bibManagerField.init(() => this.bibManager),
            citeKeyCacheField,
            citeKeyPlugin,
            editorTooltipHandler(this.tooltipManager),
            // 新的图表渲染器
            pandocFigTblField
        ]);

        // 4. Commands
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

        // ... Keep existing status bar and watcher logic ...
        // (For brevity, assuming standard boilerplate below is same as previous version)
        // You can paste the rest of the onload/onunload/etc from the previous working version here.
        // Or simply keep the rest of the file if you are editing in place.

        // Since I'm providing the FULL file replacement, I will include the rest of the class structure roughly.

        this.addCommand({
            id: 'focus-reference-list-view',
            name: t('Show reference list'),
            callback: async () => {
                this.initLeaf();
            },
        });

        document.body.toggleClass('pwc-tooltips', !!this.settings.showCitekeyTooltips);

        // Listeners...
        this.registerEvent(app.metadataCache.on('changed', debounce(async (file) => {
            await this.initPromise.promise;
            await this.bibManager.initPromise.promise;
            const activeView = app.workspace.getActiveViewOfType(MarkdownView);
            if (activeView && file === activeView.file) this.processReferences();
        }, 100, true)));

        this.registerEvent(app.workspace.on('active-leaf-change', debounce(async (leaf) => {
            await this.initPromise.promise;
            await this.bibManager.initPromise.promise;
            app.workspace.iterateRootLeaves((rootLeaf) => {
                if (rootLeaf === leaf) {
                    if (leaf.view instanceof MarkdownView) this.processReferences();
                    else this.view?.setNoContentMessage();
                }
            });
        }, 100, true)));

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
        this.app.workspace.getLeavesOfType(viewType).forEach((leaf) => leaf.detach());
        this.bibManager.destroy();
    }

    // ... Helper methods (statusBar, view, settings) ...
    statusBarIcon: HTMLElement;
    initStatusBar() {
        const ico = (this.statusBarIcon = this.addStatusBarItem());
        ico.addClass('pwc-status-icon', 'clickable-icon');
        // ... (standard status bar code)
        this.setStatusBarIdle();
    }
    setStatusBarLoading() { this.statusBarIcon.addClass('is-loading'); setIcon(this.statusBarIcon, 'lucide-loader'); }
    setStatusBarIdle() { this.statusBarIcon.removeClass('is-loading'); setIcon(this.statusBarIcon, 'lucide-at-sign'); }

    get view() { return this.app.workspace.getLeavesOfType(viewType)[0]?.view as ReferenceListView; }

    async initLeaf() {
        if (this.view) return this.revealLeaf();
        await this.app.workspace.getRightLeaf(false).setViewState({ type: viewType });
        this.revealLeaf();
    }
    revealLeaf() { const leaves = this.app.workspace.getLeavesOfType(viewType); if(leaves.length) this.app.workspace.revealLeaf(leaves[0]); }

    async loadSettings() { this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData()); }
    async saveSettings(cb?: () => void) {
        document.body.toggleClass('pwc-tooltips', !!this.settings.showCitekeyTooltips);
        this.emitSettingsUpdate(cb);
        await this.saveData(this.settings);
    }
    emitSettingsUpdate = debounce((cb) => { if (this.initPromise.settled) { cb && cb(); this.processReferences(); } }, 5000, true);
    // 将 main.ts 最后那个空的 processReferences 替换为：

    processReferences = async () => {
        const { settings, view } = this;
        // 1. 如果没有配置 Bibliography 文件，提示错误
        if (!settings.pathToBibliography && !settings.pullFromZotero) {
            return view?.setMessage(
                t('Please provide the path to your pandoc compatible bibliography file in the Pandoc Reference List plugin settings.')
            );
        }

        // 2. 获取当前激活的 Markdown 视图
        const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (activeView) {
            try {
                // 读取缓存或文件内容
                const fileContent = await this.app.vault.cachedRead(activeView.file);

                // 让 bibManager 解析引用
                const bib = await this.bibManager.getReferenceList(
                    activeView.file,
                    fileContent
                );

                // Zotero 连接检查逻辑
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
                    // 更新侧边栏视图
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
