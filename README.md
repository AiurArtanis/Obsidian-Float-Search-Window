<p align="center">
  <img src="media/banner.jpg" alt="Float Search Window banner" width="720">
</p>

<p align="center">
  <a href="README.md"><img alt="中文" src="https://img.shields.io/badge/lang-%E4%B8%AD%E6%96%87-red?style=flat-square"></a>
  <a href="README_en.md"><img alt="English" src="https://img.shields.io/badge/lang-English-blue?style=flat-square"></a>
  <a href="https://github.com/AiurArtanis/Obsidian-Float-Search-Window/stargazers"><img alt="stars" src="https://img.shields.io/github/stars/AiurArtanis/Obsidian-Float-Search-Window?style=flat-square"></a>
  <a href="https://github.com/AiurArtanis/Obsidian-Float-Search-Window/network/members"><img alt="forks" src="https://img.shields.io/github/forks/AiurArtanis/Obsidian-Float-Search-Window?style=flat-square"></a>
  <img alt="last commit" src="https://img.shields.io/github/last-commit/AiurArtanis/Obsidian-Float-Search-Window?color=blue&style=flat-square">
  <a href="LICENSE"><img alt="license" src="https://img.shields.io/github/license/AiurArtanis/Obsidian-Float-Search-Window?color=blue&style=flat-square"></a>
  <a href="https://github.com/AiurArtanis/Obsidian-Float-Search-Window/releases"><img alt="release" src="https://img.shields.io/github/v/release/AiurArtanis/Obsidian-Float-Search-Window?style=flat-square"></a>
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white">
  <img alt="Obsidian" src="https://img.shields.io/badge/Obsidian-plugin-8A5CF5?logo=obsidian&logoColor=white&style=flat-square">
</p>

# Float Search Window

把 Obsidian 自带的搜索视图放到浮动弹窗、分栏、标签页或独立窗口里用。本仓库面向 Windows 与中文输入法继续维护。

[中文](README.md) | [English](README_en.md)

本仓库继承自 [Quorafind/Obsidian-Float-Search](https://github.com/Quorafind/Obsidian-Float-Search)（作者 [Boninall](https://github.com/Quorafind)）。原作者已停止维护，这里从上游 4.3.0 起继续维护。请给上游也点星。问题请优先在本仓库开 issue。

## 📖 目录

- [演示](#演示)
- [功能](#-功能)
- [相对原版新增](#相对原版新增)
- [安装](#-安装)
- [使用](#使用)
- [快捷键](#️-快捷键)
- [设置](#设置)
- [致谢](#-致谢)
- [许可证](#许可证)
- [点星](#-点星)

## 演示

浮动搜索弹窗：

<p align="center">
  <img src="media/img.png" alt="浮动搜索弹窗截图" width="720">
</p>

## ✨ 功能

- 用弹窗、侧边栏、分栏、标签页或独立窗口打开 Obsidian 原生搜索
- 双击 `Shift`（可改）打开 CMDK 快速搜索：文件名、标题、正文，可预览并跳到命中位置
- 中文输入法组字完成后再搜索，不在拼音过程中打断
- 按类型筛选数据库、白板，并可只看收藏
- 大小写敏感、正则表达式（VSCode 式图标开关）
- 搜索结果可在弹窗右侧预览，再决定打开位置
- 右键选中文本即可搜索
- 外部用 `obsidian://fs?query=关键词` 唤起
- 快速搜索里可按时间戳文件名新建笔记

## 相对原版新增

相对 [Floating Search 4.3.0](https://github.com/Quorafind/Obsidian-Float-Search) 多出来的部分：

| 项 | 说明 |
|---|---|
| 中文输入法 | 组字过程中不提前查询，避免拼音吞字、乱序 |
| 中英界面 | 跟随 Obsidian 语言，设置、命令、按键说明都会切换 |
| 分段设置页 | 常规 / 快速搜索 / 快速新建 三个 tab |
| 多功能筛选 | 数据库、白板复选；全部 / 只看收藏分段按钮；Aa 与正则 |
| 独立插件 id | `float-search-window`，不会被官方 `float-search` 覆盖 |

全局搜索弹窗的过滤行：

<p align="center">
  <img src="media/filter-global.png" alt="全局搜索过滤行" width="720">
</p>

快速浮窗（双击 Shift）同样有这一行：

<p align="center">
  <img src="media/filter-cmdk.png" alt="快速搜索过滤行" width="720">
</p>

## 📦 安装

本仓库目前不在官方社区插件列表中。插件 id 是 `float-search-window`，与官方 Floating Search（`float-search`）互不覆盖。

### BRAT

1. 安装 [BRAT](https://github.com/TfTHacker/obsidian42-brat)
2. 添加 `AiurArtanis/Obsidian-Float-Search-Window`
3. 启用 **Float Search Window**，并关闭官方 **Floating Search**（如果还开着）

### 手动

1. 从 [Releases](https://github.com/AiurArtanis/Obsidian-Float-Search-Window/releases) 下载 `main.js`、`manifest.json`、`styles.css`
2. 放到 `{vault}/.obsidian/plugins/float-search-window/`
3. 重载已安装插件，然后启用

## 使用

### 命令

| 命令 | 作用 |
|---|---|
| 全局搜索 | 每次打开清空关键字 |
| 全局搜索（保留上次关键字） | 保留上次关键字，约 30 秒后清空 |
| 在当前文件中搜索 | 只搜当前文件 |
| 搜索当前文件的反向链接 | 搜指向当前文件的反链 |
| 打开搜索视图（分栏 / 标签页 / 窗口） | 在分栏 / 标签 / 新窗口打开搜索 |
| 显示/隐藏文件路径 | 切换结果里是否显示路径 |

没有默认命令热键。到 **设置 → 快捷键** 搜索 `Float Search` 自行绑定。

### 弹窗内操作

光标在搜索框时：

- `↑` `↓` 切换结果；`Shift+↑/↓` 展开或折叠
- `Enter` 后台打开；`Ctrl+Enter` 后台新标签打开；`Alt+Enter` 打开并关弹窗
- `Ctrl+Shift+Alt+Enter` 新窗口打开并关弹窗
- `Tab` 右侧预览，`Shift+Tab` 关闭预览
- `Ctrl+Shift+C` 复制当前结果
- 预览时 `Ctrl+E` 切换阅读模式；`Ctrl+G` 在输入框和预览之间跳转

有预览时，鼠标点击结果只换预览文件；`Alt+点击` 打开并关弹窗。没有预览时，点击结果会打开文件并关弹窗。

### URI

```
obsidian://fs?query=hello
obsidian://fs?query=world&viewType=tab
```

`viewType` 可为 `modal`（默认）、`sidebar`、`split`、`tab`、`window`。

## ⌨️ 快捷键

| 操作 | 默认 | 说明 |
|---|---|---|
| 打开 CMDK 快速搜索 | 双击 `Shift` | 可在设置里改成 Ctrl / Alt / Meta，或关闭 |

弹窗内键位见上一节。命令热键需自己绑定。

<details>
<summary><strong>展开完整弹窗键位</strong></summary>

| 键 | 作用 |
|---|---|
| `↑` `↓` | 切换结果 |
| `Shift+↑/↓` | 展开 / 折叠 |
| `Enter` | 后台打开 |
| `Ctrl+Enter` | 后台新标签打开 |
| `Alt+Enter` | 打开并关弹窗 |
| `Ctrl+Shift+Alt+Enter` | 新窗口打开并关弹窗 |
| `Tab` / `Shift+Tab` | 打开 / 关闭预览 |
| `Ctrl+Shift+C` | 复制结果 |
| `Ctrl+E` | 预览阅读模式 |
| `Ctrl+G` | 输入框 ↔ 预览 |
| `Alt+点击` | 打开并关弹窗 |

</details>

## 设置

- **常规**：默认视图、是否显示路径、是否显示按键说明
- **快速搜索**：双击哪个键打开 CMDK、两次按键的最大间隔（默认 300ms）
- **快速新建**：无精确匹配时用搜索词建笔记，以及目录和时间戳文件名格式

## 🙏 致谢

- [Boninall / Quorafind](https://github.com/Quorafind) 与 [Obsidian-Float-Search](https://github.com/Quorafind/Obsidian-Float-Search)
- [obsidian-hover-editor](https://github.com/nothingislost/obsidian-hover-editor) 的嵌入 leaf 实现

## 许可证

[GPL-3.0](LICENSE)。版权与上游关系见 [NOTICE](NOTICE)。

## ⭐ 点星

如果这个项目对你有用，请给仓库点一个 star。
