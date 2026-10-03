---
kind: upgrade-guide
description: "Desktop 产品名从 DeepSeek Harness 改为 CTD Core，Electron 用户数据目录和日志目录随之改变。"
---

# DeepSeek Harness Desktop 更名为 CTD Core

[English](guide.md) | 中文

## 变更

Desktop 此前以 `DeepSeek Harness` 发布（macOS 上为 `DeepSeek Harness.app`），现在以 `CTD Core` 发布（`CTD Core.app`），名称、图标、关于面板、菜单、托盘文字、安装程序文字、PWA manifest 和 Web 客户端品牌均改为 CTD Core。`dsh` 命令、profile 名称、`cordis.yml` 和设置键、环境变量、`dsh://` 链接以及 `@deepseek-ai/dsh-*` 包名保持不变。

Electron 根据产品名确定用户数据目录和日志目录，因此它们会改变：

| 数据 | 之前 | 之后 |
| --- | --- | --- |
| macOS 上的 Electron 用户数据 | `~/Library/Application Support/DeepSeek Harness` | `~/Library/Application Support/CTD Core` |
| Windows 上的 Electron 用户数据 | `%APPDATA%\DeepSeek Harness` | `%APPDATA%\CTD Core` |
| macOS 上的崩溃报告 | `~/Library/Logs/DeepSeek Harness` | `~/Library/Logs/CTD Core` |

用户数据目录保存本机状态：`keybindings.json` 中的快捷键覆盖、Windows 的 `background-close-confirmed` 标记以及浏览器存储。CTD Core 不读取旧目录，因此升级后快捷键覆盖恢复为默认值，Windows 在隐藏到托盘前会再次询问。Harness 主目录（`~/.dsh` 或 `DSH_HOME`）保存会话、设置、凭据、profile 和插件；其位置不变，CTD Core 照常读取。

## 迁移

1. 退出 DeepSeek Harness 和 CTD Core。
2. 如果 CTD Core 从未在这台电脑上启动过，复制整个旧目录。macOS 上运行 `cp -Rp ~/Library/Application\ Support/DeepSeek\ Harness ~/Library/Application\ Support/CTD\ Core`；Windows 上运行 `robocopy "%APPDATA%\DeepSeek Harness" "%APPDATA%\CTD Core" /E`。
3. 如果 CTD Core 已经启动过，不要覆盖它的目录，因为其中的浏览器存储属于该安装。只把旧目录中的 `keybindings.json`（Windows 上还有 `background-close-confirmed`）复制到新目录。
4. 旧崩溃报告保留在 `~/Library/Logs/DeepSeek Harness`；只有需要与新报告放在一起时才移动它们。启动时的清理只管理新目录。
5. 确认：启动 CTD Core，打开快捷键设置，检查覆盖项是否出现。然后删除旧的 `DeepSeek Harness.app` 或卸载 DeepSeek Harness；Windows 卸载程序不会改动 Harness 主目录。
