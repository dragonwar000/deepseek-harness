# Rebrand: "DeepSeek Harness" → "CTD Core"

Ngày: 2026-09-29

## Mục tiêu

Thay toàn bộ thương hiệu "DeepSeek Harness", logo cá DeepSeek, icon DeepSeek trong client UI thành "CTD Core" (icon CTD teal + text "CTD Core") trên tất cả file source, test, snapshot, và locale.

---

## Vòng 1: Thay đổi ban đầu

### `brand.localBuild` locale keys
- **`packages/client/ui-settings-models/src/client/locales.ts`**
  - `brand.localBuild` en: `'CTD Core'`
  - `brand.localBuild` zh: `'CTD Core'`

### `DEFAULT_CLIENT_TITLE`
- **`apps/web/vite.config.ts`**: `'CTD Core'`

### Xóa guard `ui-brand-official`
- `OfficialBrandMark` (CTD icon) và `OfficialBrandName` (CTD wordmark) luôn đăng ký vào `sidebar.brand.mark` / `sidebar.brand.name`

### Onboarding / welcome copy
- **`packages/client/ui-settings-models/src/client/locales.ts`**
  - `welcomeTitle`: `'Welcome to CTD Core'` / `'欢迎使用 CTD Core'`
  - `welcomeBody`: Đã có "CTD Core 0.1"

### Test/snapshot fixes vòng 1
- `browser-plugin.client.spec.tsx`: slot assertion
- 6 snapshot files `ui-settings-account`
- `welcome-notice.client.spec.tsx`: inline copy

---

## Vòng 2: Quét toàn bộ "DeepSeek Harness" còn sót

### File source (product-visible copy)

| # | File | Dòng | Thay đổi |
|---|---|---|---|
| 1 | `packages/client/ui-settings-account/src/client/locales.ts` | 16 | `backToHarness: 'Back to DeepSeek Harness'` → `'Back to CTD Core'` |
| 2 | `packages/client/ui-settings-account/src/client/locales.ts` | 26 | `settingsSignedOutTitle: 'You are not signed in to DeepSeek Harness'` → `'...CTD Core'` |
| 3 | `packages/client/ui-settings-account/src/client/locales.ts` | 27 | `settingsSignedOutDescription: 'Sign in to DeepSeek Harness...'` → `'...CTD Core'` |
| 4 | `packages/client/ui-settings-account/src/client/locales.ts` | 33 | `quotaDescription: 'DeepSeek Harness cannot start...'` → `'CTD Core cannot...'` |
| 5 | `packages/client/ui-settings-account/src/client/locales.ts` | 52 | zh `backToHarness: '返回 DeepSeek Harness'` → `'返回 CTD Core'` |
| 6 | `packages/client/ui-settings-account/src/client/locales.ts` | 62 | zh `settingsSignedOutTitle` → `'当前未登录 CTD Core 账号'` |
| 7 | `packages/client/ui-settings-account/src/client/locales.ts` | 63 | zh `settingsSignedOutDescription` → `'登录 CTD Core 账号...'` |
| 8 | `packages/client/ui-settings-account/src/client/locales.ts` | 69 | zh `quotaDescription` → `'CTD Core 无法开始新的任务...'` |
| 9 | `packages/client/ui-plugin-manager/src/client/locales.ts` | 66 | zh `installGuideSafety` → `'...损坏 CTD Core...'` |
| 10 | `packages/client/ui-plugin-manager/src/client/locales.ts` | 259 | en `installGuideSafety` → `'...damage CTD Core...'` |
| 11 | `packages/client/ui-sidebar-documentpreview/src/client/office/locales.ts` | 11 | zh `unavailable` → `'...运行 CTD Core 的主机上...'` |
| 12 | `packages/client/ui-sidebar-documentpreview/src/client/office/locales.ts` | 33 | en `unavailable` → `'...running CTD Core.'` |
| 13 | `packages/client/ui-brand-official/src/client/index.ts` | 1 | JSDoc → `/** CTD Core brand occupants... */` |
| 14 | `packages/client/ui-primitives/src/code-file-icon-artwork.manifest.json` | 3 | `"owner": "CTD Core product design"` |

### File test

| # | File | Dòng | Thay đổi |
|---|---|---|---|
| 15 | `packages/client/ui-layout/tests/document-title.client.spec.tsx` | 36-51 | `"DeepSeek Harness"` → `"CTD Core"` |
| 16 | `packages/client/ui-primitives/tests/code-file-icon.client.spec.tsx` | 128 | `'DeepSeek Harness product design'` → `'CTD Core product design'` |
| 17 | `packages/client/ui-settings-account/tests/expected/platform-error-zh.txt` | 1 | `返回 DeepSeek Harness` → `返回 CTD Core` |
| 18 | `packages/client/ui-settings-account/tests/expected/account-signed-out-en.txt` | 1 | `DeepSeek Harness` → `CTD Core` (x2) |
| 19 | `packages/client/ui-settings-account/tests/expected/platform-header-en.txt` | 1 | `Back to DeepSeek Harness` → `Back to CTD Core` |
| 20 | `packages/client/ui-settings-account/tests/expected/platform-error-en.txt` | 1 | `Back to DeepSeek Harness` → `Back to CTD Core` |
| 21 | `packages/client/ui-settings-account/tests/expected/account-signed-out-zh.txt` | 1 | `DeepSeek Harness` → `CTD Core` (x2) |
| 22 | `packages/client/ui-settings-account/tests/expected/platform-header-zh.txt` | 1 | `返回 DeepSeek Harness` → `返回 CTD Core` |

---

## Những gì KHÔNG thay đổi (cố ý giữ nguyên)

Các key này tham chiếu đến **nền tảng DeepSeek thật** (tài khoản, API, provider), không phải tên sản phẩm:

| Key | Lý do giữ nguyên |
|---|---|
| `deepseekAccount` / `deepSeekAccount` | Tài khoản nền tảng DeepSeek |
| `signedIn: 'Signed in to DeepSeek'` / `'已登录 DeepSeek'` | Trạng thái đăng nhập nền tảng |
| `signInDescription: 'Use your DeepSeek account...'` | Mô tả đăng nhập nền tảng |
| `loginDescription: 'Sign in to your DeepSeek account...'` | Mô tả đăng nhập nền tảng |
| `onboardingDescription: 'Configure the official DeepSeek provider...'` | Cấu hình model provider DeepSeek |

### Các thành phần icon/logo chưa thay đổi

| Thành phần | Vị trí | Trạng thái |
|---|---|---|
| `FishLogo` | `ui-sidebar/src/client/SidebarRoot.tsx` lines 189, 225 | Fallback — với guard đã xóa, `OfficialBrandMark` (CTD) luôn đăng ký, nên fallback cá DeepSeek không bao giờ render |
| `HeroFish` | `ui-conversation/src/client/skeleton/EmptyHero.tsx` lines 100, 148-149 | Cá hoạt hình trên màn hình conversation trống — `ui-brand-official` cố ý không đăng ký vào slot này |
| `BrandWordmark` | `ui-primitives` | SVG text "DeepSeek" — có thể dùng trong onboarding flow |

---

## Kết quả test

```
pnpm run test:gui
Test Files  587 passed (587)
Tests      9198 passed | 1 skipped (9199)
Duration   91.46s
```

✅ Tất cả test pass, không có failure nào.

---

## Build & Launch

```sh
make dev-desktop
```

- Build thành công
- Desktop app launch thành công (port 9229, 9222, 9230)
- App chạy tại `http://127.0.0.1:19387/`

---

## Vòng 3: AI Account (thay Anthropic account)

AI Account cho phép chạy Claude Code và Codex bằng subscription của chính người dùng, thông qua CLI chính hãng (`claude auth login`, `codex login --device-auth`), mỗi account một thư mục cấu hình riêng. Bản nháp cũ "Anthropic account" (đọc token OAuth của CLI rồi dùng làm API key cho model chính) đã bị loại bỏ. Lý do thiết kế: `.agents/notes/implemented/feature/2026-09-29-official-cli-ai-accounts.md`.

### Package mới (tất cả `0.2.5`)

| # | Package | Số file nguồn | Vai trò |
|---|---|---|---|
| 1 | `packages/credentials/ai-account` | 7 | Service `ctx.aiAccount` |
| 2 | `packages/credentials/ai-account-platform` | 11 | Chạy CLI chính hãng, lưu metadata trong `accounts.json` |
| 3 | `packages/api/ai-account-controller` | 8 | Remote namespace `aiAccount` |
| 4 | `packages/client/ui-settings-ai-account` | 14 | Trang cài đặt **AI Account** / **AI 账号** |
| 5 | `packages/subagent/subagent-ai-account` | 12 | Mount `subagent-claude-code` / `subagent-codex` với `CLAUDE_CONFIG_DIR` / `CODEX_HOME` |
| 6 | Agent Note `2026-09-29-official-cli-ai-accounts` (`.md`, `.zh.md`, `.i18n.yaml`) | 3 | Quyết định thiết kế |

Sửa các file dùng chung: `packages/api/remotes` (mount `aiAccountRemote`), `packages/bundle/*/cordis.patch.yml`, `packages/test-support/client-runtime/.../remote-default-responses.ts` (stream `aiAccount/watch`), `docs/capability-seams`, `docs/subsystems/credentials`, `docs/config-catalog`, README các gói `subagent*`.

### Lỗi tìm thấy khi quét lại

`aiAccount/remove` trùng tên với method `remove` của `RemoteNamespaceService`, làm `@deepseek-ai/dsh-api-remotes` báo `failed` lúc boot và kéo theo 54 plugin client không kích hoạt (thấy qua `built-boot.expected.e2e.ts`). Đã đổi method Remote thành `removeAccount` (controller, client, 2 file test, README en/zh, ghi lại pairing). Provider `ctx.aiAccount.remove` giữ nguyên.

### Giữ nguyên (không phải tên tính năng cũ)

Quét toàn repo (trừ `node_modules`, `lib`, `dist`, `.desktop-build`, `vendor`, `docs/persistence-changes/releases|historical-formats`, Agent Note archived) với `anthropic[ _-]?account`, `AnthropicAccount`, `ANTHROPIC_ACCOUNT`, `llm-anthropic-account`: **0 kết quả**.

| Chỗ còn "Anthropic" | Lý do giữ |
|---|---|
| `'llm-anthropic': 'Anthropic'` trong `WelcomePage.tsx` | Nhà cung cấp LLM Anthropic thật |
| `subagent-claude-code`, `subagent-codex` | Tích hợp Claude Code / Codex thật |
| `@anthropic-ai/*` | Tên package của nhà cung cấp |

### Việc còn mở

| # | Việc | Ghi chú |
|---|---|---|
| 1 | Kiểm tra đăng nhập thật Claude / ChatGPT | Test dùng executable giả; Agent Note ghi rõ sign-in thật là bước kiểm tra thủ công |
| 2 | Cài `@deepseek-ai/dsh-subagent-ai-account` vào profile | Là Profile Bundle tùy chọn; chưa có trong `cordis.patch.yml` hay `presets/*.yml` nào, nên chưa dùng được end-to-end |
| 3 | Version `0.2.5` vs `0.1.7-rc.2` | **Quyết định của user**: đã bump toàn bộ package + `pnpm-lock.yaml` lên `0.2.5` (chưa commit, HEAD vẫn là merge của bản phát hành 0.1.7-rc.2). 338 manifest `@deepseek-ai/dsh*` (gồm 5 package mới) đều `0.2.5`, không còn `0.1.7-rc.2`; `hygiene` không còn báo lệch version |
| 4 | Backup bản cũ | `/Users/thoaidd/Documents/Development/AI_native/_backup/llm-anthropic-account-20260929-213258/` (`llm-anthropic-account/`, `original-anthropic-account-stack/`) |

---

## Vòng 4: Logo/hero/wordmark + quét lại

### Tài sản thương hiệu

| # | File | Thay đổi |
|---|---|---|
| 1 | `packages/client/ui-primitives/src/CtdMark.tsx` (mới) + `index.ts` | Icon CTD dùng chung (`CtdMark`, `CTD_BRAND_BLUE`, `CTD_BRAND_TEAL`, `CTD_MARK_GLYPHS`, `CTD_MARK_VIEWBOX`) |
| 2 | `ui-primitives/src/BrandWordmark.tsx` | Wordmark "CTD Core" |
| 3 | `ui-sidebar/.../SidebarRoot.tsx`, `.module.css`, `contract/slots.ts` | Fallback mark là `CtdMark` |
| 4 | `ui-conversation/.../EmptyHero.tsx`, `HeroShell.module.css` | Hero dùng `CtdMark` tĩnh, bỏ `HeroFish` |
| 5 | `ui-brand-official/src/client/Brand.tsx`, `index.ts` | `OfficialBrandMark` = `CtdMark`; `OfficialBrandName` = SVG 96x18; đăng ký vô điều kiện |
| 6 | `apps/desktop/resources/icon*.{svg,png}`, `tray-windows.ico`, `renderer/assets/welcome-brand.svg`, `welcome.css` | Icon app / tray / welcome |
| 7 | `FishLogo.tsx` | **Đã xoá**, bỏ export, sửa bảng README và `icons.client.spec.tsx`; `rg -i "fish\|whale"` trong client UI chỉ còn cú pháp shell `fish` |

### Quét lại "DeepSeek Harness" (lượt này)

| # | Phạm vi | Số file | Chi tiết |
|---|---|---|---|
| 1 | Đóng gói / installer Desktop | 6 | `package-macos.ts`, `package-target.ts`, `smoke-packaged-runtime.ts`, `electron-builder.config.d.mts`, `installer/extract-report.h`, `installer/strings.nsh` |
| 2 | Test spec Desktop | 11 | `tray`, `quit-confirmation`, `crash-report`, `background-notice`, `macos-*`, `package-macos`, `main-startup`, `windows-sign`, `fatal-recovery` |
| 3 | Expected fixture Desktop | 19 | `about-panel`, `application-menu-*`, `fatal-*`, `update-restart-*`, `welcome/*` |
| 4 | README Desktop | 2 | Tiêu đề, menu About/Hide/Quit, tray, đường dẫn log (`~/Library/Logs/CTD Core`), bỏ chữ "whale" |
| 5 | PWA | 2 | `manifest.webmanifest` (`name`, `short_name`), `pwa-manifest.e2e.ts` |
| 6 | System prompt "Web GUI" | 8 | `bundle/web-app/src/index.ts` (2 chỗ) + 6 file expected/snapshot mirror; chỉ đổi cụm "…Web GUI" |
| 7 | `dsh --profile web --help` | 1 | `bundle/web-app/src/startup.ts` |
| 8 | Fixture ZH/EN còn sót | 5 | onboarding, `scaffold.ts`, plugin-install, `document-preview` |
| 9 | `rg-sidecar.spec.ts` | 1 | Đường dẫn giả `CTD Core.app` |
| 10 | `ui-brand-official` README en/zh | 2 | Sửa đoạn sai "profile quyết định đăng ký": code không có kiểm tra đó |
| 11 | `built-boot.expected.e2e.ts` | 1 | Nhánh non-official cũ mong đợi nhãn local-build + badge version, nhưng `ui-brand-official` luôn có trong bundle web-app nên cả hai profile đều hiện wordmark; test được đơn giản hoá |
| 12 | Lint Desktop welcome | 4 | 7 lỗi: `WelcomePage.tsx` (`list[0] ?? 'llm-deepseek'`, bỏ điều kiện thừa, thêm EOL), `preload-welcome.ts` (max-len), `welcome-api.ts` (EOL), `welcome-backend.ts` (bỏ `!== null` và `as string` thừa) |
| 13 | Ghi lại translation pairing | 4 cặp | `ui-primitives`, `ui-sidebar`, `ui-brand-official`, `api/ai-account-controller`; kiểm tra toàn corpus: 1140 cặp nhất quán |

### Cố ý giữ "DeepSeek Harness" (tên framework, `BRAND_GUIDELINES.md` cho phép "built on DeepSeek Harness")

| Chỗ | Lý do |
|---|---|
| System prompt lõi "You are an AI agent powered by DeepSeek Harness." | Ghi nhận framework; mirror ở ~110 snapshot, cần `test:snapshot:record` (có API key) |
| "The DeepSeek Harness implementation checkout is at …" | Nói về checkout mã nguồn framework |
| Help của `dsh` (`args.ts`), mô tả SDK app | Khái niệm CLI / SDK cấp framework |
| `subagent-codex` handshake title, tiêu đề CDP của inspector, nav website docs | Định danh nội bộ / dev-tool |
| `package.json` description, README/docs kiến trúc, tên `@deepseek-ai/*`, `dsh` | Tên dự án và package |
| `assembled-boot.ts:230` (`document.title` mồi cho test) | Giá trị giả, không được assert |

### Kết quả gate

| Gate | rc | Kết quả |
|---|---|---|
| `pnpm run typecheck` | 0 | 0 lỗi TS |
| `pnpm run lint` | 0 | oxlint sạch |
| `pnpm run test:gui` | 0 | 589 file pass; 9208 test pass, 1 skipped (9209) |
| `pnpm run doc-sync` | 0 | 42 pass, 0 fail |
| `pnpm run hygiene` | 0 | 18 pass, 0 fail (không còn lỗi version) |
| `pnpm run build` | 0 | 345 client artifact |
| `built-boot.expected.e2e.ts` | 0 | 2/2 pass |
| `startup-auto-selection.e2e.ts` | 0 | 2/2 pass (cần Chromium 1228 cho playwright 1.61.1; đã cài thêm) |

Lệnh e2e: `npx vitest run --config vitest.web.config.ts <file>` sau `pnpm run build`. `test:snapshot` không chạy lại.

### Việc còn mở

| # | Việc | Ghi chú |
|---|---|---|
| 1 | `pnpm run render:tray-icon` sẽ lỗi | `render-tray-icon.ts` cần nhóm `<g id="tray-glyph">` trong `icon-windows.svg` và giả định `SOURCE_EDGE = 1024`; SVG mới không có nhóm này và rộng 1104. Không gate nào bắt được vì `tray-icon.spec.ts` chỉ đọc `.ico` đã commit |
| 2 | Đường dẫn dữ liệu Electron | `productName` là `CTD Core` nên `userData` / log mặc định chuyển sang `CTD Core`; người dùng cũ sẽ không thấy dữ liệu ở thư mục `DeepSeek Harness` |
| 3 | `test:snapshot` chưa chạy | 5 file snapshot web (`ptc-round`, `fresh-round-trip` x2, `schedule-catalog`, `cordis-tool-round`) được sửa tay cụm "CTD Core Web GUI"; nên chạy `pnpm run test:snapshot` |
| 4 | `smoke-real.e2e.ts` | Fixture `web-surface-prompt.expected.md` cập nhật nhưng test cần `DEEPSEEK_API_KEY` |

---

## Tổng số file đã sửa

`git status` hiện có 527 mục thay đổi, chưa commit; gồm 319 `package.json` + `pnpm-lock.yaml` do bump `0.2.5` (quyết định của user).

| Vòng | Số file |
|---|---|
| Vòng 1 (brand.localBuild, title, guard, onboarding, test) | ~10 files |
| Vòng 2 (locale source, JSDoc, manifest, test expected output) | 14 files |
| Vòng 3 (AI Account: 5 package mới = 52 file nguồn, Agent Note 3 file, ~15 file dùng chung) | ~70 files |
| Vòng 4 (tài sản thương hiệu ~20 file, quét lại ~65 file, lint 4 file) | ~90 files |
| Bump version `0.2.5` | 319 files |
| **Tổng (không tính bump version)** | **~208 files** |

---

## Vòng 5: Coteccons SSO (thay đăng nhập DeepSeek)

Đăng nhập DeepSeek Platform được thay bằng Coteccons SSO qua Microsoft Entra ID. Mỗi nhân viên đăng nhập bằng tài khoản Microsoft Coteccons của chính mình; access token Entra ID của người đó gọi thẳng Azure OpenAI / Foundry (`https://ctd-opus-resource.openai.azure.com/openai/v1`) dưới dạng `Authorization: Bearer`, quyền truy cập do Azure RBAC quyết định. **Không có API key, không có client secret.** Lý do thiết kế: `.agents/notes/implemented/feature/2026-09-30-coteccons-sso-entra-main-model.md`.

### Package mới (tất cả `0.2.5`)

| # | Package | Vai trò |
|---|---|---|
| 1 | `packages/credentials/coteccons-sso` (`@deepseek-ai/dsh-coteccons-sso`) | Service Definition `ctx.cotecconsSso`: trạng thái không chứa token, đăng nhập/huỷ/đăng xuất/watch, `getAccessToken(scope, signal)` chỉ trên Host |
| 2 | `packages/credentials/coteccons-sso-msal` (`@deepseek-ai/dsh-coteccons-sso-msal`) | Service Provider dùng `@azure/msal-node` `PublicClientApplication`: auth code + PKCE qua trình duyệt hệ thống, redirect loopback `http://localhost:<port>`, token cache lưu trong credential store |
| 3 | `packages/llm/llm-coteccons-sso` (`@deepseek-ai/dsh-llm-coteccons-sso`) | Route model `coteccons` (pi-ai `openai-completions`), model mặc định `DeepSeek-V4-Pro` (context 131072, không có reasoning) và `gpt-5.6-terra`; mỗi request gắn Bearer token của người dùng |
| 4 | `packages/api/coteccons-sso-controller` (`@deepseek-ai/dsh-api-coteccons-sso-controller`) | Remote namespace `cotecconsSso` (`getState`, `startSignIn`, `cancelSignIn`, `signOut`, `watch`); không có method trả token |
| 5 | `packages/client/ui-settings-coteccons-sso` (`@deepseek-ai/dsh-client-ui-settings-coteccons-sso`) | Nhóm **Coteccons SSO — used for the main model** đứng đầu trang **AI Account** (slot `settings.ai-account.group`, icon `CtdMark`), copy en + zh |

### Luồng đăng nhập và token

1. Người dùng bấm **Sign in with Coteccons SSO** (Settings → AI Account, hoặc cửa sổ welcome của Desktop).
2. Provider gọi MSAL `acquireTokenInteractive` với `openid profile offline_access` + `https://cognitiveservices.azure.com/.default`, `prompt: select_account`. MSAL mở listener loopback trên `127.0.0.1` (cổng ngẫu nhiên); URL đăng nhập được hiển thị trên UI và được mở bằng trình duyệt mặc định của Host.
3. Entra ID trả authorization code về listener (`form_post`), MSAL đổi code lấy token. Nếu cấu hình `allowedDomains`, domain của UPN được kiểm tra; sai domain thì xoá token và báo `domain-not-allowed`.
4. Token cache được ghi thành một bản ghi grant `coteccons-sso/token-cache` trong `$DSH_HOME/.credentials.yaml` (qua `ctx.credentials`), không ghi file riêng, không ghi log.
5. Mỗi request tới route `coteccons` gọi `getAccessToken(aiScope)` → `acquireTokenSilent` (tự refresh); nếu Entra ID yêu cầu đăng nhập lại thì xoá cache và báo `session-expired`. Chưa đăng nhập thì request lỗi `MISSING_CREDENTIAL`: "Sign in with Coteccons SSO in Settings → AI Account…".
6. Sau khi đăng nhập thành công trên trang AI Account, `session.initializeDefaultModel('coteccons')` đặt model đầu tiên của route `coteccons` làm model mặc định.
7. Đăng xuất xoá bản ghi token cache.

### Gỡ đăng nhập DeepSeek khỏi composition (giữ package, chỉ tắt row)

| Bundle | Row | Trạng thái |
|---|---|---|
| `packages/bundle/base/cordis.patch.yml` | `deepseek-account`, `llm-deepseek-account` | `disabled: true` |
| `packages/bundle/web-app/cordis.patch.yml` | `ui-settings-account` (nhóm DeepSeek trong AI Account, menu tài khoản ở sidebar, thông báo quota/bonus, onboarding Desktop, đăng nhập DeepSeek trong onboarding model), `account-controller` | `disabled: true` |
| `packages/bundle/web-app/cordis.patch.yml` | `coteccons-sso`, `llm-coteccons-sso`, `coteccons-sso-controller`, `ui-settings-coteccons-sso` | mới, bật |

`llm-deepseek-api-key` (DeepSeek bằng API key) và `llm-pi-ai` vẫn được mount. Row bị tắt vẫn giữ `id` để patch profile cũ của người dùng không báo lỗi.

### Checklist cho quản trị Azure

- [ ] **App registration** `CTD-Core` — Application (client) ID `149471d2-fb7e-4a8c-a4d0-a81b00e36a4b`, Directory (tenant) ID `afc21379-100b-463d-8325-cd1686ae94ca`.
- [ ] Authentication → Add a platform → **Mobile and desktop applications**, redirect URI `http://localhost` (không ghi cổng; MSAL dùng cổng ngẫu nhiên).
- [ ] Authentication → Advanced settings → **Allow public client flows = Yes**.
- [ ] **Không tạo client secret / certificate** — đây là public client.
- [ ] API permissions → Add a permission → **Azure Cognitive Services** → Delegated → `user_impersonation` → **Grant admin consent** cho tenant.
- [ ] Trên resource `ctd-opus-resource` → Access control (IAM) → Add role assignment → **Cognitive Services OpenAI User** → gán cho nhóm nhân viên (security group) được dùng CTD Core.
- [ ] (Tuỳ chọn) Giới hạn domain email: thêm `allowedDomains` (ví dụ `['coteccons.vn']`) vào row `coteccons-sso`.

### Nơi cấu hình tenantId / clientId

Giá trị đã được đặt sẵn trong composition phát hành, row `coteccons-sso` của `packages/bundle/web-app/cordis.patch.yml`:

```yaml
    - id: coteccons-sso
      name: '@deepseek-ai/dsh-coteccons-sso-msal'
      config:
        tenantId: afc21379-100b-463d-8325-cd1686ae94ca
        clientId: 149471d2-fb7e-4a8c-a4d0-a81b00e36a4b
```

Để ghi đè trên một máy (ví dụ thêm `allowedDomains`), thêm row vào patch của profile `$DSH_HOME/profiles/<profile>/cordis.patch.yml` (Desktop dùng profile `desktop`). Patch **thay toàn bộ** `config` của row, nên phải ghi lại cả `tenantId` và `clientId`:

```yaml
- id: coteccons-sso
  name: '@deepseek-ai/dsh-coteccons-sso-msal'
  config:
    tenantId: afc21379-100b-463d-8325-cd1686ae94ca
    clientId: 149471d2-fb7e-4a8c-a4d0-a81b00e36a4b
    allowedDomains: ['coteccons.vn']
```

Khi thiếu `tenantId` hoặc `clientId`, nhóm Coteccons SSO hiển thị trạng thái "not configured" và nêu trường còn thiếu; ứng dụng vẫn khởi động bình thường.

### Kết quả gate

| Gate | rc | Kết quả |
|---|---|---|
| `pnpm install --offline` | 0 | lockfile đã cập nhật (`@azure/msal-node` 7.0.0) |
| `pnpm run typecheck` | 0 | 0 lỗi TS |
| `pnpm run lint` | 0 | oxlint sạch |
| `pnpm run test:gui` | 0 | 591 file pass; 9227 test pass, 1 skipped |
| vitest các package non-client bị chạm (coteccons-sso*, llm-coteccons-sso, llm-pi-ai, session-controller, remotes, test-support, bundle, credentials, deepseek-account*) | 0 | 110 file; 1907 pass |
| `pnpm run doc-sync` | 0 | 42 pass, 0 fail |
| `pnpm run hygiene` | 1 | 17 pass; `vendor rescope` lỗi ENOENT vì `apps/desktop/src/account-backend.ts` đã xoá nhưng vẫn còn trong git index (chưa stage). Chạy lại với bản sao index đã bỏ file đó: pass |
| Web e2e (sau `pnpm run build`): built-boot, bonus-notice, desktop-onboarding, settings-appearance, onboarding-usable-provider, deepseek-messages-settings, onboarding-deepseek-config, shipped-composition, startup-auto-selection, default-model | 0 | tất cả pass |
| `apps/desktop/tests` | 1 | 3 lỗi có sẵn, không liên quan: `fatal-recovery` (text address-in-use) x2, `packaged-runtime-verification` (version 0.2.5) |

Coverage per-file 100% cho `src` của 5 package mới. Chưa kiểm tra đăng nhập thật với tenant Coteccons (cần máy có trình duyệt và tài khoản thật); `test:snapshot:record` cho route mới cần quyền Azure thật nên chưa ghi snapshot phiên.
