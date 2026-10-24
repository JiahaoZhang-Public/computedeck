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
skipped**. CI always includes WebKit; F6 adds its overlay tests to `*.overlays.spec.ts`.
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

The separate **jobs reason at 1280 zh with panel open** check records a known failure until P2.
It checks text clipping and drawer occlusion after independently asserting the page and
panel loaded, and asserts that at least one reason is clipped. P2 must change that assertion
to require no clipping; a fix before then fails this check and prompts its update.
Other browser errors and focus-coverage failures still fail directly. DOM findings are
compared with their reviewed baselines rather than marked expected-fail.

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
coverage; F5 adds the new display primitives; F6 adds layers in both engines; U1/U2 add
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
palette 15,000), as is all CSS (16,000). `check.sh` runs this after the build.
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
its own CSS. The new focus-view wizard and palette remain later items (F6 and U2).

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
F6's future overlay suite. The weekly WebKit fallback-only render is advisory, outside the
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
regeneration command succeeds. In particular, inspect 375 px layouts and the old Jobs
reason-clip assertion. The full six-shape/raster and persisted identity assignment tests
belong to F5; navigation/scroll chrome remains U1; private-plugin comparison and the advisory
pinned network-plugin run remain release follow-ups.

中文：F4 增加零依赖 token 生成器、兼容变量映射、颜色 lint、WCAG 对比度矩阵及
仅供参考的 APCA 报告。生成器需要 Node.js 22.18+ 或 24，拒绝 sRGB 溢出；浅色警告形状
的色度由 `.13` 微调到 `.1299`，避免蓝色通道略低于零。
本地 UI 脚本构建正常版、禁用 `light-dark()` 的兼容版及真实脚手架示例插件版。
测试覆盖系统/显式主题、增强对比度、设备设置持久化、空插槽、全部组件/类和横幅切换；
兼容版截图门禁仅在 Chromium 运行；WebKit 保留不截图的主题测试（axe 和计算颜色
一致性），以及 F6 后续的浮层测试。每周 WebKit 兼容版渲染属于非阻塞巡检，不纳入
PR 门禁。界面状态只依赖设备设置和双语测试插件，
无需修改 `demo.py`。F4 有意改变全站颜色和共享字体/控件，基线覆盖全部旧页面及
兼容版/插件截图。有意修改视觉效果时，重新生成并检查受影响基线，再运行一次
不更新基线的完整 UI gate。macOS 基线不提交；Linux 基线在 PR 时生成、审核并提交。
不得仅凭重新生成成功就接受基线；重点检查 375 像素布局和 Jobs 已知裁剪用例。
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

Unknown values hatch only the small dash box, leaving the reason on a solid background.
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
在 0.8 中略有调整。未知值只在短横线小框上绘制斜纹，原因文字位于纯色背景上。
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
