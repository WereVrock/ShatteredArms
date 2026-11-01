// Profile select / create / delete panel. Single-player identity only —
// wording mirrors classic local profile screens (Warcraft III style),
// never online-account language.
//
// Modes driven by show(options):
//   select  — pick an existing profile or create a new one
//   manage  — switch / leave / delete while already active
//
// Pure UI. Persistence goes through ProfileStore via the callbacks the
// caller supplies (onSelect / onCreated / onDeleted / onLogout).

const STYLE_ID = 'profile-picker-styles';

const STYLE_TEXT = `
  .profile-root {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.72);
    display: none;
    align-items: center;
    justify-content: center;
    z-index: 1200;
    font-family: system-ui, -apple-system, Segoe UI, sans-serif;
    color: #e8e8e8;
  }
  .profile-panel {
    background: #1e222a;
    border: 1px solid #384050;
    border-radius: 10px;
    box-shadow: 0 12px 40px rgba(0,0,0,0.6);
    width: min(420px, calc(100vw - 32px));
    max-height: calc(100vh - 32px);
    display: flex;
    flex-direction: column;
    box-sizing: border-box;
  }
  .profile-header {
    padding: 16px 20px 10px;
    border-bottom: 1px solid #2a3544;
  }
  .profile-title {
    font-size: 20px;
    font-weight: 700;
    color: #eef2f8;
    letter-spacing: 0.4px;
  }
  .profile-sub {
    font-size: 12px;
    color: #7a8a9e;
    margin-top: 4px;
    line-height: 1.4;
  }
  .profile-body {
    padding: 14px 20px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .profile-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .profile-btn {
    flex: 1 1 auto;
    text-align: left;
    padding: 10px 12px;
    border-radius: 5px;
    border: 1px solid #2a3544;
    background: #1a1f28;
    color: #dde5ee;
    font-family: inherit;
    font-size: 14px;
    cursor: pointer;
  }
  .profile-btn:hover { background: #232b38; border-color: #4a5a8a; }
  .profile-btn.active {
    border-color: #4a8a5a;
    background: #1e2e24;
    color: #c8e6d0;
  }
  .profile-btn.danger {
    flex: 0 0 auto;
    color: #d08a6a;
    border-color: #5a3a30;
    background: #2a1e1a;
    padding: 10px 12px;
  }
  .profile-btn.danger:hover { background: #3a2820; }
  .profile-create {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-top: 6px;
    padding-top: 10px;
    border-top: 1px solid #2a3544;
  }
  .profile-create label {
    font-size: 11px;
    color: #8a9ab0;
    letter-spacing: 1px;
    text-transform: uppercase;
  }
  .profile-create input {
    padding: 8px 10px;
    border-radius: 4px;
    border: 1px solid #384050;
    background: #10151d;
    color: #eef2f8;
    font-family: inherit;
    font-size: 14px;
  }
  .profile-create input:focus {
    outline: none;
    border-color: #6a8ac0;
  }
  .profile-error {
    font-size: 12px;
    color: #d08a6a;
    min-height: 16px;
  }
  .profile-footer {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    padding: 12px 20px 16px;
    border-top: 1px solid #2a3544;
  }
  .profile-action {
    padding: 8px 18px;
    border-radius: 5px;
    border: 1px solid #384050;
    background: #2a2f3a;
    color: #dde5ee;
    font-family: inherit;
    font-size: 13px;
    cursor: pointer;
  }
  .profile-action:hover { background: #343a48; }
  .profile-action.primary {
    background: #2e5c3a;
    border-color: #4a8a5a;
    color: #eef8f0;
    font-weight: 600;
  }
  .profile-action.primary:hover { background: #3a7248; }
  .profile-empty {
    color: #6a7a8e;
    font-style: italic;
    font-size: 13px;
    padding: 8px 0;
    text-align: center;
  }
`;

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const st = document.createElement('style');
  st.id = STYLE_ID;
  st.textContent = STYLE_TEXT;
  document.head.appendChild(st);
}

export class ProfilePickerView {
  constructor() {
    ensureStyles();
    this.root = document.createElement('div');
    this.root.className = 'profile-root';
    this.root.addEventListener('mousedown', (e) => {
      if (e.target === this.root && this._allowCancel) {
        this._cancel();
      }
    });
    document.body.appendChild(this.root);
    this._opts = null;
    this._allowCancel = true;
  }

  isOpen() {
    return this.root.style.display === 'flex';
  }

  // options:
  //   profiles: [{id,name}]
  //   activeId: string|null
  //   required: bool — if true, cancel is hidden (campaign gate)
  //   onSelect(id)
  //   onCreate(name) -> profile|null  (caller creates; return null on fail)
  //   onDelete(id)
  //   onLogout()
  //   onCancel()
  show(options) {
    this._opts = options || {};
    this._allowCancel = !this._opts.required;
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
    const profiles = opts.profiles || [];
    const activeId = opts.activeId || null;

    this.root.innerHTML = '';
    const panel = document.createElement('div');
    panel.className = 'profile-panel';

    const header = document.createElement('div');
    header.className = 'profile-header';
    const title = document.createElement('div');
    title.className = 'profile-title';
    title.textContent = activeId ? 'Profiles' : 'Select a Profile';
    header.appendChild(title);
    const sub = document.createElement('div');
    sub.className = 'profile-sub';
    sub.textContent = activeId
      ? 'Switch profile, create another, or leave the current one.'
      : 'Choose a local profile for this machine. No password — just a name.';
    header.appendChild(sub);
    panel.appendChild(header);

    const body = document.createElement('div');
    body.className = 'profile-body';

    if (profiles.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'profile-empty';
      empty.textContent = 'No profiles yet. Create one below.';
      body.appendChild(empty);
    } else {
      for (const p of profiles) {
        const row = document.createElement('div');
        row.className = 'profile-row';

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'profile-btn' + (p.id === activeId ? ' active' : '');
        btn.textContent = p.name + (p.id === activeId ? '  (current)' : '');
        btn.addEventListener('click', () => {
          if (opts.onSelect) opts.onSelect(p.id);
        });
        row.appendChild(btn);

        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'profile-btn danger';
        del.textContent = 'Delete';
        del.title = 'Delete this profile and its campaign save';
        del.addEventListener('click', (e) => {
          e.stopPropagation();
          if (!confirm(`Delete profile "${p.name}"? Its campaign progress will be lost.`)) return;
          if (opts.onDelete) opts.onDelete(p.id);
        });
        row.appendChild(del);

        body.appendChild(row);
      }
    }

    // Create form
    const create = document.createElement('div');
    create.className = 'profile-create';
    const lab = document.createElement('label');
    lab.textContent = 'New profile name';
    create.appendChild(lab);
    const input = document.createElement('input');
    input.type = 'text';
    input.maxLength = 24;
    input.placeholder = 'Enter a name';
    input.autocomplete = 'off';
    create.appendChild(input);
    const err = document.createElement('div');
    err.className = 'profile-error';
    create.appendChild(err);
    const createBtn = document.createElement('button');
    createBtn.type = 'button';
    createBtn.className = 'profile-action primary';
    createBtn.textContent = 'Create Profile';
    createBtn.style.alignSelf = 'flex-end';
    const doCreate = () => {
      err.textContent = '';
      if (!opts.onCreate) return;
      const result = opts.onCreate(input.value);
      if (!result) {
        err.textContent = 'Enter a unique name (max 24 characters).';
      }
    };
    createBtn.addEventListener('click', doCreate);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') doCreate();
    });
    create.appendChild(createBtn);
    body.appendChild(create);

    panel.appendChild(body);

    const footer = document.createElement('div');
    footer.className = 'profile-footer';
    if (activeId && opts.onLogout) {
      const leave = document.createElement('button');
      leave.type = 'button';
      leave.className = 'profile-action';
      leave.textContent = 'Leave Profile';
      leave.addEventListener('click', () => {
        if (opts.onLogout) opts.onLogout();
      });
      footer.appendChild(leave);
    }
    if (this._allowCancel) {
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'profile-action';
      cancel.textContent = 'Cancel';
      cancel.addEventListener('click', () => this._cancel());
      footer.appendChild(cancel);
    }
    panel.appendChild(footer);

    this.root.appendChild(panel);
    setTimeout(() => input.focus(), 0);
  }
}