/** Localized welcome copy, Coteccons SSO sign-in actions, and write-only credential actions. */

import type { CotecconsSsoSignInId, CotecconsSsoView } from '@deepseek-ai/dsh-coteccons-sso/types'
import { contextBridge, ipcRenderer } from 'electron'
import { resolveDesktopLocale } from './locale.ts'
import { WELCOME_IPC, type WelcomeApi, type WelcomeNotice, type WelcomeSaveResult } from './welcome-api.ts'

const prefix = '--dsh-welcome-locale='
const locale = process.argv.find(argument => argument.startsWith(prefix))?.slice(prefix.length)
if (locale === undefined) throw new Error('desktop welcome: missing window locale')
const api: WelcomeApi = {
  ...resolveDesktopLocale(locale),
  takeNotice: () => ipcRenderer.invoke(WELCOME_IPC.takeNotice) as Promise<WelcomeNotice | undefined>,
  startSignIn: () => ipcRenderer.invoke(WELCOME_IPC.start) as Promise<CotecconsSsoView>,
  cancelSignIn: (id: CotecconsSsoSignInId) => ipcRenderer.invoke(WELCOME_IPC.cancel, id) as Promise<CotecconsSsoView>,
  copySignInLink: (id: CotecconsSsoSignInId) => ipcRenderer.invoke(WELCOME_IPC.copyLink, id) as Promise<void>,
  onSsoState: (listener) => {
    const receive = (_event: Electron.IpcRendererEvent, state: CotecconsSsoView): void => { listener(state) }
    ipcRenderer.on(WELCOME_IPC.state, receive)
    return () => { ipcRenderer.removeListener(WELCOME_IPC.state, receive) }
  },
  saveApiKey: (settingsNs: string, value: string) =>
    ipcRenderer.invoke(WELCOME_IPC.saveApiKey, settingsNs, value) as Promise<WelcomeSaveResult>,
  skip: () => ipcRenderer.invoke(WELCOME_IPC.skip) as Promise<void>,
  getWritableProviders: () => ipcRenderer.invoke(WELCOME_IPC.providers) as Promise<readonly string[]>,
}
contextBridge.exposeInMainWorld('dshWelcome', api)
