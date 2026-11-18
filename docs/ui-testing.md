# Local UI checks

The UI harness runs against a real, throwaway ComputeDeck service with fictional data.
It never reads the normal data directory or discovers installed plugins, and collection
and plugin background loops are off. The service loads only the bundled Notify and Chat
tools, enabled in its temporary database. Browser requests outside this service's origin
are aborted and fail the test. No Docker is needed locally.

After the normal development setup (`uv sync --frozen`, `npm --prefix web ci`):

```sh
bash scripts/check.sh
bash scripts/check-ui.sh
bash scripts/check-ui.sh 'jobs|gallery'
```

`check-ui.sh` builds into a temporary directory, checks bundle sizes, binds a free loopback
port, waits for readiness, runs Playwright, then stops the service and removes its build and
data on success or failure, returning non-zero on failed builds, size checks, startup,
shell errors or UI checks, including with macOS `/bin/bash` 3.2.
An optional argument filters test titles, including page names. The Chromium channel can
be selected with `PLAYWRIGHT_CHANNEL`; on macOS, missing bundled Chromium automatically
selects installed Google Chrome. Missing local WebKit prints **WebKit not installed —
skipped**. CI always includes WebKit; F6 runs its overlay tests in `*.overlays.spec.ts`.
No browser or package downloads happen in this script.

`COMPUTEDECK_DEMO_NOW` accepts an ISO datetime with a timezone. It freezes only example
responses (dashboard, history, events and collection nodes), in UTC, rounded down to the
minute. Invalid or timezone-less values fail explicitly. The default continues to use the
current minute. Example summary freshness and history rollups use the same clock; live
collection and live API clocks are unchanged. Event range filters use the example clock
in example mode and the real clock for live data. The harness uses `2026-01-15T14:00:00Z`,
exported by `check-ui.sh` for both the service and Playwright's fixed browser clock, and UTC.
The browser fixture fails if this variable is missing. In the test transport only, health's host name,
database path and service start time become generic stable values so public artifacts
contain no developer paths and do not vary with service restarts. Metrics are not mocked.
The only screenshot mask is Settings → Service → Address (`.page-settings .kv > div >
dd.mono`), whose value contains the throwaway service's random port. The shared screenshot
options mask exactly that value with `#808080` in both baseline assertions and raw captures
for fresh-context comparison. No other element is masked; product code is unchanged.

Touch projects scroll to the top and capture with a viewport grown to the re-measured document
height: Chromium's `fullPage` capture temporarily switches to fine-pointer media, moving the
layout away from the mask rectangles. Pointer/hover changes fail the capture, and settled
Settings images must have grey pixels throughout the Address box. The original viewport is
restored before axe, DOM and focus checks; non-touch projects keep their existing full-page path.

中文：触屏项目先滚动到顶部，增高视口并重新测量文档高度后截取视口；Chromium 的
`fullPage` 截图会临时切换为精细指针布局，导致遮罩与内容错位。截图期间若指针或
悬停媒体发生变化就失败，设置页稳定截图还须验证整个地址区域内的灰色遮罩像素。
axe、DOM 和焦点检查前恢复原视口；非触屏项目保持原有的整页截图方式。

All Chromium projects use `--disable-gpu --disable-partial-raster`, locally and in CI.
Partial raster (re-rasterising only invalidated tile areas) produced ±1–2 channel-level
differences between otherwise identical renders, even with GPU rendering disabled. Both
flags give deterministic software rasterisation. WebKit configuration is unchanged.
Baselines made with other flags must be regenerated and reviewed before the next two normal
gate runs.

## What gates

The six Chromium combinations are 375/en/light, 375/zh-CN/dark, 900/en/dark,
900/zh-CN/light, 1280/en/light and 1280/zh-CN/dark, all 800 px high. They cover the twelve
0.7 routes (including Chat), the Nodes abnormal filter, the Marketplace tab, the component
gallery and its compatibility state: 96 page cases. Every case waits for `aria-busy=false`,
page reads and fonts, and checks:

- Exact full-page pixels with zero differing pixels, and byte equality in a second fresh
  browser context with the same project options and fixture setup. Storage and scroll history
  are not carried across, so Activity's legitimate seen marker does not make this a revisit.
  Each raw image must settle: at most five full-page captures are taken until two consecutive
  captures are byte-identical. Failure to settle fails the test and attaches the last two PNGs.
  The settled images are then compared exactly between contexts; a mismatch attaches both PNGs.
  `maxDiffPixels: 0` and `threshold: 0` remain unchanged.
- Axe WCAG 2.2 AA violations recorded by rule and target, with no unchecked new entries.
  Full violation details are attached to the report. No axe rules are disabled.
- Horizontal page overflow, duplicate main-content headings, empty visible plugin slots and
  44 px coarse-pointer controls are recorded in each page/project's `*.dom.json` baseline.
  Each fingerprint contains the check kind, control identity (name or stable selector) and
  occurrence count. Pixel measurements are kept only in the full findings attached to the
  report, so font-metric changes do not change the fingerprint. New findings, changed counts
  and fixes require baseline review; the 44 px threshold and checked controls are unchanged.
- Fully covered focused controls still fail directly; focus coverage has no baseline allowance.
- Actual rendered Han fonts through Chromium's font API: Noto Sans CJK SC in Linux CI;
  a supported system CJK font on macOS/Windows. Installing a font without rendering its
  glyphs does not satisfy the guard. The page language must match the project's configured
  locale before the font check, so a failed locale switch cannot silently bypass it.
- Activity must show example event rows and day headings before capturing a baseline.

The separate **jobs reason at 1280 zh with panel open** check now requires no clipped reasons
with the beside panel open, using the same text geometry and occlusion checks after
asserting that the page and panel loaded. Failures report the clipped text. P2 must retain
this guarantee when it adds table column priorities.
Other browser errors and focus-coverage failures still fail directly. DOM findings are
compared with their reviewed baselines rather than marked expected-fail.

中文：1280-zh 下打开旁侧面板时，作业原因必须完全可见；原有文字几何和遮挡检查不变，
失败时报告被裁剪的文字。此用例不再要求重现旧缺陷；P2 增加表格列优先级时必须保留
原因完整可见的要求。

`routing.spec.ts` checks the Clusters, Nodes and Marketplace aliases across the same six
Chromium combinations, including reload and browser Back/Forward, plus the legacy node
filter with a cluster. Run `bash scripts/check-ui.sh 'routing alias|legacy node'` for
these interaction checks. They use the existing page layouts and require no new screenshot
baselines. The full gate still compares all existing screenshots. Vitest also renders the
0.7 URL fixture table in English and Chinese and tests hash changes during startup,
plugin navigation, alias history replacement and preservation of new view parameters.
The routing suite also runs with `URLSearchParams.size` unavailable, covering query
preservation on older supported engines during alias rewrites and filter updates.

P6 follow-up: clearing `nodes` leaves `tab=nodes` in place. Conversely, clearing
only `tab` while `nodes` is set restores `tab=nodes` through the legacy rewrite.
When switching away from Nodes, clear both keys or set an explicit destination tab
such as `tab=overview`; cover both directions in the P6 tab-switching tests.

中文：路由测试也在 `URLSearchParams.size` 不可用时运行，检查旧版受支持浏览器在
别名重写和筛选更新时保留查询参数。P6 待办：清除 `nodes` 后仍会保留 `tab=nodes`；
保留 `nodes` 而仅清除 `tab` 时，旧链接重写又会补回 `tab=nodes`。离开节点标签页时，
应同时清除两个参数，或明确设置目标标签（如 `tab=overview`），并在 P6 中测试两个方向。

The initial 0.7 DOM findings include small touch targets across the 375 px pages and
horizontal overflow in Marketplace at 375 px. F1 records these without changing the 0.7
look. U1 owns the frame and shared touch targets, each P-item owns its page's controls,
and Q1 owns remaining polish (including the Marketplace overflow). Their fixes should
remove the corresponding entries in a reviewed baseline update. The same checks and
baseline policy apply to both languages and every project.

The full release suite grows with each item: F4 adds fallback/contrast and fixture-plugin
coverage; F5 adds the new display primitives; F6 tests layers in both engines; U1/U2 add
navigation, disabled-tool and keyboard states; P1 adds the fold check; later page items
add their own states. Those unimplemented interfaces are not simulated by F1.

## Baseline workflow

Snapshot paths include the platform. Only `web/e2e/snapshots/linux/` from the CI `ui` job
belongs in Git. macOS/Windows baseline directories, reports and traces are ignored.
Missing baselines fail normal runs; no normal check silently creates them.

For the first local run, or an intentional UI change, explicitly generate/review local
baselines and then run again without the update flag:

```sh
bash scripts/check-ui.sh --update-snapshots
bash scripts/check-ui.sh
```

Use the same Chrome/channel and local fonts between items. Review the HTML report in
`web/playwright-report/`. Updating snapshots also updates the axe rule/target records and
DOM kind/identity/count records: review each addition and removal; never accept regressions
merely to turn the gate green. Font, focus-coverage and exact fresh-context determinism
assertions still fail during baseline generation.

For Linux, dispatch CI with **update_ui_baselines** enabled. The job uses
`mcr.microsoft.com/playwright:v1.64.1-noble` plus `fonts-noto-cjk` and uploads
**ui-linux-baselines** and **ui-results**, even if checks report failures. Review/download
the baseline artifact and commit the Linux files at PR time. The workflow never commits.
Normal PR runs compare those baselines. Until that first artifact is reviewed and committed,
CI reports missing baselines; an absent baseline is not a passing gate.

In a socket-restricted sandbox, run `npm --prefix web run typecheck` (which includes the
Playwright suite) and, from `web/`,
`COMPUTEDECK_DEMO_NOW=2026-01-15T14:00:00Z npx --no-install playwright test --list`. The browser
UI gate must run outside a socket-restricted sandbox. Never skip socket-based
service/security tests or weaken assertions to make the sandbox pass.

## Gallery and size budget

`#/__gallery` shows the existing public components; `#/__gallery?compat` exercises the
frozen CSS classes and 19 public tokens plus `--accent-hover` and `--text-muted`. It is
an unlisted development route, available in either language. Its controls change only
local gallery state. The gallery adds no token aliases and does not change existing
component DOM or page styling; the missing `--text-muted` alias remains visible for F4.

The build emits Vite's standard manifest. `scripts/build.sh` removes `.vite` from the
copied package assets, so the wheel and sdist do not ship or serve the manifest; the
original in `web/dist` and the temporary UI build remain available for size checks.
Screenshot baselines, browser reports and test results are excluded from the sdist;
`build.sh` also rejects an sdist containing `web/e2e/snapshots`.
`web/scripts/check-size.mjs` traverses static imports for initial JS (170,000 bytes gzip
ceiling; 160,000 target). It reports and gates both the larger single-locale startup graph
(device choice or matching remembered server default) and the graph with both dictionaries
(first visit or a changed server default). Shared imports count once in each total. It also
requires all F3 routes, forms, Gallery and both locale entries to exist as dynamic entries
outside the initial static import graph. Each non-initial chunk is checked (30,000;
palette 15,000), as is all CSS (17,500; raised from 16,000 in 0.8 because the accent
tokens add four entries to every generated theme block, now with ink values, and the drawer
tabs, key figures and list cards add their own rules). `check.sh` runs this after the build.
Runtime performance budgets, including LCP, remain Q2 work.

F3 follow-up for F4, F5, F8 and U1: with Clusters eager, the reviewed build measures
142,390 bytes for single-locale startup and 163,541 bytes for both locales. The existing
two-locale gate therefore leaves only 6,459 bytes below 170,000, even though the proposal's
budget describes one active locale. Keep this stricter check and its tests intact; plan
shared primitives, tokens, charts and frame changes around that remaining space, and
recheck both totals after each item. P6 owns the new lazy cluster detail page.

中文：首屏 JS 的 gzip 上限为 170,000 字节，目标为 160,000 字节。检查会分别报告并约束
单语言启动（设备选择或与服务器一致的记忆值，取两种语言中较大的总量）及双字典启动
（首次访问或服务器默认语言变化），每种总量中的共享依赖只计算一次。F3 的延迟页面、
表单、组件展示页及两份字典必须在构建清单中保留为动态入口，且不在首屏静态依赖图中。
每个延迟加载块和全部 CSS 仍分别受原有预算约束；LCP 等运行时预算留待 Q2 验证。
F4、F5、F8、U1 待办：集群列表立即加载后，本次构建单语言为 142,390 字节，双语言为
163,541 字节；现有双语言检查比提案的单语言预算更严格，仅余 6,459 字节。保留检查及
测试，在实现共享组件、令牌、图表和框架时规划空间，每项完成后复查两个总量。
新集群详情页的延迟加载由 P6 完成。

## Lazy views and languages

`App.tsx` owns data and actions; `app/Frame.tsx`, `app/Routes.tsx` and `app/Layers.tsx`
render the existing frame, route table and layers. The F2 hash store, aliases and plugin
routes are unchanged. Plan, Usage, Toolbox, Notify, Chat and Settings load on first
visit. Clusters stays eager, including its existing single-group view; P6 owns splitting
the new cluster detail page. The existing source/instance forms load on opening, and Gallery brings
its own CSS. F6 wraps forms in focus views; the new source wizard and palette remain P8/U2 work.

The first dictionary request starts before React mounts. Startup uses the device choice,
then a separately remembered server-language hint, then English. The current server default
still applies when there is no device choice, so a first visit or changed default may load
both dictionaries; blocked storage cannot preserve the hint for later visits. A small shared
loading/error vocabulary reports a failed dictionary request and offers Retry. The gate
passes the language it loaded into the application, so a cross-tab storage change during
loading cannot select an unloaded dictionary. Startup loading is a polite status, and
loading/error states have side gutters (16 px on phones, 24 px otherwise).
Switching languages keeps the current page in its previous language until the new
one arrives, while the select shows the requested value with `aria-busy=true`. A failed
switch preserves both the active language and the stored device
choice and shows an error toast; a late server preference or older selection cannot
overwrite the newest device choice. Unit-test setup loads both dictionaries before
synchronous translation tests; the browser tests exercise actual cold imports.

`loading.spec.ts` covers all six Chromium combinations: deferred
assets and the unchanged host API, navigating away from a delayed route and back,
recovery from a failed route import, a delayed language switch, and closing/reopening a
cold form with focus return, plus a failed form's title-only accessible name. It also
checks startup storage changes, loading/error gutters, and focus and Tab wrapping when
a cold form stays open. Add source opens a type chooser first; selecting Slurm focuses
the cluster-name field. Add instance directly exercises autoFocus on chunk arrival. A failed view
import offers Retry, which reloads the app
at its current URL (React caches failed lazy imports). Route rendering errors still use
the existing page boundary. Suspense loading states carry `aria-busy=true`; modal shells
and their close controls remain mounted while their content loads.

There is no intended settled-page visual change and no baseline regeneration for F3.
The startup gutter correction is covered by browser geometry assertions.
Run the full `bash scripts/check-ui.sh` outside the socket-restricted sandbox to compare
all existing screenshots and exercise the new interactions. Example data is unchanged:
loading and import failures are transport states, exercised with delayed/failed local
asset requests, rather than new server data states.

中文：页面、表单及语言字典按需加载，组件展示页的 CSS 随页面加载。加载完成后的布局、
插件 DOM 和样式约定不变。字典请求在 React 挂载前开始，优先使用设备选择，其次使用
独立记住的服务器语言，否则使用英语。应用直接使用加载门传入的语言，避免加载期间
其他标签页更改存储导致选择尚未加载的字典。启动加载状态会被朗读，加载及错误状态
保留侧边距（手机 16 px，其他宽度 24 px）。首次访问或服务器默认语言变化时可能加载两份
字典，存储不可用时无法为后续访问保留提示。切换语言时下拉框显示所选值并标记为忙碌，
当前页面文字保留，成功后再保存设备选择；失败时恢复下拉框、保留原语言并显示错误。
延迟返回的服务器语言或旧选择不会覆盖新的设备选择。新增浏览器测试覆盖冷加载、
失败重试、前进后退、启动期间存储变化、侧边距、表单焦点恢复及加载失败时仅含标题的
对话框名称。冷表单保持打开时也检查焦点和 Tab 循环：添加来源先选类型，再聚焦集群名称；
添加实例直接检查加载完成后的自动聚焦。集群列表保持立即加载，新详情页的拆分留待 P6。
F3 不更新截图基线或示例数据。

## F4 tokens and plugin compatibility

`npm --prefix web run gen:tokens` regenerates `theme/tokens.css` and
`theme/tokens.fallback-only.css` from `theme/tokens.ts`. The generator uses Node's native
TypeScript support (Node.js 22.18+ or 24); it has no package dependency and rejects sRGB
clipping. Generated files have their own byte-for-byte check instead of Prettier; authored
files still use Prettier. `check.sh` and `npm run build` run `check:tokens`: generation
freshness, component colour lint, every fallback context (including both explicit themes
and contrast-more), and a WCAG/APCA report. Vitest gates the WCAG matrix, gamut and identity
separation, the 21 compatibility names, and device-preference persistence/blocked storage.
APCA Lc is advisory; it is never used as a pass threshold. Fallback declarations reference
the matching primitive, with no `light-dark()` call. The lint checks both that reference and
the primitive's value; removing or changing any declaration in any of the eight fallback
contexts must fail the mutation test.

The light warning shape uses OKLCH `.60 .1299 70`: the proposed chroma `.13` produces
linear-sRGB blue `-0.00002774`. The tiny chroma adjustment keeps the hue/lightness and passes
the strict no-clipping test. All matrix backgrounds include hover and selected, plus raised,
overlay, each status's own tint and the identity tints. Translucent chart marks are composed
in sRGB before measuring WCAG contrast. The hatch edge is checked against both the base and
the composited stripe. Contrast-more stripe alpha is .72 (light) / .60 (dark), keeping edge
contrast at 3.18 / 3.22 instead of the original 2.51 / 2.18.

The local launcher now makes three isolated builds: normal core, fallback-only core under
`/__ui-fallback/`, and the scaffolded hello example plus test fixtures under `/__ui-plugins/`.
These paths exist only in the throwaway test server. Both test build flags are unset before
the normal build. `theme.spec.ts` requires zero axe violations on the compat gallery in
normal and contrast-more mode, compares every semantic/compat colour with the fallback in
all system/explicit theme combinations, and checks persistence and exact single/two-line
row boxes (hairline included) for both densities, `.compact`, and coarse pointers. It also
exercises a generic stacked table and the new `cell-overflow` DOM finding: visible `td`/`th`
with non-table-cell display and `scrollHeight > clientHeight + 1`. Like the other DOM findings,
its kind, identity and count are baselined; pixel measurements stay in the report.
`fallback.spec.ts`
renders Overview and the gallery under six theme/contrast contexts, with exact screenshots,
normal/fallback image equality and axe records (named `gallery-…` or `overview-…`). Existing Overview findings remain visible
in those records until P1/Q1. The gating fallback screenshot suite runs only in Chromium.
WebKit keeps the screenshot-free theme suite (axe and computed-colour parity), as well as
F6's overlay suite. The weekly WebKit fallback-only render is advisory, outside the
PR gate.

`plugin-compat.spec.ts` exercises the actual `plugin new --web` template through
`window.ComputeDeck`: page and all slots, all public classes/components, a null overview,
a page-only plugin, and a banner toggled from null to shown and back. Switch interactions
click the visible label and assert the input's checked state by role. The hello screenshot
uses the same settled capture and options as the page gate. The fixture build uses
`COMPUTEDECK_WEB_PLUGINS`, `COMPUTEDECK_HELLO_EXAMPLE` and `COMPUTEDECK_TEST_PLUGIN_SLOTS=1`;
normal builds neither load these fixtures nor expose example-mode slots. No live plugins or
external services are needed. The template itself is bilingual and skips its greeting API
read in example mode, so `demo.py` needs no new server data state for F4.

F4 intentionally changes every existing page's palette and shared typography/controls.
Its baseline coverage includes **all 96 existing page screenshots and their axe/DOM
records**, plus the fallback and hello screenshots. For intentional visual changes,
regenerate and review affected baselines, then run the full gate without `--update-snapshots`.
Local macOS baselines remain ignored; Linux artifacts
are reviewed and committed at PR time as before. No baseline is approved merely because a
regeneration command succeeds. In particular, inspect 375 px layouts and the Jobs
no-clipping regression check. The full six-shape/raster and persisted identity assignment tests
belong to F5; navigation/scroll chrome remains U1; private-plugin comparison and the advisory
pinned network-plugin run remain release follow-ups.

中文：F4 增加零依赖 token 生成器、兼容变量映射、颜色 lint、WCAG 对比度矩阵及
仅供参考的 APCA 报告。生成器需要 Node.js 22.18+ 或 24，拒绝 sRGB 溢出；浅色警告形状
的色度由 `.13` 微调到 `.1299`，避免蓝色通道略低于零。
本地 UI 脚本构建正常版、禁用 `light-dark()` 的兼容版及真实脚手架示例插件版。
测试覆盖系统/显式主题、增强对比度、设备设置持久化、空插槽、全部组件/类和横幅切换；
兼容版截图门禁仅在 Chromium 运行；WebKit 保留不截图的主题测试（axe 和计算颜色
一致性），以及 F6 的浮层测试。每周 WebKit 兼容版渲染属于非阻塞巡检，不纳入
PR 门禁。界面状态只依赖设备设置和双语测试插件，
无需修改 `demo.py`。F4 有意改变全站颜色和共享字体/控件，基线覆盖全部旧页面及
兼容版/插件截图。有意修改视觉效果时，重新生成并检查受影响基线，再运行一次
不更新基线的完整 UI gate。macOS 基线不提交；Linux 基线在 PR 时生成、审核并提交。
不得仅凭重新生成成功就接受基线；重点检查 375 像素布局和 Jobs 原因完整可见的用例。
F5 的完整状态形状/身份分配、U1 的导航与滚动边距、发布前的私有插件比较及固定版本
network 插件巡检仍由后续项目完成。

中文（F4 跟进）：兼容分支引用对应基础变量，lint 同时检查引用与基础变量值；八个上下文
中的任意声明被删除或改动都必须触发失败。斜线填充测试同时检查底色和叠加后的条纹，
增强对比度条纹透明度改为浅色 .72 / 深色 .60，使边缘对比度达到 3.18 / 3.22。
行高测试精确检查包含分隔线的单行/双行尺寸、两种设备密度、`.compact` 和粗指针，
并验证通用堆叠布局自然增高。新增 `cell-overflow` DOM 记录：可见的非 table-cell
显示模式 td/th 的 scrollHeight 大于 clientHeight + 1；种类、身份和数量纳入基线，
像素值仅供报告。hello 开关点击可见 label，按角色断言 checked 状态，截图使用统一
稳定捕获流程；兼容版基线采用可读的 `gallery-…` / `overview-…` 名称。


### F4 review corrections and follow-ups

Table cells inherit the default font size so `.mono` keeps its family and 12 px size,
while cell text keeps a 20 px line height and `.num` keeps tabular figures; headings and
`.stat-value` also preserve inherited numeric variants. Collapsed
borders remain part of the frozen table contract, including borders supplied on plugin
rows. The last row keeps a transparent 1 px bottom border so Chromium and WebKit use the
same collapsed hairline width; the existing exact row-height assertions remain unchanged.
The two-line padding selector has specificity (0,1,1), letting Plan and plugin padding
overrides win. The phone selector no longer needs
its extra `tr`. Compatibility styles use semantic hover/error backgrounds directly; a unit
test ensures their variables are all defined without legacy page styles.

`theme.spec.ts` checks computed table numeric variants, 12 px monospace cells and Overview
metrics, collapsed borders, zero stacked Plan cell padding and the option/explanation seam
in table layout. The hello plugin also asserts tabular numbers and collapsed borders.
Browser theme-colour metadata now uses the canvas colours and honours the device theme
choice, restoring OS media queries in System mode; unit and browser checks cover this.
No API, exported component DOM, locale keys or example-data states change.

**Deviation from proposal §3.3:** the hatch uses a dashed `--hatch-edge` (ink) instead of
`--border-strong`. This is deliberate: the edge must reach 3:1 against both the base and
composited stripe, including contrast-more. F5/P6 should keep this edge and its contrast tests.

**Deferred to U1:** make BrandMark monochrome (`currentColor`/ink) and remove
`brand-top`/`brand-middle`/`brand-base` from the token table and regenerated CSS. Add per-slot
error boundaries for banner and settings slots, with throwing-plugin fixtures proving the
frame and sibling slots survive. **Deferred to P1:** the same boundary and failure coverage
for each overview slot. Bare wrappers and null-slot hiding alone do not isolate exceptions.

**Baseline procedure:** F4's table changes affect Jobs, Clusters, Sources, Overview and
Plan, plus the compat gallery, hello and fallback counterparts. Review intentional geometry
and typography changes at 375/900/1280 across the six locale/theme combinations, then run
the full gate without updating snapshots. Keep local macOS baselines ignored; regenerate,
review and commit Linux baselines at PR time.

中文：F4 评审修复让单元格继承默认字号，保留 `.mono` 字体及 12 像素字号、20 像素文本行高、
`.num` 和概览指标的等宽数字，恢复折叠边框及插件行边框；末行保留透明的 1 像素底边框，
使 Chromium 和 WebKit 使用相同的折叠分隔线宽度，原有精确行高断言不变。双行内边距规则的
优先级降为 (0,1,1)，Plan 与插件可覆盖；移除手机选择器中多余的 `tr`。兼容样式直接使用
语义背景变量，并以单元测试保证不依赖旧页面变量。新增浏览器断言覆盖计算字体、12 像素字号、数字、
折叠边框、Plan 堆叠零内边距及桌面选项与解释之间的间距。浏览器栏主题色改为画布颜色，
跟随显式设备选择，系统模式恢复媒体查询；没有 API、导出组件 DOM、翻译键或示例数据变化。
明确记录与 §3.3 的偏差：斜线填充边缘使用墨色 `--hatch-edge`，确保底色及叠加条纹上的
对比度达到 3:1，F5/P6 应保留。U1 负责单色 BrandMark、删除三个品牌令牌，以及横幅和设置
插槽的独立错误边界与抛错测试；P1 负责概览插槽的对应测试和边界。
基线流程：F4 表格修改影响 Jobs、Clusters、Sources、Overview、Plan，以及兼容展示页、
hello 和兼容渲染版。按三种宽度、六组语言/主题组合检查有意修改的布局和字体，
再运行不更新截图的完整 UI gate。macOS 基线保持忽略；Linux 基线在 PR 时生成、审核并提交。

### F4 appearance review regression checks

`theme.spec.ts` checks that Plan's waiting verdict retains exactly one clock, uncoloured
and `.wait` pills gain no shape, and coloured pills never add a mask beside an existing
icon. `checkLayout` reports visible text below 12 px or outside weights 400/600; Plan,
Activity and Usage must have zero such findings. A probe verifies the guard detects both
violations and ignores hidden text. The base styles set heading weights to 600 and give
`small` a 12 px floor. The current navigation item uses a straight 2 px pseudo-element bar.

Appearance selects use namespaced IDs and role/name queries. The inline head bootstrap
applies saved theme, density and browser chrome media before the application bundle;
unit tests cover both themes, invalid values and blocked storage. A browser test blocks
module downloads and checks the saved appearance still applies. The scaffold test keeps
slot/component/class coverage; rendered hit areas remain gated by plugin axe tests.
No API, exported component DOM, locale keys or example-data states change.

**Q3 CHANGELOG, For plugin authors:** retain the coarse-pointer selector list and the
`44px !important` minimum dimensions from the [styling contract](plugins.md#styling-contract-web_api-1),
including their effect on inline `.link` controls and compact toolbars.

中文：主题测试检查 Plan 等待标签恰有一个时钟，无颜色及 `.wait` 标签不添加形状，
带图标的彩色标签不重复添加掩码。`checkLayout` 报告可见文字小于 12 像素或字重不属于
400/600；Plan、Activity、Usage 必须零违规，并有探针验证检测与隐藏文字排除。
基础样式将标题字重设为 600、`small` 下限设为 12 像素；当前导航使用笔直的 2 像素指示条。
外观控件使用带命名空间的 ID，测试按角色和名称定位。head 内联脚本在应用脚本加载前
设置主题、密度及浏览器栏主题色；单元测试覆盖两种主题、无效值与存储受限，浏览器测试
阻止应用脚本下载后验证设置仍生效。脚手架保留插槽、组件与类覆盖，点击区域由插件
axe 测试验证。API、导出组件 DOM、翻译键和示例数据状态不变。
Q3 的 CHANGELOG「For plugin authors」须保留样式约定中的粗指针选择器列表和
`44px !important` 最小尺寸，说明对文字内 `.link` 控件和紧凑工具栏的影响。

### F5 display primitives

**Gallery and contracts.** `#/__gallery` retains the WEB_API 1 samples and adds the core
components in `web/src/ui/`: six SVG statuses, value kinds, time disclosures and durations,
ages, scope and server-rule disclosures, six identity swatches/monograms, copy feedback
and six data states. Fictional readings and the rule trace come from `demo.py` through
`display_example`; example mode never writes live configuration. Frozen `ui.tsx` exports
keep their DOM. Compat pills use CSS masks from the same shape definitions; their ok,
warn and error outlines changed slightly in 0.8.

Inline unknown values use a plain `--fg-subtle` dash beside their reason, matching the
mockup; hatching remains for cells and swatches. Copied commands declare `lang="en"`
inside localized labels.
Time disclosures use phrasing-only buttons and spans, valid inside paragraphs and values;
rule disclosures use `details` outside paragraphs. Both expand in flow. Non-today readings
show the local date while collapsed. Passing `descriptionId` renders a plain `time` and
an always-available screen-reader description for the row link, with no extra tab stop.
Prose durations use localized messages consistently across engines, including a labelled
zero below one minute. The shared clock publishes whole-minute snapshots at minute
boundaries and immediately updates labels when the 12/24-hour setting changes.

**Automated coverage.** Unit tests cover both locales, durations with and without native
DurationFormat available, today/older dates, one shared timer with cleanup, unknown/stale
values, clipboard errors, all display states and the plugin formatter callback contract.
Server tests cover persistence, deletion/reuse, six distinct automatic slots, balanced
sharing, explicit overrides and config merge/round trips, read-only stores, cloud login
rename/removal, and a literal demo slot map. A frontend test reads the real server demo
and requires every group key to resolve to its server slot, including reordered sources.

The shape rows request 8/10/12/16 px in normal and grayscale, clamped to 10 px (12 px for
the dashed ring). Standalone shapes support localized accessible names and severity
prefixes; unlabelled shapes are decorative. Monograms retain the full accessible name
and grow to fit their initials. The off shape is a 10×10 rounded square at (1,1), radius
0.5, in the 12-unit viewBox, enlarged from the mockup to distinguish it from the circle.
The browser raster gate compares all 15 pairs at 10 px in grayscale, requiring at least
eight equivalent differing pixels and reporting the complete matrix. A Vitest geometric
check supplements it with supersampled circle/square coverage and corner checks.
**Implementation deviation:** rasterisation uses Chromium's real canvas in Playwright;
jsdom's canvas needs an additional package. The browser gate remains required.

`display.spec.ts` covers normal/forced-colors screenshots, axe, Enter/Space/Escape time
controls, row descriptions without time buttons, persisted clock choice, older readings,
local-only copy feedback, and unknown-reason contrast on every semantic background in
normal and contrast-more modes. Token contrast tests check both themes and contrast modes.
The gallery must have zero DOM findings collapsed and expanded, and zero expanded-state
axe violations across all six viewport/locale/theme combinations. Coarse-pointer controls
and the row link have 44×44 px minimum targets. The rule summary retains its native
list-item marker; its padding provides the target height. The grayscale caption is a
12/16 px heading with the same 16 px inline gutter as the samples.

`ready()` excludes busy descendants only within the gallery's explicit `data-static-sample`
wrapper for the loading sample. The sample retains `aria-busy="true"`. A busy wrapper,
an unmarked gallery region, or any busy region on a real page still blocks readiness.
The gate rejects the marker outside the gallery; unit tests enforce its source usage.

**Screenshots.** Review local gallery, gallery-compat, Settings, fallback gallery,
hello-page and pages with group marks or compat pills after intentional display changes.
Display screenshots are `display-none.png`, `display-active.png`,
`display-reasons-no-preference.png` and `display-reasons-more.png` across all six Chromium
combinations. Run the full UI gate after reviewing updates. macOS baselines remain ignored;
Linux baselines are generated/reviewed at PR time. Unit tests and compilation never update
baselines.

**中文：画廊与约定。** F5 保留 WEB_API 1 样例，新增状态、数值、时间、时长、数据年龄、
范围、服务端规则说明、标识颜色、复制反馈与六种数据状态。示例来自 `demo.py`，不写入
真实配置。插件导出组件 DOM 不变；兼容状态标签共用 SVG 蒙版，正常、警告和错误轮廓
在 0.8 中略有调整。行内未知值按参考稿使用 `--fg-subtle` 纯色长横线，旁边显示原因；
斜纹保留给单元格与色块。复制命令在本地化标签中声明 `lang="en"`。
时间使用可置于段落中的按钮与 span，规则使用段落外的 details，均原地展开。
非当天读数在收起时也显示本地日期；`descriptionId` 模式只输出 time 和行链接的屏幕阅读器
描述，不增加焦点。各浏览器使用一致的本地化时长，不足一分钟显示带单位的零。
共享时钟只在整分钟边界及 12/24 小时设置改变时更新标签。

**中文：自动测试。** 单元测试覆盖双语、原生 DurationFormat 存在与否时的一致输出、
当天与旧日期、共享计时器及清理、未知与过期值、复制失败、全部数据状态和插件格式化回调。
服务端覆盖色位持久化、删除与复用、六组互异、均衡共享、显式覆盖、合并导入与往返、
只读数据库、云登录改名与删除，以及固定的演示色位映射。前端直接读取服务端演示，
验证每组都能查到服务端色位，且顺序变化不影响结果。
形状展示请求 8/10/12/16 px，实际最小为 10 px（虚线圆为 12 px），覆盖灰度与强制颜色。
独立形状可提供本地化名称和严重程度前缀，无标签形状仅作装饰；字母标记保留完整名称。
停用形状为 (1,1) 的 10×10、圆角 0.5 方形，比参考稿大，以便区分圆形。
浏览器栅格门禁在 10 px 比较全部 15 对形状，每对至少八个等效像素差，并报告完整矩阵。
Vitest 几何超采样补充覆盖面积和圆角检查。实现偏离：jsdom 缺少无需额外依赖的 canvas，
因此使用 Playwright 的 Chromium canvas，浏览器门禁仍然必需。

浏览器测试覆盖普通与强制颜色截图、axe、时间键盘操作、无额外按钮的行描述、时间偏好
持久化、旧读数、仅本地复制，以及普通和高对比度下各语义背景的未知原因对比度。
令牌测试覆盖两种主题和对比度模式。六种组合均要求收起与展开时无 DOM 问题、展开后
无 axe 违规；粗指针控件及行链接至少 44×44 px。规则摘要保留原生列表标记；灰度标题
使用 12/16 px 和与样例一致的 16 px 留白。ready() 只排除画廊静态加载样例显式包装内
的忙碌后代，样例仍保留 aria-busy；其他忙碌区域阻止就绪，画廊外禁止此标记。

**中文：截图。** 显示变化后审核本地画廊、兼容画廊、设置、兼容色彩画廊、hello 页面及
使用组标记或兼容标签的页面。显示截图为上述四个文件名，覆盖六种 Chromium 组合。
审核更新后运行完整门禁；macOS 基线保持忽略，Linux 基线留待 PR。单元测试和编译不改基线。

### F6 layers and interaction checks

**Automated coverage.** `web/e2e/layers.overlays.spec.ts` runs in the six Chromium and
six WebKit projects. To run only its tests with the isolated service:

```sh
layer_checks='C1|C18|documented layer address|tool and marketplace'
layer_checks+='|phone detail|focus visibility probe|source Next|beside j/k'
layer_checks+='|health pill|beside panel retains|Toolbox tab changes'
bash scripts/check-ui.sh "$layer_checks"
```

The suite checks beside panels versus modal sheets, heading focus and focus return,
Escape/Back, cold links and resize across 1200 px. Focus views and nested confirmations
check safe focus, no backdrop dismissal, lower-modal inertness and both Tab directions.
Menus cover keyboard navigation, flipping clear of the trigger and touch sheets; Vitest
also checks typeahead. Outside clicks on blank content return focus to the popover trigger;
clicking an outside input closes the popover and lets it receive focus and typed text.
Three toasts share the modal host; Undo pauses on hover/focus, errors persist, and
Escape clears toasts first. The Command/Ctrl+Z handler is tested with Command+Z in browsers.
Every documented layer address in [configuration.md](configuration.md#panels-forms-and-notifications)
is checked cold, through Escape, and via warm open plus Back, preserving other filters;
step changes replace the entry. Tool and marketplace URLs, j/k over displayed rows in
both directions, and the phone action bar with measured scroll padding are covered too.
Vitest checks prior inert-state restoration, out-of-order closes, unchanged non-modal
layers, outside clicks/labels without suppressing later pointer sequences, and cancellation
as Keep exactly once on hash/history changes, including tool-enable consent.

Coverage also includes health-pill positioning and focus return in both engines,
edited Jobs filters surviving Escape/Close, Back after filtering, Toolbox tab cleanup,
and bottom toast placement after mouse clicks. Source diagnosis panels focus their
heading at all widths. After j/k, Escape returns focus to the stepped row.
The address table includes saved-source step 3; bilingual unit tests require no
POST /check or saved-settings claim until an explicit check, and verify Save still
starts the check. Unsaved step-3 links explain the missing source.
Vitest also checks settings saves, plain-toast expiry at 4.5 seconds, Undo expiry
after hover/focus ends, and preserved time and pause state across modal-host changes.
The gallery confirmation names the removal outcome; form labels use stacked spacing.

For WebKit's tab-to-text-fields default, the modal trap moves every Tab/Shift+Tab itself.
For WebKit's nested-modal behaviour, the stack explicitly marks lower modal layers `inert`.
`checkFocus` measures immediately, then waits up to three animation frames for the browser's
own reveal of a just-focused control that is not exposed; WebKit reveals asynchronously.
It never scrolls for the browser or relaxes the exposure test; Chromium's immediately
exposed controls are unchanged. A fixed-cover probe proves covered controls still fail.

**Screenshots.** Overlay baselines are `context-panel.png` and `modal-toasts.png`. The beside panel
meets the current top bar and bottom chrome without canvas gaps; its width and list
margin use `--panel-w`. The gallery's
Layers section uses the example-only `layer_example` dashboard field and changes the
normal gallery, fallback-gallery and `display.spec.ts` gallery baselines. Review intentional
updates using the existing baseline workflow; tests and compilation do not approve them.
See [layers-spike.md](layers-spike.md) for the decision record and owner-only manual checklist.

**中文：F6 浮层检查。** `layers.overlays.spec.ts` 覆盖六种 Chromium 和六种 WebKit 组合，
上面的筛选命令只运行该文件的测试。检查旁侧面板与模态抽屉、标题焦点与焦点恢复、
Escape/返回、直接链接和跨 1200 px 缩放；聚焦视图及嵌套确认检查安全初始焦点、遮罩不关闭、
低层模态 inert 和双向 Tab。菜单覆盖键盘、避免遮住触发控件的翻转与触屏抽屉，Vitest 另查
按字检索。点击浮层外空白内容后焦点回到触发控件；点击外部输入框则保留其聚焦与输入。
三条通知共用模态内宿主，检查悬停/聚焦时撤销暂停、错误持续显示、Escape 先清通知；
Command/Ctrl+Z 共用的撤销处理器在浏览器测试中通过 Command+Z 验证。配置文档的每种浮层地址均覆盖
直接打开、Escape、压入历史后返回及筛选保留，步骤变更替换历史项；另查工具/市场面板
URL、j/k 双向遍历实际显示的行、手机操作栏与实测滚动留白。单元测试验证原 inert 状态
恢复、乱序关闭、非模态层不变、空白/输入框/标签外部点击不影响后续指针序列，以及
hash/历史变化将待确认操作（含工具启用授权）按“保留”取消且只返回一次决定。
WebKit 默认只 Tab 到文本框，因此模态焦点循环自行移动每次 Tab/Shift+Tab；其嵌套模态
行为由显式设置低层 inert 补足。焦点检查先立即测量，不可见时最多等待三个动画帧，让
浏览器自行显露焦点；不代替浏览器滚动、不放宽遮挡判定，立即显露的 Chromium 控件不受
影响，固定遮罩探针仍须报告失败。新增截图为 `context-panel.png` 和 `modal-toasts.png`；
示例专用 `layer_example` 驱动的 Layers 区块改变普通画廊、兼容渲染画廊和 display.spec
画廊基线，须沿用既有流程审核更新。决策与人工检查清单见 [layers-spike.md](layers-spike.md)。

中文：还覆盖双引擎健康按钮定位与焦点恢复、修改 Jobs 筛选后 Escape/关闭仍保留筛选、
筛选后的返回、工具箱标签清理、鼠标点击后通知底部位置。来源诊断面板在所有宽度聚焦
标题，j/k 后 Escape 回到当前行。地址表包括已保存来源的第 3 步；双语单测要求显式
检查前无 POST /check、无已保存声明，并验证保存仍启动检查。未保存链接说明前提缺失。
单测另查设置保存、普通通知 4.5 秒过期、撤销暂停结束后的剩余时间，以及模态宿主切换
不重置时间或暂停。示例确认明确移除结果，表单标签使用上下排列间距。

旁侧面板紧贴当前顶栏与底部栏，不留画布间隙；宽度和列表留白共用 `--panel-w`。

### Live-data regression checks

`live.spec.ts` checks the four conditional reads at the fine/coarse pointer cadence,
unchanged response bodies totalling at most 1 KB, retained row elements and focus, and
one polite transition announcement in both locales. The tests use the existing fixed
example data and inject one job-state transition; they do not contact providers or add
new screenshot baselines. Existing page screenshots must remain identical.

Vitest profiles the mounted App on Jobs: both fine and coarse unchanged polls produce
zero React commits. Store tests check one publication for changed data, no publication
for equal snapshots, row sharing across changes/reorders/removals, source-scoped row IDs,
and content comparison without revisions. Clock tests prove that age text updates while
its parent does not rerender. Minute-clock updates and the legacy chart's independent
window timer are time updates, not poll commits; F8 replaces that chart. The planner
also rechecks time-dependent machine eligibility on the minute clock, and running-cost
labels keep advancing. Its ranking rules are unchanged.

Pytest covers auxiliary since-tokens, plugin changes, external writes, row revisions,
compression negotiation and the combined unchanged payload budget. Source checks keep
streaming their NDJSON without gzip buffering. The health path remains dashboard-free.

`live.spec.ts` 检查精细／粗略指针的轮询周期、四个未变响应正文总计不超过 1 KB、行元素与
焦点保留，以及两种语言共用一个礼貌播报区域。测试复用固定示例数据并注入一次作业状态
变化，不访问外部服务，也不新增截图基线。现有页面截图应保持一致。

Vitest 对 Jobs 中挂载的 App 计数，精细和粗略指针的未变轮询都必须产生零次 React 提交。
行存储测试覆盖变化时一次发布、相同快照零发布、重排／删除／更新的结构共享、按来源区分
行 ID，以及没有 `rev` 的内容比较。时钟测试确保只有年龄文字更新，父组件不重绘。
每分钟的时间文字更新和旧图表的独立窗口计时不属于轮询提交；F8 将替换旧图表。规划页
也按分钟重新检查机器样本的有效期，运行费用文字继续更新；排序规则不变。

Pytest 覆盖辅助接口令牌、插件变化、外部写入、行内容标识、gzip 协商与总正文预算。
源检查保持 NDJSON 流式返回，不因压缩而缓冲；健康接口仍不构建仪表盘。

### F7 review corrections and follow-ups

Twin-login job observations are matched by dashboard job ID for transition announcements;
changing only the source login stays silent. Both failure end labels tick on the shared
minute clock. Usage's running-cost visibility condition also uses that clock. The pointer
rule applies even in WebKit hosts with message handlers. A retained dashboard after a 401
leaves the health pill Unknown; the health panel already receives null data at the token
gate. Transition announcements expire after 4.5 seconds while the live region stays mounted.

Bilingual Vitest cases cover twin-login changes, failure end ages without a poll, and
retained-data authentication failures in both pill and panel. Further tests cover coarse
WebKit cadence and announcement replacement/expiry without dismissing persistent errors.
The live Playwright test checks expiry, unchanged region identity and retained row focus.
No screenshot baseline or CSS/API contract change is intended.

Mode-switch lifecycle tests cover both directions in English and Chinese with the new
dashboard held pending: required plugin pages keep their state and health props without
remounting, and plugin, Notify and Chat links stay present. Transition tests also check
sentence separators and a localized health prefix, including an Unknown status after a 401.

- **P3/Q2:** move Activity's 15-second polling to `usePollCadence` and its arrivals
  announcement into the shared toast region, avoiding duplicate job-change announcements.
- **Q2:** avoid serializing dashboard rows once for revisions and again for the response.
- **Q2:** replace the streaming `Content-Encoding: identity` workaround with content-type
  exclusions, including plugin NDJSON. The installed Starlette supports exclusions; using
  that option across the supported FastAPI dependency range needs a separate compatibility
  check. Changing the runtime floor or adding a wrapper is deferred from this correction.
- **Q3 CHANGELOG, For plugin authors:** the host no longer rerenders plugin pages or slots
  on a timer; `format.relativeTime` output does not tick by itself. Plugins own their time
  updates and timer cleanup. Record the streaming-route compression guidance in plugins.md.

中文：按仪表盘作业 ID 判断变化，双登录仅切换来源时不播报；失败表和详情的结束时间
按分钟更新，Usage 的运行费用显示条件也使用共享时钟。WebKit 消息处理器不覆盖指针周期。
401 后即使保留仪表盘，健康按钮仍显示未知；面板已有令牌失效时接收 null 数据的保护。
变化播报在 4.5 秒后清除，播报区域保持挂载。双语单测覆盖上述作业、时间及认证回归，
另查粗指针 WebKit、播报替换和过期不影响持续错误；浏览器测试验证过期、区域及行焦点
保留。无预期截图基线、CSS 或 API 约定变更。

模式切换生命周期测试覆盖中英文及双向切换，在新仪表盘尚未返回时验证依赖工具的插件
页面保留状态和健康属性、不重新挂载，插件、Notify 与 Chat 链接持续显示。变化播报测试
另查句子分隔符及本地化健康前缀，包括 401 后的未知状态。

后续：P3/Q2 统一 Activity 的轮询周期和播报区域；Q2 避免行重复序列化，并用内容类型
排除替换流式响应的 identity 临时措施（需单独核查当前依赖范围内的兼容性）。
Q3 的 CHANGELOG「For plugin authors」须说明宿主不再定时重绘插件、relativeTime 不会
自动更新、插件自行管理计时器及清理，并保留 plugins.md 的流式路由压缩说明。

## Chart kit checks

The Usage trend deliberately changes to stacked plots. `chart.spec.ts` covers keyboard
and click/tap pinning, range changes, restored historical windows, the exact Activity
request bounds, table paging, axe, and normal/forced-colors screenshots in all six
Chromium combinations. The existing Usage UI screenshots also change; other page
baselines should remain unchanged. Review the local Usage and new `chart-*.png`
baselines before updating them, then run the full gate without snapshot updates.
Linux baselines follow the existing CI artifact procedure.

Python tests cover raw (unthinned) aggregation, all bucket sizes and edges, unknown
versus zero, min/mean/max, source coverage, collection intervals, lower bounds, old
records, deterministic demo states and Activity bounds before grouping. Cadence tests write
10-minute and hourly history, check held readings and stale expiry, and keep expected-sample
shortfalls separate from source completeness. Invalid Activity end dates name the end time. Vitest covers
one plot tab stop, all chart keys, IME/modifier guards, pin retention across updates,
mouse/touch behavior, table equality, identity collisions and disconnected geometry. Checks
also cover Escape bubbling, merged gap bands, CSS-pixel sizing, axis labels, compact time
disclosures and chart-only bucket-boundary refreshes that preserve rollups. Playwright
checks the padded controls and their span labels at every viewport.
The previous TrendChart outage/partial tests now exercise server-shaped buckets; the
old ten-second timer test asserts stable geometry and shared-clock labels instead.

Usage's existing daily GPU-hours/spend breakdown and projection copy are left for P4;
Overview adoption belongs to P1. U2 can register the chart's focused-widget key handler
in its shared key registry. No chart gestures perform writes to a cluster or cloud.

### 图表检查

Usage 趋势有意改成上下分图。`chart.spec.ts` 在六种 Chromium 组合检查键盘、点击/轻触
固定、切换范围、历史窗口重载、动态精确边界、表格分页、axe 和正常/强制颜色截图。
既有 Usage 截图及新增 `chart-*.png` 需要审阅更新，其余页面应不变。更新后重新运行
完整门禁；Linux 基线仍按 CI 产物流程生成。

Python 覆盖原始未抽稀分桶、边界、未知与零、极值均值、覆盖数、周期、下界、旧记录、
确定性示例和分组前时间过滤；另写入 10 分钟及小时采集历史，检查沿用读数、过期和
预期样本不足不影响源完整性，并检查动态结束时间错误提示。Vitest 覆盖单焦点、全部键位、输入法/修饰键、更新后
固定读数、触摸、表格一致性、身份色冲突及断线，还检查 Escape 传递、合并间隙、实际
像素尺寸、纵轴、紧凑时间展开及跨桶仅刷新图表并保留汇总。Playwright 检查各宽度工具
行的内边距和时长标签。旧图的断档/不完整测试迁移为服务端
形状的分桶测试，10 秒计时器测试改为图形保持不变且共享时钟更新标签。

P4 负责每日 GPU 小时/费用明细和预测文案调整，P1 负责 Overview 接入；U2 将图表焦点
键位纳入共享注册表。图表交互不会写入集群或云端。

### F8 review corrections

Regression tests cover idle/CPU-only/linked-instance utilization exclusions and unknown
allocation subjects (a failing source and an unreachable monitored manual machine)
remaining in the utilization total, contiguous gap runs, demo source counts/cadence,
`[` / `]` paging with retained plot focus and the live no-op, compact readouts, live/dated
edge ticks, and labelled empty states. Activity tests
cover valid, invalid, reversed and equal intervals, range-chip replacement, both Clear
controls and filtered empty wording in English and Chinese. The Playwright chart checks
also assert that coarse-pointer hints remain described but are visually hidden.

The additional week-total request has neither `chart=1` nor `end`.
Follow-ups remain P4 local-date day buckets and Q2 evaluation of an additive `points=0`
option for chart-only refreshes, which still return the legacy points array.
Usage and `chart-*.png` baselines change for the live “Now” tick, dashed now rule,
dated edge ticks, compact 24 h readouts, keyboard hints hidden on coarse pointers,
and example coverage/cadence at 375, 900 and 1280 px in the existing locale/theme matrix.
Other baselines stay unchanged. Linux baselines still come only from CI.

中文：回归测试覆盖空闲/纯 CPU/同节点来源不计入利用率总数，以及分配量未知的对象
（故障来源、无法连接的受监测手动机器）仍计入利用率总数、连续缺失段、示例来源数及
周期、`[` / `]` 翻页保留图表焦点和最新窗口无操作、紧凑读数、现在/日期端点、带标签
空状态。动态测试覆盖有效/无效/倒序/相等时段、范围切换、两个清除入口及双语筛选空状态。
浏览器用例另查粗指针提示视觉隐藏且保留无障碍描述。额外周汇总请求不带 `chart=1` 或
`end`。后续仍为 P4 本地日期日区间、Q2 评估 `points=0`。Usage 与 `chart-*.png` 基线
因实时“现在”刻度、现在虚线、带日期的边缘刻度、紧凑的 24 小时读数、粗指针下隐藏
键位提示、示例覆盖数及采集周期而变化，覆盖既有 375、900、1280 像素及语言/主题矩阵。
其余基线保持不变，Linux 基线仅来自 CI。

### Foundation checkpoint corrections

The checkpoint adds literal 0.7 (`eace2d4`) DOM assertions for all eight exported
WEB_API 1 components, including both Switch modes and unknown Meter. The scaffold's
spinner is its own 16 px SVG; its motion-enabled browser test bounds every sampled box.
The frozen `.spin` rule and `ui.tsx` component DOM remain unchanged.

Core pages use `StatusLabel` with `statusKind` / `statusKindLabel`; the legacy `Status`
export remains for plugins until each page migrates. `computeHealth.level` uses the
same six kinds, and the health pill draws the corresponding SVG. Group `slot` is
one-based, while legacy `color` remains zero-based. Identity marks accept a group;
name-adjacent monograms use `decorative`.

`Value`'s inline estimate word is opt-in (`label`); scope lines can carry the word once.
Both Value and ScopeLine forward `descriptionId` to a non-interactive Time in row links.
ScopeLine accepts a time label and trailing content, CoverageLine names exceptions,
and quiet/first DataState accept page-specific title, text and actions. Future times
say “in …”; prose durations include seconds and days. Fractional bounds round down.

`ctx.copy(text, {kind: 'command' | 'link' | 'text', message?})` and CopyButton use one
service and the existing toast announcement. Only command copies in example mode
append `# example data`; text and links remain exact. CopyButton reads the service from
context, with no per-call example flag or second live region. Success feedback now uses
the shared toast lifetime instead of the former button-local two-second status.

`ctx.actions` and the corresponding top-level handlers keep stable identities while
reading current committed data. Memoized rows can take a row plus actions. Source Test and
Collect share operation state; collection stays in flight until an accepted
poll shows completion. Pause in the diagnosis offers Undo, including while a read-only check is running. U2 can use these same handlers;
server-side draft checks and authentication cooldown remain P8 (0.8.x).

Detail keys are centralized in `layers/routes.ts`. Steppable containers declare
`data-detail-list`, so separate lists never merge. Only `section=ssh` is an overlay;
Settings sections survive form operations. Menu triggers accept children/className and
an accessible label; stable item ids and radio/checkbox checked states are supported.

Toast tests cover Undo, Dismiss, Meta-Z and Escape focus return, plus error-row removal.
On-ink focus and hover colours and chart hatch edges use contrast-gated colours.
All axe runs share the complete WCAG 2.2 AA tag set, including `wcag21a`. Service 5xx
responses fail the fixture; fulfilled failure fixtures remain usable. Failed UI runs
print and retain the service log in `web/test-results/service.log`. CI allows 60 minutes
and four workers. The Jobs guard is named `@reason-visible`; P2 must preserve it.

Local UI verification and screenshot updates remain required outside the socket-restricted
sandbox. Expected visual changes include the scaffold spinner, health shape, time/duration
labels, copy feedback and toast focus/hover. No baselines were regenerated in the sandbox.
U1 still owns migrating the legacy frame CSS bands to `breakpoints.ts`; P1–P6/Q1 own
replacing remaining legacy core Status/GroupMark usages. P4 owns selecting five groups
plus Other and rendering the new usage series. The existing compact runDuration API is
kept for existing callers; its removal is deferred rather than changing their rounding.

## Quiet interface

A row is one line and a cell holds one value. A fact that matters in a list has its own column,
named by its header; anything else is in the detail drawer. A number's meaning comes from its
tile label or column header. A secondary line stays only where it shows an exception the user
must act on, such as a collection error under a Clusters account. When reviewing a screenshot
diff, check that:

- A partial total keeps `≥`, and the number itself is the trigger: “≥ 27” has a dotted
  underline and the accessible name “≥ 27, 6 not counted”. It opens a list of each
  unmeasured source or machine with its reason; each entry opens its diagnosis or machine. No
  “not counted”, “unpriced” or “jobs unknown” text appears beside numbers. Unknown stays `—`.
  Vitest covers this in `quiet-markers.test.tsx`.
- A main page shows what and its state, never why; the reason is one click away in a detail
  pane, and no row text is truncated. Attention rows: dot, short title, age, one dismiss (×)
  button; snoozing is in the item's detail pane; example data dismisses on the page only.
  Activity rows: dot, what happened in a few words, source, time; the full sentence, changed
  fields and notification results are in the event's details.
- Job rows read Job, User, Cluster, Queue, GPUs (“8 × H100”), State, Node or reason (the node,
  or a short reason label such as “User limit”), Time. The reason sentence and the raw
  scheduler code are in the job drawer; a stale row is dimmed with one mark in its
  State cell. Columns leave lowest priority first as the table narrows (container queries), so
  no row wraps at 1280 px; beside an open drawer the reason column stays fully readable.
- On a phone a list row is a card: name and state on the first line, one meta line under it.
- The phone top bar and the example-data banner each fit on one line; filter chips scroll
  sideways in one row.

中文：一行只有一行，一个单元格只放一个值。列表里重要的事实有自己的列，由列头说明；其余放在
详情抽屉。部分合计保留 `≥`，数字本身就是按钮（虚线下划线，读屏名称如“≥ 27，6 项未计入”），
点开列出每个未计入的来源或机器及原因；数字旁不再有“未计入”“未定价”等文字，未知仍显示
`—`。待处理和活动各占一行；作业表列为作业、用户、集群、队列、GPU、状态、节点或原因、时间，
窄时先隐藏优先级低的列。手机上每行是卡片：第一行名称和状态，下面一行信息。
