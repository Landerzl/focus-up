"""Focus Up desktop app: live timer, session controls and the calendar.

It is a remote control and mirror. The extension in Brave owns the session and the history;
this window only displays them and sends commands. Closing it never affects a running session.
Run with pythonw (no console):  pythonw focusup_app.py
"""
import datetime as dt
import os
import queue
import subprocess
import sys
import time
import tkinter as tk
from tkinter import messagebox, simpledialog, ttk

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import focusup_core as core
import focusup_ipc as ipc

SMOKE = os.environ.get('FOCUSUP_SMOKE')  # test mode: fake data, no server; value = seconds to stay open

C = {
    'bg': '#16181a', 'card': '#1f2326', 'text': '#e6e8ea', 'muted': '#8b949e',
    'accent': '#6fb59f', 'accent_text': '#10211c', 'border': '#2e3438',
    'danger': '#e0786d', 'warn': '#e0b05a',
}
FONT = 'Segoe UI'
SLOT_LABELS = {'research': 'Research tab (Google / AI)', 'work': 'Work tab (book / article / PDF)', 'music': 'Music tab'}
WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']


def find_brave():
    import winreg
    for hive in (winreg.HKEY_LOCAL_MACHINE, winreg.HKEY_CURRENT_USER):
        try:
            with winreg.OpenKey(hive, r'SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\brave.exe') as k:
                path = winreg.QueryValue(k, None)
                if path and os.path.exists(path):
                    return path
        except OSError:
            pass
    for base in (os.environ.get('PROGRAMFILES'), os.environ.get('PROGRAMFILES(X86)'), os.environ.get('LOCALAPPDATA')):
        if base:
            path = os.path.join(base, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe')
            if os.path.exists(path):
                return path
    return None


class App:
    def __init__(self, root, server):
        self.root, self.server = root, server
        self.state = None
        self.breaks = dict(core.DEFAULT_BREAKS)
        self.was_resting = False
        self.sessions, self.projects = ipc.load_mirror()
        self.connected = False
        self.combo_ids = {k: [None] for k in SLOT_LABELS}
        self.pending, self.next_id = {}, 1
        self.today = dt.date.today()
        self.view = self.today.replace(day=1)
        self.selected = self.today
        self.end_early = False
        self.last_project_id = None
        self.chosen_project = None   # None until the first render picks the last-used project
        self.pending_choice = None   # a project we just created, to select once it arrives
        self.got_projects = False    # has the extension sent its project list yet?
        self.project_ids = ['']
        self.filter = ''             # calendar filter: '' all, 'none', or a project id
        self.filter_ids = ['']

        root.title('Focus Up')
        root.configure(bg=C['bg'])
        root.minsize(900, 640)
        try:
            root.iconbitmap(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'focusup.ico'))
        except tk.TclError:
            pass
        self.setup_style()
        self.build_ui()
        self.render_all()
        self.poll()
        self.tick()

    # ---------- styling ----------

    def setup_style(self):
        st = ttk.Style(self.root)
        st.theme_use('clam')
        st.configure('.', background=C['bg'], foreground=C['text'], font=(FONT, 10))
        st.configure('TCombobox', fieldbackground=C['card'], background=C['card'], foreground=C['text'],
                     arrowcolor=C['text'], bordercolor=C['border'], lightcolor=C['card'], darkcolor=C['card'])
        st.map('TCombobox', fieldbackground=[('readonly', C['card'])], foreground=[('readonly', C['text'])],
               selectbackground=[('readonly', C['card'])], selectforeground=[('readonly', C['text'])])
        self.root.option_add('*TCombobox*Listbox.background', C['card'])
        self.root.option_add('*TCombobox*Listbox.foreground', C['text'])
        self.root.option_add('*TCombobox*Listbox.selectBackground', C['accent'])
        self.root.option_add('*TCombobox*Listbox.selectForeground', C['accent_text'])
        st.configure('Treeview', background=C['card'], fieldbackground=C['card'], foreground=C['text'],
                     bordercolor=C['border'], lightcolor=C['border'], darkcolor=C['border'], rowheight=26)
        st.map('Treeview', background=[('selected', C['accent'])], foreground=[('selected', C['accent_text'])])
        st.configure('Treeview.Heading', background=C['bg'], foreground=C['muted'], relief='flat')
        st.map('Treeview.Heading', background=[('active', C['bg'])])
        st.configure('TNotebook', background=C['bg'], borderwidth=0, bordercolor=C['border'],
                     lightcolor=C['border'], darkcolor=C['border'])
        st.configure('TNotebook.Tab', background=C['bg'], foreground=C['muted'], padding=(16, 7), borderwidth=0,
                     bordercolor=C['border'], lightcolor=C['border'], darkcolor=C['border'])
        st.map('TNotebook.Tab', background=[('selected', C['card'])], foreground=[('selected', C['text'])])

    def button(self, parent, text, command, kind='normal', padx=14):
        raised = core.blend(C['card'], C['text'], 0.09)
        bg, fg = {'primary': (C['accent'], C['accent_text']), 'danger': (raised, C['danger'])}.get(kind, (raised, C['text']))
        b = tk.Button(parent, text=text, command=command, bg=bg, fg=fg, activebackground=bg, activeforeground=fg,
                      relief='flat', bd=0, padx=padx, pady=7, font=(FONT, 10), cursor='hand2',
                      highlightthickness=1, highlightbackground=core.blend(C['card'], C['text'], 0.22) if kind != 'primary' else C['accent'],
                      disabledforeground=C['muted'])
        return b

    def label(self, parent, text='', size=10, color='text', bold=False, **kw):
        return tk.Label(parent, text=text, bg=kw.pop('bg', C['bg']), fg=C[color],
                        font=(FONT, size, 'bold' if bold else 'normal'), **kw)

    def card(self, parent):
        return tk.Frame(parent, bg=C['card'], highlightthickness=1, highlightbackground=C['border'])

    # ---------- layout ----------

    def build_ui(self):
        r = self.root
        top = tk.Frame(r, bg=C['bg'])
        top.pack(fill='x', padx=18, pady=(14, 8))
        self.label(top, 'Focus Up', 18, bold=True).pack(side='left')
        self.open_brave_btn = self.button(top, 'Open Brave', self.open_brave)
        self.open_brave_btn.pack(side='right')
        self.conn_label = self.label(top, '', 10, 'muted')
        self.conn_label.pack(side='right', padx=12)

        body = tk.Frame(r, bg=C['bg'])
        body.pack(fill='both', expand=True, padx=18, pady=(0, 16))
        body.columnconfigure(0, weight=0, minsize=330)
        body.columnconfigure(1, weight=1)
        body.rowconfigure(0, weight=1)

        left = tk.Frame(body, bg=C['bg'])
        left.grid(row=0, column=0, sticky='nsew', padx=(0, 16))
        right = tk.Frame(body, bg=C['bg'])
        right.grid(row=0, column=1, sticky='nsew')

        self.build_session_panel(left)
        self.build_stats(left)
        self.nb = ttk.Notebook(right)
        self.nb.pack(fill='both', expand=True)
        cal_tab, proj_tab = tk.Frame(self.nb, bg=C['bg']), tk.Frame(self.nb, bg=C['bg'])
        self.nb.add(cal_tab, text='Calendar')
        self.nb.add(proj_tab, text='Projects')
        self.build_calendar(cal_tab)
        self.build_day_panel(cal_tab)
        self.build_projects_tab(proj_tab)

    def build_session_panel(self, parent):
        self.session_card = self.card(parent)
        self.session_card.pack(fill='x')

        # idle view
        self.idle = tk.Frame(self.session_card, bg=C['card'])
        self.label(self.idle, 'Start a focus session', 13, bold=True, bg=C['card']).pack(anchor='w', pady=(0, 8))
        self.name_var, self.planned_var = tk.StringVar(), tk.StringVar()
        top_row = tk.Frame(self.idle, bg=C['card'])
        top_row.pack(fill='x', pady=(0, 8))
        top_row.columnconfigure(0, weight=1)
        for col, (text, var, width) in enumerate((('Session name (optional)', self.name_var, None),
                                                  ('Planned min.', self.planned_var, 8))):
            cell = tk.Frame(top_row, bg=C['card'])
            cell.grid(row=0, column=col, sticky='ew', padx=(0, 8) if col == 0 else 0)
            self.label(cell, text, 9, 'muted', bg=C['card']).pack(anchor='w')
            entry = tk.Entry(cell, textvariable=var, bg=C['bg'], fg=C['text'], insertbackground=C['text'], relief='flat',
                             highlightthickness=1, highlightbackground=C['border'], highlightcolor=C['accent'],
                             font=(FONT, 10), **({'width': width} if width else {}))
            entry.pack(fill='x', ipady=4, pady=(2, 0))
        self.label(self.idle, 'Project', 9, 'muted', bg=C['card']).pack(anchor='w')
        prow = tk.Frame(self.idle, bg=C['card'])
        prow.pack(fill='x', pady=(2, 8))
        self.project_combo = ttk.Combobox(prow, state='readonly', values=['— no project —'])
        self.project_combo.pack(side='left', fill='x', expand=True, ipady=3)
        self.project_combo.bind('<<ComboboxSelected>>', self.on_project_selected)
        self.new_project_btn = self.button(prow, '+ New', lambda: self.new_project(None), padx=8)
        self.new_project_btn.pack(side='left', padx=(6, 0))
        self.new_sub_btn = self.button(prow, '+ Sub', lambda: self.new_project(self.selected_project_id()), padx=8)
        self.new_sub_btn.pack(side='left', padx=(4, 0))
        self.combos = {}
        for k, text in SLOT_LABELS.items():
            self.label(self.idle, text, 9, 'muted', bg=C['card']).pack(anchor='w')
            cb = ttk.Combobox(self.idle, state='readonly', values=['—'])
            cb.pack(fill='x', pady=(2, 8), ipady=3)
            cb.current(0)
            self.combos[k] = cb
        row = tk.Frame(self.idle, bg=C['card'])
        row.pack(fill='x', pady=(2, 0))
        self.start_btn = self.button(row, 'Start session', self.on_start, 'primary')
        self.start_btn.pack(side='left', fill='x', expand=True)
        self.refresh_btn = self.button(row, 'Refresh tabs', self.refresh_tabs)
        self.refresh_btn.pack(side='left', padx=(8, 0))
        self.idle_error = self.label(self.idle, '', 9, 'danger', bg=C['card'], wraplength=290, justify='left')
        self.idle_error.pack(anchor='w', pady=(8, 0))

        # active view
        self.active = tk.Frame(self.session_card, bg=C['card'])
        self.s_name = self.label(self.active, '', 12, bold=True, bg=C['card'])
        self.s_name.pack()
        self.s_project = self.label(self.active, '', 9, 'muted', bg=C['card'])
        self.s_project.pack()
        self.timer_label = self.label(self.active, '00:00:00', 40, bold=True, bg=C['card'])
        self.timer_label.pack(pady=(4, 0))
        self.phase_label = self.label(self.active, '', 10, 'muted', bg=C['card'])
        self.phase_label.pack()
        self.goal_label = self.label(self.active, '', 9, 'muted', bg=C['card'])
        self.goal_label.pack()
        self.attempts_label = self.label(self.active, '', 9, 'muted', bg=C['card'])
        self.attempts_label.pack(pady=(0, 10))
        row = tk.Frame(self.active, bg=C['card'])
        row.pack(fill='x')
        self.pause_btn = self.button(row, 'Pause', self.on_pause)
        self.pause_btn.pack(side='left', fill='x', expand=True)
        self.end_btn = self.button(row, 'End session', self.on_end_click, 'danger')
        self.end_btn.pack(side='left', fill='x', expand=True, padx=(8, 0))
        self.end_panel = tk.Frame(self.active, bg=C['card'])
        self.end_msg = self.label(self.end_panel, '', 9, bg=C['card'], wraplength=290, justify='left')
        self.end_msg.pack(anchor='w', pady=(10, 4))
        self.phrase_var = tk.StringVar()
        self.phrase_var.trace_add('write', lambda *_: self.update_end_confirm())
        self.phrase_entry = tk.Entry(self.end_panel, textvariable=self.phrase_var, bg=C['bg'], fg=C['text'],
                                     insertbackground=C['text'], relief='flat', highlightthickness=1,
                                     highlightbackground=C['border'], highlightcolor=C['accent'])
        self.end_row = row2 = tk.Frame(self.end_panel, bg=C['card'])
        row2.pack(fill='x', pady=(8, 0))
        self.end_confirm = self.button(row2, 'End session', self.on_end_confirm, 'danger')
        self.end_confirm.pack(side='left', fill='x', expand=True)
        self.button(row2, 'Keep going', self.hide_end_panel).pack(side='left', fill='x', expand=True, padx=(8, 0))
        self.discard_btn = self.button(self.end_panel, 'Discard: started by mistake, saves nothing', self.on_discard, 'danger')
        self.discard_btn.pack(fill='x', pady=(8, 0))
        self.active_error = self.label(self.active, '', 9, 'danger', bg=C['card'], wraplength=290, justify='left')
        self.active_error.pack(anchor='w', pady=(8, 0))
        self.slots_label = self.label(self.active, '', 9, 'muted', bg=C['card'], justify='left', wraplength=290)
        self.slots_label.pack(anchor='w', pady=(8, 0))

        # offline view
        self.offline = tk.Frame(self.session_card, bg=C['card'])
        self.label(self.offline, 'Brave isn’t connected', 13, bold=True, bg=C['card']).pack(anchor='w')
        self.offline_msg = self.label(
            self.offline, 'Open Brave with the Focus Up extension to start or control a session. '
            'Your calendar below still shows the last synced history.', 9, 'muted', bg=C['card'],
            wraplength=290, justify='left')
        self.offline_msg.pack(anchor='w', pady=(6, 0))

        for f in (self.idle, self.active, self.offline):
            f.configure(padx=14, pady=14)

    def build_stats(self, parent):
        self.stats_frame = tk.Frame(parent, bg=C['bg'])
        self.stats_frame.pack(fill='x', pady=(14, 0))
        self.stats_frame.columnconfigure((0, 1), weight=1, uniform='s')

    def build_calendar(self, parent):
        bar = tk.Frame(parent, bg=C['bg'])
        bar.pack(fill='x', pady=(10, 4))
        self.label(bar, 'Showing', 9, 'muted').pack(side='left')
        self.filter_combo = ttk.Combobox(bar, state='readonly', width=36, values=['All projects'])
        self.filter_combo.pack(side='left', padx=8)
        self.filter_combo.bind('<<ComboboxSelected>>', self.on_filter)
        head = tk.Frame(parent, bg=C['bg'])
        head.pack(fill='x')
        self.button(head, '‹', lambda: self.shift_month(-1)).pack(side='left')
        self.month_label = self.label(head, '', 14, bold=True)
        self.month_label.pack(side='left', expand=True)
        self.button(head, '›', lambda: self.shift_month(1)).pack(side='right')
        self.button(head, 'Today', self.go_today).pack(side='right', padx=(0, 8))
        self.cal_frame = tk.Frame(parent, bg=C['bg'])
        self.cal_frame.pack(fill='x', pady=(10, 0))
        for c in range(7):
            self.cal_frame.columnconfigure(c, weight=1, uniform='d')

    def build_day_panel(self, parent):
        self.day_title = self.label(parent, '', 12, bold=True)
        self.day_title.pack(anchor='w', pady=(14, 6))
        wrap = tk.Frame(parent, bg=C['bg'])
        wrap.pack(fill='both', expand=True)
        cols = ('time', 'name', 'project', 'dur', 'blocked', 'note')
        self.tree = ttk.Treeview(wrap, columns=cols, show='headings', height=4, selectmode='browse')
        for c, text, w in (('time', 'Time', 100), ('name', 'Session', 170), ('project', 'Project', 150),
                           ('dur', 'Focused', 70), ('blocked', 'Blocked', 60), ('note', '', 80)):
            self.tree.heading(c, text=text, anchor='w')
            self.tree.column(c, width=w, anchor='w', stretch=(c == 'name'))
        self.tree.pack(fill='both', expand=True)
        bar = tk.Frame(parent, bg=C['bg'])
        bar.pack(fill='x', pady=(8, 0))
        self.rename_btn = self.button(bar, 'Rename', self.on_rename)
        self.rename_btn.pack(side='left')
        self.setproj_btn = self.button(bar, 'Set project…', self.on_set_project)
        self.setproj_btn.pack(side='left', padx=(8, 0))
        self.delete_btn = self.button(bar, 'Delete', self.on_delete, 'danger')
        self.delete_btn.pack(side='left', padx=(8, 0))
        self.edit_hint = self.label(bar, '', 9, 'muted')
        self.edit_hint.pack(side='left', padx=12)

    # ---------- rendering ----------

    def render_all(self):
        self.render_projects_ui()
        self.render_session()
        self.render_stats()
        self.render_calendar()
        self.render_day()

    def render_session(self):
        for f in (self.idle, self.active, self.offline):
            f.pack_forget()
        if not self.connected:
            self.offline.pack(fill='x')
            self.conn_label.configure(text='● Brave not connected', fg=C['warn'])
            self.open_brave_btn.pack(side='right')
        else:
            self.conn_label.configure(text='● Brave connected', fg=C['accent'])
            self.open_brave_btn.pack_forget()
            if self.state:
                self.active.pack(fill='x')
                self.s_name.configure(text=self.state.get('name') or 'Focus session')
                pid = self.state.get('projectId')
                self.s_project.configure(text=core.project_path(self.projects, pid) if pid else '')
                planned = self.state.get('plannedMinutes') or 0
                self.goal_label.configure(text=f'Goal: {planned} min' if planned else '')
                self.attempts_label.configure(text=f'Blocked attempts: {self.state.get("blockedAttempts", 0)}')
                resting = bool(self.state.get('rest'))
                self.pause_btn.configure(text='Skip rest' if resting else 'Resume' if self.state.get('pausedAt') is not None else 'Pause')
                slots = self.state.get('slots', {})
                names = [f'{k.capitalize()}: {"open" if slots.get(k) is not None else "empty"}' for k in ('research', 'work', 'music')]
                self.slots_label.configure(text='   ·   '.join(names))
                self.update_timer()
            else:
                self.hide_end_panel()
                self.idle.pack(fill='x')
        self.update_edit_buttons()

    def update_timer(self):
        if not self.state:
            return
        sec = core.active_seconds(self.state, int(time.time() * 1000))
        paused = self.state.get('pausedAt') is not None
        self.timer_label.configure(text=core.fmt_clock(sec), fg=C['muted'] if paused else C['text'])
        plan = core.break_plan(self.state, self.breaks, int(time.time() * 1000))
        phase, color = '', C['muted']
        if plan['in_rest']:
            phase, color = f'{"Long rest" if plan["is_long"] else "Rest"}: {core.fmt_ms(plan["rest_left"])} left', C['warn']
        elif paused:
            phase = 'Paused (restrictions still on)'
        elif plan['enabled']:
            phase = f'Next rest in {core.fmt_ms(plan["due_in"])}'
        self.phase_label.configure(text=phase, fg=color)

    def render_stats(self):
        for w in self.stats_frame.winfo_children():
            w.destroy()
        s = core.compute_stats(self.visible_sessions(), self.today)
        tiles = [('This week', core.fmt_duration(s['week'])), ('Daily average', core.fmt_duration(s['daily_avg'])),
                 ('Streak', f'{s["streak"]} day{"" if s["streak"] == 1 else "s"}'),
                 ('Longest session', core.fmt_duration(s['longest']))]
        for i, (k, v) in enumerate(tiles):
            f = self.card(self.stats_frame)
            f.grid(row=i // 2, column=i % 2, sticky='ew', padx=(0, 8) if i % 2 == 0 else 0, pady=(0, 8))
            self.label(f, v, 13, bold=True, bg=C['card']).pack(anchor='w', padx=10, pady=(5, 0))
            self.label(f, k, 9, 'muted', bg=C['card']).pack(anchor='w', padx=10, pady=(0, 5))

    def heat_color(self, level):
        return C['card'] if level == 0 else core.blend(C['card'], C['accent'], (0.18, 0.38, 0.6, 0.82)[level - 1])

    def render_calendar(self):
        for w in self.cal_frame.winfo_children():
            w.destroy()
        self.month_label.configure(text=self.view.strftime('%B %Y'))
        for c, d in enumerate(WEEKDAYS):
            self.label(self.cal_frame, d, 9, 'muted').grid(row=0, column=c, pady=(0, 4))
        days = core.group_by_day(self.visible_sessions())
        for r, week in enumerate(core.month_weeks(self.view.year, self.view.month), start=1):
            for c, n in enumerate(week):
                if not n:
                    continue
                day = dt.date(self.view.year, self.view.month, n)
                total = core.day_total(days.get(day))
                level = core.heat_level(total)
                bg = self.heat_color(level)
                fg = C['accent_text'] if level >= 3 else C['text']
                border = C['text'] if day == self.selected else (C['accent'] if day == self.today else C['border'])
                cell = tk.Label(self.cal_frame, text=f'{n}\n{core.fmt_duration(total) if total else ""}', bg=bg, fg=fg,
                                font=(FONT, 9, 'bold' if total else 'normal'), anchor='nw', justify='left',
                                padx=6, pady=2, height=2, highlightthickness=2 if day in (self.selected, self.today) else 1,
                                highlightbackground=border, cursor='hand2')
                cell.grid(row=r, column=c, sticky='nsew', padx=2, pady=2)
                cell.bind('<Button-1>', lambda _e, d=day: self.select_day(d))

    def render_day(self):
        self.tree.delete(*self.tree.get_children())
        items = sorted(core.group_by_day(self.visible_sessions()).get(self.selected, []), key=lambda s: s['start'])
        total = core.day_total(items)
        devices = {s['device'] for s in self.sessions if s.get('device')}
        self.day_title.configure(text=self.selected.strftime('%A, %d %B') + (f'  ·  {core.fmt_duration(total)}' if items else ''))
        if not items:
            self.tree.insert('', 'end', iid='_empty', values=('', 'No sessions this day.', '', '', '', ''))
        for s in items:
            self.tree.insert('', 'end', iid=s['id'], values=(
                f'{core.session_time(s["start"])}–{core.session_time(s["end"])}', s.get('name', ''),
                core.project_path(self.projects, s.get('projectId')),
                core.fmt_duration(s.get('activeSeconds', 0)), s.get('blockedAttempts', 0),
                ', '.join(x for x in (s['device'] if s.get('device') and len(devices) > 1 else '',
                                      f'{s["breaks"]} rest{"" if s["breaks"] == 1 else "s"}' if s.get('breaks') else '',
                                      'ended early' if s.get('endedEarly') else '') if x)))
        self.update_edit_buttons()

    def update_edit_buttons(self):
        state = 'normal' if self.connected else 'disabled'
        for b in (self.rename_btn, self.delete_btn, self.setproj_btn, *self.tree_buttons):
            b.configure(state=state)
        hint = '' if self.connected else 'Connect Brave to rename, delete or change projects.'
        self.edit_hint.configure(text=hint)
        self.proj_hint.configure(text=hint)
        if hasattr(self, 'new_project_btn'):
            self.new_project_btn.configure(state=state)
            self.new_sub_btn.configure(state='normal' if self.connected and self.chosen_project else 'disabled')

    # ---------- calendar navigation ----------

    def shift_month(self, delta):
        m = self.view.month - 1 + delta
        self.view = dt.date(self.view.year + m // 12, m % 12 + 1, 1)
        self.render_calendar()

    def go_today(self):
        self.today = dt.date.today()
        self.view, self.selected = self.today.replace(day=1), self.today
        self.render_stats()
        self.render_calendar()
        self.render_day()

    def select_day(self, day):
        self.selected = day
        self.render_calendar()
        self.render_day()

    # ---------- commands to the extension ----------

    def cmd(self, command, callback=None, **args):
        cid = self.next_id
        self.next_id += 1
        if not self.server.send({'type': 'cmd', 'id': cid, 'cmd': command, **args}):
            if callback:
                callback({'ok': False, 'error': 'Brave is not connected.'})
            return
        if callback:
            self.pending[cid] = callback
            self.root.after(20000, lambda: self.pending.pop(cid, None) and callback({'ok': False, 'error': 'Brave did not answer.'}))

    def refresh_tabs(self):
        self.cmd('listTabs', self.fill_tabs)

    def fill_tabs(self, res):
        if not res.get('ok'):
            self.idle_error.configure(text=res.get('error', ''))
            return
        guess = res.get('guess', {})
        for k, cb in self.combos.items():
            ids = [None] + [t['id'] for t in res['tabs']]
            none_text = '— open a new Google tab —' if k == 'research' else '— none (open later) —'
            cb['values'] = [none_text] + [f'{t["title"][:36]} · {t["host"]}' for t in res['tabs']]
            self.combo_ids[k] = ids
            cb.current(ids.index(guess.get(k)) if guess.get(k) in ids else 0)

    def on_start(self):
        picks = {}
        for k, cb in self.combos.items():
            i = cb.current()
            picks[k] = self.combo_ids[k][i] if 0 <= i < len(self.combo_ids[k]) else None
        try:
            planned = int(self.planned_var.get() or 0)
        except ValueError:
            self.idle_error.configure(text='Planned minutes must be a number.')
            return
        self.idle_error.configure(text='')
        self.start_btn.configure(state='disabled')

        def done(res):
            self.start_btn.configure(state='normal')
            if res.get('ok'):
                self.name_var.set('')
                self.planned_var.set('')
            else:
                self.idle_error.configure(text=res.get('error', 'Could not start.'))
        self.cmd('start', done, name=self.name_var.get(), planned=planned, picks=picks, projectId=self.chosen_project or None)

    def on_pause(self):
        if self.state and self.state.get('rest'):
            self.cmd('skipRest', self.show_active_error, snoozeMinutes=0)
            return
        self.cmd('resume' if self.state and self.state.get('pausedAt') is not None else 'pause', self.show_active_error)

    def alert_rest(self):
        """A rest just started: bring this window to the front so it can't be missed."""
        try:
            self.root.deiconify()
            self.root.lift()
            self.root.attributes('-topmost', True)
            self.root.after(2500, lambda: self.root.attributes('-topmost', False))
            self.root.bell()
        except tk.TclError:
            pass

    def show_active_error(self, res):
        self.active_error.configure(text='' if res.get('ok') else res.get('error', ''))

    def on_end_click(self):
        sec = core.active_seconds(self.state, int(time.time() * 1000))
        planned = self.state.get('plannedMinutes') or 0
        self.end_early = bool(planned and sec < planned * 60)
        self.phrase_var.set('')
        if self.end_early:
            self.end_msg.configure(text=f'You planned {planned} min and are at {core.fmt_duration(sec)}. '
                                        f'To end early, type: "{core.EARLY_PHRASE}"')
            self.phrase_entry.pack(fill='x', ipady=4, before=self.end_row)
        else:
            self.end_msg.configure(text=f'End this session at {core.fmt_duration(sec)}?')
            self.phrase_entry.pack_forget()
        self.end_panel.pack(fill='x')
        self.update_end_confirm()

    def update_end_confirm(self):
        ok = (not self.end_early) or self.phrase_var.get().strip().lower() == core.EARLY_PHRASE.lower()
        self.end_confirm.configure(state='normal' if ok else 'disabled')

    def hide_end_panel(self):
        self.end_panel.pack_forget()

    def on_discard(self):
        sec = core.active_seconds(self.state, int(time.time() * 1000)) if self.state else 0
        if not messagebox.askyesno('Discard session', f'Discard this {core.fmt_duration(sec)} session?\n\n'
                                   'Nothing will be saved: no calendar entry and no project time.', parent=self.root):
            return
        self.hide_end_panel()
        self.cmd('discard', self.show_active_error)
        self.root.after(1500, self.refresh_tabs)

    def on_end_confirm(self):
        self.hide_end_panel()
        self.cmd('end', self.show_active_error, early=self.end_early)
        self.root.after(1500, self.refresh_tabs)

    def selected_session(self):
        sel = self.tree.selection()
        if not sel or sel[0] == '_empty':
            return None
        return next((s for s in self.sessions if s['id'] == sel[0]), None)

    def on_rename(self):
        s = self.selected_session()
        if not s:
            return
        new = simpledialog.askstring('Rename session', 'Name:', initialvalue=s.get('name', ''), parent=self.root)
        if new is not None and new.strip():
            self.cmd('rename', lambda r: self.edit_result(r), id=s['id'], name=new)

    def on_delete(self):
        s = self.selected_session()
        if s and messagebox.askyesno('Delete session', f'Delete "{s.get("name", "")}"?', parent=self.root):
            self.cmd('delete', lambda r: self.edit_result(r), id=s['id'])

    def edit_result(self, res):
        if not res.get('ok'):
            messagebox.showerror('Focus Up', res.get('error', 'That did not work.'), parent=self.root)

    # ---------- projects ----------

    def save_mirror(self):
        try:
            ipc.save_mirror(self.sessions, self.projects)
        except OSError:
            pass

    def visible_sessions(self):
        return core.filter_sessions(self.projects, self.sessions, self.filter)

    def project_by_id(self, pid):
        return next((p for p in self.projects if p['id'] == pid), None)

    def project_labels(self, exclude=()):
        return [(p['id'], '\u00a0\u00a0' * d + ('↳ ' if d else '') + p['name'])
                for p, d in core.flatten_projects(self.projects) if p['id'] not in exclude]

    def render_projects_ui(self):
        entries = self.project_labels()
        # start form
        self.project_ids = [''] + [i for i, _ in entries]
        self.project_combo['values'] = ['— no project —'] + [label for _, label in entries]
        if self.pending_choice in self.project_ids:
            self.chosen_project, self.pending_choice = self.pending_choice, None
        elif self.chosen_project is None and self.got_projects:  # continue where the last session left off
            self.chosen_project = self.last_project_id if self.last_project_id in self.project_ids else ''
        if self.chosen_project is not None and self.chosen_project not in self.project_ids:
            self.chosen_project = ''
        self.project_combo.current(self.project_ids.index(self.chosen_project or ''))
        # calendar filter
        self.filter_ids = ['', 'none'] + [i for i, _ in entries]
        self.filter_combo['values'] = ['All projects', 'No project'] + [label for _, label in entries]
        if self.filter not in self.filter_ids:
            self.filter = ''
        self.filter_combo.current(self.filter_ids.index(self.filter))
        self.render_project_tree()
        self.update_edit_buttons()

    def on_project_selected(self, _event=None):
        self.chosen_project = self.project_ids[self.project_combo.current()]
        self.update_edit_buttons()

    def selected_project_id(self):
        return self.chosen_project or None

    def on_filter(self, _event=None):
        self.filter = self.filter_ids[self.filter_combo.current()]
        self.render_stats()
        self.render_calendar()
        self.render_day()

    def build_projects_tab(self, parent):
        self.label(parent, 'Time on a subproject also counts toward every project above it.', 9, 'muted').pack(anchor='w', pady=(12, 8))
        wrap = tk.Frame(parent, bg=C['bg'])
        wrap.pack(fill='both', expand=True)
        self.ptree = ttk.Treeview(wrap, columns=('total', 'week', 'own'), show='tree headings', selectmode='browse')
        self.ptree.heading('#0', text='Project', anchor='w')
        self.ptree.column('#0', width=300, stretch=True)
        for c, text in (('total', 'Total'), ('week', 'This week'), ('own', 'Own')):
            self.ptree.heading(c, text=text, anchor='e')
            self.ptree.column(c, width=90, anchor='e', stretch=False)
        self.ptree.pack(fill='both', expand=True)
        bar = tk.Frame(parent, bg=C['bg'])
        bar.pack(fill='x', pady=(8, 0))
        self.tree_buttons = []
        for text, fn, kind in (('+ Project', lambda: self.new_project(None), 'normal'),
                               ('+ Subproject', self.on_tree_sub, 'normal'), ('Rename', self.on_tree_rename, 'normal'),
                               ('Move…', self.on_tree_move, 'normal'), ('Delete', self.on_tree_delete, 'danger')):
            b = self.button(bar, text, fn, kind)
            b.pack(side='left', padx=(0, 8))
            self.tree_buttons.append(b)
        self.proj_hint = self.label(bar, '', 9, 'muted')
        self.proj_hint.pack(side='left')

    def render_project_tree(self):
        keep = self.selected_tree_project()
        self.ptree.delete(*self.ptree.get_children())
        if not self.projects:
            self.ptree.insert('', 'end', iid='_empty', text='No projects yet. Create one with “+ Project”, then pick it when you start a session.')
            return
        today = dt.date.today()
        week_start = today - dt.timedelta(days=today.weekday())

        def in_week(s):
            try:
                return core.session_date(s) >= week_start
            except (KeyError, ValueError):
                return False
        total = core.project_totals(self.projects, self.sessions)
        week = core.project_totals(self.projects, self.sessions, in_week)
        ids = {p['id'] for p in self.projects}
        for p, _depth in core.flatten_projects(self.projects):
            parent = p.get('parentId') if p.get('parentId') in ids else ''
            if parent and not self.ptree.exists(parent):
                parent = ''  # only possible inside a cycle
            t = total[p['id']]
            own = core.fmt_duration(t['own']) if t['own'] and t['own'] != t['total'] else ''
            self.ptree.insert(parent, 'end', iid=p['id'], text=p['name'], open=True,
                              values=(core.fmt_duration(t['total']), core.fmt_duration(week[p['id']]['total']), own))
        if keep and self.ptree.exists(keep):
            self.ptree.selection_set(keep)

    def selected_tree_project(self):
        sel = self.ptree.selection()
        return sel[0] if sel and sel[0] != '_empty' else None

    def new_project(self, parent_id):
        parent = self.project_by_id(parent_id) if parent_id else None
        prompt = f'Subproject of "{parent["name"]}":' if parent else 'New project name:'
        name = simpledialog.askstring('New project', prompt, parent=self.root)
        if not name or not name.strip():
            return

        def done(res):
            if res.get('ok'):
                self.pending_choice = res.get('id')  # select it in the start form once it arrives
                self.render_projects_ui()
            else:
                messagebox.showerror('Focus Up', res.get('error', 'That did not work.'), parent=self.root)
        self.cmd('createProject', done, name=name, parentId=parent_id)

    def on_tree_sub(self):
        pid = self.selected_tree_project()
        if pid:
            self.new_project(pid)
        else:
            messagebox.showinfo('Focus Up', 'Select a project first.', parent=self.root)

    def on_tree_rename(self):
        p = self.project_by_id(self.selected_tree_project())
        if p:
            name = simpledialog.askstring('Rename project', 'Name:', initialvalue=p['name'], parent=self.root)
            if name and name.strip():
                self.cmd('renameProject', self.edit_result, id=p['id'], name=name)

    def on_tree_move(self):
        p = self.project_by_id(self.selected_tree_project())
        if p:
            dest = self.pick_project(f'Move "{p["name"]}" to:', core.descendant_ids(self.projects, p['id']),
                                     p.get('parentId') or '', '— top level —', 'Move')
            if dest is not None:
                self.cmd('moveProject', self.edit_result, id=p['id'], parentId=dest or None)

    def on_tree_delete(self):
        p = self.project_by_id(self.selected_tree_project())
        if not p:
            return
        kids = sum(1 for x in self.projects if x.get('parentId') == p['id'])
        n = sum(1 for s in self.sessions if s.get('projectId') == p['id'])
        up = self.project_by_id(p.get('parentId'))
        where = f'"{up["name"]}"' if up else 'no project'
        if messagebox.askyesno('Delete project', f'Delete "{p["name"]}"?\n\nIts {kids} subproject(s) and {n} session(s) '
                               f'move up to {where}. No time is lost.', parent=self.root):
            self.cmd('deleteProject', self.edit_result, id=p['id'])

    def on_set_project(self):
        s = self.selected_session()
        if s:
            dest = self.pick_project(f'Project for "{s.get("name", "")}":', set(), s.get('projectId') or '',
                                     '— no project —', 'Set')
            if dest is not None:
                self.cmd('setSessionProject', self.edit_result, sessionId=s['id'], projectId=dest or None)

    def pick_project(self, title, exclude, current, none_label, ok_label):
        """Small modal chooser. Returns a project id, '' for the "none" choice, or None if cancelled."""
        dlg = tk.Toplevel(self.root)
        dlg.title('Focus Up')
        dlg.configure(bg=C['card'], padx=16, pady=14)
        dlg.transient(self.root)
        dlg.resizable(False, False)
        entries = [('', none_label)] + self.project_labels(exclude)
        self.label(dlg, title, 10, bg=C['card']).pack(anchor='w', pady=(0, 8))
        combo = ttk.Combobox(dlg, state='readonly', width=42, values=[label for _, label in entries])
        combo.pack(fill='x', ipady=3)
        ids = [i for i, _ in entries]
        combo.current(ids.index(current) if current in ids else 0)
        result = {'v': None}

        def ok():
            result['v'] = ids[combo.current()]
            dlg.destroy()
        row = tk.Frame(dlg, bg=C['card'])
        row.pack(fill='x', pady=(12, 0))
        self.button(row, ok_label, ok, 'primary').pack(side='left', fill='x', expand=True)
        self.button(row, 'Cancel', dlg.destroy).pack(side='left', fill='x', expand=True, padx=(8, 0))
        dlg.bind('<Escape>', lambda _e: dlg.destroy())
        dlg.grab_set()
        self.root.wait_window(dlg)
        return result['v']

    def open_brave(self):
        path = find_brave()
        if not path:
            messagebox.showinfo('Focus Up', 'Could not find Brave. Open it yourself and the app will connect.', parent=self.root)
            return
        subprocess.Popen([path])

    # ---------- event loop ----------

    def poll(self):
        try:
            while True:
                kind, data = self.server.events.get_nowait()
                if kind == 'connected':
                    self.connected = True
                    self.render_session()
                    self.refresh_tabs()
                elif kind == 'disconnected':
                    self.connected, self.state = False, None
                    self.pending.clear()
                    self.render_session()
                elif kind == 'payload':
                    self.on_payload(data)
        except queue.Empty:
            pass
        self.root.after(100, self.poll)

    def on_payload(self, p):
        kind = p.get('type')
        if kind == 'state':
            self.state = p.get('state')
            self.breaks = {**self.breaks, **(p.get('breaks') or {})}
            resting = bool(self.state and self.state.get('rest'))
            if resting and not self.was_resting:
                self.alert_rest()
            self.was_resting = resting
            self.render_session()
        elif kind == 'sessions':
            self.sessions = p.get('sessions') or []
            if not SMOKE:
                self.save_mirror()
            self.today = dt.date.today()
            self.render_stats()
            self.render_calendar()
            self.render_day()
            self.render_project_tree()
        elif kind == 'projects':
            self.projects = p.get('projects') or []
            self.last_project_id = p.get('lastProjectId')
            self.got_projects = True
            if not SMOKE:
                self.save_mirror()
            self.render_projects_ui()
            self.render_stats()
            self.render_calendar()
            self.render_day()
            self.render_session()
        elif kind == 'reply':
            cb = self.pending.pop(p.get('id'), None)
            if cb:
                cb(p.get('result') or {'ok': False, 'error': 'Empty reply.'})

    def tick(self):
        self.update_timer()
        self.root.after(250, self.tick)


class FakeServer:
    """Used by the smoke test: same interface as AppServer, nothing real behind it."""
    def __init__(self):
        self.events = queue.Queue()
        self.sent = []

    def send(self, payload):
        self.sent.append(payload)
        return True

    def close(self):
        pass


def focus_existing_window():
    """A second launch brings the running app to the front instead of opening another one."""
    import ctypes
    user32 = ctypes.windll.user32
    hwnd = user32.FindWindowW(None, 'Focus Up')
    if hwnd:
        user32.ShowWindow(hwnd, 9)  # SW_RESTORE (un-minimise)
        user32.SetForegroundWindow(hwnd)


def single_instance():
    import ctypes
    ctypes.windll.kernel32.CreateMutexW(None, False, 'FocusUpDesktopApp')
    return ctypes.windll.kernel32.GetLastError() != 183  # ERROR_ALREADY_EXISTS


def smoke_projects():
    return [{'id': 'p-thesis', 'name': 'Thesis', 'parentId': None}, {'id': 'p-ch2', 'name': 'Chapter 2', 'parentId': 'p-thesis'},
            {'id': 'p-fig', 'name': 'Figures', 'parentId': 'p-ch2'}, {'id': 'p-exam', 'name': 'Exam prep', 'parentId': None},
            {'id': 'p-micro', 'name': 'Microwave Engineering', 'parentId': None}]


def smoke_data():
    now = dt.datetime.now().astimezone()

    def mk(days_ago, hour, mins, name, pid, blocked=0, early=False):
        start = (now - dt.timedelta(days=days_ago)).replace(hour=hour, minute=0, second=0, microsecond=0)
        return {'id': f'{days_ago}-{hour}', 'name': name, 'start': start.isoformat(), 'projectId': pid,
                'end': (start + dt.timedelta(minutes=mins)).isoformat(), 'activeSeconds': mins * 60,
                'blockedAttempts': blocked, 'endedEarly': early}
    return [mk(0, 9, 95, 'Chapter 4 problems', 'p-micro', 3), mk(1, 14, 50, 'Plots', 'p-fig'), mk(1, 19, 25, 'Reading', 'p-micro', 1, True),
            mk(2, 10, 140, 'Outline', 'p-thesis', 6), mk(4, 16, 35, 'Write-up', 'p-ch2'), mk(6, 11, 70, 'Revision', 'p-exam', 2),
            mk(9, 10, 20, 'Notes', None), mk(12, 13, 190, 'Exam prep', 'p-exam', 4)]


def main():
    root = tk.Tk()
    if SMOKE:
        server = FakeServer()
        app = App(root, server)
        root.geometry('1000x720+40+40')
        root.attributes('-topmost', True)
        server.events.put(('connected', None))
        server.events.put(('payload', {'type': 'projects', 'projects': smoke_projects(), 'lastProjectId': 'p-micro'}))
        server.events.put(('payload', {'type': 'sessions', 'sessions': smoke_data()}))
        if os.environ.get('FOCUSUP_SMOKE_TAB') == 'projects':
            app.nb.select(1)
        if os.environ.get('FOCUSUP_SMOKE_STATE') == 'active':
            started = int(time.time() * 1000) - 47 * 60 * 1000
            server.events.put(('payload', {'type': 'state', 'breaks': dict(core.DEFAULT_BREAKS), 'state': {
                'name': 'Microwave Engineering ch. 5', 'startedAt': started, 'pausedAt': None, 'pauses': [],
                'plannedMinutes': 90, 'blockedAttempts': 2, 'projectId': 'p-fig', 'slots': {'research': 1, 'work': 2, 'music': None}}}))
        elif os.environ.get('FOCUSUP_SMOKE_STATE') == 'rest':
            now = int(time.time() * 1000)
            server.events.put(('payload', {'type': 'state', 'breaks': dict(core.DEFAULT_BREAKS), 'state': {
                'name': 'Microwave Engineering ch. 5', 'startedAt': now - 53 * 60 * 1000, 'pausedAt': now - 3 * 60 * 1000,
                'pauses': [], 'plannedMinutes': 0, 'blockedAttempts': 2, 'projectId': 'p-fig', 'breaksTaken': 1,
                'slots': {'research': 1, 'work': 2, 'music': None},
                'rest': {'start': now - 3 * 60 * 1000, 'until': now + 7 * 60 * 1000, 'minutes': 10, 'long': False}}}))
        elif os.environ.get('FOCUSUP_SMOKE_STATE') == 'offline':
            server.events.put(('disconnected', None))
        else:
            server.events.put(('payload', {'type': 'state', 'state': None, 'breaks': dict(core.DEFAULT_BREAKS)}))
            app.fill_tabs({'ok': True, 'guess': {'music': 3, 'research': 1, 'work': 2}, 'tabs': [
                {'id': 1, 'title': 'Google', 'host': 'www.google.com'}, {'id': 2, 'title': 'Microwave Engineering, 4th Edition', 'host': 'page'},
                {'id': 3, 'title': '(164) GTA IV Theme x Soviet Contr…', 'host': 'www.youtube.com'}]})
        root.after(int(float(SMOKE) * 1000), root.destroy)
        root.mainloop()
        return

    if not single_instance():
        focus_existing_window()
        return
    server = ipc.AppServer()
    server.start()
    app = App(root, server)  # noqa: F841 (kept alive by the Tk callbacks)
    root.update_idletasks()
    # Never open taller than the screen (small laptops); otherwise use the natural size.
    root.geometry(f'{max(root.winfo_reqwidth(), 960)}x{min(root.winfo_reqheight(), root.winfo_screenheight() - 110)}')

    def on_close():
        server.close()
        root.destroy()
    root.protocol('WM_DELETE_WINDOW', on_close)
    root.mainloop()


if __name__ == '__main__':
    main()
