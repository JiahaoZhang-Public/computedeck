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
data on success or failure. Its EXIT trap preserves the original status, including shell
errors (with a completion guard for Bash 3.2 nounset errors that report status zero),
and it returns non-zero on failed builds, size checks, startup or UI checks. Optional
arguments work with macOS `/bin/bash` 3.2, including a full run without a page filter.
An optional argument filters test titles, including page names. The Chromium channel can
be selected with `PLAYWRIGHT_CHANNEL`; on macOS, missing bundled Chromium automatically
selects installed Google Chrome. Missing local WebKit prints **WebKit not installed —
skipped**. CI always includes WebKit; F6 adds its overlay tests to `*.overlays.spec.ts`.
No browser or package downloads happen in this script.

`COMPUTEDECK_DEMO_NOW` accepts an ISO datetime with a timezone. It freezes only example
responses (dashboard, history, events and collection nodes), in UTC, rounded down to the
minute. Invalid or timezone-less values fail explicitly. The default continues to use the
current minute. Example summary freshness and history rollups use the same clock; live
collection and live API clocks are unchanged. The harness uses `2026-01-15T14:00:00Z`,
Playwright's fixed browser clock and UTC. In the test transport only, health's host name,
database path and service start time become generic stable values so public artifacts
contain no developer paths and do not vary with service restarts. Metrics are not mocked.
The only screenshot mask is Settings → Service → Address (`.page-settings .kv > div >
dd.mono`), whose value contains the throwaway service's random port. The shared screenshot
options mask exactly that value with `#808080` in both baseline assertions and raw captures
for fresh-context comparison. No other element is masked; product code is unchanged.

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
  glyphs does not satisfy the guard.

The separate **jobs reason at 1280 zh with panel open** check is expected to fail until P2.
It checks text clipping and drawer occlusion after independently asserting the page and
panel loaded. An unexpected pass fails too; remove the expected-failure marker in P2.
Other browser errors and focus-coverage failures still fail directly. DOM findings are
compared with their reviewed baselines rather than marked expected-fail.

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
Playwright suite) and, from `web/`, `npx --no-install playwright test --list`. The browser
UI gate requires the orchestrator's unsandboxed environment. Never skip socket-based
service/security tests or weaken assertions to make the sandbox pass.

## Gallery and size budget

`#/__gallery` shows the existing public components; `#/__gallery?compat` exercises the
frozen CSS classes and 19 public tokens plus `--accent-hover` and `--text-muted`. It is
an unlisted development route, available in either language. Its controls change only
local gallery state. The gallery adds no token aliases and does not change existing
component DOM or page styling; the missing `--text-muted` alias remains visible for F4.

The build emits Vite's standard manifest. `scripts/build.sh` removes `.vite` from the
copied package assets, so the wheel and sdist do not ship or serve the manifest; the
original in `web/dist` and the temporary UI build remain available for size checks. `web/scripts/check-size.mjs` traverses static
imports for initial JS (200,000 bytes gzip ceiling; 160,000 target), checks each non-initial
chunk (30,000; palette 15,000) and all CSS (16,000). `check.sh` runs this after the build.
F3 will tighten the initial-JS gate to 170,000 bytes as routing becomes lazy. Runtime
performance budgets remain Q2 work.
