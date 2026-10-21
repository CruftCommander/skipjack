// The skip toast: a short message with an Undo button, mounted inside the player so it shows in
// fullscreen. Styles live in a shadow root so the page's CSS cannot reach them and ours cannot leak.

const VISIBLE_MS = 6000;

const STYLE = `
  :host { all: initial; }
  .toast {
    position: absolute; left: 12px; bottom: 64px; z-index: 2147483647;
    display: flex; align-items: center; gap: 12px;
    max-width: calc(100% - 24px); box-sizing: border-box;
    padding: 8px 8px 8px 14px; border-radius: 8px;
    background: rgba(18, 18, 18, 0.92); color: #f1f1f1;
    font: 500 14px/1.3 Roboto, "Segoe UI", system-ui, sans-serif;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
    opacity: 0; transform: translateY(6px); transition: opacity 150ms, transform 150ms;
    pointer-events: none;
  }
  .toast.show { opacity: 1; transform: none; pointer-events: auto; }
  .msg { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  button {
    all: unset; cursor: pointer; padding: 6px 10px; border-radius: 6px;
    color: #8ab4f8; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; font-size: 12px;
  }
  button[hidden] { display: none; }
  button:hover, button:focus-visible { background: rgba(138, 180, 248, 0.16); }
  @media (prefers-reduced-motion: reduce) { .toast { transition: none; } }
`;

export class Toast {
  private host: HTMLElement | null = null;
  private box: HTMLDivElement | null = null;
  private msg: HTMLSpanElement | null = null;
  private button: HTMLButtonElement | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private undo: (() => void) | null = null;

  show(parent: HTMLElement, message: string, undo: (() => void) | null): void {
    this.mount(parent);
    if (!this.box || !this.msg || !this.button) return;
    this.msg.textContent = message;
    this.undo = undo;
    this.button.hidden = !undo;
    this.box.classList.add('show');
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.hide(), VISIBLE_MS);
  }

  hide(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.undo = null;
    this.box?.classList.remove('show');
  }

  destroy(): void {
    this.hide();
    this.host?.remove();
    this.host = this.box = this.msg = this.button = null;
  }

  private mount(parent: HTMLElement): void {
    if (this.host && this.host.parentElement === parent) return;
    this.host?.remove();
    const host = document.createElement('skipjack-toast');
    const root = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = STYLE;
    const box = document.createElement('div');
    box.className = 'toast';
    box.setAttribute('role', 'status');
    box.setAttribute('aria-live', 'polite');
    const msg = document.createElement('span');
    msg.className = 'msg';
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'Undo';
    button.addEventListener('click', (e) => {
      e.stopPropagation();
      const undo = this.undo;
      this.hide();
      undo?.();
    });
    // Keep clicks on the toast from reaching the player, where a click toggles play and pause.
    box.addEventListener('click', (e) => e.stopPropagation());
    box.append(msg, button);
    root.append(style, box);
    parent.append(host);
    this.host = host;
    this.box = box;
    this.msg = msg;
    this.button = button;
  }
}
