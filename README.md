### 原项目地址
https://github.com/mgmeyers/obsidian-pandoc-reference-list

### 📘 视觉风格重构 (Visual Overhaul)

去标签化：彻底移除了原有的灰色方块背景，改为清爽的学术蓝文字。

差异化排版：

图表定义处：display: block + text-align: center，让图片下方的“图1 标题”自动居中独占一行，加粗显示。

正文引用处：display: inline，让 (图1) 完美融入段落文字流，不打断阅读。

### 👁️ 所见即所得的实时渲染 (Live Preview)

图名回显：输入 ! [说明] (...) {#fig:id}，不再只显示“图1”，而是渲染为完整的 (图1 说明)。

分图支持 (Sub-figures)：完美支持 {#fig:id}a 语法，能够识别 ID 后面的字母后缀，渲染为 (图1a 说明)。

<img width="1724" height="900" alt="image" src="https://github.com/user-attachments/assets/03c8dff7-d14e-4560-8d78-92fb3cd2fc34" />

抗干扰能力：正则匹配逻辑进行了增强，能够忽略 ID 花括号内的额外属性（如 width=14cm），确保渲染不失效。

🔗 智能引用与交互 (Smart Interaction)

自动补全：输入 @ fig 触发菜单，展示“图号+图名”供选择。

自动格式化：选中后自动插入带括号的格式 (@ fig:id)。

灵活后缀：支持在引用中手动输入后缀（如 (@ fig:id a)），插件会自动去除空格并渲染为紧凑的 (图1a)。

点击跳转：点击正文中的蓝色引用链接，屏幕会自动滚动定位到图片定义的位置。

### 📚 文献功能保留

修复了 processReferences 逻辑，确保插件原有的 Zotero/Pandoc 参考文献列表功能依然正常工作。
