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

    defColor: string;
    defBold: boolean;
    defCenter: boolean;
    defVerticalOffset: number;
    // 【新增】：图片上方间距修正
    imageTopOffset: number;

    refColor: string;
    refBold: boolean;

    enableClickToJump: boolean;
    enableAutoBrackets: boolean;

    // === 完整性校验 ===
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
    defColor: '#1e88e5',
    defBold: true,
    defCenter: true,
    defVerticalOffset: -15,
    // 【默认值】：给一个比较大的负值来抵消空行，你可以手动调
    imageTopOffset: -25,

    refColor: '#1565c0',
    refBold: false,

    enableClickToJump: true,
    enableAutoBrackets: true,

    enableIntegrityCheck: true,
    errorColor: '#d32f2f',
};

export class ReferenceListSettingsTab extends PluginSettingTab {
    plugin: ReferenceList;

    constructor(plugin: ReferenceList) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        // ============================================================
        // SECTION 1: Bibliography
        // ============================================================
        containerEl.createEl('h2', { text: '📚 Bibliography & Citations', cls: 'pandoc-setting-header' });

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


        // ============================================================
        // SECTION 2: Figure & Table Settings
        // ============================================================
        containerEl.createEl('br');
        containerEl.createEl('h2', { text: '🖼️ Figure & Table Settings', cls: 'pandoc-setting-header' });

        // --- Prefixes ---
        containerEl.createEl('h3', { text: 'Prefix Configuration' });
        new Setting(containerEl).setName('Figure Prefix').addText(text => text.setPlaceholder('图').setValue(this.plugin.settings.figurePrefix).onChange(async (value) => { this.plugin.settings.figurePrefix = value; await this.plugin.saveSettings(); this.plugin.app.workspace.trigger('parse-style-settings'); }));
        new Setting(containerEl).setName('Table Prefix').addText(text => text.setPlaceholder('表').setValue(this.plugin.settings.tablePrefix).onChange(async (value) => { this.plugin.settings.tablePrefix = value; await this.plugin.saveSettings(); this.plugin.app.workspace.trigger('parse-style-settings'); }));

        // --- Visual ---
        containerEl.createEl('h3', { text: 'Visual Style' });
        new Setting(containerEl).setName('Definition Text Color').addColorPicker(color => color.setValue(this.plugin.settings.defColor).onChange(async (value) => { this.plugin.settings.defColor = value; await this.plugin.saveSettings(); this.plugin.applyCssStyles(); }));
        new Setting(containerEl).setName('Bold Definition Label').addToggle(toggle => toggle.setValue(this.plugin.settings.defBold).onChange(async (value) => { this.plugin.settings.defBold = value; await this.plugin.saveSettings(); this.plugin.applyCssStyles(); }));
        new Setting(containerEl).setName('Center Definition Label').addToggle(toggle => toggle.setValue(this.plugin.settings.defCenter).onChange(async (value) => { this.plugin.settings.defCenter = value; await this.plugin.saveSettings(); this.plugin.applyCssStyles(); }));

        new Setting(containerEl)
            .setName('Caption Vertical Offset (Chart & Text)')
            .setDesc('Adjust the space between image and caption. (Default: -15px)')
            .addSlider(slider => slider.setLimits(-50, 10, 1).setValue(this.plugin.settings.defVerticalOffset).setDynamicTooltip().onChange(async (value) => { this.plugin.settings.defVerticalOffset = value; await this.plugin.saveSettings(); this.plugin.applyCssStyles(); }));

        // 【新增】：图片上方的间距控制
        new Setting(containerEl)
            .setName('Image Top Offset (Fix Empty Lines)')
            .setDesc('Moves the whole image line up to cover the empty line required by Pandoc. (Default: -25px)')
            .addSlider(slider => slider
                .setLimits(-100, 0, 1) // 范围 -100 到 0
                .setValue(this.plugin.settings.imageTopOffset)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    this.plugin.settings.imageTopOffset = value;
                    await this.plugin.saveSettings();
                    this.plugin.applyCssStyles();
                }));

        new Setting(containerEl).setName('Reference Text Color').addColorPicker(color => color.setValue(this.plugin.settings.refColor).onChange(async (value) => { this.plugin.settings.refColor = value; await this.plugin.saveSettings(); this.plugin.applyCssStyles(); }));
        new Setting(containerEl).setName('Bold Reference Text').addToggle(toggle => toggle.setValue(this.plugin.settings.refBold).onChange(async (value) => { this.plugin.settings.refBold = value; await this.plugin.saveSettings(); this.plugin.applyCssStyles(); }));

        // --- Interaction ---
        containerEl.createEl('h3', { text: 'Interaction & Behavior' });

        new Setting(containerEl)
            .setName('Enable Click-to-Jump')
            .setDesc('Scroll to figure definition when clicking citations.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableClickToJump)
                .onChange(async (value) => {
                    this.plugin.settings.enableClickToJump = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Auto-add Brackets on Suggest')
            .setDesc('Insert (@fig:id) instead of @fig:id.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableAutoBrackets)
                .onChange(async (value) => {
                    this.plugin.settings.enableAutoBrackets = value;
                    await this.plugin.saveSettings();
                }));

        // === 完整性校验 ===
        containerEl.createEl('h3', { text: 'Integrity & Validation' });

        new Setting(containerEl)
            .setName('Enable Integrity Check')
            .setDesc('Highlight orphans (defined but unused) and broken links in red. Also affects the sidebar navigator.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableIntegrityCheck)
                .onChange(async (value) => {
                    this.plugin.settings.enableIntegrityCheck = value;
                    await this.plugin.saveSettings();
                    this.plugin.applyCssStyles();
                    this.plugin.refreshLivePreview();
                }));

        new Setting(containerEl)
            .setName('Error/Warning Color')
            .setDesc('Color for highlighting unused figures and broken links.')
            .addColorPicker(color => color
                .setValue(this.plugin.settings.errorColor)
                .onChange(async (value) => {
                    this.plugin.settings.errorColor = value;
                    await this.plugin.saveSettings();
                    this.plugin.applyCssStyles();
                }));
    }
}
