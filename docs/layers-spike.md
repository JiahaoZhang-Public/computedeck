# F6 native layers decision

Decision: keep native `HTMLDialogElement.showModal()` for sheets, focus views and
confirmations, and a plain non-modal `aside` at widths of at least 1200 px.
Menus/popovers use manual placement (no Popover API); touch menus use a sheet.
One stack owns Escape, native cancel, focus return and the active toast host.
While modals are stacked, it explicitly makes lower modal layers inert (WebKit
otherwise leaves them focusable), restoring each layer's prior inert state even
when layers close out of order. Non-modal layers are not changed by this rule.
Outside dismissal on non-focusable content preserves trigger focus; a click on a
focusable control keeps that control's normal focus and click behaviour. This
suppression is limited to the dismissal's pointer sequence. Pending confirmations
resolve as Keep on both hash navigation and browser history navigation.
No runtime dependency was added. The eight WEB_API 1 components retain their DOM.


Health popovers capture the pointer-aware opener. Closing a beside panel preserves
filters changed while it was open and returns focus to the current subject's row,
falling back to the opener if that row is gone. j/k reveals the stepped row.
Toasts retain their remaining lifetime and pause state across modal-host changes;
only an overlapping focused control moves them from their bottom position.
Tool settings close on successful Save. A saved-source step-3 link waits for an
explicit Run check and never claims a save occurred; only Save in the mounted form
automatically starts the check. Unsaved-source links explain the prerequisite.

中文：健康浮层使用指针感知的触发控件。关闭旁侧面板保留期间修改的筛选，焦点回到
当前对象的行；该行已移除时回到原触发控件。j/k 将下一行滚动到可见范围。通知在模态
宿主变化后保留剩余时间和暂停状态，仅为重叠的聚焦控件调整底部位置。工具设置保存
成功后关闭。已保存来源的第 3 步链接等待显式“运行检查”，不声称发生过保存；仅当前
表单保存成功后自动检查。未保存来源的链接说明缺少的前提。

The decision is native layers, with no Radix dependency. The automated C1 gate is
`bash scripts/check-ui.sh`, including `layers.overlays.spec.ts` in all six Chromium
and six Playwright WebKit projects. It must pass before this item is committed.
The manual device and VoiceOver checks below are to be run by the owner.

## Automated gate

- `npm --prefix web run typecheck` compiles the Playwright suite.
- `bash scripts/check-ui.sh` runs the real isolated demo service, axe, screenshots,
  focus and history checks. `layers.overlays.spec.ts` runs all six viewport/locale/
  theme combinations in Chromium and Playwright WebKit.
- Check the ≥1200 beside panel has no backdrop/inert background, and narrower
  sheets are native modals. Verify resize preserves the panel opener.
- Verify safe initial focus, nested confirmation, both Tab directions, Escape
  priority, native cancel, Back/Forward and reload/cold links.
- Verify menu arrows/Home/End/typeahead/disabled items, touch sheets, outside
  dismissal, field/IME guards, Undo pause, persistent errors and toast placement.
- Review the gallery changes and both new overlay screenshots before updating
  local baselines. Jobs reasons must remain fully visible with the beside panel; P2
  must preserve that assertion when adding column priorities.

## To be run by the owner

Record device/OS/browser, date, result and any failing steps for each environment.

- [ ] macOS 15 Safari with VoiceOver.
- [ ] macOS 15 ComputeDeck.app WKWebView with VoiceOver.
- [ ] Physical iPhone over the existing SSH forward, Safari with VoiceOver.
- [ ] One macOS 14 VM smoke (Tart): WKWebView, dialog/inert and VoiceOver.

For each environment:

- [ ] Open a job panel; hear its heading and status. Desktop background stays
  reachable; a sheet's background is absent from sequential focus and the rotor.
- [ ] Open a form, then a removal confirmation. Hear the name and outcome;
  initial focus is the safe control. Backdrop clicks do not dismiss either.
- [ ] Tab/Shift+Tab and VoiceOver navigation remain in the top modal. Escape
  closes one layer; focus returns to its opener, or the page heading if removed.
- [ ] Back closes addressed panels/forms without leaving their list. A cold
  deep link closes locally. Test source add/edit/repair and the current step.
- [ ] Resize across 1200 px and rotate the phone; preserve the subject, opener,
  safe-area spacing and reachable sticky actions. Focus is never obscured.
- [ ] Open a menu using touch and keyboard. Hear item names and disabled state;
  arrows, first/last and typeahead work. Escape and outside clicks on blank
  content return focus. Clicking an outside input closes the popover and focuses
  that input; later clicks and text selection still work normally.
- [ ] Show three notifications inside a modal. Hear one polite region. Undo is
  available for ten seconds and pauses on hover/focus; Command+Z works outside
  fields. Errors persist and remain available in the local action-error rows.
- [ ] Escape dismisses notifications without changing focus before closing a
  layer. Reduced-motion closing never slides or translates the dialog.

macOS 13 assistive-technology testing remains with the 0.9 floor decision, as
specified by C1. The actual new source wizard, page-specific panel contents,
frame chrome and shared key registry remain their assigned later items.

中文：决定采用原生 dialog 和桌面非模态 aside，不引入 Radix。自动 C1 门禁是
`bash scripts/check-ui.sh`，其中 `layers.overlays.spec.ts` 覆盖六种 Chromium 和六种
Playwright WebKit 组合；提交此项之前必须通过。上述 macOS 15 Safari、应用内 WKWebView、
实体 iPhone 和 macOS 14 虚拟机的设备及 VoiceOver 检查“待所有者执行”，需记录环境、
日期、结果与失败步骤。macOS 13 辅助技术测试仍按 C1 留待 0.9 系统版本决策。

中文：叠加模态框时，栈显式将较低的模态层设为 inert，以修正 WebKit 仍允许低层获得
焦点的问题；逐层关闭或乱序关闭时均恢复各层原来的 inert 状态，不修改非模态层。
点击浮层外的非可聚焦内容关闭浮层后，焦点保留在触发控件；点击外部可聚焦控件时，
保留该控件正常的焦点和点击行为。默认焦点变更的阻止仅作用于关闭浮层的那一次指针
序列，不影响后续点击与文字选择。hash 跳转及浏览器历史跳转均将待确认操作按“保留”
取消。人工检查也须分别验证空白区域点击和外部输入框点击这两种结果。


## Later items

U1 aligns the legacy 52 px top bar with `--topbar-h`. Until then the beside panel
starts at 52 px; its width uses `--panel-w` and its bottom edge uses the chrome
height without the 8 px scroll-padding margin.
P2 replaces the interim stacked Jobs cards at 1200–1280 px beside the panel with
container-query column priorities, keeping the list tabular and the pending reason
fully visible.

中文：U1 将现有 52 像素顶栏与 `--topbar-h` 对齐；此前旁侧面板从 52 像素开始，宽度使用
`--panel-w`，底边按底部栏高度计算，不含 8 像素滚动留白。P2 用容器查询列优先级替换
1200–1280 像素旁侧面板旁的临时 Jobs 卡片，保持表格布局并完整显示排队原因。
