/** Focus a stable reading target before removing the control that currently owns focus. */
export function focusReadingTarget(preferred?: HTMLElement | null, host?: HTMLElement | null) {
  const target =
    preferred?.isConnected && !preferred.closest('[inert]') && (!host || host.contains(preferred))
      ? preferred
      : (host?.querySelector<HTMLElement>('h1, h2, [tabindex]') ??
        host ??
        document.querySelector<HTMLElement>('main h1, header h1'));
  if (!target) return;
  if (!target.matches('button, input, a[href], [tabindex]')) target.tabIndex = -1;
  target.focus();
}
export function dismissErrorRow(button: HTMLElement, remove: () => void) {
  const row = button.parentElement!;
  if (row.contains(document.activeElement)) {
    const next = row.nextElementSibling?.querySelector<HTMLElement>('button');
    focusReadingTarget(next);
  }
  remove();
}
