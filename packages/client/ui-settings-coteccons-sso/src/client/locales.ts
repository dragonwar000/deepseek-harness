/** Coteccons SSO group copy on the AI Account settings page. */

/** English dictionary (the key-set source of truth). */
export const en = {
  title: 'Coteccons SSO — used for the main model',
  description: 'Sign in with your Coteccons Microsoft account. The main model runs on the Coteccons Azure AI resource with your own sign-in, so your Azure permissions decide access and no API key is stored.',
  loading: 'Loading the sign-in state…',
  unavailable: 'Lost the connection to the sign-in state. Reload the page to retry.',
  notConfigured: 'Coteccons SSO is not configured on this Host. Set {settings} on the coteccons-sso row of the composition (cordis.patch.yml), then restart.',
  signedOut: 'Not signed in. The Coteccons models stay unavailable until you sign in.',
  signIn: 'Sign in with Coteccons SSO',
  signingIn: 'Finish signing in in the browser window that opened. If no window opened, open this link:',
  preparing: 'Opening the Microsoft sign-in page…',
  cancel: 'Cancel',
  signedInAs: 'Signed in as',
  tenant: 'Tenant',
  signOut: 'Sign out',
  errorSignInFailed: 'Sign-in did not complete. Try again.',
  errorTimeout: 'Sign-in timed out. Try again.',
  errorDomain: 'This account is not a Coteccons account. Sign in with your Coteccons email.',
  errorExpired: 'Your sign-in expired. Sign in again.',
  errorAction: 'The request failed. Try again.',
} satisfies Record<string, string>

/** Keys of the Coteccons SSO dictionary. */
export type CotecconsSsoLocaleKey = keyof typeof en

/** Simplified Chinese dictionary (same keys as {@link en}). */
export const zh: { [Key in CotecconsSsoLocaleKey]: string } = {
  title: 'Coteccons SSO — 用于主模型',
  description: '使用 Coteccons Microsoft 账号登录。主模型以你本人的登录身份在 Coteccons Azure AI 资源上运行，访问权限由你的 Azure 权限决定，不保存 API Key。',
  loading: '正在加载登录状态…',
  unavailable: '与登录状态的连接已断开。请刷新页面后重试。',
  notConfigured: '此主机尚未配置 Coteccons SSO。请在组合配置（cordis.patch.yml）的 coteccons-sso 行设置 {settings}，然后重启。',
  signedOut: '尚未登录。登录前无法使用 Coteccons 模型。',
  signIn: '使用 Coteccons SSO 登录',
  signingIn: '请在已打开的浏览器窗口中完成登录。如果没有打开窗口，请打开此链接：',
  preparing: '正在打开 Microsoft 登录页面…',
  cancel: '取消',
  signedInAs: '已登录账号',
  tenant: '租户',
  signOut: '退出登录',
  errorSignInFailed: '登录未完成，请重试。',
  errorTimeout: '登录超时，请重试。',
  errorDomain: '此账号不是 Coteccons 账号。请使用 Coteccons 邮箱登录。',
  errorExpired: '登录已过期，请重新登录。',
  errorAction: '请求失败，请重试。',
}
