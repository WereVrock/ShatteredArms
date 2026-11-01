// ===== CampaignExitDialog.js =====
// Modal asking the player whether to save their campaign and return to
// the menu, or abandon it permanently. Used both for battle exit (from
// the pause menu) and for every picker exit (initial recruitment,
// reward shop). Pure UI: the actual save/abandon behavior is delegated
// to the caller via onSaveExit / onAbandon callbacks.
//
// One instance is created in main.js and passed into CampaignFlow. Both
// call sites share it — the dialog is never shown twice simultaneously.

const STYLE_ID = 'campaign-exit-dialog-styles';

const STYLE_TEXT = `
  .campaign-exit-root {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.72);
    display: none;
    align-items: center;
    justify-content: center;
    z-index: 1300;
    font-family: system-ui, -apple-system, Segoe UI, sans-serif;
    color: #e8e8e8;
  }
  .campaign-exit-panel {
    background: #1e222a;
    border: 1px solid #384050;
    border-radius: 10px;
    box-shadow: 0 12px 40px rgba(0,0,0,0.6);
    width: min(420px, calc(100vw - 32px));
    padding: 20px;
    box-sizing: border-box;
  }
  .campaign-exit-title {
    font-size: 18px;
    font-weight: 700;
    color: #eef2f8;
    letter-spacing: 0.4px;
  }
  .campaign-exit-sub {
    font-size: 13px;
    color: #8a9ab0;
    line-height: 1.4;
    margin-top: 6px;
    margin-bottom: 18px;
  }
  .campaign-exit-options {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .campaign-exit-option {
    text-align: left;
    padding: 12px 14px;
    border-radius: 6px;
    border: 1px solid #384050;
    background: #2a2f3a;
    color: #dde5ee;
    font-family: inherit;
    font-size: 14px;
    cursor: pointer;
    display: flex;
    flex-direction: column;
    gap: 3px;
    transition: background 0.12s;
  }
  .campaign-exit-option:hover {
    background: #343a48;
    border-color: #4a5a8a;
  }
  .campaign-exit-option.danger {
    border-color: #5a3a30;
    background: #2a1e1a;
    color: #e0c0b0;
  }
  .campaign-exit-option.danger:hover {
    background: #3a2820;
    border-color: #8a5a4a;
  }
  .campaign-exit-option-label { font-weight: 600; }
  .campaign-exit-option-desc {
    font-size: 12px;
    color: #8a9ab0;
  }
  .campaign-exit-option.danger .campaign-exit-option-desc { color: #b08a7a; }
  .campaign-exit-cancel {
    margin-top: 6px;
    padding: 8px 14px;
    border-radius: 5px;
    border: 1px solid #384050;
    background: transparent;
    color: #a0b0c4;
    font-family: inherit;
    font-size: 13px;
    cursor: pointer;
    align-self: flex-end;
  }
  .campaign-exit-cancel:hover {
    background: #232b38;
    color: #dde5ee;
  }
`;

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const st = document.createElement('style');
  st.id = STYLE_ID;
  st.textContent = STYLE_TEXT;
  document.head.appendChild(st);
}

export class CampaignExitDialog {
  constructor() {
    ensureStyles();
    this.root = document.createElement('div');
    this.root.className = 'campaign-exit-root';
    // Backdrop click cancels — same affordance as ProfilePickerView.
    this.root.addEventListener('mousedown', (e) => {
      if (e.target === this.root) this._cancel();
    });
    document.body.appendChild(this.root);
    this._opts = null;
  }

  isOpen() {
    return this.root.style.display === 'flex';
  }

  // opts: { title?, subtitle?, saveLabel?, saveDesc?,
  //         abandonLabel?, abandonDesc?,
  //         onSaveExit, onAbandon, onCancel? }
  show(opts) {
    this._opts = opts || {};
    this._render();
    this.root.style.display = 'flex';
  }

  close() {
    this.root.style.display = 'none';
    this._opts = null;
  }

  _cancel() {
    const cb = this._opts && this._opts.onCancel;
    this.close();
    if (cb) cb();
  }

  _render() {
    const opts = this._opts || {};
    this.root.innerHTML = '';

    const panel = document.createElement('div');
    panel.className = 'campaign-exit-panel';

    const title = document.createElement('div');
    title.className = 'campaign-exit-title';
    title.textContent = opts.title || 'Leave campaign?';
    panel.appendChild(title);

    const sub = document.createElement('div');
    sub.className = 'campaign-exit-sub';
    sub.textContent = opts.subtitle
      || 'Save your progress to continue later, or end this run for good.';
    panel.appendChild(sub);

    const options = document.createElement('div');
    options.className = 'campaign-exit-options';

    const makeOption = (label, desc, danger, onClick) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'campaign-exit-option' + (danger ? ' danger' : '');

      const l = document.createElement('span');
      l.className = 'campaign-exit-option-label';
      l.textContent = label;
      btn.appendChild(l);

      if (desc) {
        const d = document.createElement('span');
        d.className = 'campaign-exit-option-desc';
        d.textContent = desc;
        btn.appendChild(d);
      }

      btn.addEventListener('click', () => {
        this.close();
        if (onClick) onClick();
      });

      options.appendChild(btn);
    };

    makeOption(
      opts.saveLabel || 'Save & Exit',
      opts.saveDesc
        || 'Keep this campaign. You can continue it from the Campaign menu.',
      false,
      opts.onSaveExit
    );

    makeOption(
      opts.abandonLabel || 'Abandon Run',
      opts.abandonDesc
        || 'End this campaign permanently. Your score will still be submitted.',
      true,
      opts.onAbandon
    );

    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'campaign-exit-cancel';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => this._cancel());
    options.appendChild(cancel);

    panel.appendChild(options);
    this.root.appendChild(panel);
  }
}