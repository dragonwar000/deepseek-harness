---
kind: upgrade-guide
description: "The Desktop product name changes from DeepSeek Harness to CTD Core, which moves the Electron user data and logs directories."
---

# DeepSeek Harness Desktop becomes CTD Core

English | [中文](guide.zh.md)

## Change

Desktop previously shipped as `DeepSeek Harness` (`DeepSeek Harness.app` on macOS). It now ships as `CTD Core` (`CTD Core.app`), with the CTD Core name, icons, About panel, menus, tray text, installer strings, PWA manifest, and Web client brand. The `dsh` command, profile names, `cordis.yml` and settings keys, environment variables, `dsh://` links, and `@deepseek-ai/dsh-*` package names are unchanged.

Electron derives its user data and logs directories from the product name, so they move:

| Data | Before | After |
| --- | --- | --- |
| Electron user data on macOS | `~/Library/Application Support/DeepSeek Harness` | `~/Library/Application Support/CTD Core` |
| Electron user data on Windows | `%APPDATA%\DeepSeek Harness` | `%APPDATA%\CTD Core` |
| Crash reports on macOS | `~/Library/Logs/DeepSeek Harness` | `~/Library/Logs/CTD Core` |

The user data directory holds device-local state: shortcut overrides in `keybindings.json`, the Windows `background-close-confirmed` marker, and browser storage. CTD Core does not read the old directory, so after upgrading shortcut overrides revert to defaults and Windows asks again before hiding to the tray. The Harness home (`~/.dsh` or `DSH_HOME`) keeps sessions, settings, credentials, profiles, and plugins; its location does not change and CTD Core reads it as before.

## Migration

1. Quit DeepSeek Harness and CTD Core.
2. If CTD Core has never started on this computer, copy the whole old directory. On macOS run `cp -Rp ~/Library/Application\ Support/DeepSeek\ Harness ~/Library/Application\ Support/CTD\ Core`; on Windows run `robocopy "%APPDATA%\DeepSeek Harness" "%APPDATA%\CTD Core" /E`.
3. If CTD Core has already started, do not overwrite its directory, because its browser storage belongs to that installation. Copy only `keybindings.json`, and on Windows `background-close-confirmed`, from the old directory into the new one.
4. Old crash reports stay under `~/Library/Logs/DeepSeek Harness`; move them only if you want them next to new reports. Startup pruning manages only the new directory.
5. Confirm: start CTD Core, open the keyboard shortcut settings, and check that your overrides appear. Then remove the old `DeepSeek Harness.app` or uninstall DeepSeek Harness; the Windows uninstaller does not touch the Harness home.
