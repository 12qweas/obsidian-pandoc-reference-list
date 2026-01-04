import { Notice, PluginSettingTab, Setting, TextComponent } from 'obsidian';
import which from 'which';
import { t } from './lang/helpers';
import ReferenceList from './main';
import ReactDOM from 'react-dom';
import React from 'react';
import { SettingItem } from './settings/SettingItem';
import AsyncSelect from 'react-select/async';
import {
    NoOptionMessage,
    customSelectStyles,
    loadCSLLangOptions,
    loadCSLOptions,
} from './settings/select.helpers';
import { cslListRaw } from './bib/cslList';
import { ZoteroPullSetting } from './settings/ZoteroPullSetting';

export interface ReferenceListSettings {
    // === 原有文献设置 ===
    pathToPandoc: string;
    pathToBibliography?: string;
    cslStyleURL?: string;
    cslStylePath?: string;
    cslLang?: string;

    hideLinks?: boolean;
    renderCitations?: boolean;
    renderCitationsReadingMode?: boolean;
    renderLinkCitations?: boolean;

    showCitekeyTooltips?: boolean;
    tooltipDelay: number;
    enableCiteKeyCompletion?: boolean;

    pullFromZotero?: boolean;
    zoteroPort?: string;
    zoteroGroups: ZoteroGroup[];

    // === 图表设置 ===
    figurePrefix: string;
    tablePrefix: string;

    // 图片样式
    defColor: string;
    defBold: boolean;
    defCenter: boolean;
    defVerticalOffset: number;
    imageTopOffset: number;

    // 表格样式
    tableTopOffset: number;
    tableCaptionOffset: number;
    tableDefColor: string;
    tableDefBold: boolean;
    tableRefColor: string;
    tableRefBold: boolean;

    // 图片引用样式 (复用旧变量名以兼容)
    refColor: string;
    refBold: boolean;

    // 交互与校验
    enableClickToJump: boolean;
    enableAutoBrackets: boolean;
    enableIntegrityCheck: boolean;
    errorColor: string;
}

export interface ZoteroGroup {
    id: number;
    name: string;
    lastUpdate?: number;
}

export const DEFAULT_SETTINGS: ReferenceListSettings = {
    pathToPandoc: '',
    tooltipDelay: 400,
    zoteroGroups: [],

    hideLinks: false,
    renderCitations: true,
    renderCitationsReadingMode: true,
    renderLinkCitations: true,

    figurePrefix: '图',
    tablePrefix: '表',

    // 图片默认
    defColor: '#1e88e5',
    defBold: true,
    defCenter: true,
    defVerticalOffset: -15,
    imageTopOffset: -25,
    refColor: '#1565c0',
    refBold: false,

    // 表格默认
    tableTopOffset: -10,
    tableCaptionOffset: 0,
    tableDefColor: '#ef6c00',
    tableDefBold: true,
    tableRefColor: '#ef6c00',
    tableRefBold: false,

    enableClickToJump: true,
    enableAutoBrackets: true,

    enableIntegrityCheck: true,
    errorColor: '#d32f2f',
};

export class ReferenceListSettingsTab extends PluginSettingTab {
    plugin: ReferenceList;
    // 状态变量：当前激活的 Tab，默认为 'bib' (文献)
    activeTab: 'bib' | 'fig' = 'bib';

    constructor(plugin: ReferenceList) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        // ============================================================
        // 0. TAB 导航栏 (Tab Navigation)
        // ============================================================
        const tabContainer = containerEl.createDiv('pwc-settings-tabs');
        tabContainer.style.display = 'flex';
        tabContainer.style.borderBottom = '1px solid var(--background-modifier-border)';
        tabContainer.style.marginBottom = '20px';
        tabContainer.style.paddingBottom = '10px';
        tabContainer.style.gap = '20px';

        const btnBib = tabContainer.createEl('button', { text: '📚 Bibliography' });
        const btnFig = tabContainer.createEl('button', { text: '🖼️ Figures & Tables' });

        // 样式：激活状态高亮
        const activeStyle = 'background-color: var(--interactive-accent); color: var(--text-on-accent);';
        const inactiveStyle = 'background-color: transparent;';

        btnBib.setAttribute('style', this.activeTab === 'bib' ? activeStyle : inactiveStyle);
        btnFig.setAttribute('style', this.activeTab === 'fig' ? activeStyle : inactiveStyle);

        btnBib.onclick = () => { this.activeTab = 'bib'; this.display(); };
        btnFig.onclick = () => { this.activeTab = 'fig'; this.display(); };

        // ============================================================
        // 根据 activeTab 渲染不同内容
        // ============================================================
        if (this.activeTab === 'bib') {
            this.displayBibliographySettings(containerEl);
        } else {
            this.displayFigureTableSettings(containerEl);
        }
    }

    // ============================================================
    // TAB 1: 文献设置 (Bibliography Settings)
    // ============================================================
    displayBibliographySettings(containerEl: HTMLElement) {
        containerEl.createEl('h3', { text: 'Bibliography & Citations' });

        new Setting(containerEl)
            .setName(t('Fallback path to Pandoc'))
            .setDesc(t("The absolute path to the Pandoc executable."))
            .then((setting) => {
                let input: TextComponent;
                setting.addText((text) => {
                    input = text;
                    text.setValue(this.plugin.settings.pathToPandoc).onChange((value) => {
                        this.plugin.settings.pathToPandoc = value;
                        this.plugin.saveSettings();
                    });
                });
                setting.addExtraButton((b) => {
                    b.setIcon('magnifying-glass');
                    b.setTooltip(t('Attempt to find Pandoc automatically'));
                    b.onClick(() => {
                        which('pandoc').then((path) => {
                            if (path) {
                                input.setValue(path);
                                this.plugin.settings.pathToPandoc = path;
                                this.plugin.saveSettings();
                            } else {
                                new Notice(t('Unable to find pandoc on your system.'));
                            }
                        }).catch((e) => console.error(e));
                    });
                });
            });

        new Setting(containerEl)
            .setName(t('Path to bibliography file'))
            .setDesc(t('The absolute path to your desired bibliography file.'))
            .then((setting) => {
                let input: TextComponent;
                setting.addText((text) => {
                    input = text;
                    text.setValue(this.plugin.settings.pathToBibliography).onChange((value) => {
                        const prev = this.plugin.settings.pathToBibliography;
                        this.plugin.settings.pathToBibliography = value;
                        this.plugin.saveSettings(() => {
                            this.plugin.bibManager.clearWatcher(prev);
                            this.plugin.bibManager.reinit(true);
                        });
                    });
                });
                setting.addExtraButton((b) => {
                    b.setIcon('folder');
                    b.onClick(() => {
                        const path = require('electron').remote.dialog.showOpenDialogSync({ properties: ['openFile'] });
                        if (path && path.length) {
                            input.setValue(path[0]);
                            this.plugin.settings.pathToBibliography = path[0];
                            this.plugin.saveSettings(() => this.plugin.bibManager.reinit(true));
                        }
                    });
                });
            });

        ReactDOM.render(
            <ZoteroPullSetting plugin={this.plugin} />,
            containerEl.createDiv('setting-item pwc-setting-item-wrapper')
        );

        const defaultStyle = cslListRaw.find(item => item.value === this.plugin.settings.cslStyleURL);
        ReactDOM.render(
            <SettingItem name={t('Citation style')}>
                <AsyncSelect
                    noOptionsMessage={NoOptionMessage}
                    placeholder={t('Search...')}
                    cacheOptions
                    className="pwc-multiselect"
                    defaultValue={defaultStyle}
                    loadOptions={loadCSLOptions}
                    isClearable
                    onChange={(selection: any) => {
                        this.plugin.settings.cslStyleURL = selection?.value;
                        this.plugin.saveSettings(() => this.plugin.bibManager.reinit(false));
                    }}
                    styles={customSelectStyles}
                />
            </SettingItem>,
            containerEl.createDiv('pwc-setting-item setting-item')
        );

        new Setting(containerEl)
            .setName(t('Show citekey suggestions'))
            .addToggle(t => t.setValue(!!this.plugin.settings.enableCiteKeyCompletion).onChange(v => { this.plugin.settings.enableCiteKeyCompletion = v; this.plugin.saveSettings(); }));

        new Setting(containerEl)
            .setName(t('Show citekey tooltips'))
            .addToggle(t => t.setValue(!!this.plugin.settings.showCitekeyTooltips).onChange(v => { this.plugin.settings.showCitekeyTooltips = v; this.plugin.saveSettings(); }));

        new Setting(containerEl)
            .setName(t('Tooltip delay'))
            .setDesc(t('Set the amount of time (in milliseconds) to wait before displaying tooltips.'))
            .addSlider((slider) => {
                slider
                    .setDynamicTooltip()
                    .setLimits(0, 5000, 100)
                    .setValue(this.plugin.settings.tooltipDelay)
                    .onChange((value) => {
                        this.plugin.settings.tooltipDelay = value;
                        this.plugin.saveSettings();
                    });
            });

        new Setting(containerEl).setName(t('Hide links in references')).setDesc(t('Replace links with link icons to save space.')).addToggle(t => t.setValue(!!this.plugin.settings.hideLinks).onChange(v => { this.plugin.settings.hideLinks = v; this.plugin.saveSettings(); }));
        new Setting(containerEl).setName(t('Render live preview inline citations')).setDesc(t('Convert [@pandoc] citations to formatted inline citations in live preview mode.')).addToggle(t => t.setValue(!!this.plugin.settings.renderCitations).onChange(v => { this.plugin.settings.renderCitations = v; this.plugin.saveSettings(); }));
        new Setting(containerEl).setName(t('Render reading mode inline citations')).setDesc(t('Convert [@pandoc] citations to formatted inline citations in reading mode.')).addToggle(t => t.setValue(!!this.plugin.settings.renderCitationsReadingMode).onChange(v => { this.plugin.settings.renderCitationsReadingMode = v; this.plugin.saveSettings(); }));
        new Setting(containerEl).setName(t('Process citations in links')).setDesc(t('Include [[@pandoc]] citations in the reference list and format them as inline citations in live preview mode.')).addToggle(t => t.setValue(!!this.plugin.settings.renderLinkCitations).onChange(v => { this.plugin.settings.renderLinkCitations = v; this.plugin.saveSettings(); }));
    }

    // ============================================================
    // TAB 2: 图表设置 (Figures & Tables Settings)
    // ============================================================
    displayFigureTableSettings(containerEl: HTMLElement) {

        // --- 1. Prefixes ---
        containerEl.createEl('h3', { text: '1. Prefix Configuration' });
        new Setting(containerEl).setName('Figure Prefix').addText(text => text.setPlaceholder('图').setValue(this.plugin.settings.figurePrefix).onChange(async (value) => { this.plugin.settings.figurePrefix = value; await this.plugin.saveSettings(); this.plugin.app.workspace.trigger('parse-style-settings'); }));
        new Setting(containerEl).setName('Table Prefix').addText(text => text.setPlaceholder('表').setValue(this.plugin.settings.tablePrefix).onChange(async (value) => { this.plugin.settings.tablePrefix = value; await this.plugin.saveSettings(); this.plugin.app.workspace.trigger('parse-style-settings'); }));

        // --- 2. Figure Style (A) ---
        containerEl.createEl('h3', { text: '2. Figure Visual Style' });

        new Setting(containerEl)
            .setName('Figure Definition Color')
            .setDesc('Color for the caption label (e.g. Fig. 1).')
            .addColorPicker(color => color.setValue(this.plugin.settings.defColor).onChange(async (value) => { this.plugin.settings.defColor = value; await this.plugin.saveSettings(); this.plugin.applyCssStyles(); }));

        new Setting(containerEl)
            .setName('Bold Figure Definition')
            .addToggle(toggle => toggle.setValue(this.plugin.settings.defBold).onChange(async (value) => { this.plugin.settings.defBold = value; await this.plugin.saveSettings(); this.plugin.applyCssStyles(); }));

        new Setting(containerEl)
            .setName('Center Figure Definition')
            .addToggle(toggle => toggle.setValue(this.plugin.settings.defCenter).onChange(async (value) => { this.plugin.settings.defCenter = value; await this.plugin.saveSettings(); this.plugin.applyCssStyles(); }));

        new Setting(containerEl)
            .setName('Figure Caption Offset')
            .setDesc('Distance between image and caption (Vertical Offset).')
            .addSlider(slider => slider.setLimits(-50, 10, 1).setValue(this.plugin.settings.defVerticalOffset).setDynamicTooltip().onChange(async (value) => { this.plugin.settings.defVerticalOffset = value; await this.plugin.saveSettings(); this.plugin.applyCssStyles(); }));

        new Setting(containerEl)
            .setName('Figure Top Offset')
            .setDesc('Distance between text above and the image (Fix Empty Lines).')
            .addSlider(slider => slider.setLimits(-100, 0, 1).setValue(this.plugin.settings.imageTopOffset).setDynamicTooltip().onChange(async (value) => { this.plugin.settings.imageTopOffset = value; await this.plugin.saveSettings(); this.plugin.applyCssStyles(); }));

        // --- 3. Table Style (B - Symmetric to A) ---
        containerEl.createEl('h3', { text: '3. Table Visual Style' });

        new Setting(containerEl)
            .setName('Table Definition Color')
            .setDesc('Color for the caption label (e.g. Tab. 1).')
            .addColorPicker(color => color.setValue(this.plugin.settings.tableDefColor).onChange(async (value) => { this.plugin.settings.tableDefColor = value; await this.plugin.saveSettings(); this.plugin.applyCssStyles(); }));

        new Setting(containerEl)
            .setName('Bold Table Definition')
            .addToggle(toggle => toggle.setValue(this.plugin.settings.tableDefBold).onChange(async (value) => { this.plugin.settings.tableDefBold = value; await this.plugin.saveSettings(); this.plugin.applyCssStyles(); }));

        // Table doesn't have "Center" option in CSS currently, skipping to maintain symmetry with available options

        new Setting(containerEl)
            .setName('Table Caption Offset')
            .setDesc('Distance between table and caption.')
            .addSlider(slider => slider.setLimits(-50, 0, 1).setValue(this.plugin.settings.tableCaptionOffset).setDynamicTooltip().onChange(async (value) => { this.plugin.settings.tableCaptionOffset = value; await this.plugin.saveSettings(); this.plugin.applyCssStyles(); }));

        new Setting(containerEl)
            .setName('Table Top Offset')
            .setDesc('Distance between text above and the table.')
            .addSlider(slider => slider.setLimits(-50, 0, 1).setValue(this.plugin.settings.tableTopOffset).setDynamicTooltip().onChange(async (value) => { this.plugin.settings.tableTopOffset = value; await this.plugin.saveSettings(); this.plugin.applyCssStyles(); }));

        // --- 4. Reference Style (Inline) ---
        containerEl.createEl('h3', { text: '4. Inline Reference Style' });

        new Setting(containerEl)
            .setName('Figure Reference Color')
            .setDesc('Color for inline citations (e.g. @fig:1).')
            .addColorPicker(color => color.setValue(this.plugin.settings.refColor).onChange(async (value) => { this.plugin.settings.refColor = value; await this.plugin.saveSettings(); this.plugin.applyCssStyles(); }));

        new Setting(containerEl)
            .setName('Bold Figure Reference')
            .addToggle(toggle => toggle.setValue(this.plugin.settings.refBold).onChange(async (value) => { this.plugin.settings.refBold = value; await this.plugin.saveSettings(); this.plugin.applyCssStyles(); }));

        new Setting(containerEl)
            .setName('Table Reference Color')
            .setDesc('Color for inline citations (e.g. @tbl:1).')
            .addColorPicker(color => color.setValue(this.plugin.settings.tableRefColor).onChange(async (value) => { this.plugin.settings.tableRefColor = value; await this.plugin.saveSettings(); this.plugin.applyCssStyles(); }));

        new Setting(containerEl)
            .setName('Bold Table Reference')
            .addToggle(toggle => toggle.setValue(this.plugin.settings.tableRefBold).onChange(async (value) => { this.plugin.settings.tableRefBold = value; await this.plugin.saveSettings(); this.plugin.applyCssStyles(); }));

        // --- 5. Interaction ---
        containerEl.createEl('h3', { text: '5. Interaction & Behavior' });

        new Setting(containerEl)
            .setName('Enable Click-to-Jump')
            .setDesc('Scroll to the figure/table definition when clicking a reference.')
            .addToggle(toggle => toggle.setValue(this.plugin.settings.enableClickToJump).onChange(async (value) => { this.plugin.settings.enableClickToJump = value; await this.plugin.saveSettings(); }));

        new Setting(containerEl)
            .setName('Auto-add Brackets')
            .setDesc('Insert (@fig:id) instead of @fig:id when selecting from suggestion.')
            .addToggle(toggle => toggle.setValue(this.plugin.settings.enableAutoBrackets).onChange(async (value) => { this.plugin.settings.enableAutoBrackets = value; await this.plugin.saveSettings(); }));

        // --- 6. Integrity ---
        containerEl.createEl('h3', { text: '6. Integrity & Validation' });

        new Setting(containerEl)
            .setName('Enable Integrity Check')
            .setDesc('Highlight orphans (defined but unused figures/tables) and broken links in red.')
            .addToggle(toggle => toggle.setValue(this.plugin.settings.enableIntegrityCheck).onChange(async (value) => { this.plugin.settings.enableIntegrityCheck = value; await this.plugin.saveSettings(); this.plugin.applyCssStyles(); this.plugin.refreshLivePreview(); }));

        new Setting(containerEl)
            .setName('Error/Warning Color')
            .setDesc('Color used for orphans and broken links.')
            .addColorPicker(color => color.setValue(this.plugin.settings.errorColor).onChange(async (value) => { this.plugin.settings.errorColor = value; await this.plugin.saveSettings(); this.plugin.applyCssStyles(); }));
    }
}
