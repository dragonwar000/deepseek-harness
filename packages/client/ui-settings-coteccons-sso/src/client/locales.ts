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

/** Microsoft 365 group copy (English, the key-set source of truth). */
export const m365En = {
  title: 'Microsoft 365 — data the assistant may read',
  description: 'Let the assistant read your Outlook mail, Teams chats and channels, and OneDrive/SharePoint files with your own permissions. Signing in with Coteccons SSO does not connect them: each kind connects separately, and IT grants or revokes each kind in Microsoft Entra ID.',
  connectAll: 'Connect all',
  loading: 'Loading the Microsoft 365 access state…',
  unavailable: 'Lost the connection to the Microsoft 365 access state. Reload the page to retry.',
  mail: 'Outlook mail',
  chat: 'Teams chats',
  files: 'OneDrive and SharePoint files',
  notConfigured: 'Not configured on this Host.',
  disconnected: 'Not connected.',
  preparing: 'Opening the Microsoft sign-in page…',
  connecting: 'Finish connecting in the browser window that opened. If no window opened, open this link:',
  connected: 'Connected as {account}.',
  connect: 'Connect',
  cancel: 'Cancel',
  disconnect: 'Disconnect',
  errorNotAssigned: 'IT has not granted you access. Ask IT to add you, then connect again.',
  errorDisabled: 'IT has turned this access off.',
  errorConsent: 'IT has not approved this access yet.',
  errorRevoked: 'Access was revoked or expired. Connect again; if it fails, IT has removed your access.',
  errorFailed: 'Connecting did not complete. Try again.',
  errorAction: 'The request failed. Try again.',
} satisfies Record<string, string>

/** Keys of the Microsoft 365 dictionary. */
export type M365LocaleKey = keyof typeof m365En

/** Simplified Chinese Microsoft 365 dictionary (same keys as {@link m365En}). */
export const m365Zh: { [Key in M365LocaleKey]: string } = {
  title: 'Microsoft 365 — 助手可读取的数据',
  description: '允许助手以你本人的权限读取 Outlook 邮件、Teams 聊天与频道以及 OneDrive/SharePoint 文件。使用 Coteccons SSO 登录不会连接它们：每类数据需单独连接，IT 在 Microsoft Entra ID 中逐类授予或撤销访问权限。',
  connectAll: '全部连接',
  loading: '正在加载 Microsoft 365 访问状态…',
  unavailable: '与 Microsoft 365 访问状态的连接已断开。请刷新页面后重试。',
  mail: 'Outlook 邮件',
  chat: 'Teams 聊天',
  files: 'OneDrive 与 SharePoint 文件',
  notConfigured: '此主机未配置。',
  disconnected: '未连接。',
  preparing: '正在打开 Microsoft 登录页面…',
  connecting: '请在已打开的浏览器窗口中完成连接。如果没有打开窗口，请打开此链接：',
  connected: '已以 {account} 连接。',
  connect: '连接',
  cancel: '取消',
  disconnect: '断开连接',
  errorNotAssigned: 'IT 尚未授予你访问权限。请联系 IT 添加后再连接。',
  errorDisabled: 'IT 已关闭此访问。',
  errorConsent: 'IT 尚未批准此访问。',
  errorRevoked: '访问已被撤销或过期。请重新连接；如果失败，说明 IT 已移除你的访问权限。',
  errorFailed: '连接未完成，请重试。',
  errorAction: '请求失败，请重试。',
}
