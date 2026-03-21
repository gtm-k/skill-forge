#!/usr/bin/env python3
"""
Generate SkillForge.html — a complete single-file AI Agent Skill Manager.
Copyright 2026 SkillForge Contributors — Apache License 2.0
"""

import textwrap

def build_html():
    # ── CSS ──────────────────────────────────────────────────────────────
    css = textwrap.dedent(r'''
    :root {
      --bg: #ffffff; --bg-alt: #f8f9fa; --bg-card: #ffffff; --bg-hover: #f1f3f5;
      --bg-sidebar: #f8f9fa; --bg-overlay: rgba(0,0,0,.45);
      --text: #1a1a2e; --text-muted: #6b7280; --text-heading: #111827;
      --border: #e5e7eb; --border-focus: #4f46e5;
      --accent: #4f46e5; --accent-light: #eef2ff; --accent-hover: #4338ca;
      --success: #16a34a; --success-bg: #dcfce7;
      --warn: #d97706; --warn-bg: #fef9c3;
      --error: #dc2626; --error-bg: #fee2e2;
      --mono: 'SF Mono','Cascadia Code','Fira Code','JetBrains Mono',ui-monospace,monospace;
      --sans: -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Oxygen,Ubuntu,Cantarell,'Helvetica Neue',sans-serif;
      --radius: 8px; --radius-lg: 12px;
      --shadow-sm: 0 1px 2px rgba(0,0,0,.06); --shadow: 0 2px 8px rgba(0,0,0,.08);
      --shadow-lg: 0 8px 24px rgba(0,0,0,.12);
      --transition: .18s ease;
    }
    [data-theme="dark"] {
      --bg: #0f1117; --bg-alt: #1a1b26; --bg-card: #1e1f2e; --bg-hover: #262736;
      --bg-sidebar: #1a1b26; --bg-overlay: rgba(0,0,0,.65);
      --text: #e2e8f0; --text-muted: #94a3b8; --text-heading: #f1f5f9;
      --border: #2d2e3f; --border-focus: #818cf8;
      --accent: #818cf8; --accent-light: #1e1b4b; --accent-hover: #6366f1;
      --success: #22c55e; --success-bg: #052e16;
      --warn: #f59e0b; --warn-bg: #422006;
      --error: #ef4444; --error-bg: #450a0a;
      --shadow-sm: 0 1px 2px rgba(0,0,0,.2); --shadow: 0 2px 8px rgba(0,0,0,.3);
      --shadow-lg: 0 8px 24px rgba(0,0,0,.4);
    }
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    html { font-size: 16px; -webkit-text-size-adjust: 100%; }
    body { font-family: var(--sans); background: var(--bg); color: var(--text); line-height: 1.6; min-height: 100vh; overflow-x: hidden; }
    ::selection { background: var(--accent); color: #fff; }
    :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    button, input, select, textarea { font-family: inherit; font-size: inherit; }
    a { color: var(--accent); text-decoration: none; }
    a:hover { text-decoration: underline; }

    /* Scrollbar */
    ::-webkit-scrollbar { width: 6px; height: 6px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
    ::-webkit-scrollbar-thumb:hover { background: var(--text-muted); }

    /* Layout */
    #app { display: flex; height: 100vh; }
    #sidebar { width: 260px; background: var(--bg-sidebar); border-right: 1px solid var(--border); display: flex; flex-direction: column; flex-shrink: 0; transition: transform var(--transition), width var(--transition); z-index: 40; }
    #sidebar.collapsed { width: 0; overflow: hidden; border-right: none; }
    #main { flex: 1; display: flex; flex-direction: column; min-width: 0; overflow: hidden; }
    #topbar { height: 52px; border-bottom: 1px solid var(--border); display: flex; align-items: center; padding: 0 16px; gap: 12px; background: var(--bg); flex-shrink: 0; }
    #content { flex: 1; overflow-y: auto; padding: 24px; }

    /* Sidebar */
    .sidebar-header { padding: 16px; display: flex; align-items: center; gap: 10px; border-bottom: 1px solid var(--border); }
    .sidebar-logo { width: 28px; height: 28px; background: var(--accent); border-radius: 6px; display: flex; align-items: center; justify-content: center; color: #fff; font-weight: 700; font-size: 14px; }
    .sidebar-title { font-weight: 700; font-size: 15px; color: var(--text-heading); }
    .sidebar-nav { flex: 1; overflow-y: auto; padding: 8px; }
    .nav-item { display: flex; align-items: center; gap: 10px; padding: 8px 12px; border-radius: var(--radius); cursor: pointer; color: var(--text-muted); font-size: 14px; transition: all var(--transition); user-select: none; border: none; background: none; width: 100%; text-align: left; }
    .nav-item:hover { background: var(--bg-hover); color: var(--text); }
    .nav-item.active { background: var(--accent-light); color: var(--accent); font-weight: 600; }
    .nav-item svg { width: 18px; height: 18px; flex-shrink: 0; }
    .nav-badge { margin-left: auto; background: var(--accent); color: #fff; font-size: 11px; font-weight: 600; padding: 1px 7px; border-radius: 10px; }
    .sidebar-footer { padding: 12px 16px; border-top: 1px solid var(--border); font-size: 12px; color: var(--text-muted); display: flex; flex-direction: column; gap: 8px; }

    /* Topbar */
    .topbar-btn { background: none; border: none; cursor: pointer; color: var(--text-muted); padding: 6px; border-radius: 6px; display: flex; align-items: center; justify-content: center; transition: all var(--transition); }
    .topbar-btn:hover { background: var(--bg-hover); color: var(--text); }
    .topbar-btn svg { width: 20px; height: 20px; }
    .search-box { flex: 1; max-width: 420px; position: relative; }
    .search-box input { width: 100%; padding: 7px 12px 7px 36px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--bg-alt); color: var(--text); font-size: 14px; transition: border-color var(--transition); }
    .search-box input:focus { border-color: var(--accent); background: var(--bg); }
    .search-box svg { position: absolute; left: 10px; top: 50%; transform: translateY(-50%); width: 16px; height: 16px; color: var(--text-muted); pointer-events: none; }
    .search-kbd { position: absolute; right: 8px; top: 50%; transform: translateY(-50%); font-size: 11px; color: var(--text-muted); background: var(--bg); border: 1px solid var(--border); padding: 1px 6px; border-radius: 4px; font-family: var(--mono); pointer-events: none; }
    .topbar-actions { display: flex; align-items: center; gap: 4px; margin-left: auto; }

    /* Buttons */
    .btn { display: inline-flex; align-items: center; gap: 6px; padding: 8px 16px; border-radius: var(--radius); font-size: 14px; font-weight: 500; cursor: pointer; border: 1px solid transparent; transition: all var(--transition); white-space: nowrap; text-decoration: none; }
    .btn:hover { text-decoration: none; }
    .btn svg { width: 16px; height: 16px; }
    .btn-primary { background: var(--accent); color: #fff; border-color: var(--accent); }
    .btn-primary:hover { background: var(--accent-hover); }
    .btn-secondary { background: var(--bg); color: var(--text); border-color: var(--border); }
    .btn-secondary:hover { background: var(--bg-hover); }
    .btn-ghost { background: transparent; color: var(--text-muted); }
    .btn-ghost:hover { background: var(--bg-hover); color: var(--text); }
    .btn-danger { background: var(--error); color: #fff; border-color: var(--error); }
    .btn-danger:hover { background: #b91c1c; }
    .btn-sm { padding: 5px 10px; font-size: 13px; }
    .btn-icon { padding: 6px; }

    /* Cards */
    .card-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 16px; }
    .skill-card { background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius-lg); padding: 20px; cursor: pointer; transition: all var(--transition); position: relative; }
    .skill-card:hover { border-color: var(--accent); box-shadow: var(--shadow); transform: translateY(-1px); }
    .skill-card.selected { border-color: var(--accent); background: var(--accent-light); }
    .card-header { display: flex; align-items: flex-start; gap: 12px; margin-bottom: 10px; }
    .card-icon { width: 40px; height: 40px; border-radius: var(--radius); background: var(--accent-light); color: var(--accent); display: flex; align-items: center; justify-content: center; flex-shrink: 0; font-size: 18px; }
    .card-title { font-weight: 600; font-size: 15px; color: var(--text-heading); line-height: 1.3; word-break: break-word; }
    .card-desc { font-size: 13px; color: var(--text-muted); line-height: 1.5; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; margin-bottom: 12px; }
    .card-meta { display: flex; align-items: center; gap: 12px; font-size: 12px; color: var(--text-muted); flex-wrap: wrap; }
    .card-tag { background: var(--bg-alt); border: 1px solid var(--border); border-radius: 4px; padding: 1px 8px; font-size: 11px; }
    .card-status { width: 8px; height: 8px; border-radius: 50%; position: absolute; top: 16px; right: 16px; }
    .card-status.valid { background: var(--success); }
    .card-status.warning { background: var(--warn); }
    .card-status.error { background: var(--error); }
    .card-checkbox { position: absolute; top: 12px; left: 12px; width: 18px; height: 18px; border: 2px solid var(--border); border-radius: 4px; background: var(--bg); cursor: pointer; display: none; align-items: center; justify-content: center; z-index: 2; }
    .card-checkbox.checked { background: var(--accent); border-color: var(--accent); }
    .card-checkbox.checked::after { content: '✓'; color: #fff; font-size: 12px; font-weight: 700; }
    .bulk-mode .card-checkbox { display: flex; }
    .agent-badges { display: flex; gap: 4px; }
    .agent-badge { font-size: 10px; font-weight: 600; padding: 1px 6px; border-radius: 3px; text-transform: uppercase; letter-spacing: .5px; }
    .agent-badge.claude { background: #fef3c7; color: #92400e; }
    .agent-badge.codex { background: #dbeafe; color: #1e40af; }
    .agent-badge.cursor { background: #ede9fe; color: #5b21b6; }
    .agent-badge.copilot { background: #dcfce7; color: #166534; }
    .quality-score { font-size: 11px; font-weight: 700; padding: 2px 8px; border-radius: 10px; }
    .quality-score.high { background: var(--success-bg); color: var(--success); }
    .quality-score.medium { background: var(--warn-bg); color: var(--warn); }
    .quality-score.low { background: var(--error-bg); color: var(--error); }

    /* Welcome Screen */
    #welcome { display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 24px; text-align: center; }
    .welcome-inner { max-width: 520px; }
    .welcome-logo { width: 72px; height: 72px; background: var(--accent); border-radius: 16px; display: flex; align-items: center; justify-content: center; margin: 0 auto 24px; font-size: 32px; color: #fff; font-weight: 700; box-shadow: 0 4px 16px rgba(79,70,229,.3); }
    .welcome-inner h1 { font-size: 28px; font-weight: 700; color: var(--text-heading); margin-bottom: 8px; }
    .welcome-inner p { color: var(--text-muted); margin-bottom: 24px; font-size: 15px; line-height: 1.6; }
    .welcome-paths { text-align: left; background: var(--bg-alt); border: 1px solid var(--border); border-radius: var(--radius); padding: 14px 18px; margin-bottom: 24px; font-size: 13px; }
    .welcome-paths strong { display: block; margin-bottom: 6px; color: var(--text-heading); }
    .welcome-paths code { font-family: var(--mono); font-size: 12px; background: var(--bg); padding: 1px 6px; border-radius: 3px; border: 1px solid var(--border); }
    .welcome-paths ul { list-style: none; display: flex; flex-direction: column; gap: 4px; }
    .welcome-paths li { display: flex; align-items: center; gap: 8px; }
    .welcome-paths li::before { content: '→'; color: var(--accent); }
    .compat-notice { background: var(--warn-bg); border: 1px solid var(--warn); border-radius: var(--radius); padding: 10px 14px; margin-top: 16px; font-size: 12px; color: var(--warn); text-align: left; }

    /* Empty state */
    .empty-state { display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 60px 24px; text-align: center; }
    .empty-icon { width: 80px; height: 80px; background: var(--accent-light); border-radius: 20px; display: flex; align-items: center; justify-content: center; margin-bottom: 20px; font-size: 36px; }
    .empty-state h2 { font-size: 20px; font-weight: 600; color: var(--text-heading); margin-bottom: 8px; }
    .empty-state p { color: var(--text-muted); margin-bottom: 20px; max-width: 400px; font-size: 14px; }

    /* Filter Bar */
    .filter-bar { display: flex; align-items: center; gap: 10px; margin-bottom: 20px; flex-wrap: wrap; }
    .filter-bar select { padding: 7px 12px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--bg); color: var(--text); font-size: 13px; cursor: pointer; }
    .filter-bar select:focus { border-color: var(--accent); }
    .filter-count { font-size: 13px; color: var(--text-muted); margin-left: auto; }

    /* Slide-over Panel */
    .panel-overlay { position: fixed; inset: 0; background: var(--bg-overlay); z-index: 90; opacity: 0; pointer-events: none; transition: opacity .25s ease; }
    .panel-overlay.open { opacity: 1; pointer-events: auto; }
    .slide-panel { position: fixed; top: 0; right: 0; bottom: 0; width: min(640px, 90vw); background: var(--bg); z-index: 100; transform: translateX(100%); transition: transform .3s cubic-bezier(.4,0,.2,1); box-shadow: var(--shadow-lg); display: flex; flex-direction: column; }
    .slide-panel.open { transform: translateX(0); }
    .panel-header { padding: 16px 20px; border-bottom: 1px solid var(--border); display: flex; align-items: center; gap: 12px; flex-shrink: 0; }
    .panel-header h2 { flex: 1; font-size: 18px; font-weight: 600; color: var(--text-heading); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .panel-tabs { display: flex; border-bottom: 1px solid var(--border); padding: 0 20px; gap: 0; flex-shrink: 0; overflow-x: auto; }
    .panel-tab { padding: 10px 16px; font-size: 13px; font-weight: 500; color: var(--text-muted); cursor: pointer; border-bottom: 2px solid transparent; white-space: nowrap; background: none; border-top: none; border-left: none; border-right: none; transition: all var(--transition); }
    .panel-tab:hover { color: var(--text); }
    .panel-tab.active { color: var(--accent); border-bottom-color: var(--accent); }
    .panel-body { flex: 1; overflow-y: auto; padding: 20px; }
    .panel-actions { padding: 12px 20px; border-top: 1px solid var(--border); display: flex; gap: 8px; flex-shrink: 0; flex-wrap: wrap; }

    /* Editor */
    .editor-container { display: flex; height: 100%; gap: 0; }
    .editor-pane { flex: 1; display: flex; flex-direction: column; min-width: 0; }
    .editor-pane-header { padding: 8px 12px; border-bottom: 1px solid var(--border); font-size: 12px; font-weight: 600; color: var(--text-muted); text-transform: uppercase; letter-spacing: .5px; display: flex; align-items: center; gap: 8px; background: var(--bg-alt); }
    .editor-divider { width: 1px; background: var(--border); cursor: col-resize; flex-shrink: 0; }
    .editor-divider:hover { background: var(--accent); }
    textarea.code-editor { flex: 1; padding: 16px; font-family: var(--mono); font-size: 13px; line-height: 1.6; border: none; resize: none; background: var(--bg); color: var(--text); tab-size: 2; }
    textarea.code-editor:focus { outline: none; }
    .preview-pane { flex: 1; overflow-y: auto; padding: 20px; }
    .preview-pane h1 { font-size: 24px; margin-bottom: 12px; color: var(--text-heading); }
    .preview-pane h2 { font-size: 20px; margin: 20px 0 8px; color: var(--text-heading); }
    .preview-pane h3 { font-size: 16px; margin: 16px 0 6px; color: var(--text-heading); }
    .preview-pane p { margin-bottom: 10px; }
    .preview-pane ul, .preview-pane ol { margin-bottom: 10px; padding-left: 24px; }
    .preview-pane li { margin-bottom: 4px; }
    .preview-pane code { font-family: var(--mono); font-size: 12px; background: var(--bg-alt); padding: 2px 6px; border-radius: 3px; border: 1px solid var(--border); }
    .preview-pane pre { background: var(--bg-alt); border: 1px solid var(--border); border-radius: var(--radius); padding: 12px 16px; overflow-x: auto; margin-bottom: 12px; }
    .preview-pane pre code { background: none; border: none; padding: 0; }
    .preview-pane blockquote { border-left: 3px solid var(--accent); padding-left: 16px; color: var(--text-muted); margin-bottom: 10px; }
    .editor-toolbar { padding: 6px 12px; border-bottom: 1px solid var(--border); display: flex; gap: 4px; background: var(--bg-alt); flex-wrap: wrap; }
    .editor-status { padding: 6px 12px; border-top: 1px solid var(--border); font-size: 12px; color: var(--text-muted); display: flex; align-items: center; gap: 12px; background: var(--bg-alt); }
    .status-dot { width: 6px; height: 6px; border-radius: 50%; }
    .status-dot.saved { background: var(--success); }
    .status-dot.unsaved { background: var(--warn); }
    .status-dot.error { background: var(--error); }

    /* Wizard */
    .wizard { max-width: 680px; margin: 0 auto; }
    .wizard-steps { display: flex; gap: 0; margin-bottom: 32px; position: relative; }
    .wizard-step { flex: 1; text-align: center; position: relative; z-index: 1; }
    .wizard-step-num { width: 32px; height: 32px; border-radius: 50%; border: 2px solid var(--border); background: var(--bg); display: flex; align-items: center; justify-content: center; margin: 0 auto 6px; font-size: 13px; font-weight: 600; color: var(--text-muted); transition: all var(--transition); }
    .wizard-step.active .wizard-step-num { border-color: var(--accent); background: var(--accent); color: #fff; }
    .wizard-step.done .wizard-step-num { border-color: var(--success); background: var(--success); color: #fff; }
    .wizard-step-label { font-size: 12px; color: var(--text-muted); }
    .wizard-step.active .wizard-step-label { color: var(--accent); font-weight: 600; }
    .wizard-step.done .wizard-step-label { color: var(--success); }
    .wizard-connector { position: absolute; top: 15px; left: 0; right: 0; height: 2px; background: var(--border); z-index: 0; }
    .wizard-body { background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius-lg); padding: 28px; }
    .wizard-footer { display: flex; justify-content: space-between; margin-top: 20px; }

    /* Forms */
    .form-group { margin-bottom: 18px; }
    .form-label { display: block; font-size: 14px; font-weight: 500; color: var(--text-heading); margin-bottom: 6px; }
    .form-hint { font-size: 12px; color: var(--text-muted); margin-top: 4px; }
    .form-input, .form-textarea, .form-select { width: 100%; padding: 9px 12px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--bg); color: var(--text); font-size: 14px; transition: border-color var(--transition); }
    .form-input:focus, .form-textarea:focus, .form-select:focus { border-color: var(--accent); outline: none; }
    .form-textarea { min-height: 120px; resize: vertical; font-family: var(--sans); line-height: 1.6; }
    .form-counter { float: right; font-size: 12px; color: var(--text-muted); }
    .form-counter.over { color: var(--error); font-weight: 600; }
    .form-error { font-size: 12px; color: var(--error); margin-top: 4px; }
    .slug-preview { font-family: var(--mono); font-size: 13px; color: var(--accent); background: var(--accent-light); padding: 4px 10px; border-radius: 4px; margin-top: 6px; display: inline-block; }

    /* Template Picker */
    .template-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 12px; }
    .template-card { border: 2px solid var(--border); border-radius: var(--radius); padding: 16px; cursor: pointer; transition: all var(--transition); text-align: center; }
    .template-card:hover { border-color: var(--accent); background: var(--accent-light); }
    .template-card.selected { border-color: var(--accent); background: var(--accent-light); }
    .template-card h4 { font-size: 14px; font-weight: 600; margin-bottom: 4px; color: var(--text-heading); }
    .template-card p { font-size: 12px; color: var(--text-muted); }
    .template-icon { font-size: 24px; margin-bottom: 8px; }

    /* Validation */
    .validation-list { display: flex; flex-direction: column; gap: 8px; }
    .validation-item { display: flex; align-items: flex-start; gap: 8px; padding: 8px 12px; border-radius: var(--radius); font-size: 13px; }
    .validation-item.pass { background: var(--success-bg); color: var(--success); }
    .validation-item.warn { background: var(--warn-bg); color: var(--warn); }
    .validation-item.fail { background: var(--error-bg); color: var(--error); }
    .validation-icon { flex-shrink: 0; font-weight: 700; }

    /* Tabs */
    .tabs { display: flex; border-bottom: 1px solid var(--border); margin-bottom: 16px; gap: 0; }
    .tab { padding: 8px 16px; font-size: 13px; font-weight: 500; color: var(--text-muted); cursor: pointer; border-bottom: 2px solid transparent; background: none; border-top: none; border-left: none; border-right: none; }
    .tab:hover { color: var(--text); }
    .tab.active { color: var(--accent); border-bottom-color: var(--accent); }

    /* Toast */
    .toast-container { position: fixed; bottom: 20px; right: 20px; z-index: 200; display: flex; flex-direction: column; gap: 8px; }
    .toast { padding: 12px 20px; border-radius: var(--radius); font-size: 14px; font-weight: 500; box-shadow: var(--shadow-lg); animation: toastIn .3s ease; display: flex; align-items: center; gap: 8px; }
    .toast.success { background: var(--success); color: #fff; }
    .toast.error { background: var(--error); color: #fff; }
    .toast.info { background: var(--accent); color: #fff; }
    @keyframes toastIn { from { transform: translateY(20px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }

    /* Modal */
    .modal-overlay { position: fixed; inset: 0; background: var(--bg-overlay); z-index: 150; display: flex; align-items: center; justify-content: center; opacity: 0; pointer-events: none; transition: opacity .2s; }
    .modal-overlay.open { opacity: 1; pointer-events: auto; }
    .modal { background: var(--bg); border-radius: var(--radius-lg); padding: 24px; width: min(480px, 90vw); box-shadow: var(--shadow-lg); }
    .modal h3 { font-size: 18px; font-weight: 600; margin-bottom: 12px; color: var(--text-heading); }
    .modal p { font-size: 14px; color: var(--text-muted); margin-bottom: 20px; }
    .modal-actions { display: flex; gap: 8px; justify-content: flex-end; }

    /* Quality Score Panel */
    .score-dimensions { display: flex; flex-direction: column; gap: 12px; }
    .score-dim { display: flex; align-items: center; gap: 12px; }
    .score-dim-label { width: 140px; font-size: 13px; color: var(--text); flex-shrink: 0; }
    .score-bar { flex: 1; height: 8px; background: var(--bg-alt); border-radius: 4px; overflow: hidden; }
    .score-bar-fill { height: 100%; border-radius: 4px; transition: width .5s ease; }
    .score-bar-fill.high { background: var(--success); }
    .score-bar-fill.medium { background: var(--warn); }
    .score-bar-fill.low { background: var(--error); }
    .score-value { width: 36px; text-align: right; font-size: 13px; font-weight: 600; }
    .overall-score { text-align: center; padding: 20px; }
    .overall-score .big-num { font-size: 48px; font-weight: 700; color: var(--accent); }
    .overall-score .label { font-size: 14px; color: var(--text-muted); }

    /* Collections */
    .collection-tag { display: inline-flex; align-items: center; gap: 4px; background: var(--accent-light); color: var(--accent); padding: 3px 10px; border-radius: 12px; font-size: 12px; font-weight: 500; cursor: pointer; }
    .collection-tag .remove { cursor: pointer; font-size: 14px; opacity: .6; }
    .collection-tag .remove:hover { opacity: 1; }

    /* AI Panel */
    .ai-panel { background: var(--bg-alt); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px; margin-bottom: 16px; }
    .ai-panel h4 { font-size: 14px; font-weight: 600; margin-bottom: 8px; }
    .api-key-input { display: flex; gap: 8px; margin-bottom: 12px; }
    .api-key-input input { flex: 1; }

    /* History */
    .history-item { display: flex; align-items: center; gap: 12px; padding: 10px; border: 1px solid var(--border); border-radius: var(--radius); margin-bottom: 8px; }
    .history-item .timestamp { font-size: 12px; color: var(--text-muted); font-family: var(--mono); flex-shrink: 0; }
    .history-item .snapshot-info { flex: 1; font-size: 13px; }

    /* Cross-agent sync */
    .folder-list { display: flex; flex-direction: column; gap: 8px; }
    .folder-item { display: flex; align-items: center; gap: 12px; padding: 10px 14px; border: 1px solid var(--border); border-radius: var(--radius); }
    .folder-item .folder-path { font-family: var(--mono); font-size: 13px; flex: 1; overflow: hidden; text-overflow: ellipsis; }
    .folder-item .folder-count { font-size: 12px; color: var(--text-muted); }

    /* Marketplace placeholder */
    .marketplace-placeholder { text-align: center; padding: 60px 24px; }
    .marketplace-placeholder h2 { font-size: 24px; margin-bottom: 8px; }
    .marketplace-placeholder p { color: var(--text-muted); max-width: 400px; margin: 0 auto; }

    /* Responsive */
    @media (max-width: 768px) {
      #sidebar { position: fixed; left: 0; top: 0; bottom: 0; transform: translateX(-100%); z-index: 50; }
      #sidebar.mobile-open { transform: translateX(0); }
      .card-grid { grid-template-columns: 1fr; }
      .editor-container { flex-direction: column; }
      .slide-panel { width: 100vw; }
    }

    /* Bulk bar */
    .bulk-bar { display: flex; align-items: center; gap: 12px; padding: 10px 16px; background: var(--accent-light); border: 1px solid var(--accent); border-radius: var(--radius); margin-bottom: 16px; }
    .bulk-bar .count { font-weight: 600; color: var(--accent); }

    /* Print */
    @media print { #sidebar, #topbar, .toast-container { display: none !important; } #content { padding: 0; } }

    /* Animations */
    @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
    @keyframes slideUp { from { transform: translateY(10px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
    .fade-in { animation: fadeIn .3s ease; }
    .slide-up { animation: slideUp .3s ease; }

    /* Import modal */
    .import-drop { border: 2px dashed var(--border); border-radius: var(--radius-lg); padding: 40px; text-align: center; cursor: pointer; transition: all var(--transition); }
    .import-drop:hover, .import-drop.drag-over { border-color: var(--accent); background: var(--accent-light); }

    /* Theme toggle */
    .theme-toggle { display: flex; align-items: center; gap: 6px; }
    ''')

    # ── JavaScript ────────────────────────────────────────────────────────
    js = textwrap.dedent(r'''
    // Copyright 2026 SkillForge Contributors
    // Licensed under the Apache License, Version 2.0
    // https://www.apache.org/licenses/LICENSE-2.0

    (function(){
    'use strict';

    // ─── Mini YAML Parser (<4KB) ─────────────────────────────────────
    const YAML = {
      parse(str) {
        const result = {};
        if (!str || !str.trim()) return result;
        const lines = str.split('\n');
        let currentKey = null;
        let inList = false;
        let listKey = null;
        let listItems = [];
        let inMap = false;
        let mapKey = null;
        let mapItems = {};

        const flushList = () => { if (listKey) { result[listKey] = listItems; listItems = []; listKey = null; inList = false; } };
        const flushMap = () => { if (mapKey) { result[mapKey] = mapItems; mapItems = {}; mapKey = null; inMap = false; } };

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) continue;

          if (inList && trimmed.startsWith('- ')) {
            listItems.push(trimmed.slice(2).trim().replace(/^["']|["']$/g, ''));
            continue;
          } else if (inList && !trimmed.startsWith('- ')) {
            flushList();
          }

          if (inMap && line.match(/^  \s*\S+:/)) {
            const m = line.match(/^\s+(\S+):\s*(.*)/);
            if (m) { mapItems[m[1]] = m[2].replace(/^["']|["']$/g, '').trim(); continue; }
          } else if (inMap) {
            flushMap();
          }

          const kv = trimmed.match(/^(\S+):\s*(.*)/);
          if (kv) {
            flushList(); flushMap();
            const key = kv[1];
            let val = kv[2].trim();
            if (val === '' || val === '|' || val === '>') {
              // Check if next line is a list item or map
              const nextLine = i + 1 < lines.length ? lines[i + 1] : '';
              const nextTrimmed = nextLine.trim();
              if (nextTrimmed.startsWith('- ')) {
                inList = true; listKey = key; continue;
              } else if (nextLine.match(/^\s+\S+:/)) {
                inMap = true; mapKey = key; continue;
              } else if (val === '|' || val === '>') {
                // Multiline string
                let text = [];
                let j = i + 1;
                const baseIndent = lines[j] ? lines[j].match(/^(\s*)/)[1].length : 2;
                while (j < lines.length) {
                  const l = lines[j];
                  if (l.trim() === '' || l.match(/^\s{2,}/)) {
                    text.push(l.slice(baseIndent));
                    j++;
                  } else break;
                }
                result[key] = val === '|' ? text.join('\n') : text.join(' ').trim();
                i = j - 1;
                continue;
              }
              result[key] = val;
              continue;
            }
            // Remove quotes
            val = val.replace(/^["']|["']$/g, '');
            // Boolean
            if (val === 'true') val = true;
            else if (val === 'false') val = false;
            // Number
            else if (/^-?\d+(\.\d+)?$/.test(val)) val = Number(val);
            result[key] = val;
          }
        }
        flushList(); flushMap();
        return result;
      },
      stringify(obj) {
        let lines = [];
        for (const [k, v] of Object.entries(obj)) {
          if (v === undefined || v === null) continue;
          if (typeof v === 'object' && !Array.isArray(v)) {
            lines.push(`${k}:`);
            for (const [mk, mv] of Object.entries(v)) {
              lines.push(`  ${mk}: ${JSON.stringify(String(mv)).slice(1, -1)}`);
            }
          } else if (Array.isArray(v)) {
            lines.push(`${k}:`);
            v.forEach(item => lines.push(`  - ${item}`));
          } else {
            const sv = String(v);
            if (sv.includes(':') || sv.includes('#') || sv.includes('"') || sv.includes("'") || sv.startsWith(' ') || sv.endsWith(' ')) {
              lines.push(`${k}: "${sv.replace(/"/g, '\\"')}"`);
            } else {
              lines.push(`${k}: ${sv}`);
            }
          }
        }
        return lines.join('\n');
      }
    };

    // ─── Mini Markdown Renderer ──────────────────────────────────────
    const MD = {
      render(src) {
        if (!src) return '';
        let html = src;
        // Escape HTML
        html = html.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        // Code blocks
        html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) =>
          `<pre><code class="lang-${lang}">${code.trim()}</code></pre>`);
        // Inline code
        html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
        // Headers
        html = html.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
        html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
        html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
        html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
        // Bold/Italic
        html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
        html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
        html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
        // Blockquotes
        html = html.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');
        // Horizontal rules
        html = html.replace(/^---$/gm, '<hr>');
        // Links
        html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
        // Unordered lists
        html = html.replace(/^(\s*)[-*] (.+)$/gm, '$1<li>$2</li>');
        html = html.replace(/((?:<li>.*<\/li>\n?)+)/g, '<ul>$1</ul>');
        // Ordered lists
        html = html.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');
        // Paragraphs
        html = html.replace(/\n{2,}/g, '</p><p>');
        html = '<p>' + html + '</p>';
        // Clean up
        html = html.replace(/<p>(<h[1-4]>)/g, '$1');
        html = html.replace(/(<\/h[1-4]>)<\/p>/g, '$1');
        html = html.replace(/<p>(<pre>)/g, '$1');
        html = html.replace(/(<\/pre>)<\/p>/g, '$1');
        html = html.replace(/<p>(<ul>)/g, '$1');
        html = html.replace(/(<\/ul>)<\/p>/g, '$1');
        html = html.replace(/<p>(<blockquote>)/g, '$1');
        html = html.replace(/(<\/blockquote>)<\/p>/g, '$1');
        html = html.replace(/<p>(<hr>)<\/p>/g, '$1');
        html = html.replace(/<p>\s*<\/p>/g, '');
        return html;
      }
    };

    // ─── Mini ZIP Builder ────────────────────────────────────────────
    const ZIP = {
      crc32Table: null,
      initCrc32() {
        if (this.crc32Table) return;
        this.crc32Table = new Uint32Array(256);
        for (let i = 0; i < 256; i++) {
          let c = i;
          for (let j = 0; j < 8; j++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
          this.crc32Table[i] = c;
        }
      },
      crc32(data) {
        this.initCrc32();
        let crc = 0xFFFFFFFF;
        for (let i = 0; i < data.length; i++) crc = this.crc32Table[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
        return (crc ^ 0xFFFFFFFF) >>> 0;
      },
      create(files) {
        // files: [{name: string, data: Uint8Array}]
        this.initCrc32();
        const enc = new TextEncoder();
        let offset = 0;
        const localHeaders = [];
        const centralHeaders = [];
        // Build local file headers + data
        const parts = [];
        for (const file of files) {
          const nameBytes = enc.encode(file.name);
          const data = file.data;
          const crc = this.crc32(data);
          // Local file header
          const lh = new Uint8Array(30 + nameBytes.length);
          const lv = new DataView(lh.buffer);
          lv.setUint32(0, 0x04034b50, true); // signature
          lv.setUint16(4, 20, true); // version needed
          lv.setUint16(6, 0, true); // flags
          lv.setUint16(8, 0, true); // compression (store)
          lv.setUint16(10, 0, true); // mod time
          lv.setUint16(12, 0, true); // mod date
          lv.setUint32(14, crc, true);
          lv.setUint32(18, data.length, true); // compressed size
          lv.setUint32(22, data.length, true); // uncompressed size
          lv.setUint16(26, nameBytes.length, true);
          lv.setUint16(28, 0, true); // extra field length
          lh.set(nameBytes, 30);
          parts.push(lh, data);
          // Central directory header
          const ch = new Uint8Array(46 + nameBytes.length);
          const cv = new DataView(ch.buffer);
          cv.setUint32(0, 0x02014b50, true);
          cv.setUint16(4, 20, true);
          cv.setUint16(6, 20, true);
          cv.setUint16(8, 0, true);
          cv.setUint16(10, 0, true);
          cv.setUint16(12, 0, true);
          cv.setUint16(14, 0, true);
          cv.setUint32(16, crc, true);
          cv.setUint32(20, data.length, true);
          cv.setUint32(24, data.length, true);
          cv.setUint16(28, nameBytes.length, true);
          cv.setUint16(30, 0, true);
          cv.setUint16(32, 0, true);
          cv.setUint16(34, 0, true);
          cv.setUint16(36, 0, true);
          cv.setUint32(38, 0, true);
          cv.setUint32(42, offset, true);
          ch.set(nameBytes, 46);
          centralHeaders.push(ch);
          offset += lh.length + data.length;
        }
        const centralStart = offset;
        let centralSize = 0;
        centralHeaders.forEach(h => centralSize += h.length);
        // End of central directory
        const eocd = new Uint8Array(22);
        const ev = new DataView(eocd.buffer);
        ev.setUint32(0, 0x06054b50, true);
        ev.setUint16(4, 0, true);
        ev.setUint16(6, 0, true);
        ev.setUint16(8, files.length, true);
        ev.setUint16(10, files.length, true);
        ev.setUint32(12, centralSize, true);
        ev.setUint32(16, centralStart, true);
        ev.setUint16(20, 0, true);
        // Combine all
        const allParts = [...parts, ...centralHeaders, eocd];
        const totalLen = allParts.reduce((s, p) => s + p.length, 0);
        const result = new Uint8Array(totalLen);
        let pos = 0;
        for (const p of allParts) { result.set(p, pos); pos += p.length; }
        return result;
      }
    };

    // ─── State ───────────────────────────────────────────────────────
    const State = {
      dirHandle: null,
      skills: [],
      selectedSkills: new Set(),
      currentSkill: null,
      view: 'welcome', // welcome, dashboard, wizard, editor, settings, collections, sync, marketplace
      wizardStep: 0,
      wizardData: {},
      theme: localStorage.getItem('sf-theme') || 'system',
      proMode: localStorage.getItem('sf-proMode') === 'true',
      recentlyUsed: JSON.parse(localStorage.getItem('sf-recent') || '[]'),
      collections: [],
      additionalFolders: [], // for cross-agent sync
      searchQuery: '',
      sortBy: localStorage.getItem('sf-sort') || 'alpha',
      filterTag: '',
      filterAgent: '',
      bulkMode: false,
      editorDirty: false,
      aiProvider: localStorage.getItem('sf-aiProvider') || '',
      aiKey: localStorage.getItem('sf-aiKey') || '',
    };

    // ─── Helpers ─────────────────────────────────────────────────────
    const $ = (s, p) => (p || document).querySelector(s);
    const $$ = (s, p) => [...(p || document).querySelectorAll(s)];
    const el = (tag, attrs, ...children) => {
      const e = document.createElement(tag);
      if (attrs) Object.entries(attrs).forEach(([k, v]) => {
        if (k === 'className') e.className = v;
        else if (k === 'innerHTML') e.innerHTML = v;
        else if (k === 'textContent') e.textContent = v;
        else if (k.startsWith('on')) e.addEventListener(k.slice(2).toLowerCase(), v);
        else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
        else e.setAttribute(k, v);
      });
      children.flat().forEach(c => { if (c) e.append(typeof c === 'string' ? document.createTextNode(c) : c); });
      return e;
    };

    function slugify(str) {
      return str.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 64);
    }

    function truncate(str, len) {
      if (!str) return '';
      return str.length > len ? str.slice(0, len - 1) + '\u2026' : str;
    }

    function timeAgo(date) {
      if (!date) return '';
      const s = Math.floor((Date.now() - date.getTime()) / 1000);
      if (s < 60) return 'just now';
      if (s < 3600) return Math.floor(s / 60) + 'm ago';
      if (s < 86400) return Math.floor(s / 3600) + 'h ago';
      if (s < 604800) return Math.floor(s / 86400) + 'd ago';
      return date.toLocaleDateString();
    }

    function countTokens(text) {
      // Rough estimate: ~4 chars per token for English
      return Math.ceil((text || '').length / 4);
    }

    function parseFrontmatter(content) {
      const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
      if (!match) return { frontmatter: {}, body: content };
      return { frontmatter: YAML.parse(match[1]), body: match[2] };
    }

    function serializeSkill(frontmatter, body) {
      return `---\n${YAML.stringify(frontmatter)}\n---\n${body}`;
    }

    // ─── Theme ───────────────────────────────────────────────────────
    function applyTheme() {
      const t = State.theme;
      if (t === 'dark' || (t === 'system' && matchMedia('(prefers-color-scheme: dark)').matches)) {
        document.documentElement.setAttribute('data-theme', 'dark');
      } else {
        document.documentElement.removeAttribute('data-theme');
      }
    }
    function cycleTheme() {
      const order = ['system', 'light', 'dark'];
      State.theme = order[(order.indexOf(State.theme) + 1) % 3];
      localStorage.setItem('sf-theme', State.theme);
      applyTheme();
      renderTopbar();
    }

    // ─── Toast ───────────────────────────────────────────────────────
    function toast(msg, type = 'success') {
      const container = $('.toast-container') || document.body.appendChild(el('div', { className: 'toast-container' }));
      const t = el('div', { className: `toast ${type}`, textContent: msg });
      container.appendChild(t);
      setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; setTimeout(() => t.remove(), 300); }, 3000);
    }

    // ─── Validation Engine (F-05) ────────────────────────────────────
    function validateSkill(skill) {
      const issues = [];
      const fm = skill.frontmatter || {};
      const body = skill.body || '';
      const content = skill.rawContent || '';

      // Name
      if (!fm.name) issues.push({ type: 'error', msg: 'Missing required field: name', field: 'name' });
      else {
        if (fm.name.length > 64) issues.push({ type: 'error', msg: `Name exceeds 64 characters (${fm.name.length})`, field: 'name' });
        if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(fm.name) && fm.name.length > 1)
          issues.push({ type: 'error', msg: 'Name must be lowercase alphanumeric and hyphens, no leading/trailing hyphens', field: 'name', autoFix: 'slug' });
        if (/--/.test(fm.name)) issues.push({ type: 'error', msg: 'Name must not contain consecutive hyphens', field: 'name' });
        if (fm.name.length === 1 && !/^[a-z0-9]$/.test(fm.name))
          issues.push({ type: 'error', msg: 'Single-character name must be alphanumeric', field: 'name' });
      }

      // Description
      if (!fm.description) issues.push({ type: 'error', msg: 'Missing required field: description', field: 'description' });
      else if (fm.description.length > 1024) issues.push({ type: 'error', msg: `Description exceeds 1024 characters (${fm.description.length})`, field: 'description' });

      // Compatibility
      if (fm.compatibility && fm.compatibility.length > 500)
        issues.push({ type: 'warn', msg: `Compatibility exceeds 500 characters (${fm.compatibility.length})`, field: 'compatibility' });

      // Body
      const lines = content.split('\n').length;
      const tokens = countTokens(content);
      if (lines > 500) issues.push({ type: 'warn', msg: `SKILL.md exceeds 500 lines (${lines})`, field: 'body' });
      if (tokens > 5000) issues.push({ type: 'warn', msg: `SKILL.md exceeds 5000 tokens (~${tokens})`, field: 'body' });

      // YAML validity check
      try {
        const test = content.match(/^---\n([\s\S]*?)\n---/);
        if (test) YAML.parse(test[1]);
      } catch (e) {
        issues.push({ type: 'error', msg: 'Invalid YAML frontmatter', field: 'yaml' });
      }

      return issues;
    }

    function getValidationStatus(issues) {
      if (issues.some(i => i.type === 'error')) return 'error';
      if (issues.some(i => i.type === 'warn')) return 'warning';
      return 'valid';
    }

    // ─── Quality Scorer (F-14) ───────────────────────────────────────
    function scoreSkill(skill) {
      const fm = skill.frontmatter || {};
      const body = skill.body || '';
      const content = skill.rawContent || '';
      const scores = {};

      // Specificity (0-100): check for concrete instructions, examples, specific terms
      let spec = 40;
      if (body.length > 200) spec += 15;
      if (/example|e\.g\.|for instance/i.test(body)) spec += 15;
      if (/step \d|1\.|first|then|next|finally/i.test(body)) spec += 15;
      if (/must|should|always|never/i.test(body)) spec += 15;
      scores.specificity = Math.min(100, spec);

      // Scope (0-100): appropriate length, not too broad/narrow
      const tokens = countTokens(content);
      let scope = 50;
      if (tokens > 100 && tokens < 4000) scope = 90;
      else if (tokens > 50) scope = 70;
      else if (tokens > 4000) scope = 60;
      if (fm.name && fm.name.split('-').length >= 2) scope = Math.min(100, scope + 10);
      scores.scope = Math.min(100, scope);

      // Completeness (0-100)
      let comp = 0;
      if (fm.name) comp += 20;
      if (fm.description) comp += 20;
      if (body.length > 50) comp += 20;
      if (/## |### /m.test(body)) comp += 15;
      if (/output|result|format|return/i.test(body)) comp += 15;
      if (fm.license) comp += 5;
      if (fm.metadata) comp += 5;
      scores.completeness = Math.min(100, comp);

      // Token Efficiency (0-100)
      let eff = 80;
      if (tokens > 5000) eff = 30;
      else if (tokens > 4000) eff = 50;
      else if (tokens > 3000) eff = 65;
      else if (tokens < 50) eff = 40;
      scores.tokenEfficiency = Math.min(100, eff);

      // Progressive Disclosure (0-100)
      let pd = 50;
      if (fm.description && fm.description.length > 20 && fm.description.length < 200) pd += 20;
      if (skill.files && skill.files.length > 1) pd += 20;
      if (tokens < 3000) pd += 10;
      scores.progressiveDisclosure = Math.min(100, pd);

      scores.overall = Math.round(
        (scores.specificity + scores.scope + scores.completeness + scores.tokenEfficiency + scores.progressiveDisclosure) / 5
      );
      return scores;
    }

    // ─── File System Operations ──────────────────────────────────────
    async function openFolder() {
      try {
        State.dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
        await loadSkills();
        State.view = 'dashboard';
        render();
      } catch (e) {
        if (e.name !== 'AbortError') toast('Failed to open folder: ' + e.message, 'error');
      }
    }

    async function loadSkills() {
      if (!State.dirHandle) return;
      const skills = [];
      try {
        for await (const entry of State.dirHandle.values()) {
          if (entry.kind !== 'directory' || entry.name.startsWith('.')) continue;
          try {
            const skillDir = await State.dirHandle.getDirectoryHandle(entry.name);
            let skillMd = null;
            let files = [];
            for await (const file of skillDir.values()) {
              files.push({ name: file.name, kind: file.kind });
              if (file.kind === 'file' && file.name === 'SKILL.md') {
                skillMd = file;
              }
            }
            if (skillMd) {
              const fileHandle = await skillDir.getFileHandle('SKILL.md');
              const file = await fileHandle.getFile();
              const content = await file.text();
              const { frontmatter, body } = parseFrontmatter(content);
              const skill = {
                dirName: entry.name,
                dirHandle: skillDir,
                fileHandle,
                frontmatter,
                body,
                rawContent: content,
                files,
                lastModified: file.lastModified ? new Date(file.lastModified) : null,
                lineCount: content.split('\n').length,
                tokenCount: countTokens(content),
              };
              skill.validation = validateSkill(skill);
              skill.scores = scoreSkill(skill);
              skills.push(skill);
            }
          } catch (e) { /* skip invalid dirs */ }
        }
      } catch (e) {
        toast('Error reading folder: ' + e.message, 'error');
      }
      // Load collections
      try {
        const sfDir = await State.dirHandle.getDirectoryHandle('.skillforge', { create: false }).catch(() => null);
        if (sfDir) {
          try {
            const colFile = await sfDir.getFileHandle('collections.json');
            const f = await (await colFile.getFile()).text();
            State.collections = JSON.parse(f);
          } catch (e) { State.collections = []; }
        }
      } catch (e) { State.collections = []; }
      State.skills = skills;
    }

    async function saveSkillContent(skill, content) {
      try {
        const writable = await skill.fileHandle.createWritable();
        await writable.write(content);
        await writable.close();
        // Update in-memory
        const { frontmatter, body } = parseFrontmatter(content);
        skill.rawContent = content;
        skill.frontmatter = frontmatter;
        skill.body = body;
        skill.lineCount = content.split('\n').length;
        skill.tokenCount = countTokens(content);
        skill.validation = validateSkill(skill);
        skill.scores = scoreSkill(skill);
        skill.lastModified = new Date();
        // Save history
        await saveHistory(skill);
        State.editorDirty = false;
        toast('Saved');
        return true;
      } catch (e) {
        toast('Save failed: ' + e.message, 'error');
        return false;
      }
    }

    async function createSkill(name, content) {
      if (!State.dirHandle) return null;
      try {
        const dirHandle = await State.dirHandle.getDirectoryHandle(name, { create: true });
        const fileHandle = await dirHandle.getFileHandle('SKILL.md', { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(content);
        await writable.close();
        await loadSkills();
        toast('Skill created: ' + name);
        return name;
      } catch (e) {
        toast('Failed to create skill: ' + e.message, 'error');
        return null;
      }
    }

    async function deleteSkill(skill) {
      try {
        await State.dirHandle.removeEntry(skill.dirName, { recursive: true });
        State.skills = State.skills.filter(s => s !== skill);
        toast('Deleted: ' + skill.dirName);
        return true;
      } catch (e) {
        toast('Delete failed: ' + e.message, 'error');
        return false;
      }
    }

    async function duplicateSkill(skill) {
      let newName = skill.dirName + '-copy';
      let counter = 1;
      while (State.skills.some(s => s.dirName === newName)) {
        newName = skill.dirName + '-copy-' + counter++;
      }
      return createSkill(newName, skill.rawContent);
    }

    // ─── Version History (F-11) ──────────────────────────────────────
    async function saveHistory(skill) {
      try {
        const sfDir = await State.dirHandle.getDirectoryHandle('.skillforge', { create: true });
        const histDir = await sfDir.getDirectoryHandle('history', { create: true });
        const fileName = skill.dirName + '.jsonl';
        let existing = '';
        try {
          const fh = await histDir.getFileHandle(fileName);
          existing = await (await fh.getFile()).text();
        } catch (e) { /* new file */ }
        const entry = JSON.stringify({ ts: Date.now(), content: skill.rawContent });
        const fh = await histDir.getFileHandle(fileName, { create: true });
        const w = await fh.createWritable();
        await w.write(existing + entry + '\n');
        await w.close();
      } catch (e) { /* silently fail */ }
    }

    async function loadHistory(skill) {
      try {
        const sfDir = await State.dirHandle.getDirectoryHandle('.skillforge', { create: false });
        const histDir = await sfDir.getDirectoryHandle('history', { create: false });
        const fh = await histDir.getFileHandle(skill.dirName + '.jsonl');
        const text = await (await fh.getFile()).text();
        return text.trim().split('\n').filter(Boolean).map(l => JSON.parse(l)).reverse();
      } catch (e) { return []; }
    }

    // ─── Collections (F-16) ──────────────────────────────────────────
    async function saveCollections() {
      try {
        const sfDir = await State.dirHandle.getDirectoryHandle('.skillforge', { create: true });
        const fh = await sfDir.getFileHandle('collections.json', { create: true });
        const w = await fh.createWritable();
        await w.write(JSON.stringify(State.collections, null, 2));
        await w.close();
      } catch (e) { toast('Failed to save collections', 'error'); }
    }

    // ─── Export (F-09) ───────────────────────────────────────────────
    function exportSkillZip(skill) {
      const enc = new TextEncoder();
      const files = [{ name: `${skill.dirName}/SKILL.md`, data: enc.encode(skill.rawContent) }];
      const zip = ZIP.create(files);
      downloadBlob(new Blob([zip], { type: 'application/zip' }), `${skill.dirName}.zip`);
      toast('Exported: ' + skill.dirName);
    }

    function exportAllZip() {
      const enc = new TextEncoder();
      const files = State.skills.map(s => ({ name: `${s.dirName}/SKILL.md`, data: enc.encode(s.rawContent) }));
      const zip = ZIP.create(files);
      downloadBlob(new Blob([zip], { type: 'application/zip' }), 'skills-export.zip');
      toast('Exported all skills');
    }

    function downloadBlob(blob, name) {
      const url = URL.createObjectURL(blob);
      const a = el('a', { href: url, download: name });
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    }

    async function importFromUrl() {
      const url = prompt('Paste a raw SKILL.md URL:');
      if (!url) return;
      try {
        const resp = await fetch(url);
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const content = await resp.text();
        const { frontmatter } = parseFrontmatter(content);
        const name = frontmatter.name || 'imported-skill';
        await createSkill(slugify(name), content);
        render();
      } catch (e) {
        toast('Import failed: ' + e.message, 'error');
      }
    }

    // ─── Clipboard ───────────────────────────────────────────────────
    async function copyToClipboard(text) {
      try {
        await navigator.clipboard.writeText(text);
        toast('Copied to clipboard');
      } catch (e) {
        toast('Copy failed', 'error');
      }
    }

    // ─── Templates ───────────────────────────────────────────────────
    const TEMPLATES = [
      { id: 'code-reviewer', icon: '🔍', name: 'Code Reviewer', category: 'Development', desc: 'Review code for quality, security, and standards',
        content: `---\nname: code-reviewer\ndescription: Review code for quality, security, and standards. Use when reviewing pull requests or code changes.\n---\n# Code Reviewer\n\n## Process\n1. Read the code changes carefully\n2. Check for security vulnerabilities (injection, XSS, etc.)\n3. Verify code follows project conventions\n4. Look for performance issues\n5. Check error handling completeness\n\n## Output Format\n- **Summary**: Brief overview of findings\n- **Issues**: List each issue with severity (Critical/Major/Minor)\n- **Suggestions**: Improvement recommendations\n- **Verdict**: Approve / Request Changes\n` },
      { id: 'documentation-writer', icon: '📝', name: 'Documentation Writer', category: 'Development', desc: 'Generate structured docs from code or specs',
        content: `---\nname: documentation-writer\ndescription: Generate structured documentation from code or specifications. Use when creating README files, API docs, or guides.\n---\n# Documentation Writer\n\n## Process\n1. Analyze the source material (code, spec, or outline)\n2. Identify the target audience\n3. Structure content with clear hierarchy\n4. Write concise, accurate descriptions\n5. Include code examples where helpful\n\n## Output Format\n- Title and overview\n- Installation/setup instructions\n- Usage examples\n- API reference (if applicable)\n- Troubleshooting section\n` },
      { id: 'pr-description-writer', icon: '🔀', name: 'PR Description Writer', category: 'Development', desc: 'Write PR summaries from git diffs',
        content: `---\nname: pr-description-writer\ndescription: Write clear pull request descriptions from git diffs. Use when creating or updating pull requests.\n---\n# PR Description Writer\n\n## Process\n1. Analyze the git diff to understand changes\n2. Identify the motivation and context\n3. Summarize what changed and why\n4. Note any breaking changes or migration steps\n\n## Output Format\n## Summary\n- Bullet points of key changes\n\n## Motivation\nWhy this change was needed\n\n## Testing\n- How to verify the changes\n\n## Breaking Changes\nList any breaking changes (or "None")\n` },
      { id: 'research-synthesizer', icon: '🔬', name: 'Research Synthesizer', category: 'Research', desc: 'Gather and summarize info on a topic',
        content: `---\nname: research-synthesizer\ndescription: Research and synthesize information on a given topic. Use when gathering background information or conducting analysis.\n---\n# Research Synthesizer\n\n## Process\n1. Identify the key question or topic\n2. Gather relevant sources and data\n3. Identify common themes and patterns\n4. Note conflicting information\n5. Synthesize into actionable insights\n\n## Output Format\n- **Key Findings**: Top 3-5 insights\n- **Evidence**: Supporting data for each finding\n- **Gaps**: What information is missing\n- **Recommendations**: Suggested next steps\n` },
      { id: 'meeting-notes-formatter', icon: '📋', name: 'Meeting Notes Formatter', category: 'Productivity', desc: 'Convert raw notes into structured summaries',
        content: `---\nname: meeting-notes-formatter\ndescription: Convert raw meeting notes into structured summaries. Use after meetings to create clear, actionable records.\n---\n# Meeting Notes Formatter\n\n## Process\n1. Parse the raw notes for key information\n2. Identify decisions made\n3. Extract action items with owners\n4. Summarize discussion topics\n\n## Output Format\n- **Date & Attendees**\n- **Summary**: 2-3 sentence overview\n- **Decisions**: Numbered list of decisions\n- **Action Items**: Task, owner, deadline\n- **Discussion Notes**: Key points discussed\n- **Next Meeting**: Date and agenda items\n` },
      { id: 'email-drafter', icon: '✉️', name: 'Email Drafter', category: 'Communication', desc: 'Draft professional emails from bullet points',
        content: `---\nname: email-drafter\ndescription: Draft professional emails from bullet points or rough notes. Use when composing important emails or responses.\n---\n# Email Drafter\n\n## Process\n1. Understand the context and recipient\n2. Determine the appropriate tone (formal, friendly, urgent)\n3. Structure the email with clear purpose\n4. Keep paragraphs short and scannable\n5. End with a clear call to action\n\n## Output Format\n- Subject line\n- Greeting\n- Body (2-4 short paragraphs)\n- Call to action\n- Sign-off\n` },
      { id: 'data-analyst', icon: '📊', name: 'Data Analyst', category: 'Data', desc: 'Clean, analyze, and summarize CSV/JSON data',
        content: `---\nname: data-analyst\ndescription: Clean, analyze, and summarize CSV or JSON data. Use when working with datasets or generating reports.\n---\n# Data Analyst\n\n## Process\n1. Examine the data structure and quality\n2. Clean and normalize data as needed\n3. Calculate key statistics and metrics\n4. Identify trends and patterns\n5. Generate visualizations if helpful\n\n## Output Format\n- **Data Summary**: Shape, columns, types\n- **Key Metrics**: Important statistics\n- **Findings**: Notable patterns or anomalies\n- **Recommendations**: Data-driven suggestions\n` },
      { id: 'brand-voice-writer', icon: '🎨', name: 'Brand Voice Writer', category: 'Content', desc: 'Write content following custom brand guidelines',
        content: `---\nname: brand-voice-writer\ndescription: Write content following custom brand voice guidelines. Use when creating marketing copy, social posts, or brand content.\n---\n# Brand Voice Writer\n\n## Process\n1. Review the brand voice guidelines\n2. Understand the target audience\n3. Match the tone, vocabulary, and style\n4. Write content that feels authentic to the brand\n5. Check against brand dos and don'ts\n\n## Output Format\n- Draft content in brand voice\n- Notes on brand alignment\n- Alternative versions if requested\n` },
      { id: 'weekly-standup-generator', icon: '📅', name: 'Weekly Standup Generator', category: 'Productivity', desc: 'Auto-generate standup summaries from work logs',
        content: `---\nname: weekly-standup-generator\ndescription: Generate standup summaries from work logs, commits, or task lists. Use to prepare for standup meetings.\n---\n# Weekly Standup Generator\n\n## Process\n1. Review recent work activity (commits, tasks, notes)\n2. Categorize into completed, in-progress, and blocked items\n3. Highlight key achievements\n4. Identify blockers and dependencies\n\n## Output Format\n### Done\n- Completed items this period\n\n### In Progress\n- Current work items with status\n\n### Blocked\n- Items needing help or waiting on others\n\n### Next\n- Planned items for next period\n` },
      { id: 'blank', icon: '📄', name: 'Blank (Advanced)', category: 'Meta', desc: 'Empty template with frontmatter only',
        content: `---\nname: my-skill\ndescription: Describe what this skill does and when to use it.\n---\n# My Skill\n\nAdd your instructions here.\n` },
    ];

    // ─── Agent info ──────────────────────────────────────────────────
    const AGENTS = [
      { id: 'claude', name: 'Claude Code', color: '#f59e0b', path: '~/.claude/skills' },
      { id: 'codex', name: 'OpenAI Codex', color: '#3b82f6', path: '~/.codex/skills' },
      { id: 'cursor', name: 'Cursor', color: '#8b5cf6', path: '~/.cursor/skills' },
      { id: 'copilot', name: 'GitHub Copilot', color: '#22c55e', path: '~/.github/skills' },
    ];

    function getInstallCommand(skillName, agent) {
      return `npx openskills install ${skillName} --agent ${agent}`;
    }

    // ─── SVG Icons ───────────────────────────────────────────────────
    const ICONS = {
      menu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>',
      search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>',
      plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
      folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>',
      home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>',
      edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>',
      trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
      download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
      upload: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>',
      copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
      x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
      check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>',
      settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
      sun: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>',
      moon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>',
      monitor: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>',
      layers: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>',
      grid: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>',
      clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
      tag: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>',
      zap: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>',
      globe: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>',
      refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>',
      chevronRight: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>',
      wand: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 4V2"/><path d="M15 16v-2"/><path d="M8 9h2"/><path d="M20 9h2"/><path d="M17.8 11.8L19 13"/><path d="M15 9h.01"/><path d="M17.8 6.2L19 5"/><path d="M11 6.2L9.8 5"/><path d="M11 11.8L9.8 13"/><path d="m2 22 10-10"/></svg>',
    };

    function icon(name, size) {
      const s = size || 18;
      return `<span style="display:inline-flex;width:${s}px;height:${s}px">${ICONS[name] || ''}</span>`;
    }

    // ─── Filtering & Sorting ─────────────────────────────────────────
    function getFilteredSkills() {
      let skills = [...State.skills];
      // Search
      if (State.searchQuery) {
        const q = State.searchQuery.toLowerCase();
        skills = skills.filter(s =>
          (s.frontmatter.name || '').toLowerCase().includes(q) ||
          (s.frontmatter.description || '').toLowerCase().includes(q) ||
          (s.body || '').toLowerCase().includes(q) ||
          s.dirName.toLowerCase().includes(q)
        );
      }
      // Filter by tag
      if (State.filterTag) {
        skills = skills.filter(s => {
          const meta = s.frontmatter.metadata;
          if (meta && meta.tags) return meta.tags.includes(State.filterTag);
          return false;
        });
      }
      // Sort
      switch (State.sortBy) {
        case 'alpha': skills.sort((a, b) => a.dirName.localeCompare(b.dirName)); break;
        case 'modified': skills.sort((a, b) => (b.lastModified || 0) - (a.lastModified || 0)); break;
        case 'lines': skills.sort((a, b) => b.lineCount - a.lineCount); break;
        case 'score': skills.sort((a, b) => (b.scores?.overall || 0) - (a.scores?.overall || 0)); break;
        case 'created': skills.sort((a, b) => a.dirName.localeCompare(b.dirName)); break;
      }
      return skills;
    }

    function getAllTags() {
      const tags = new Set();
      State.skills.forEach(s => {
        const meta = s.frontmatter.metadata;
        if (meta && meta.tags) {
          if (typeof meta.tags === 'string') meta.tags.split(',').forEach(t => tags.add(t.trim()));
          else if (Array.isArray(meta.tags)) meta.tags.forEach(t => tags.add(t));
        }
      });
      return [...tags];
    }

    // ─── Render Functions ────────────────────────────────────────────
    function render() {
      const app = $('#app');
      if (!app) return;
      if (State.view === 'welcome') {
        app.innerHTML = '';
        app.appendChild(renderWelcome());
      } else {
        app.innerHTML = '';
        app.appendChild(renderSidebar());
        const main = el('div', { id: 'main' });
        main.appendChild(renderTopbarEl());
        const content = el('div', { id: 'content' });
        switch (State.view) {
          case 'dashboard': content.appendChild(renderDashboard()); break;
          case 'wizard': content.appendChild(renderWizard()); break;
          case 'editor': content.appendChild(renderEditor()); break;
          case 'settings': content.appendChild(renderSettings()); break;
          case 'collections': content.appendChild(renderCollections()); break;
          case 'sync': content.appendChild(renderSync()); break;
          case 'marketplace': content.appendChild(renderMarketplace()); break;
        }
        main.appendChild(content);
        app.appendChild(main);
      }
    }

    // ─── Welcome (F-01) ──────────────────────────────────────────────
    function renderWelcome() {
      const wrap = el('div', { id: 'welcome', className: 'fade-in' });
      const inner = el('div', { className: 'welcome-inner' });
      inner.innerHTML = `
        <div class="welcome-logo">SF</div>
        <h1>SkillForge</h1>
        <p>Manage your AI agent skills visually. Create, edit, organize, and deploy skills from your browser — no terminal needed.</p>
        <div class="welcome-paths">
          <strong>Common skill folder locations:</strong>
          <ul>
            <li><code>~/.claude/skills</code> — Claude Code</li>
            <li><code>~/.codex/skills</code> — OpenAI Codex</li>
            <li><code>~/.cursor/skills</code> — Cursor</li>
            <li><code>~/.github/skills</code> — GitHub Copilot</li>
          </ul>
        </div>
      `;
      const btn = el('button', { className: 'btn btn-primary', style: { padding: '12px 32px', fontSize: '16px' }, onClick: openFolder });
      btn.innerHTML = `${icon('folder')} Open Skills Folder`;
      inner.appendChild(btn);

      if (!window.showDirectoryPicker) {
        const notice = el('div', { className: 'compat-notice' });
        notice.textContent = 'Your browser does not support the File System Access API. Please use Chrome 120+, Edge 120+, Brave, or Arc.';
        inner.appendChild(notice);
      }
      wrap.appendChild(inner);
      return wrap;
    }

    // ─── Sidebar ─────────────────────────────────────────────────────
    function renderSidebar() {
      const sidebar = el('div', { id: 'sidebar' });
      sidebar.innerHTML = `
        <div class="sidebar-header">
          <div class="sidebar-logo">SF</div>
          <div class="sidebar-title">SkillForge</div>
        </div>
      `;
      const nav = el('div', { className: 'sidebar-nav' });
      const items = [
        { id: 'dashboard', icon: 'home', label: 'Library', badge: State.skills.length },
        { id: 'wizard', icon: 'plus', label: 'New Skill' },
        { id: 'collections', icon: 'layers', label: 'Collections' },
        { id: 'sync', icon: 'refresh', label: 'Cross-Agent Sync' },
        { id: 'marketplace', icon: 'globe', label: 'Marketplace' },
        { id: 'settings', icon: 'settings', label: 'Settings' },
      ];
      items.forEach(item => {
        const btn = el('button', {
          className: `nav-item${State.view === item.id ? ' active' : ''}`,
          onClick: () => { State.view = item.id; if (item.id === 'wizard') { State.wizardStep = 0; State.wizardData = {}; } render(); },
          'aria-label': item.label,
        });
        btn.innerHTML = icon(item.icon);
        btn.appendChild(document.createTextNode(' ' + item.label));
        if (item.badge !== undefined) {
          const badge = el('span', { className: 'nav-badge', textContent: String(item.badge) });
          btn.appendChild(badge);
        }
        nav.appendChild(btn);
      });
      sidebar.appendChild(nav);
      const footer = el('div', { className: 'sidebar-footer' });
      const folderBtn = el('button', { className: 'btn btn-ghost btn-sm', onClick: openFolder });
      folderBtn.innerHTML = `${icon('folder', 14)} Change Folder`;
      footer.appendChild(folderBtn);
      footer.appendChild(el('span', { textContent: 'SkillForge v1.0 — Apache 2.0', style: { fontSize: '11px' } }));
      sidebar.appendChild(footer);
      return sidebar;
    }

    // ─── Topbar ──────────────────────────────────────────────────────
    function renderTopbarEl() {
      const topbar = el('div', { id: 'topbar' });
      // Mobile menu toggle
      const menuBtn = el('button', { className: 'topbar-btn', onClick: () => { const s = $('#sidebar'); s.classList.toggle('mobile-open'); }, 'aria-label': 'Toggle menu' });
      menuBtn.innerHTML = ICONS.menu;
      topbar.appendChild(menuBtn);

      // Search box
      const searchBox = el('div', { className: 'search-box' });
      searchBox.innerHTML = ICONS.search;
      const searchInput = el('input', {
        type: 'text', placeholder: 'Search skills...', value: State.searchQuery,
        'aria-label': 'Search skills',
        onInput: (e) => { State.searchQuery = e.target.value; renderContent(); },
      });
      searchBox.appendChild(searchInput);
      searchBox.appendChild(el('span', { className: 'search-kbd', textContent: 'Ctrl+K' }));
      topbar.appendChild(searchBox);

      // Actions
      const actions = el('div', { className: 'topbar-actions' });
      // Theme toggle
      const themeIcon = State.theme === 'dark' ? 'moon' : State.theme === 'light' ? 'sun' : 'monitor';
      const themeBtn = el('button', { className: 'topbar-btn', onClick: cycleTheme, title: `Theme: ${State.theme}`, 'aria-label': 'Toggle theme' });
      themeBtn.innerHTML = ICONS[themeIcon];
      actions.appendChild(themeBtn);

      // New skill
      const newBtn = el('button', { className: 'btn btn-primary btn-sm', onClick: () => { State.view = 'wizard'; State.wizardStep = 0; State.wizardData = {}; render(); } });
      newBtn.innerHTML = `${icon('plus', 14)} New Skill`;
      actions.appendChild(newBtn);
      topbar.appendChild(actions);
      return topbar;
    }

    function renderTopbar() {
      const existing = $('#topbar');
      if (existing) existing.replaceWith(renderTopbarEl());
    }

    function renderContent() {
      const content = $('#content');
      if (!content) return;
      content.innerHTML = '';
      switch (State.view) {
        case 'dashboard': content.appendChild(renderDashboard()); break;
        case 'wizard': content.appendChild(renderWizard()); break;
        case 'editor': content.appendChild(renderEditor()); break;
        case 'settings': content.appendChild(renderSettings()); break;
        case 'collections': content.appendChild(renderCollections()); break;
        case 'sync': content.appendChild(renderSync()); break;
        case 'marketplace': content.appendChild(renderMarketplace()); break;
      }
    }

    // ─── Dashboard (F-02) ────────────────────────────────────────────
    function renderDashboard() {
      const wrap = el('div', { className: 'slide-up' });
      const skills = getFilteredSkills();

      if (State.skills.length === 0) {
        // Empty state
        const empty = el('div', { className: 'empty-state' });
        empty.innerHTML = `
          <div class="empty-icon">✨</div>
          <h2>Create Your First Skill</h2>
          <p>Agent skills are modular capability files that extend what AI agents can do. Get started with a template or create from scratch.</p>
        `;
        const row = el('div', { style: { display: 'flex', gap: '10px' } });
        const createBtn = el('button', { className: 'btn btn-primary', onClick: () => { State.view = 'wizard'; State.wizardStep = 0; State.wizardData = {}; render(); } });
        createBtn.innerHTML = `${icon('plus')} Create Skill`;
        const browseBtn = el('button', { className: 'btn btn-secondary', onClick: () => { State.view = 'wizard'; State.wizardStep = 1; State.wizardData = {}; render(); } });
        browseBtn.innerHTML = `${icon('grid')} Browse Templates`;
        row.append(createBtn, browseBtn);
        empty.appendChild(row);
        wrap.appendChild(empty);
        return wrap;
      }

      // Filter bar
      const filterBar = el('div', { className: 'filter-bar' });

      // Sort
      const sortSelect = el('select', { className: 'form-select', style: { width: 'auto' }, 'aria-label': 'Sort skills',
        onChange: (e) => { State.sortBy = e.target.value; localStorage.setItem('sf-sort', State.sortBy); renderContent(); }
      });
      [['alpha', 'A-Z'], ['modified', 'Last Modified'], ['lines', 'Line Count'], ['score', 'Quality Score']].forEach(([v, l]) => {
        const opt = el('option', { value: v, textContent: l });
        if (State.sortBy === v) opt.selected = true;
        sortSelect.appendChild(opt);
      });
      filterBar.appendChild(sortSelect);

      // Tag filter
      const tags = getAllTags();
      if (tags.length > 0) {
        const tagSelect = el('select', { className: 'form-select', style: { width: 'auto' }, 'aria-label': 'Filter by tag',
          onChange: (e) => { State.filterTag = e.target.value; renderContent(); }
        });
        tagSelect.appendChild(el('option', { value: '', textContent: 'All Tags' }));
        tags.forEach(t => tagSelect.appendChild(el('option', { value: t, textContent: t })));
        filterBar.appendChild(tagSelect);
      }

      // Bulk toggle
      const bulkBtn = el('button', { className: `btn btn-sm ${State.bulkMode ? 'btn-primary' : 'btn-ghost'}`,
        onClick: () => { State.bulkMode = !State.bulkMode; State.selectedSkills.clear(); renderContent(); }
      });
      bulkBtn.textContent = State.bulkMode ? 'Cancel Selection' : 'Select';
      filterBar.appendChild(bulkBtn);

      // Export all
      const exportBtn = el('button', { className: 'btn btn-ghost btn-sm', onClick: exportAllZip });
      exportBtn.innerHTML = `${icon('download', 14)} Export All`;
      filterBar.appendChild(exportBtn);

      // Import
      const importBtn = el('button', { className: 'btn btn-ghost btn-sm', onClick: importFromUrl });
      importBtn.innerHTML = `${icon('upload', 14)} Import`;
      filterBar.appendChild(importBtn);

      filterBar.appendChild(el('span', { className: 'filter-count', textContent: `${skills.length} skill${skills.length !== 1 ? 's' : ''}` }));
      wrap.appendChild(filterBar);

      // Bulk actions bar
      if (State.bulkMode && State.selectedSkills.size > 0) {
        const bulkBar = el('div', { className: 'bulk-bar' });
        bulkBar.innerHTML = `<span class="count">${State.selectedSkills.size} selected</span>`;
        const delBtn = el('button', { className: 'btn btn-danger btn-sm', onClick: async () => {
          if (!confirm(`Delete ${State.selectedSkills.size} skills?`)) return;
          for (const name of State.selectedSkills) {
            const s = State.skills.find(sk => sk.dirName === name);
            if (s) await deleteSkill(s);
          }
          State.selectedSkills.clear(); State.bulkMode = false; renderContent();
        } });
        delBtn.textContent = 'Delete';
        const expBtn = el('button', { className: 'btn btn-secondary btn-sm', onClick: () => {
          const enc = new TextEncoder();
          const files = [];
          for (const name of State.selectedSkills) {
            const s = State.skills.find(sk => sk.dirName === name);
            if (s) files.push({ name: `${s.dirName}/SKILL.md`, data: enc.encode(s.rawContent) });
          }
          const zip = ZIP.create(files);
          downloadBlob(new Blob([zip], { type: 'application/zip' }), 'skills-selection.zip');
          toast('Exported selected skills');
        } });
        expBtn.textContent = 'Export';
        bulkBar.append(delBtn, expBtn);
        wrap.appendChild(bulkBar);
      }

      // Card grid (with batch rendering for 200+)
      const grid = el('div', { className: `card-grid ${State.bulkMode ? 'bulk-mode' : ''}` });
      const renderBatch = (startIdx) => {
        const batchSize = 50;
        const end = Math.min(startIdx + batchSize, skills.length);
        for (let i = startIdx; i < end; i++) {
          grid.appendChild(renderSkillCard(skills[i]));
        }
        if (end < skills.length) {
          requestAnimationFrame(() => renderBatch(end));
        }
      };
      renderBatch(0);
      wrap.appendChild(grid);
      return wrap;
    }

    function renderSkillCard(skill) {
      const card = el('div', {
        className: `skill-card${State.selectedSkills.has(skill.dirName) ? ' selected' : ''}`,
        onClick: (e) => {
          if (State.bulkMode) {
            if (State.selectedSkills.has(skill.dirName)) State.selectedSkills.delete(skill.dirName);
            else State.selectedSkills.add(skill.dirName);
            renderContent();
          } else {
            openDetailPanel(skill);
          }
        },
        role: 'button',
        tabindex: '0',
        'aria-label': `Skill: ${skill.frontmatter.name || skill.dirName}`,
      });

      // Checkbox for bulk mode
      const checkbox = el('div', {
        className: `card-checkbox${State.selectedSkills.has(skill.dirName) ? ' checked' : ''}`,
      });
      card.appendChild(checkbox);

      // Validation status dot
      const status = getValidationStatus(skill.validation);
      card.appendChild(el('div', { className: `card-status ${status}`, title: status }));

      // Header
      const header = el('div', { className: 'card-header' });
      const iconDiv = el('div', { className: 'card-icon', textContent: (skill.frontmatter.name || skill.dirName).charAt(0).toUpperCase() });
      const titleDiv = el('div');
      titleDiv.appendChild(el('div', { className: 'card-title', textContent: skill.frontmatter.name || skill.dirName }));
      header.append(iconDiv, titleDiv);
      card.appendChild(header);

      // Description
      card.appendChild(el('div', { className: 'card-desc', textContent: skill.frontmatter.description || 'No description' }));

      // Meta row
      const meta = el('div', { className: 'card-meta' });

      // Quality score
      const score = skill.scores?.overall || 0;
      const scoreClass = score >= 70 ? 'high' : score >= 40 ? 'medium' : 'low';
      meta.appendChild(el('span', { className: `quality-score ${scoreClass}`, textContent: score + '/100' }));

      // Line count
      meta.appendChild(el('span', { textContent: skill.lineCount + ' lines' }));

      // Last modified
      if (skill.lastModified) {
        meta.appendChild(el('span', { textContent: timeAgo(skill.lastModified) }));
      }

      // Agent badges
      const badges = el('span', { className: 'agent-badges' });
      AGENTS.forEach(agent => {
        badges.appendChild(el('span', { className: `agent-badge ${agent.id}`, textContent: agent.id.slice(0, 2).toUpperCase(), title: agent.name }));
      });
      meta.appendChild(badges);

      card.appendChild(meta);
      return card;
    }

    // ─── Detail Panel (F-06) ─────────────────────────────────────────
    let panelTab = 'preview';
    function openDetailPanel(skill) {
      State.currentSkill = skill;
      panelTab = 'preview';
      // Track recently used
      State.recentlyUsed = [skill.dirName, ...State.recentlyUsed.filter(n => n !== skill.dirName)].slice(0, 10);
      localStorage.setItem('sf-recent', JSON.stringify(State.recentlyUsed));
      renderPanel();
    }

    function renderPanel() {
      const skill = State.currentSkill;
      if (!skill) return;
      // Remove existing
      $$('.panel-overlay, .slide-panel').forEach(el => el.remove());

      const overlay = el('div', { className: 'panel-overlay open', onClick: closePanel });
      document.body.appendChild(overlay);

      const panel = el('div', { className: 'slide-panel open' });

      // Header
      const header = el('div', { className: 'panel-header' });
      header.appendChild(el('h2', { textContent: skill.frontmatter.name || skill.dirName }));
      const closeBtn = el('button', { className: 'topbar-btn', onClick: closePanel, 'aria-label': 'Close panel' });
      closeBtn.innerHTML = ICONS.x;
      header.appendChild(closeBtn);
      panel.appendChild(header);

      // Tabs
      const tabs = el('div', { className: 'panel-tabs' });
      ['preview', 'source', 'files', 'quality', 'history', 'agents'].forEach(t => {
        const tab = el('button', { className: `panel-tab${panelTab === t ? ' active' : ''}`,
          textContent: t.charAt(0).toUpperCase() + t.slice(1),
          onClick: () => { panelTab = t; renderPanel(); }
        });
        tabs.appendChild(tab);
      });
      panel.appendChild(tabs);

      // Body
      const body = el('div', { className: 'panel-body' });
      switch (panelTab) {
        case 'preview':
          body.innerHTML = `<div class="preview-pane">${MD.render(skill.body)}</div>`;
          break;
        case 'source':
          const pre = el('pre', { style: { background: 'var(--bg-alt)', padding: '16px', borderRadius: 'var(--radius)', fontSize: '13px', fontFamily: 'var(--mono)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' } });
          pre.textContent = skill.rawContent;
          body.appendChild(pre);
          break;
        case 'files':
          skill.files.forEach(f => {
            const item = el('div', { style: { padding: '8px 0', borderBottom: '1px solid var(--border)', fontSize: '14px', display: 'flex', alignItems: 'center', gap: '8px' } });
            item.innerHTML = `${f.kind === 'directory' ? icon('folder', 14) : icon('edit', 14)} ${f.name}`;
            body.appendChild(item);
          });
          if (skill.files.length === 0) body.textContent = 'No files found.';
          break;
        case 'quality':
          body.appendChild(renderQualityPanel(skill));
          break;
        case 'history':
          renderHistoryPanel(skill, body);
          break;
        case 'agents':
          body.appendChild(renderAgentsPanel(skill));
          break;
      }
      panel.appendChild(body);

      // Actions
      const actions = el('div', { className: 'panel-actions' });
      const editBtn = el('button', { className: 'btn btn-primary btn-sm', onClick: () => { closePanel(); State.view = 'editor'; State.currentSkill = skill; render(); } });
      editBtn.innerHTML = `${icon('edit', 14)} Edit`;
      const dupBtn = el('button', { className: 'btn btn-secondary btn-sm', onClick: async () => { await duplicateSkill(skill); closePanel(); await loadSkills(); render(); } });
      dupBtn.textContent = 'Duplicate';
      const expBtn = el('button', { className: 'btn btn-secondary btn-sm', onClick: () => exportSkillZip(skill) });
      expBtn.innerHTML = `${icon('download', 14)} Export`;
      const copyBtn = el('button', { className: 'btn btn-secondary btn-sm', onClick: () => copyToClipboard(skill.rawContent) });
      copyBtn.innerHTML = `${icon('copy', 14)} Copy`;
      const delBtn = el('button', { className: 'btn btn-danger btn-sm', onClick: async () => {
        if (!confirm('Delete ' + skill.dirName + '?')) return;
        await deleteSkill(skill); closePanel(); render();
      } });
      delBtn.innerHTML = `${icon('trash', 14)} Delete`;
      actions.append(editBtn, dupBtn, expBtn, copyBtn, delBtn);
      panel.appendChild(actions);

      document.body.appendChild(panel);
    }

    function closePanel() {
      $$('.panel-overlay, .slide-panel').forEach(el => el.remove());
      State.currentSkill = null;
    }

    function renderQualityPanel(skill) {
      const wrap = el('div');
      const scores = skill.scores;
      // Overall
      const overall = el('div', { className: 'overall-score' });
      overall.innerHTML = `<div class="big-num">${scores.overall}</div><div class="label">Overall Quality Score</div>`;
      wrap.appendChild(overall);

      // Dimensions
      const dims = el('div', { className: 'score-dimensions', style: { marginTop: '20px' } });
      const dimNames = { specificity: 'Specificity', scope: 'Scope', completeness: 'Completeness', tokenEfficiency: 'Token Efficiency', progressiveDisclosure: 'Progressive Disclosure' };
      for (const [key, label] of Object.entries(dimNames)) {
        const val = scores[key];
        const cls = val >= 70 ? 'high' : val >= 40 ? 'medium' : 'low';
        const row = el('div', { className: 'score-dim' });
        row.innerHTML = `<span class="score-dim-label">${label}</span><div class="score-bar"><div class="score-bar-fill ${cls}" style="width:${val}%"></div></div><span class="score-value">${val}</span>`;
        dims.appendChild(row);
      }
      wrap.appendChild(dims);

      // Validation
      wrap.appendChild(el('h3', { textContent: 'Validation', style: { marginTop: '24px', marginBottom: '12px', fontSize: '16px' } }));
      const vList = el('div', { className: 'validation-list' });
      if (skill.validation.length === 0) {
        vList.appendChild(el('div', { className: 'validation-item pass', innerHTML: `<span class="validation-icon">✓</span> All checks passed` }));
      } else {
        skill.validation.forEach(v => {
          const cls = v.type === 'error' ? 'fail' : 'warn';
          const ic = v.type === 'error' ? '✕' : '⚠';
          const item = el('div', { className: `validation-item ${cls}` });
          item.innerHTML = `<span class="validation-icon">${ic}</span> ${v.msg}`;
          if (v.autoFix === 'slug') {
            const fixBtn = el('button', { className: 'btn btn-sm btn-secondary', textContent: 'Auto-fix', style: { marginLeft: 'auto' },
              onClick: async () => {
                skill.frontmatter.name = slugify(skill.frontmatter.name || skill.dirName);
                const content = serializeSkill(skill.frontmatter, skill.body);
                await saveSkillContent(skill, content);
                renderPanel();
              }
            });
            item.appendChild(fixBtn);
          }
          vList.appendChild(item);
        });
      }
      wrap.appendChild(vList);
      return wrap;
    }

    async function renderHistoryPanel(skill, body) {
      const history = await loadHistory(skill);
      if (history.length === 0) {
        body.appendChild(el('p', { textContent: 'No version history yet. History is saved each time you edit.', style: { color: 'var(--text-muted)' } }));
        return;
      }
      history.forEach((h, i) => {
        const item = el('div', { className: 'history-item' });
        const date = new Date(h.ts);
        item.innerHTML = `<span class="timestamp">${date.toLocaleString()}</span><span class="snapshot-info">${h.content.split('\\n').length} lines</span>`;
        const restoreBtn = el('button', { className: 'btn btn-sm btn-secondary', textContent: 'Restore',
          onClick: async () => {
            if (!confirm('Restore this version?')) return;
            await saveSkillContent(skill, h.content);
            renderPanel();
            toast('Version restored');
          }
        });
        item.appendChild(restoreBtn);
        body.appendChild(item);
      });
    }

    function renderAgentsPanel(skill) {
      const wrap = el('div');
      wrap.appendChild(el('p', { textContent: 'This skill is compatible with all agents that support the agentskills.io standard:', style: { marginBottom: '16px', color: 'var(--text-muted)' } }));
      AGENTS.forEach(agent => {
        const item = el('div', { style: { display: 'flex', alignItems: 'center', gap: '12px', padding: '12px', border: '1px solid var(--border)', borderRadius: 'var(--radius)', marginBottom: '8px' } });
        item.appendChild(el('span', { className: `agent-badge ${agent.id}`, textContent: agent.name, style: { fontSize: '13px', padding: '4px 10px' } }));
        item.appendChild(el('code', { textContent: agent.path, style: { fontSize: '12px', fontFamily: 'var(--mono)', flex: '1' } }));
        const cmd = getInstallCommand(skill.dirName, agent.id);
        const copyBtn = el('button', { className: 'btn btn-ghost btn-sm', onClick: () => copyToClipboard(cmd), title: 'Copy install command' });
        copyBtn.innerHTML = icon('copy', 14);
        item.appendChild(copyBtn);
        wrap.appendChild(item);
      });
      return wrap;
    }

    // ─── Wizard (F-03) ───────────────────────────────────────────────
    function renderWizard() {
      const wrap = el('div', { className: 'wizard slide-up' });
      const steps = ['Name & Purpose', 'Template', 'Instructions', 'Advanced', 'Review'];

      // Step indicators
      const stepsEl = el('div', { className: 'wizard-steps' });
      stepsEl.appendChild(el('div', { className: 'wizard-connector' }));
      steps.forEach((s, i) => {
        const step = el('div', { className: `wizard-step${i === State.wizardStep ? ' active' : ''}${i < State.wizardStep ? ' done' : ''}` });
        step.innerHTML = `<div class="wizard-step-num">${i < State.wizardStep ? '✓' : i + 1}</div><div class="wizard-step-label">${s}</div>`;
        stepsEl.appendChild(step);
      });
      wrap.appendChild(stepsEl);

      // Body
      const body = el('div', { className: 'wizard-body' });
      switch (State.wizardStep) {
        case 0: body.appendChild(renderWizardStep0()); break;
        case 1: body.appendChild(renderWizardStep1()); break;
        case 2: body.appendChild(renderWizardStep2()); break;
        case 3: body.appendChild(renderWizardStep3()); break;
        case 4: body.appendChild(renderWizardStep4()); break;
      }
      wrap.appendChild(body);

      // Footer
      const footer = el('div', { className: 'wizard-footer' });
      if (State.wizardStep > 0) {
        const backBtn = el('button', { className: 'btn btn-secondary', textContent: 'Back', onClick: () => { State.wizardStep--; renderContent(); } });
        footer.appendChild(backBtn);
      } else {
        footer.appendChild(el('div'));
      }
      if (State.wizardStep < 4) {
        const nextBtn = el('button', { className: 'btn btn-primary', textContent: 'Next', onClick: () => {
          if (State.wizardStep === 0 && !State.wizardData.name) { toast('Please enter a skill name', 'error'); return; }
          State.wizardStep++; renderContent();
        } });
        footer.appendChild(nextBtn);
      } else {
        const createBtn = el('button', { className: 'btn btn-primary', textContent: 'Create Skill', onClick: async () => {
          const d = State.wizardData;
          const fm = { name: d.slug || slugify(d.name || 'my-skill'), description: d.description || '' };
          if (d.license) fm.license = d.license;
          if (d.compatibility) fm.compatibility = d.compatibility;
          if (d.allowedTools) fm['allowed-tools'] = d.allowedTools;
          if (d.metadata) fm.metadata = d.metadata;
          const bodyContent = d.instructions || d.templateBody || '# ' + (d.name || 'My Skill') + '\n\nAdd your instructions here.\n';
          const content = serializeSkill(fm, bodyContent);
          const name = fm.name;
          const result = await createSkill(name, content);
          if (result) { await loadSkills(); State.view = 'dashboard'; render(); }
        } });
        footer.appendChild(createBtn);
      }
      wrap.appendChild(footer);
      return wrap;
    }

    function renderWizardStep0() {
      const wrap = el('div');
      wrap.appendChild(el('h3', { textContent: 'Name & Purpose', style: { marginBottom: '16px', fontSize: '18px' } }));

      // Name
      const nameGroup = el('div', { className: 'form-group' });
      nameGroup.appendChild(el('label', { className: 'form-label', textContent: 'Skill Name' }));
      const nameInput = el('input', { className: 'form-input', type: 'text', placeholder: 'e.g., Code Review Helper',
        value: State.wizardData.name || '',
        onInput: (e) => { State.wizardData.name = e.target.value; State.wizardData.slug = slugify(e.target.value); nameGroup.querySelector('.slug-preview').textContent = State.wizardData.slug; updateCounter(nameGroup, e.target.value.length, 64); }
      });
      nameGroup.appendChild(nameInput);
      nameGroup.appendChild(el('span', { className: 'form-counter', textContent: `${(State.wizardData.name || '').length}/64` }));
      nameGroup.appendChild(el('div', { className: 'slug-preview', textContent: State.wizardData.slug || slugify(State.wizardData.name || '') }));
      nameGroup.appendChild(el('div', { className: 'form-hint', textContent: 'This becomes the folder name. Lowercase letters, numbers, and hyphens only.' }));
      wrap.appendChild(nameGroup);

      // Description
      const descGroup = el('div', { className: 'form-group' });
      descGroup.appendChild(el('label', { className: 'form-label', textContent: 'Description' }));
      const descInput = el('textarea', { className: 'form-textarea', placeholder: 'What does this skill do? When should the agent use it?',
        value: State.wizardData.description || '', style: { minHeight: '80px' },
        onInput: (e) => { State.wizardData.description = e.target.value; updateCounter(descGroup, e.target.value.length, 1024); }
      });
      descGroup.appendChild(descInput);
      descGroup.appendChild(el('span', { className: 'form-counter', textContent: `${(State.wizardData.description || '').length}/1024` }));
      wrap.appendChild(descGroup);
      return wrap;
    }

    function renderWizardStep1() {
      const wrap = el('div');
      wrap.appendChild(el('h3', { textContent: 'Choose a Template', style: { marginBottom: '16px', fontSize: '18px' } }));
      const grid = el('div', { className: 'template-grid' });
      TEMPLATES.forEach(t => {
        const card = el('div', {
          className: `template-card${State.wizardData.templateId === t.id ? ' selected' : ''}`,
          onClick: () => {
            State.wizardData.templateId = t.id;
            const { frontmatter, body } = parseFrontmatter(t.content);
            State.wizardData.templateBody = body;
            if (!State.wizardData.name && frontmatter.name !== 'my-skill') {
              State.wizardData.name = frontmatter.name.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
              State.wizardData.slug = frontmatter.name;
            }
            if (!State.wizardData.description) State.wizardData.description = frontmatter.description || '';
            renderContent();
          },
        });
        card.innerHTML = `<div class="template-icon">${t.icon}</div><h4>${t.name}</h4><p>${t.desc}</p>`;
        grid.appendChild(card);
      });
      wrap.appendChild(grid);
      return wrap;
    }

    function renderWizardStep2() {
      const wrap = el('div');
      wrap.appendChild(el('h3', { textContent: 'Customize Instructions', style: { marginBottom: '16px', fontSize: '18px' } }));
      wrap.appendChild(el('p', { textContent: 'Edit the instructions below. These tell the AI agent exactly what to do when this skill is activated.', style: { marginBottom: '12px', color: 'var(--text-muted)', fontSize: '14px' } }));

      const textarea = el('textarea', { className: 'form-textarea', style: { minHeight: '300px', fontFamily: 'var(--mono)', fontSize: '13px' },
        value: State.wizardData.instructions || State.wizardData.templateBody || '# My Skill\n\nAdd your instructions here.\n',
        onInput: (e) => { State.wizardData.instructions = e.target.value; }
      });
      wrap.appendChild(textarea);
      const lines = (State.wizardData.instructions || State.wizardData.templateBody || '').split('\n').length;
      const tokens = countTokens(State.wizardData.instructions || State.wizardData.templateBody || '');
      wrap.appendChild(el('div', { className: 'form-hint', textContent: `${lines} lines · ~${tokens} tokens (recommended: <500 lines, <5000 tokens)` }));
      return wrap;
    }

    function renderWizardStep3() {
      const wrap = el('div');
      wrap.appendChild(el('h3', { textContent: 'Advanced Options', style: { marginBottom: '16px', fontSize: '18px' } }));

      // License
      const licGroup = el('div', { className: 'form-group' });
      licGroup.appendChild(el('label', { className: 'form-label', textContent: 'License (optional)' }));
      const licSelect = el('select', { className: 'form-select',
        onChange: (e) => { State.wizardData.license = e.target.value; }
      });
      ['', 'Apache-2.0', 'MIT', 'BSD-3-Clause', 'ISC', 'GPL-3.0'].forEach(l => {
        const opt = el('option', { value: l, textContent: l || 'None' });
        if (State.wizardData.license === l) opt.selected = true;
        licSelect.appendChild(opt);
      });
      licGroup.appendChild(licSelect);
      wrap.appendChild(licGroup);

      // Compatibility
      const compGroup = el('div', { className: 'form-group' });
      compGroup.appendChild(el('label', { className: 'form-label', textContent: 'Compatibility (optional)' }));
      compGroup.appendChild(el('input', { className: 'form-input', type: 'text', placeholder: 'e.g., node >= 18',
        value: State.wizardData.compatibility || '',
        onInput: (e) => { State.wizardData.compatibility = e.target.value; }
      }));
      wrap.appendChild(compGroup);

      // Allowed tools
      const toolsGroup = el('div', { className: 'form-group' });
      toolsGroup.appendChild(el('label', { className: 'form-label', textContent: 'Allowed Tools (optional, space-separated)' }));
      toolsGroup.appendChild(el('input', { className: 'form-input', type: 'text', placeholder: 'e.g., Bash Read Write',
        value: State.wizardData.allowedTools || '',
        onInput: (e) => { State.wizardData.allowedTools = e.target.value; }
      }));
      wrap.appendChild(toolsGroup);

      return wrap;
    }

    function renderWizardStep4() {
      const wrap = el('div');
      wrap.appendChild(el('h3', { textContent: 'Review & Save', style: { marginBottom: '16px', fontSize: '18px' } }));

      const d = State.wizardData;
      const fm = { name: d.slug || slugify(d.name || 'my-skill'), description: d.description || '' };
      if (d.license) fm.license = d.license;
      if (d.compatibility) fm.compatibility = d.compatibility;
      if (d.allowedTools) fm['allowed-tools'] = d.allowedTools;
      const bodyContent = d.instructions || d.templateBody || '';
      const content = serializeSkill(fm, bodyContent);

      // Preview
      wrap.appendChild(el('h4', { textContent: 'Frontmatter Preview', style: { marginBottom: '8px', fontSize: '14px', color: 'var(--text-muted)' } }));
      const pre = el('pre', { style: { background: 'var(--bg-alt)', padding: '12px', borderRadius: 'var(--radius)', fontSize: '13px', fontFamily: 'var(--mono)', marginBottom: '16px', whiteSpace: 'pre-wrap' } });
      pre.textContent = `---\n${YAML.stringify(fm)}\n---`;
      wrap.appendChild(pre);

      // Body preview
      wrap.appendChild(el('h4', { textContent: 'Instructions Preview', style: { marginBottom: '8px', fontSize: '14px', color: 'var(--text-muted)' } }));
      const preview = el('div', { className: 'preview-pane', style: { background: 'var(--bg-alt)', padding: '16px', borderRadius: 'var(--radius)', maxHeight: '300px', overflow: 'auto' } });
      preview.innerHTML = MD.render(bodyContent);
      wrap.appendChild(preview);

      // Validation
      const tempSkill = { frontmatter: fm, body: bodyContent, rawContent: content };
      const issues = validateSkill(tempSkill);
      if (issues.length > 0) {
        wrap.appendChild(el('h4', { textContent: 'Validation Issues', style: { marginTop: '16px', marginBottom: '8px', fontSize: '14px' } }));
        const vList = el('div', { className: 'validation-list' });
        issues.forEach(v => {
          const cls = v.type === 'error' ? 'fail' : 'warn';
          const ic = v.type === 'error' ? '✕' : '⚠';
          vList.appendChild(el('div', { className: `validation-item ${cls}`, innerHTML: `<span class="validation-icon">${ic}</span> ${v.msg}` }));
        });
        wrap.appendChild(vList);
      }
      return wrap;
    }

    function updateCounter(group, len, max) {
      const counter = group.querySelector('.form-counter');
      if (counter) {
        counter.textContent = `${len}/${max}`;
        counter.className = `form-counter${len > max ? ' over' : ''}`;
      }
    }

    // ─── Editor (F-04) ───────────────────────────────────────────────
    function renderEditor() {
      if (!State.currentSkill) { State.view = 'dashboard'; renderContent(); return el('div'); }
      const skill = State.currentSkill;
      const wrap = el('div', { style: { display: 'flex', flexDirection: 'column', height: 'calc(100vh - 52px - 48px)', margin: '-24px' } });

      // Toolbar
      const toolbar = el('div', { className: 'editor-toolbar' });
      const insertFm = el('button', { className: 'btn btn-ghost btn-sm', textContent: 'Insert Frontmatter', onClick: () => {
        const ta = wrap.querySelector('textarea.code-editor');
        if (ta && !ta.value.startsWith('---')) {
          ta.value = '---\nname: \ndescription: \n---\n' + ta.value;
          State.editorDirty = true;
          updateEditorStatus(wrap);
        }
      } });
      const insertCode = el('button', { className: 'btn btn-ghost btn-sm', textContent: 'Insert Code Block', onClick: () => {
        const ta = wrap.querySelector('textarea.code-editor');
        if (ta) {
          const pos = ta.selectionStart;
          const before = ta.value.slice(0, pos);
          const after = ta.value.slice(pos);
          ta.value = before + '```\n\n```' + after;
          ta.selectionStart = ta.selectionEnd = pos + 4;
          ta.focus();
          State.editorDirty = true;
          updateEditorStatus(wrap);
        }
      } });
      const saveBtn = el('button', { className: 'btn btn-primary btn-sm', onClick: async () => {
        const ta = wrap.querySelector('textarea.code-editor');
        if (ta) await saveSkillContent(skill, ta.value);
        updateEditorStatus(wrap);
        updatePreview(wrap);
      } });
      saveBtn.innerHTML = `${icon('check', 14)} Save`;
      const backBtn = el('button', { className: 'btn btn-ghost btn-sm', onClick: () => { State.view = 'dashboard'; render(); } });
      backBtn.textContent = 'Back to Library';
      toolbar.append(backBtn, insertFm, insertCode, saveBtn);
      wrap.appendChild(toolbar);

      // Editor + Preview
      const container = el('div', { className: 'editor-container', style: { flex: '1' } });

      // Left pane — editor
      const leftPane = el('div', { className: 'editor-pane' });
      leftPane.appendChild(el('div', { className: 'editor-pane-header', textContent: 'Source' }));
      const textarea = el('textarea', { className: 'code-editor',
        value: skill.rawContent,
        spellcheck: 'false',
        'aria-label': 'Skill source editor',
        onInput: () => { State.editorDirty = true; updateEditorStatus(wrap); updatePreview(wrap); },
        onKeydown: (e) => {
          // Tab support
          if (e.key === 'Tab') {
            e.preventDefault();
            const start = textarea.selectionStart;
            textarea.value = textarea.value.slice(0, start) + '  ' + textarea.value.slice(textarea.selectionEnd);
            textarea.selectionStart = textarea.selectionEnd = start + 2;
          }
          // Ctrl+S save
          if ((e.ctrlKey || e.metaKey) && e.key === 's') {
            e.preventDefault();
            saveBtn.click();
          }
        },
        onBlur: async () => {
          if (State.editorDirty) {
            await saveSkillContent(skill, textarea.value);
            updateEditorStatus(wrap);
          }
        }
      });
      leftPane.appendChild(textarea);
      container.appendChild(leftPane);

      // Divider
      container.appendChild(el('div', { className: 'editor-divider' }));

      // Right pane — preview
      const rightPane = el('div', { className: 'editor-pane' });
      rightPane.appendChild(el('div', { className: 'editor-pane-header', textContent: 'Preview' }));
      const preview = el('div', { className: 'preview-pane' });
      const { body } = parseFrontmatter(skill.rawContent);
      preview.innerHTML = MD.render(body);
      rightPane.appendChild(preview);
      container.appendChild(rightPane);

      wrap.appendChild(container);

      // Status bar
      const statusBar = el('div', { className: 'editor-status' });
      const lines = skill.rawContent.split('\n').length;
      const tokens = countTokens(skill.rawContent);
      statusBar.innerHTML = `<span class="status-dot saved"></span> Saved · ${lines} lines · ~${tokens} tokens`;
      wrap.appendChild(statusBar);

      return wrap;
    }

    function updatePreview(wrap) {
      const ta = wrap.querySelector('textarea.code-editor');
      const preview = wrap.querySelector('.preview-pane');
      if (ta && preview) {
        const { body } = parseFrontmatter(ta.value);
        preview.innerHTML = MD.render(body);
      }
    }

    function updateEditorStatus(wrap) {
      const statusBar = wrap.querySelector('.editor-status');
      if (!statusBar) return;
      const ta = wrap.querySelector('textarea.code-editor');
      if (!ta) return;
      const lines = ta.value.split('\n').length;
      const tokens = countTokens(ta.value);
      const dotClass = State.editorDirty ? 'unsaved' : 'saved';
      const statusText = State.editorDirty ? 'Unsaved changes' : 'Saved';
      statusBar.innerHTML = `<span class="status-dot ${dotClass}"></span> ${statusText} · ${lines} lines · ~${tokens} tokens`;
    }

    // ─── Settings ────────────────────────────────────────────────────
    function renderSettings() {
      const wrap = el('div', { className: 'slide-up', style: { maxWidth: '600px' } });
      wrap.appendChild(el('h2', { textContent: 'Settings', style: { marginBottom: '24px', fontSize: '22px' } }));

      // Theme
      const themeGroup = el('div', { className: 'form-group' });
      themeGroup.appendChild(el('label', { className: 'form-label', textContent: 'Theme' }));
      const themeSelect = el('select', { className: 'form-select',
        onChange: (e) => { State.theme = e.target.value; localStorage.setItem('sf-theme', State.theme); applyTheme(); }
      });
      [['system', 'System'], ['light', 'Light'], ['dark', 'Dark']].forEach(([v, l]) => {
        const opt = el('option', { value: v, textContent: l });
        if (State.theme === v) opt.selected = true;
        themeSelect.appendChild(opt);
      });
      themeGroup.appendChild(themeSelect);
      wrap.appendChild(themeGroup);

      // AI Settings (F-13)
      wrap.appendChild(el('h3', { textContent: 'AI-Assisted Writing (BYOK)', style: { marginTop: '24px', marginBottom: '12px' } }));
      const aiPanel = el('div', { className: 'ai-panel' });
      aiPanel.appendChild(el('h4', { textContent: 'Bring Your Own API Key' }));
      aiPanel.appendChild(el('p', { textContent: 'Your API key is stored locally in your browser and only sent to the AI provider you select.', style: { fontSize: '12px', color: 'var(--text-muted)', marginBottom: '12px' } }));

      const providerGroup = el('div', { className: 'form-group' });
      providerGroup.appendChild(el('label', { className: 'form-label', textContent: 'Provider' }));
      const provSelect = el('select', { className: 'form-select',
        onChange: (e) => { State.aiProvider = e.target.value; localStorage.setItem('sf-aiProvider', State.aiProvider); }
      });
      [['', 'None'], ['anthropic', 'Anthropic (Claude)'], ['openai', 'OpenAI (GPT-4)']].forEach(([v, l]) => {
        const opt = el('option', { value: v, textContent: l });
        if (State.aiProvider === v) opt.selected = true;
        provSelect.appendChild(opt);
      });
      providerGroup.appendChild(provSelect);
      aiPanel.appendChild(providerGroup);

      const keyGroup = el('div', { className: 'form-group' });
      keyGroup.appendChild(el('label', { className: 'form-label', textContent: 'API Key' }));
      keyGroup.appendChild(el('input', { className: 'form-input', type: 'password', placeholder: 'sk-...',
        value: State.aiKey,
        onInput: (e) => { State.aiKey = e.target.value; localStorage.setItem('sf-aiKey', State.aiKey); }
      }));
      aiPanel.appendChild(keyGroup);
      wrap.appendChild(aiPanel);

      // About
      wrap.appendChild(el('h3', { textContent: 'About', style: { marginTop: '24px', marginBottom: '8px' } }));
      wrap.appendChild(el('p', { textContent: 'SkillForge v1.0 — A zero-install, single-file AI agent skill manager.', style: { color: 'var(--text-muted)', fontSize: '14px' } }));
      wrap.appendChild(el('p', { textContent: 'Licensed under Apache License 2.0', style: { color: 'var(--text-muted)', fontSize: '13px' } }));

      return wrap;
    }

    // ─── Collections (F-16) ──────────────────────────────────────────
    function renderCollections() {
      const wrap = el('div', { className: 'slide-up' });
      wrap.appendChild(el('h2', { textContent: 'Collections', style: { marginBottom: '8px', fontSize: '22px' } }));
      wrap.appendChild(el('p', { textContent: 'Group skills into named collections for easy organization and export.', style: { color: 'var(--text-muted)', marginBottom: '20px' } }));

      // Create collection
      const createRow = el('div', { style: { display: 'flex', gap: '8px', marginBottom: '24px' } });
      const nameInput = el('input', { className: 'form-input', type: 'text', placeholder: 'New collection name', style: { flex: '1' } });
      const addBtn = el('button', { className: 'btn btn-primary', textContent: 'Create', onClick: async () => {
        const name = nameInput.value.trim();
        if (!name) return;
        State.collections.push({ name, skills: [] });
        await saveCollections();
        nameInput.value = '';
        renderContent();
      } });
      createRow.append(nameInput, addBtn);
      wrap.appendChild(createRow);

      // List collections
      if (State.collections.length === 0) {
        wrap.appendChild(el('p', { textContent: 'No collections yet.', style: { color: 'var(--text-muted)' } }));
      } else {
        State.collections.forEach((col, ci) => {
          const card = el('div', { style: { border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', padding: '16px', marginBottom: '12px' } });
          const header = el('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '10px' } });
          header.appendChild(el('h3', { textContent: col.name, style: { flex: '1', fontSize: '16px' } }));
          header.appendChild(el('span', { textContent: `${col.skills.length} skills`, style: { fontSize: '13px', color: 'var(--text-muted)' } }));
          // Export collection
          const expBtn = el('button', { className: 'btn btn-ghost btn-sm', onClick: () => {
            const enc = new TextEncoder();
            const files = [];
            col.skills.forEach(name => {
              const s = State.skills.find(sk => sk.dirName === name);
              if (s) files.push({ name: `${s.dirName}/SKILL.md`, data: enc.encode(s.rawContent) });
            });
            if (files.length === 0) { toast('No skills to export', 'error'); return; }
            const zip = ZIP.create(files);
            downloadBlob(new Blob([zip], { type: 'application/zip' }), `${col.name}.zip`);
          } });
          expBtn.innerHTML = icon('download', 14);
          header.appendChild(expBtn);
          // Delete collection
          const delBtn = el('button', { className: 'btn btn-ghost btn-sm', onClick: async () => {
            State.collections.splice(ci, 1);
            await saveCollections();
            renderContent();
          } });
          delBtn.innerHTML = icon('trash', 14);
          header.appendChild(delBtn);
          card.appendChild(header);

          // Skill tags
          const tagsDiv = el('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: '10px' } });
          col.skills.forEach((sName, si) => {
            const tag = el('span', { className: 'collection-tag' });
            tag.textContent = sName;
            const removeSpan = el('span', { className: 'remove', textContent: '×', onClick: async (e) => {
              e.stopPropagation();
              col.skills.splice(si, 1);
              await saveCollections();
              renderContent();
            } });
            tag.appendChild(removeSpan);
            tagsDiv.appendChild(tag);
          });
          card.appendChild(tagsDiv);

          // Add skill to collection
          const addSelect = el('select', { className: 'form-select', style: { fontSize: '13px' },
            onChange: async (e) => {
              if (e.target.value) {
                col.skills.push(e.target.value);
                await saveCollections();
                renderContent();
              }
            }
          });
          addSelect.appendChild(el('option', { value: '', textContent: '+ Add skill...' }));
          State.skills.filter(s => !col.skills.includes(s.dirName)).forEach(s => {
            addSelect.appendChild(el('option', { value: s.dirName, textContent: s.dirName }));
          });
          card.appendChild(addSelect);
          wrap.appendChild(card);
        });
      }
      return wrap;
    }

    // ─── Cross-Agent Sync (F-15) ────────────────────────────────────
    function renderSync() {
      const wrap = el('div', { className: 'slide-up' });
      wrap.appendChild(el('h2', { textContent: 'Cross-Agent Sync', style: { marginBottom: '8px', fontSize: '22px' } }));
      wrap.appendChild(el('p', { textContent: 'Open multiple agent skill folders to compare and sync skills between them.', style: { color: 'var(--text-muted)', marginBottom: '20px' } }));

      // Current folder
      const currentDiv = el('div', { className: 'folder-item', style: { marginBottom: '16px' } });
      currentDiv.innerHTML = `<span style="font-weight:600;font-size:14px">Primary Folder</span><span class="folder-path">${State.dirHandle?.name || 'Not set'}</span><span class="folder-count">${State.skills.length} skills</span>`;
      wrap.appendChild(currentDiv);

      // Add folder
      const addBtn = el('button', { className: 'btn btn-secondary', onClick: async () => {
        try {
          const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
          // Scan for skills
          const skills = [];
          for await (const entry of handle.values()) {
            if (entry.kind !== 'directory' || entry.name.startsWith('.')) continue;
            try {
              const dir = await handle.getDirectoryHandle(entry.name);
              await dir.getFileHandle('SKILL.md');
              skills.push(entry.name);
            } catch (e) {}
          }
          State.additionalFolders.push({ handle, name: handle.name, skills });
          renderContent();
        } catch (e) {
          if (e.name !== 'AbortError') toast('Failed to open folder', 'error');
        }
      } });
      addBtn.innerHTML = `${icon('folder')} Add Agent Folder`;
      wrap.appendChild(addBtn);

      // Additional folders
      if (State.additionalFolders.length > 0) {
        wrap.appendChild(el('h3', { textContent: 'Additional Folders', style: { marginTop: '24px', marginBottom: '12px' } }));
        State.additionalFolders.forEach((folder, fi) => {
          const item = el('div', { className: 'folder-item' });
          item.innerHTML = `<span class="folder-path">${folder.name}</span><span class="folder-count">${folder.skills.length} skills</span>`;
          // Show skills not in primary
          const missing = folder.skills.filter(s => !State.skills.some(sk => sk.dirName === s));
          if (missing.length > 0) {
            const badge = el('span', { style: { fontSize: '12px', color: 'var(--warn)' }, textContent: `${missing.length} unique` });
            item.appendChild(badge);
          }
          wrap.appendChild(item);

          // Copy buttons
          if (missing.length > 0) {
            const copyDiv = el('div', { style: { padding: '8px 0 16px', fontSize: '13px', color: 'var(--text-muted)' } });
            copyDiv.textContent = `Skills in "${folder.name}" not in primary: ${missing.join(', ')}`;
            wrap.appendChild(copyDiv);
          }
        });
      }
      return wrap;
    }

    // ─── Marketplace Placeholder (F-12) ──────────────────────────────
    function renderMarketplace() {
      const wrap = el('div', { className: 'marketplace-placeholder slide-up' });
      wrap.innerHTML = `
        <div class="empty-icon" style="margin:0 auto 20px;font-size:48px">🏪</div>
        <h2>Skill Marketplace</h2>
        <p style="margin-top:8px">Browse and install community skills from agentskills.io and GitHub. Coming soon in a future update.</p>
      `;
      return wrap;
    }

    // ─── Keyboard Shortcuts ──────────────────────────────────────────
    document.addEventListener('keydown', (e) => {
      // Ctrl+K → focus search
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        const input = $('.search-box input');
        if (input) input.focus();
      }
      // Ctrl+N → new skill
      if ((e.ctrlKey || e.metaKey) && e.key === 'n') {
        e.preventDefault();
        State.view = 'wizard'; State.wizardStep = 0; State.wizardData = {};
        render();
      }
      // Escape → close panel
      if (e.key === 'Escape') {
        closePanel();
        const overlay = $('.modal-overlay.open');
        if (overlay) overlay.classList.remove('open');
      }
    });

    // ─── Init ────────────────────────────────────────────────────────
    function init() {
      applyTheme();
      matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
      document.body.innerHTML = '<div id="app"></div>';
      render();
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
    })();
    ''')

    # ── HTML Shell ────────────────────────────────────────────────────
    html = f'''<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="description" content="SkillForge — A zero-install, single-file AI agent skill manager">
<title>SkillForge — AI Agent Skill Manager</title>
<style>
{css}
</style>
</head>
<body>
<script>
{js}
</script>
</body>
</html>'''
    return html


if __name__ == '__main__':
    html = build_html()
    with open('SkillForge.html', 'w', encoding='utf-8') as f:
        f.write(html)
    size = len(html.encode('utf-8'))
    print(f'Generated SkillForge.html — {size:,} bytes ({size/1024:.1f} KB)')
