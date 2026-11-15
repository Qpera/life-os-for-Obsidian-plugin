'use strict';
/* Life OS — плагин-надстройка для Obsidian. Без сборки: main.js + manifest.json + styles.css */
const obsidian = require('obsidian');
const { Plugin, ItemView, Modal, Notice, Setting, PluginSettingTab, TFile, requestUrl, normalizePath, debounce, moment } = obsidian;

const VIEW_DASH = 'life-os-dashboard';
const VIEW_MEDIA = 'life-os-media';
const F = 'YYYY-MM-DD';
const PROJECT_KINDS = ['work', 'study', 'research'];
const PROJECT_STATUSES = ['Идея', 'В работе', 'Пауза', 'Завершено', 'Архив', 'Отменено'];
const MEDIA_STATUSES = [
  ['planned', 'Запланировано'], ['watching', 'Смотрю'], ['rewatching', 'Пересматриваю'],
  ['completed', 'Просмотрено'], ['on_hold', 'Отложено'], ['dropped', 'Брошено'],
];
// Соответствие типов закладок CUB/Lampa статусам. Если у тебя иначе — поправь здесь.
const CUB_STATUS = { look: 'watching', scheduled: 'planned', viewed: 'completed', thrown: 'dropped', wath: 'on_hold', book: 'planned' };
const ENTRY_TYPES = [['sleep', 'Сон (часы)'], ['work', 'Работа (часы)'], ['income', 'Доход'], ['expense', 'Расход'], ['activity', 'Активность (минуты)']];

const DEFAULTS = {
  root: 'LifeOS',
  habits: 'Зарядка, Чтение, Вода, Прогулка',
  categories: 'Семья, Друзья, Коллеги, Знакомые',
  doneStatuses: 'Завершено, Архив, Отменено',
  currency: '₽',
  weeklyWorkTarget: 20,
  sleepTarget: 8,
  autoStart: true,
  icsUrl: '',
  tgToken: '', tgChatId: '',
  shikiNick: '',
  cubBase: 'https://cub.rip/api/', cubToken: '', cubProfile: '', cubPath: 'bookmarks/all?full=1',
  templates: { daily: '', meeting: '', person: '', project: '', travel: '' },
};

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const splitList = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);
const dkey = (m) => moment(m).format(F);
const safeName = (s) => String(s).replace(/[\\/:*?"<>|#^\[\]]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Без названия';
const num = (v) => { const n = parseFloat(String(v).replace(',', '.')); return isNaN(n) ? null : n; };
const fmtMoney = (n, c) => Math.round(n).toLocaleString('ru-RU') + ' ' + c;
const statusLabel = (k) => (MEDIA_STATUSES.find((s) => s[0] === k) || [k, k])[1];

/* ---------------- ICS (простой разбор, без повторяющихся событий) ---------------- */
function parseIcsDate(v) {
  if (v.endsWith('Z')) return moment.utc(v.slice(0, -1), 'YYYYMMDD[T]HHmmss').local();
  if (v.includes('T')) return moment(v, 'YYYYMMDD[T]HHmmss');
  return moment(v, 'YYYYMMDD');
}
function parseIcs(text, day) {
  const lines = text.replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
  const out = []; let ev = null;
  for (const l of lines) {
    if (l === 'BEGIN:VEVENT') { ev = {}; continue; }
    if (l === 'END:VEVENT') {
      if (ev && ev.start && ev.start.isValid() && ev.start.isSame(day, 'day')) out.push({ title: ev.title || 'Событие', time: ev.allDay ? '' : ev.start.format('HH:mm') });
      ev = null; continue;
    }
    if (!ev) continue;
    const i = l.indexOf(':'); if (i < 0) continue;
    const key = l.slice(0, i); const val = l.slice(i + 1); const name = key.split(';')[0];
    if (name === 'SUMMARY') ev.title = val.replace(/\\,/g, ',').replace(/\\n/gi, ' ');
    if (name === 'DTSTART') { ev.allDay = key.includes('VALUE=DATE') && !val.includes('T'); ev.start = parseIcsDate(val); }
  }
  return out.sort((a, b) => a.time.localeCompare(b.time));
}

/* ---------------- SVG-графики ---------------- */
const SVGNS = 'http://www.w3.org/2000/svg';
function se(parent, tag, attrs, text) {
  const e = document.createElementNS(SVGNS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (text != null) e.textContent = text;
  parent.appendChild(e); return e;
}
function chartBase(parent, w, h) {
  const s = document.createElementNS(SVGNS, 'svg');
  s.setAttribute('viewBox', `0 0 ${w} ${h}`); s.setAttribute('class', 'los-chart');
  parent.appendChild(s); return s;
}
function barChart(parent, vals, labels, cls) {
  const w = 340, h = 120, pad = 18; const s = chartBase(parent, w, h);
  const max = Math.max(1, ...vals); const bw = (w - 8) / vals.length;
  se(s, 'line', { x1: 0, x2: w, y1: h - pad, y2: h - pad, class: 'los-axis' });
  vals.forEach((v, i) => {
    const bh = (v / max) * (h - pad - 6);
    se(s, 'rect', { x: 4 + i * bw + 1, y: h - pad - bh, width: Math.max(2, bw - 2), height: bh, rx: 1.5, class: cls || 'los-bar' });
    if (labels && labels[i] != null) se(s, 'text', { x: 4 + i * bw + bw / 2, y: h - 4, 'text-anchor': 'middle', class: 'los-tick' }, labels[i]);
  });
}
function lineChart(parent, vals, target, labels) {
  const w = 340, h = 120, pad = 18; const s = chartBase(parent, w, h);
  const real = vals.filter((v) => v != null);
  const max = Math.max(target || 1, ...real, 1) * 1.1;
  const X = (i) => 8 + (i * (w - 16)) / Math.max(1, vals.length - 1);
  const Y = (v) => h - pad - (v / max) * (h - pad - 8);
  se(s, 'line', { x1: 0, x2: w, y1: h - pad, y2: h - pad, class: 'los-axis' });
  if (target) { se(s, 'line', { x1: 0, x2: w, y1: Y(target), y2: Y(target), class: 'los-target' }); }
  let d = '';
  vals.forEach((v, i) => { if (v == null) { d += ' '; return; } d += (d.trim() === '' || vals[i - 1] == null ? 'M' : 'L') + X(i) + ' ' + Y(v); });
  if (d.trim()) se(s, 'path', { d, class: 'los-line' });
  vals.forEach((v, i) => { if (v != null) se(s, 'circle', { cx: X(i), cy: Y(v), r: 3, class: 'los-dot' }); });
  if (labels) labels.forEach((t, i) => { if (t != null) se(s, 'text', { x: X(i), y: h - 4, 'text-anchor': 'middle', class: 'los-tick' }, t); });
}
function radarChart(parent, axes) {
  const W = 340, H = 300, cx = 170, cy = 150, R = 95; const s = chartBase(parent, W, H);
  const n = axes.length; const ang = (i) => -Math.PI / 2 + (i * 2 * Math.PI) / n;
  const P = (i, r) => [cx + Math.cos(ang(i)) * r, cy + Math.sin(ang(i)) * r];
  [0.25, 0.5, 0.75, 1].forEach((k) => {
    se(s, 'polygon', { points: axes.map((_, i) => P(i, R * k).join(',')).join(' '), class: 'los-grid' });
  });
  axes.forEach((_, i) => { const [x, y] = P(i, R); se(s, 'line', { x1: cx, y1: cy, x2: x, y2: y, class: 'los-grid' }); });
  se(s, 'polygon', { points: axes.map((a, i) => P(i, (R * clamp(a.value, 0, 100)) / 100).join(',')).join(' '), class: 'los-radar-area' });
  axes.forEach((a, i) => {
    const [x, y] = P(i, (R * clamp(a.value, 0, 100)) / 100); se(s, 'circle', { cx: x, cy: y, r: 3.5, class: 'los-dot' });
    const [lx, ly] = P(i, R + 22);
    const anchor = Math.abs(lx - cx) < 8 ? 'middle' : lx > cx ? 'start' : 'end';
    se(s, 'text', { x: lx, y: ly + 4, 'text-anchor': anchor, class: 'los-radar-label' }, `${a.label} ${Math.round(a.value)}`);
  });
}

/* ---------------- Универсальная форма ---------------- */
class FormModal extends Modal {
  constructor(app, title, fields, onSubmit, submitText) {
    super(app); this.title = title; this.fields = fields; this.onSubmit = onSubmit; this.submitText = submitText || 'Сохранить';
  }
  onOpen() {
    const { contentEl } = this; contentEl.empty(); contentEl.addClass('los-form');
    contentEl.createEl('h3', { text: this.title });
    const values = {}; this.values = values;
    this.fields.forEach((f) => {
      values[f.key] = f.value != null ? f.value : (f.type === 'checks' ? [] : '');
      const s = new Setting(contentEl).setName(f.label); if (f.desc) s.setDesc(f.desc);
      if (f.type === 'textarea') {
        s.settingEl.addClass('los-vertical');
        s.addTextArea((t) => { t.setValue(values[f.key]); t.inputEl.rows = f.rows || 5; t.onChange((v) => (values[f.key] = v)); });
      } else if (f.type === 'select') {
        s.addDropdown((d) => {
          f.options.forEach((o) => (Array.isArray(o) ? d.addOption(o[0], o[1]) : d.addOption(o, o)));
          if (!values[f.key]) values[f.key] = Array.isArray(f.options[0]) ? f.options[0][0] : f.options[0];
          d.setValue(values[f.key]); d.onChange((v) => (values[f.key] = v));
        });
      } else if (f.type === 'checks') {
        const box = s.controlEl.createDiv({ cls: 'los-checks' }); const sel = new Set(values[f.key]);
        f.options.forEach((o) => {
          const lab = box.createEl('label'); const cb = lab.createEl('input', { type: 'checkbox' }); cb.checked = sel.has(o);
          lab.createSpan({ text: ' ' + o });
          cb.addEventListener('change', () => { cb.checked ? sel.add(o) : sel.delete(o); values[f.key] = [...sel]; });
        });
      } else {
        s.addText((t) => { t.setValue(String(values[f.key])); if (f.placeholder) t.setPlaceholder(f.placeholder); t.onChange((v) => (values[f.key] = v)); if (f.type === 'date') t.inputEl.type = 'date'; });
      }
    });
    new Setting(contentEl).addButton((b) => b.setButtonText(this.submitText).setCta().onClick(() => { this.close(); this.onSubmit(this.values); }));
  }
  onClose() { this.contentEl.empty(); }
}

/* ======================= ПЛАГИН ======================= */
module.exports = class LifeOSPlugin extends Plugin {
  async onload() {
    await this.loadSettings(); await this.loadDb();
    this.dailyCache = new Map();
    this.registerView(VIEW_DASH, (l) => new DashboardView(l, this));
    this.registerView(VIEW_MEDIA, (l) => new MediaView(l, this));
    this.addRibbonIcon('layout-dashboard', 'Life OS: открыть дашборд', () => this.openDashboard());
    this.addSettingTab(new LifeSettingTab(this.app, this));

    const cmd = (id, name, callback) => this.addCommand({ id, name, callback });
    cmd('open-dashboard', 'Открыть дашборд', () => this.openDashboard());
    cmd('daily-plan', 'План дня', () => this.dailyPlan());
    cmd('daily-end', 'Итоги дня (рефлексия и привычки)', () => this.dailyEnd());
    cmd('new-meeting', 'Новая встреча', () => this.newMeeting());
    cmd('new-person', 'Новый человек в картотеку', () => this.newPerson());
    cmd('new-project', 'Новый проект (работа / учёба / исследование)', () => this.newProject());
    cmd('new-travel', 'Новое путешествие', () => this.newTravel());
    cmd('quick-entry', 'Быстрая запись (сон, работа, финансы, активность)', () => this.quickEntry());
    cmd('person-category', 'Сменить категорию человека (текущая заметка)', () => this.changeCategory());
    cmd('open-anime', 'Открыть аниме', () => this.openMedia('anime'));
    cmd('open-movies', 'Открыть фильмы и сериалы', () => this.openMedia('movies'));
    cmd('sync-shikimori', 'Синхронизировать Shikimori', () => this.syncShikimori(true));
    cmd('sync-cub', 'Синхронизировать CUB', () => this.syncCub(true));
    cmd('import-movies', 'Импортировать фильмы из JSON-файла', () => this.importMoviesJson());
    cmd('poll-telegram', 'Проверить Telegram-бота сейчас', () => this.pollTelegram(true));

    this.refreshViews = debounce(() => this.doRefresh(), 900, true);
    const ev = (f) => { if (!f || !f.path || !f.path.endsWith('life.json')) this.refreshViews(); };
    this.registerEvent(this.app.vault.on('modify', ev));
    this.registerEvent(this.app.vault.on('create', ev));
    this.registerEvent(this.app.vault.on('delete', ev));
    this.registerEvent(this.app.vault.on('rename', ev));
    this.registerEvent(this.app.metadataCache.on('changed', ev));
    this.registerInterval(window.setInterval(() => this.pollTelegram(), 60000));
    this.app.workspace.onLayoutReady(() => this.onStart());
  }
  onunload() { this.app.workspace.detachLeavesOfType(VIEW_DASH); this.app.workspace.detachLeavesOfType(VIEW_MEDIA); }

  /* ---------- настройки и база ---------- */
  async loadSettings() {
    const d = (await this.loadData()) || {};
    this.settings = Object.assign({}, DEFAULTS, d, { templates: Object.assign({}, DEFAULTS.templates, d.templates || {}) });
  }
  async saveSettings() { await this.saveData(this.settings); this.refreshViews && this.refreshViews(); }
  get dataPath() { return normalizePath(`${this.settings.root}/Data/life.json`); }
  async loadDb() {
    this.db = { entries: [], ideas: [], later: [], anime: [], movies: [], tgOffset: 0 };
    try {
      if (await this.app.vault.adapter.exists(this.dataPath)) Object.assign(this.db, JSON.parse(await this.app.vault.adapter.read(this.dataPath)));
    } catch (e) { console.error('Life OS: не удалось прочитать базу', e); }
    this.saveDbNow = debounce(async () => {
      try { await this.ensureFolder(`${this.settings.root}/Data`); await this.app.vault.adapter.write(this.dataPath, JSON.stringify(this.db)); }
      catch (e) { console.error('Life OS: не удалось сохранить базу', e); }
    }, 600, true);
  }
  saveDb() { this.saveDbNow(); this.refreshViews(); }
  doRefresh() {
    for (const t of [VIEW_DASH, VIEW_MEDIA]) for (const l of this.app.workspace.getLeavesOfType(t)) { if (l.view && l.view.containerEl.offsetParent && l.view.render) l.view.render(); }
  }

  /* ---------- файлы ---------- */
  async ensureFolder(path) {
    const parts = normalizePath(path).split('/'); let cur = '';
    for (const p of parts) { cur = cur ? `${cur}/${p}` : p; if (!(await this.app.vault.adapter.exists(cur))) await this.app.vault.createFolder(cur); }
  }
  async uniquePath(folder, name) {
    await this.ensureFolder(folder); let p = normalizePath(`${folder}/${safeName(name)}.md`); let i = 2;
    while (this.app.vault.getAbstractFileByPath(p)) p = normalizePath(`${folder}/${safeName(name)} ${i++}.md`);
    return p;
  }
  fm(file) { return (this.app.metadataCache.getFileCache(file) || {}).frontmatter || {}; }
  filesOfType(types) { return this.app.vault.getMarkdownFiles().filter((f) => types.includes(this.fm(f).type)); }
  async openFile(file) { await this.app.workspace.getLeaf(false).openFile(file); }

  /* ---------- ежедневные заметки ---------- */
  dailyInfo() {
    const o = (this.app.internalPlugins && this.app.internalPlugins.getPluginById && this.app.internalPlugins.getPluginById('daily-notes') && this.app.internalPlugins.getPluginById('daily-notes').instance && this.app.internalPlugins.getPluginById('daily-notes').instance.options) || {};
    return { folder: normalizePath(o.folder || `${this.settings.root}/Daily`), format: o.format || F };
  }
  dailyPath(m) { const { folder, format } = this.dailyInfo(); return normalizePath(`${folder}/${moment(m).format(format)}.md`); }
  dailyFile(m) { const f = this.app.vault.getAbstractFileByPath(this.dailyPath(m)); return f instanceof TFile ? f : null; }
  async ensureDaily(m) {
    m = moment(m); const ex = this.dailyFile(m); if (ex) return ex;
    const path = this.dailyPath(m); await this.ensureFolder(path.split('/').slice(0, -1).join('/'));
    const content = `---\ntype: daily\ndate: ${m.format(F)}\nhabits: []\n---\n# ${m.format('dddd, D MMMM')}\n\n## Главная задача\n\n## Задачи\n\n## Рядом\n\n## Итоги дня\n`;
    return this.app.vault.create(path, content);
  }
  insertUnder(data, heading, lines) {
    if (!lines.length) return data;
    const arr = data.split('\n'); let i = arr.findIndex((l) => l.trim() === `## ${heading}`);
    if (i < 0) { arr.push('', `## ${heading}`, ...lines); return arr.join('\n'); }
    let j = i + 1; while (j < arr.length && !arr[j].startsWith('## ')) j++;
    while (j > i + 1 && arr[j - 1].trim() === '') j--;
    arr.splice(j, 0, ...lines); return arr.join('\n');
  }
  parseTasks(content, path) {
    const out = [];
    content.split('\n').forEach((l, i) => {
      const m = /^\s*- \[( |x|X)\]\s+(.*)$/.exec(l); if (!m) return;
      out.push({ path, line: i, done: m[1] !== ' ', raw: m[2], main: /#main\b/.test(m[2]),
        text: m[2].replace(/#[\p{L}\d_/-]+/gu, '').replace(/[✅📅⏳🛫]\s*\d{4}-\d{2}-\d{2}/g, '').trim() });
    });
    return out;
  }
  async todayTasks() {
    const f = this.dailyFile(moment()); if (!f) return { file: null, tasks: [] };
    return { file: f, tasks: this.parseTasks(await this.app.vault.cachedRead(f), f.path) };
  }
  async toggleTask(path, line, wasDone) {
    const f = this.app.vault.getAbstractFileByPath(path); if (!(f instanceof TFile)) return;
    await this.app.vault.process(f, (data) => {
      const lines = data.split('\n'); let l = lines[line];
      if (!l || !/^\s*- \[[ xX]\]/.test(l)) return data;
      l = wasDone ? l.replace(/\[[xX]\]/, '[ ]').replace(/\s*✅\s*\d{4}-\d{2}-\d{2}/, '') : l.replace(/\[ \]/, '[x]') + ` ✅ ${dkey(moment())}`;
      lines[line] = l; return lines.join('\n');
    });
  }
  habitList() { return splitList(this.settings.habits); }
  habitsDone(day) { const f = this.dailyFile(day); if (!f) return new Set(); const h = this.fm(f).habits; return new Set(Array.isArray(h) ? h : []); }
  async toggleHabit(day, name) {
    const f = await this.ensureDaily(day);
    await this.app.fileManager.processFrontMatter(f, (fm) => {
      const a = Array.isArray(fm.habits) ? fm.habits.slice() : []; const i = a.indexOf(name);
      if (i >= 0) a.splice(i, 1); else a.push(name); fm.habits = a;
    });
  }

  /* ---------- сбор данных ---------- */
  addEntry(type, value, note, date) {
    this.db.entries.push({ id: uid(), date: date || dkey(moment()), ts: Date.now(), type, value, note: note || '' });
    this.saveDb();
  }
  entries(type, from, to) { return this.db.entries.filter((e) => e.type === type && e.date >= from && e.date <= to); }
  sum(type, from, to) { return this.entries(type, from, to).reduce((s, e) => s + (+e.value || 0), 0); }
  daySeries(type, days, mode) {
    const out = [], labels = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = dkey(moment().subtract(i, 'days')); const es = this.entries(type, d, d);
      out.push(es.length ? es.reduce((s, e) => s + (+e.value || 0), 0) / (mode === 'avg' ? es.length : 1) : (mode === 'avg' ? null : 0));
      labels.push(i % 5 === 0 ? moment().subtract(i, 'days').format('D') : null);
    }
    return { vals: out, labels };
  }
  doneSet() { return splitList(this.settings.doneStatuses).map((s) => s.toLowerCase()); }
  projects() {
    const done = this.doneSet();
    return this.filesOfType(PROJECT_KINDS).map((f) => ({ file: f, ...this.fm(f) }))
      .filter((p) => !done.includes(String(p.status || '').toLowerCase()))
      .sort((a, b) => String(a.deadline || '9999').localeCompare(String(b.deadline || '9999')));
  }
  goals() { return this.filesOfType(['goal']).map((f) => ({ file: f, ...this.fm(f) })); }
  upcomingPeople(days = 21) {
    const out = []; const t = moment().startOf('day');
    this.filesOfType(['person']).forEach((f) => {
      const b = /^(?:\d{4}-)?(\d{2})-(\d{2})$/.exec(String(this.fm(f).birthday || '')); if (!b) return;
      let d = moment(`${t.year()}-${b[1]}-${b[2]}`, F); if (d.isBefore(t)) d = d.add(1, 'year');
      const diff = d.diff(t, 'days'); if (diff <= days) out.push({ file: f, date: d, diff });
    });
    return out.sort((a, b) => a.diff - b.diff);
  }
  upcomingMeetings(days = 14) {
    const t = dkey(moment()); const end = dkey(moment().add(days, 'days'));
    return this.filesOfType(['meeting']).map((f) => ({ file: f, ...this.fm(f) })).filter((m) => m.date >= t && m.date <= end)
      .sort((a, b) => String(a.date + (a.time || '')).localeCompare(String(b.date + (b.time || ''))));
  }
  async calendarEvents(m) {
    if (!this.settings.icsUrl) return [];
    try { const r = await requestUrl({ url: this.settings.icsUrl }); return parseIcs(r.text, moment(m)); }
    catch (e) { console.warn('Life OS: ICS недоступен', e); return []; }
  }

  /* ---------- XP ---------- */
  async scanDaily() {
    const { folder, format } = this.dailyInfo(); const res = new Map();
    for (const f of this.app.vault.getMarkdownFiles()) {
      if (!f.path.startsWith(folder + '/')) continue;
      const d = moment(f.basename, format, true); if (!d.isValid()) continue;
      let c = this.dailyCache.get(f.path);
      if (!c || c.mtime !== f.stat.mtime) {
        const tasks = this.parseTasks(await this.app.vault.cachedRead(f), f.path).filter((t) => t.done && /#daily\b/.test(t.raw));
        const fm = this.fm(f);
        c = { mtime: f.stat.mtime, done: tasks.filter((t) => !t.main).length, main: tasks.filter((t) => t.main).length, habits: Array.isArray(fm.habits) ? fm.habits.length : 0, reflected: fm.reflected ? 1 : 0 };
        this.dailyCache.set(f.path, c);
      }
      res.set(d.format(F), c);
    }
    return res;
  }
  async xpInfo() {
    const days = await this.scanDaily(); let xp = 0;
    days.forEach((c) => { xp += c.done * 10 + c.main * 30 + c.habits * 5 + c.reflected * 20; });
    this.db.entries.forEach((e) => {
      const v = +e.value || 0;
      if (e.type === 'work') xp += Math.round(v * 10); else if (e.type === 'sleep') xp += 5;
      else if (e.type === 'activity') xp += Math.round(v / 6); else xp += 2;
    });
    xp += this.db.ideas.length * 3;
    const level = Math.floor((1 + Math.sqrt(1 + xp / 12.5)) / 2);
    const lo = 50 * level * (level - 1), hi = 50 * (level + 1) * level;
    let streak = 0; const cur = moment(); const act = (m) => { const c = days.get(dkey(m)); return c && (c.done + c.main + c.habits + c.reflected > 0); };
    if (!act(cur)) cur.subtract(1, 'day'); while (act(cur)) { streak++; cur.subtract(1, 'day'); }
    return { xp, level, lo, hi, streak };
  }
  radar() {
    const t = dkey(moment()); const d14 = dkey(moment().subtract(13, 'days')); const d30 = dkey(moment().subtract(29, 'days'));
    const sl = this.entries('sleep', d14, t); const sleepAvg = sl.length ? sl.reduce((s, e) => s + +e.value, 0) / sl.length : 0;
    const act = this.sum('activity', d14, t);
    const health = clamp(sleepAvg / this.settings.sleepTarget, 0, 1) * 60 + clamp(act / (14 * 20), 0, 1) * 40;
    const wk = this.sum('work', dkey(moment().startOf('isoWeek')), t);
    const work = clamp(wk / this.settings.weeklyWorkTarget, 0, 1) * 100;
    const inc = this.sum('income', d30, t), exp = this.sum('expense', d30, t);
    const fin = inc > 0 ? clamp((inc - exp) / inc, 0, 1) * 100 : 0;
    const hl = this.habitList(); let hd = 0;
    for (let i = 0; i < 30; i++) hd += this.habitsDone(moment().subtract(i, 'days')).size;
    const habits = hl.length ? clamp(hd / (hl.length * 30), 0, 1) * 100 : 0;
    const social = clamp(this.filesOfType(['meeting']).filter((f) => { const d = String(this.fm(f).date || ''); return d >= d30 && d <= t; }).length / 4, 0, 1) * 100;
    const since = Date.now() - 30 * 864e5;
    const ideas = clamp((this.db.ideas.filter((i) => i.ts > since).length + this.db.later.filter((i) => i.ts > since).length) / 10, 0, 1) * 100;
    return [{ label: 'Здоровье', value: health }, { label: 'Работа', value: work }, { label: 'Финансы', value: fin }, { label: 'Привычки', value: habits }, { label: 'Люди', value: social }, { label: 'Идеи', value: ideas }];
  }

  /* ---------- создание заметок (с мостом к Templater) ---------- */
  async fromTemplater(kind, folder, name) {
    const tp = this.settings.templates[kind]; if (!tp) return null;
    const plugin = this.app.plugins && this.app.plugins.plugins && this.app.plugins.plugins['templater-obsidian'];
    const tf = this.app.vault.getAbstractFileByPath(normalizePath(tp));
    if (!plugin || !plugin.templater || !(tf instanceof TFile)) return null;
    try { await this.ensureFolder(folder); return await plugin.templater.create_new_note_from_template(tf, folder, safeName(name), true); }
    catch (e) { console.warn('Life OS: Templater не сработал, беру встроенный шаблон', e); return null; }
  }
  async createNote(kind, folder, name, content) {
    if (await this.fromTemplater(kind, folder, name)) return;
    const path = await this.uniquePath(folder, name); const f = await this.app.vault.create(path, content); await this.openFile(f);
  }
  newMeeting() {
    new FormModal(this.app, 'Новая встреча', [
      { key: 'title', label: 'Тема' }, { key: 'person', label: 'С кем' },
      { key: 'date', label: 'Дата', type: 'date', value: dkey(moment()) }, { key: 'time', label: 'Время', placeholder: '18:30' },
    ], async (v) => {
      const body = `---\ntype: meeting\ndate: ${v.date}\ntime: "${v.time}"\nperson: "${v.person}"\ntags: [meeting]\n---\n# Встреча: ${v.title}\n\n## До встречи\n- [ ] Цель встречи #meeting\n- [ ] Подготовить вопросы #meeting\n\n---\n**Выше — заполнить до встречи. Ниже — во время и после.**\n---\n\n## Во время\n\n## После\n- [ ] Итоговые действия #meeting\n`;
      await this.createNote('meeting', `${this.settings.root}/Meetings`, `${v.date} ${v.title}`, body);
    }, 'Создать').open();
  }
  newPerson() {
    new FormModal(this.app, 'Новый человек', [
      { key: 'name', label: 'Имя' }, { key: 'category', label: 'Категория', type: 'select', options: splitList(this.settings.categories) },
      { key: 'birthday', label: 'День рождения', placeholder: 'ГГГГ-ММ-ДД или ММ-ДД' }, { key: 'contact', label: 'Контакты' },
    ], async (v) => {
      const body = `---\ntype: person\ncategory: ${v.category}\nbirthday: "${v.birthday}"\ncontact: "${v.contact}"\ntags: [rolodex]\n---\n# ${v.name}\n\n## О человеке\n\n## Как познакомились\n\n## Важное\n\n## Задачи\n- [ ] #rolodex\n`;
      await this.createNote('person', `${this.settings.root}/Rolodex`, v.name, body);
    }, 'Создать').open();
  }
  newProject() {
    new FormModal(this.app, 'Новый проект', [
      { key: 'title', label: 'Название' },
      { key: 'kind', label: 'Тип', type: 'select', options: [['work', 'Работа'], ['study', 'Учёба'], ['research', 'Исследование']] },
      { key: 'deadline', label: 'Дедлайн', type: 'date' },
    ], async (v) => {
      const sec = { work: '## Цель\n\n## Результат\n', study: '## Что нужно усвоить\n\n## Материалы\n', research: '## Вопрос и гипотеза\n\n## Методы\n\n## Выводы\n' }[v.kind];
      const body = `---\ntype: ${v.kind}\nstatus: Идея\ndeadline: ${v.deadline || ''}\ntags: [${v.kind}]\n---\n# ${v.title}\n\n${sec}\n## Задачи\n- [ ] #${v.kind}\n`;
      await this.createNote('project', `${this.settings.root}/Projects`, v.title, body);
    }, 'Создать').open();
  }
  newTravel() {
    new FormModal(this.app, 'Новое путешествие', [{ key: 'title', label: 'Куда' }, { key: 'from', label: 'С', type: 'date' }, { key: 'to', label: 'По', type: 'date' }], async (v) => {
      const body = `---\ntype: travel\nfrom: ${v.from}\nto: ${v.to}\ntags: [travel]\n---\n# ${v.title}\n\n## Планы\n\n## Бронирования\n\n## Что взять\n- [ ] #travel\n\n## Заметки\n`;
      await this.createNote('travel', `${this.settings.root}/Travel`, v.title, body);
    }, 'Создать').open();
  }
  changeCategory() {
    const f = this.app.workspace.getActiveFile();
    if (!f || this.fm(f).type !== 'person') { new Notice('Открой заметку человека (type: person)'); return; }
    new FormModal(this.app, `Категория: ${f.basename}`, [{ key: 'category', label: 'Категория', type: 'select', options: splitList(this.settings.categories), value: this.fm(f).category }],
      (v) => this.app.fileManager.processFrontMatter(f, (fm) => { fm.category = v.category; }), 'Применить').open();
  }
  quickEntry() {
    new FormModal(this.app, 'Быстрая запись', [
      { key: 'type', label: 'Что', type: 'select', options: ENTRY_TYPES },
      { key: 'value', label: 'Значение', placeholder: '7.5' }, { key: 'note', label: 'Заметка / категория' },
      { key: 'date', label: 'Дата', type: 'date', value: dkey(moment()) },
    ], (v) => { const n = num(v.value); if (n == null) return new Notice('Нужно число'); this.addEntry(v.type, n, v.note, v.date); new Notice('Записано'); }, 'Записать').open();
  }
  addIdea(text) { this.db.ideas.unshift({ id: uid(), ts: Date.now(), text, done: false }); this.saveDb(); }
  addLater(text) { this.db.later.unshift({ id: uid(), ts: Date.now(), text, done: false }); this.saveDb(); }
  async ideaToNote(idea) {
    const path = await this.uniquePath(`${this.settings.root}/Ideas`, idea.text.slice(0, 40));
    await this.app.vault.create(path, `---\ntype: idea\ncreated: ${dkey(idea.ts)}\n---\n# ${idea.text.slice(0, 80)}\n\n${idea.text}\n`);
    idea.done = true; this.saveDb(); new Notice('Идея стала заметкой');
  }

  /* ---------- план дня / итоги дня ---------- */
  onStart() {
    if (this.app.workspace.getLeavesOfType(VIEW_DASH).length) return;
    if (this.settings.autoStart) { if (!this.dailyFile(moment())) this.dailyPlan(); else this.openDashboard(); }
    this.pollTelegram();
  }
  dailyPlan() {
    new FormModal(this.app, 'План дня', [
      { key: 'main', label: 'Главная задача дня' },
      { key: 'tasks', label: 'Другие задачи', desc: 'По одной на строку', type: 'textarea' },
    ], async (v) => {
      const now = moment(); const f = await this.ensureDaily(now);
      const events = await this.calendarEvents(now);
      const near = [];
      this.projects().filter((p) => p.deadline && p.deadline <= dkey(moment().add(3, 'days'))).forEach((p) => near.push(`- ⏳ Дедлайн: [[${p.file.basename}]] — ${p.deadline}`));
      this.upcomingPeople(3).forEach((p) => near.push(`- 🎂 [[${p.file.basename}]] — ${p.diff === 0 ? 'сегодня' : 'через ' + p.diff + ' дн.'}`));
      this.upcomingMeetings(3).forEach((m) => near.push(`- 🤝 [[${m.file.basename}]] — ${m.date} ${m.time || ''}`));
      const tasks = (v.tasks || '').split('\n').map((s) => s.trim()).filter(Boolean).map((t) => `- [ ] ${t} #daily`);
      const cal = events.map((e) => `- [ ] ${e.time ? e.time + ' ' : ''}${e.title} #daily`);
      await this.app.vault.process(f, (data) => {
        let d = data;
        if (v.main && v.main.trim()) d = this.insertUnder(d, 'Главная задача', [`- [ ] ${v.main.trim()} #daily #main`]);
        d = this.insertUnder(d, 'Задачи', [...tasks, ...cal]); d = this.insertUnder(d, 'Рядом', near); return d;
      });
      if (v.main) await this.app.fileManager.processFrontMatter(f, (fm) => { fm.main_task = v.main.trim(); });
      this.dailyCache.delete(f.path); await this.openDashboard(); new Notice('План на день готов');
    }, 'Начать день').open();
  }
  dailyEnd() {
    const active = this.app.workspace.getActiveFile(); const { folder, format } = this.dailyInfo();
    const isDaily = active && active.path.startsWith(folder + '/') && moment(active.basename, format, true).isValid();
    const day = isDaily ? moment(active.basename, format, true) : moment();
    const done = [...this.habitsDone(day)];
    new FormModal(this.app, `Итоги дня: ${day.format('D MMMM')}`, [
      { key: 'good', label: 'Что получилось', type: 'textarea', rows: 3 }, { key: 'bad', label: 'Что не получилось', type: 'textarea', rows: 3 },
      { key: 'next', label: 'Что улучшить завтра', type: 'textarea', rows: 3 },
      { key: 'mood', label: 'Настроение', type: 'select', options: ['1', '2', '3', '4', '5'], value: '3' },
      { key: 'habits', label: 'Привычки', type: 'checks', options: this.habitList(), value: done },
    ], async (v) => {
      const f = await this.ensureDaily(day);
      await this.app.fileManager.processFrontMatter(f, (fm) => { fm.habits = v.habits; fm.mood = +v.mood; fm.reflected = true; });
      const lines = [`**Получилось:** ${v.good}`, `**Не получилось:** ${v.bad}`, `**Улучшить:** ${v.next}`];
      await this.app.vault.process(f, (data) => this.insertUnder(data, 'Итоги дня', lines));
      this.dailyCache.delete(f.path); new Notice('День закрыт');
    }, 'Закрыть день').open();
  }

  /* ---------- представления ---------- */
  async openDashboard() {
    let leaf = this.app.workspace.getLeavesOfType(VIEW_DASH)[0];
    if (!leaf) { leaf = this.app.workspace.getLeaf('tab'); await leaf.setViewState({ type: VIEW_DASH, active: true }); }
    this.app.workspace.revealLeaf(leaf);
  }
  async openMedia(kind) {
    let leaf = this.app.workspace.getLeavesOfType(VIEW_MEDIA).find((l) => l.view.kind === kind);
    if (!leaf) { leaf = this.app.workspace.getLeaf('tab'); await leaf.setViewState({ type: VIEW_MEDIA, active: true, state: { kind } }); }
    this.app.workspace.revealLeaf(leaf);
  }

  /* ---------- Telegram ---------- */
  async tgSend(chat, text) {
    try { await requestUrl({ url: `https://api.telegram.org/bot${this.settings.tgToken}/sendMessage`, method: 'POST', contentType: 'application/json', body: JSON.stringify({ chat_id: chat, text }), throw: false }); } catch (e) { /* ignore */ }
  }
  async pollTelegram(manual) {
    const s = this.settings; if (!s.tgToken || this.polling) { if (manual && !s.tgToken) new Notice('Укажи токен бота в настройках'); return; }
    this.polling = true;
    try {
      const r = await requestUrl({ url: `https://api.telegram.org/bot${s.tgToken}/getUpdates?offset=${(this.db.tgOffset || 0) + 1}&timeout=0`, throw: false });
      const upd = (r.json && r.json.result) || []; let n = 0;
      for (const u of upd) {
        this.db.tgOffset = Math.max(this.db.tgOffset || 0, u.update_id);
        const m = u.message; if (!m || !m.text) continue;
        const chat = String(m.chat.id);
        if (!s.tgChatId) { await this.tgSend(chat, `Твой chat id: ${chat}\nВставь его в настройки плагина Life OS — после этого бот начнёт записывать данные.`); continue; }
        if (chat !== String(s.tgChatId)) continue;
        await this.tgSend(chat, await this.tgHandle(m.text)); n++;
      }
      if (upd.length) this.saveDb();
      if (manual) new Notice(`Telegram: обработано сообщений — ${n}`);
    } catch (e) { console.warn('Life OS: Telegram', e); if (manual) new Notice('Telegram: ошибка запроса'); }
    this.polling = false;
  }
  async tgHandle(text) {
    const t = text.trim();
    if (!t.startsWith('/')) { this.addIdea(t); return '💡 Идея записана'; }
    const [raw, ...rest] = t.split(/\s+/); const cmd = raw.slice(1).split('@')[0].toLowerCase(); const arg = rest.join(' '); const n = num(rest[0] || '');
    switch (cmd) {
      case 'start': case 'help':
        return 'Команды:\n/sleep 7.5 — сон, часы\n/work 2 — работа, часы\n/income 5000 зарплата\n/expense 300 еда\n/act бег 30 — активность, минуты\n/habit имя — отметить привычку\n/idea текст\n/later текст — «посмотреть позже»\n/today — задачи на сегодня\nПросто текст без команды — идея.';
      case 'sleep': case 'work':
        if (n == null) return `Формат: /${cmd} 7.5`; this.addEntry(cmd, n); return `✅ ${cmd === 'sleep' ? 'Сон' : 'Работа'}: ${n} ч`;
      case 'income': case 'expense':
        if (n == null) return `Формат: /${cmd} 500 категория`; this.addEntry(cmd, n, rest.slice(1).join(' ')); return `✅ ${cmd === 'income' ? 'Доход' : 'Расход'}: ${n} ${this.settings.currency}`;
      case 'act': {
        const m = /^(.*?)\s*(\d+(?:[.,]\d+)?)$/.exec(arg); if (!m) return 'Формат: /act бег 30';
        this.addEntry('activity', num(m[2]), m[1]); return `✅ Активность: ${m[1] || 'без названия'}, ${m[2]} мин`;
      }
      case 'idea': if (!arg) return 'Формат: /idea текст'; this.addIdea(arg); return '💡 Идея записана';
      case 'later': if (!arg) return 'Формат: /later название'; this.addLater(arg); return '📌 Добавлено в «Посмотреть позже»';
      case 'habit': {
        const h = this.habitList().find((x) => x.toLowerCase().startsWith(arg.toLowerCase()) && arg);
        if (!h) return 'Не нашёл такую привычку. Список: ' + this.habitList().join(', ');
        if (!this.habitsDone(moment()).has(h)) await this.toggleHabit(moment(), h); return `✅ ${h}`;
      }
      case 'today': {
        const { tasks } = await this.todayTasks(); if (!tasks.length) return 'На сегодня задач нет.';
        return tasks.map((x) => `${x.done ? '✅' : '▫️'} ${x.text}`).join('\n');
      }
      default: return 'Не знаю такую команду. /help';
    }
  }

  /* ---------- Shikimori ---------- */
  async syncShikimori(manual) {
    const nick = this.settings.shikiNick; if (!nick) { new Notice('Укажи ник Shikimori в настройках'); return; }
    const headers = { 'User-Agent': 'Obsidian-LifeOS' };
    try {
      const u = await requestUrl({ url: `https://shikimori.one/api/users/${encodeURIComponent(nick)}?is_nickname=1`, headers, throw: false });
      if (u.status !== 200 || !u.json || !u.json.id) throw new Error('пользователь не найден (' + u.status + ')');
      const list = []; const limit = 1000;
      for (let page = 1; page < 20; page++) {
        const r = await requestUrl({ url: `https://shikimori.one/api/users/${u.json.id}/anime_rates?limit=${limit}&page=${page}`, headers, throw: false });
        if (r.status !== 200) throw new Error('HTTP ' + r.status);
        const arr = r.json || []; list.push(...arr); if (arr.length < limit) break;
      }
      this.db.anime = list.filter((x) => x.anime).map((x) => ({
        id: 'shiki-' + x.anime.id, source: 'shikimori', status: x.status, score: x.score || 0, progress: x.episodes || 0, total: x.anime.episodes || x.anime.episodes_aired || 0,
        title: x.anime.russian || x.anime.name, cover: x.anime.image ? 'https://shikimori.one' + (x.anime.image.original || x.anime.image.preview) : '', url: 'https://shikimori.one' + x.anime.url,
      }));
      this.db.shikiAt = Date.now(); this.saveDb(); new Notice(`Shikimori: загружено ${this.db.anime.length}`);
    } catch (e) { console.error(e); new Notice('Shikimori: ' + e.message); }
  }

  /* ---------- CUB (best effort: формат ответа проверь на своём аккаунте) ---------- */
  async syncCub() {
    const s = this.settings; if (!s.cubToken) { new Notice('Укажи токен CUB в настройках'); return; }
    try {
      const headers = { token: s.cubToken }; if (s.cubProfile) headers.profile = s.cubProfile;
      const r = await requestUrl({ url: s.cubBase.replace(/\/?$/, '/') + s.cubPath.replace(/^\//, ''), headers, throw: false });
      if (r.status !== 200) throw new Error('HTTP ' + r.status);
      const j = r.json; const arr = Array.isArray(j) ? j : (j.bookmarks || j.results || j.items || j.data || []);
      const items = [];
      for (const it of arr) {
        const c = (it.data && typeof it.data === 'object' ? it.data : null) || it.card || it;
        const title = c.title || c.name || c.original_title || c.original_name; if (!title) continue;
        const st = CUB_STATUS[it.type] || 'planned';
        items.push({ id: 'cub-' + (it.card_id || c.id || it.id), source: 'cub', status: st, score: it.score || 0, progress: 0, total: c.number_of_episodes || 0, title,
          cover: c.poster_path ? (c.poster_path.startsWith('http') ? c.poster_path : 'https://image.tmdb.org/t/p/w342' + c.poster_path) : (c.img || ''), url: '' });
      }
      if (!items.length) throw new Error('не распознал ответ — путь/формат нужно подстроить (см. README)');
      const manual = this.db.movies.filter((m) => m.source !== 'cub'); this.db.movies = [...manual, ...items];
      this.db.cubAt = Date.now(); this.saveDb(); new Notice(`CUB: загружено ${items.length}`);
    } catch (e) { console.error(e); new Notice('CUB: ' + e.message); }
  }
  importMoviesJson() {
    new FormModal(this.app, 'Импорт фильмов из JSON', [{ key: 'path', label: 'Путь к файлу в хранилище', desc: 'Массив: [{"title","status","score","progress","total","cover"}]', placeholder: 'LifeOS/Data/movies.json' }], async (v) => {
      try {
        const arr = JSON.parse(await this.app.vault.adapter.read(normalizePath(v.path)));
        const items = arr.map((x) => ({ id: 'imp-' + uid(), source: 'import', status: MEDIA_STATUSES.some((s) => s[0] === x.status) ? x.status : 'planned', score: x.score || 0, progress: x.progress || 0, total: x.total || 0, title: x.title, cover: x.cover || '', url: '' }));
        this.db.movies.push(...items); this.saveDb(); new Notice(`Импортировано: ${items.length}`);
      } catch (e) { new Notice('Не удалось прочитать JSON: ' + e.message); }
    }, 'Импортировать').open();
  }
};

/* ======================= ДАШБОРД ======================= */
class DashboardView extends ItemView {
  constructor(leaf, plugin) { super(leaf); this.plugin = plugin; this.tx = 20; this.ty = 20; this.s = 1; this.rid = 0; }
  getViewType() { return VIEW_DASH; }
  getDisplayText() { return 'Life OS'; }
  getIcon() { return 'layout-dashboard'; }
  async onOpen() {
    const root = this.contentEl; root.empty(); root.addClass('los-root');
    this.vp = root.createDiv({ cls: 'los-viewport' }); this.world = this.vp.createDiv({ cls: 'los-world' });
    const bar = root.createDiv({ cls: 'los-zoombar los-nopan' });
    [['−', () => this.zoomAt(this.vp.clientWidth / 2, this.vp.clientHeight / 2, 1 / 1.2)], ['+', () => this.zoomAt(this.vp.clientWidth / 2, this.vp.clientHeight / 2, 1.2)], ['Вместить', () => this.fit()]]
      .forEach(([t, fn]) => bar.createEl('button', { text: t }).addEventListener('click', fn));
    this.bindPanZoom(); await this.render(); this.fit();
  }
  apply() { this.world.style.transform = `translate(${this.tx}px,${this.ty}px) scale(${this.s})`; }
  fit() { this.s = clamp((this.vp.clientWidth - 40) / 1500, 0.3, 1); this.tx = Math.max(20, (this.vp.clientWidth - 1500 * this.s) / 2); this.ty = 20; this.apply(); }
  zoomAt(x, y, k) {
    const r = this.vp.getBoundingClientRect(); const px = x - r.left, py = y - r.top; const ns = clamp(this.s * k, 0.25, 2.5); const real = ns / this.s;
    this.tx = px - (px - this.tx) * real; this.ty = py - (py - this.ty) * real; this.s = ns; this.apply();
  }
  bindPanZoom() {
    const vp = this.vp; let mode = null, lx = 0, ly = 0, ox = 0, oy = 0;
    vp.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) this.zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.1 : 1 / 1.1);
      else { this.tx -= e.deltaX; this.ty -= e.deltaY; this.apply(); }
    }, { passive: false });
    vp.addEventListener('contextmenu', (e) => { if (e.ctrlKey) e.preventDefault(); });
    vp.addEventListener('mousedown', (e) => {
      if (e.target.closest('button,input,select,textarea,a,.los-nopan')) return;
      if (e.button === 2 && e.ctrlKey) { mode = 'zoom'; ox = e.clientX; oy = e.clientY; ly = e.clientY; e.preventDefault(); }
      else if (e.button === 0 || e.button === 1) { mode = 'pan'; lx = e.clientX; ly = e.clientY; vp.addClass('is-panning'); }
    });
    window.addEventListener('mousemove', this.mm = (e) => {
      if (!mode) return;
      if (mode === 'pan') { this.tx += e.clientX - lx; this.ty += e.clientY - ly; lx = e.clientX; ly = e.clientY; this.apply(); }
      else { this.zoomAt(ox, oy, Math.exp((ly - e.clientY) * 0.01)); ly = e.clientY; }
    });
    window.addEventListener('mouseup', this.mu = () => { mode = null; vp.removeClass('is-panning'); });
    vp.addEventListener('dblclick', (e) => { if (e.target === vp || e.target === this.world) this.fit(); });
  }
  async onClose() { window.removeEventListener('mousemove', this.mm); window.removeEventListener('mouseup', this.mu); }

  card(area, title) { const c = this.world.createDiv({ cls: `los-card los-a-${area}` }); if (title) c.createEl('h4', { text: title }); return c; }
  btn(parent, text, fn, cls) { const b = parent.createEl('button', { text, cls: cls || '' }); b.addEventListener('click', fn); return b; }

  async render() {
    const id = ++this.rid; const p = this.plugin; const cur = p.settings.currency;
    const ctx = { xp: await p.xpInfo(), today: await p.todayTasks(), projects: p.projects(), people: p.upcomingPeople(), meetings: p.upcomingMeetings(), goals: p.goals(), radar: p.radar() };
    if (id !== this.rid) return;
    this.world.empty();
    this.cHero(ctx); this.cToday(ctx); this.cActions(); this.cProjects(ctx); this.cHabits(); this.cFinance(cur);
    this.cSleep(); this.cWork(); this.cRadar(ctx); this.cPeople(ctx); this.cGoals(ctx); this.cIdeas(); this.cLater();
  }

  cHero(ctx) {
    const c = this.card('hero'); const { xp, level, lo, hi, streak } = ctx.xp;
    const top = c.createDiv({ cls: 'los-hero-top' });
    top.createDiv({ cls: 'los-level', text: String(level) }); const meta = top.createDiv();
    meta.createDiv({ cls: 'los-hero-title', text: 'уровень' }); meta.createDiv({ cls: 'los-muted', text: moment().format('dddd, D MMMM') });
    const bar = c.createDiv({ cls: 'los-xpbar' }); bar.createDiv({ cls: 'los-xpfill' }).style.width = clamp(((xp - lo) / (hi - lo)) * 100, 0, 100) + '%';
    c.createDiv({ cls: 'los-muted', text: `${xp - lo} / ${hi - lo} XP до следующего уровня · серия ${streak} дн.` });
  }
  cToday(ctx) {
    const c = this.card('today', 'Сегодня'); const { file, tasks } = ctx.today;
    if (!file) { c.createDiv({ cls: 'los-muted', text: 'План на сегодня ещё не составлен.' }); this.btn(c, 'Составить план дня', () => this.plugin.dailyPlan(), 'mod-cta'); return; }
    const main = tasks.find((t) => t.main); const rest = tasks.filter((t) => !t.main);
    const row = (t, big) => {
      const r = c.createDiv({ cls: 'los-task' + (big ? ' los-main' : '') + (t.done ? ' is-done' : '') });
      const cb = r.createEl('input', { type: 'checkbox' }); cb.checked = t.done; cb.addEventListener('change', () => this.plugin.toggleTask(t.path, t.line, t.done));
      r.createSpan({ text: t.text });
    };
    if (main) row(main, true); rest.forEach((t) => row(t, false));
    if (!tasks.length) c.createDiv({ cls: 'los-muted', text: 'В заметке дня нет задач.' });
    c.createDiv({ cls: 'los-muted los-foot', text: `Выполнено ${tasks.filter((t) => t.done).length} из ${tasks.length}` });
    this.btn(c, 'Открыть заметку дня', () => this.plugin.openFile(file));
  }
  cActions() {
    const c = this.card('acts', 'Действия'); const g = c.createDiv({ cls: 'los-btns' }); const p = this.plugin;
    [['План дня', () => p.dailyPlan()], ['Итоги дня', () => p.dailyEnd()], ['Запись', () => p.quickEntry()], ['Встреча', () => p.newMeeting()], ['Человек', () => p.newPerson()], ['Проект', () => p.newProject()],
      ['Путешествие', () => p.newTravel()], ['Аниме', () => p.openMedia('anime')], ['Фильмы', () => p.openMedia('movies')], ['Telegram', () => p.pollTelegram(true)]].forEach(([t, fn]) => this.btn(g, t, fn));
  }
  cProjects(ctx) {
    const c = this.card('proj', 'Проекты и дедлайны');
    if (!ctx.projects.length) c.createDiv({ cls: 'los-muted', text: 'Нет активных проектов.' });
    ctx.projects.slice(0, 8).forEach((pr) => {
      const r = c.createDiv({ cls: 'los-proj' }); const a = r.createEl('a', { text: pr.file.basename }); a.addEventListener('click', () => this.plugin.openFile(pr.file));
      r.createSpan({ cls: 'los-tag los-' + pr.type, text: { work: 'работа', study: 'учёба', research: 'исследование' }[pr.type] });
      if (pr.deadline) { const late = pr.deadline < dkey(moment()); r.createSpan({ cls: 'los-muted' + (late ? ' los-late' : ''), text: moment(pr.deadline, F).format('D MMM') }); }
      const sel = r.createEl('select'); PROJECT_STATUSES.forEach((s) => sel.createEl('option', { text: s, value: s }));
      if (pr.status && !PROJECT_STATUSES.includes(pr.status)) sel.createEl('option', { text: pr.status, value: pr.status });
      sel.value = pr.status || 'Идея'; sel.addEventListener('change', () => this.plugin.app.fileManager.processFrontMatter(pr.file, (fm) => { fm.status = sel.value; }));
    });
  }
  cHabits() {
    const p = this.plugin; const c = this.card('habits', 'Привычки: ' + moment().format('MMMM')); const hl = p.habitList(); const dim = moment().daysInMonth();
    const grid = c.createDiv({ cls: 'los-hgrid los-nopan' }); grid.style.gridTemplateColumns = `110px repeat(${dim}, 1fr)`;
    grid.createDiv(); for (let d = 1; d <= dim; d++) grid.createDiv({ cls: 'los-hday', text: d % 5 === 0 || d === 1 ? String(d) : '' });
    const sets = []; for (let d = 1; d <= dim; d++) sets.push(p.habitsDone(moment().date(d)));
    hl.forEach((h) => {
      grid.createDiv({ cls: 'los-hname', text: h });
      for (let d = 1; d <= dim; d++) {
        const day = moment().date(d); const future = day.isAfter(moment(), 'day');
        const cell = grid.createDiv({ cls: 'los-hcell' + (sets[d - 1].has(h) ? ' on' : '') + (future ? ' future' : '') + (day.isSame(moment(), 'day') ? ' today' : '') });
        if (!future) cell.addEventListener('click', () => p.toggleHabit(day, h));
      }
    });
    if (!hl.length) c.createDiv({ cls: 'los-muted', text: 'Добавь привычки в настройках плагина.' });
  }
  cFinance(cur) {
    const p = this.plugin; const c = this.card('fin', 'Финансы'); const a = dkey(moment().startOf('month')), b = dkey(moment().endOf('month'));
    const inc = p.sum('income', a, b), exp = p.sum('expense', a, b);
    const nums = c.createDiv({ cls: 'los-nums' });
    [['Доход', fmtMoney(inc, cur), 'gain'], ['Расход', fmtMoney(exp, cur), 'loss'], ['Баланс', fmtMoney(inc - exp, cur), '']].forEach(([l, v, k]) => {
      const n = nums.createDiv(); n.createDiv({ cls: 'los-num ' + k, text: v }); n.createDiv({ cls: 'los-muted', text: l });
    });
    c.createDiv({ cls: 'los-muted', text: 'Расходы за 30 дней' }); const s = p.daySeries('expense', 30); barChart(c, s.vals, s.labels, 'los-bar loss');
  }
  cSleep() {
    const p = this.plugin; const c = this.card('sleep', 'Сон'); const s = p.daySeries('sleep', 14, 'avg'); const real = s.vals.filter((v) => v != null);
    c.createDiv({ cls: 'los-num', text: real.length ? (real.reduce((x, y) => x + y, 0) / real.length).toFixed(1) + ' ч' : '—' });
    c.createDiv({ cls: 'los-muted', text: 'в среднем за 14 дней' }); lineChart(c, s.vals, p.settings.sleepTarget, s.labels);
  }
  cWork() {
    const p = this.plugin; const c = this.card('work', 'Работа'); const mon = moment().startOf('isoWeek');
    const vals = [], labels = []; for (let i = 0; i < 7; i++) { const d = dkey(mon.clone().add(i, 'days')); vals.push(p.sum('work', d, d)); labels.push(mon.clone().add(i, 'days').format('dd')); }
    c.createDiv({ cls: 'los-num', text: vals.reduce((x, y) => x + y, 0).toFixed(1).replace(/\.0$/, '') + ' ч' });
    c.createDiv({ cls: 'los-muted', text: `за неделю, цель ${p.settings.weeklyWorkTarget} ч` }); barChart(c, vals, labels);
  }
  cRadar(ctx) { const c = this.card('radar', 'Баланс за 30 дней'); radarChart(c, ctx.radar); }
  cPeople(ctx) {
    const c = this.card('people', 'Люди и встречи');
    if (!ctx.people.length && !ctx.meetings.length) c.createDiv({ cls: 'los-muted', text: 'Ближайшие 2–3 недели свободны.' });
    ctx.meetings.slice(0, 4).forEach((m) => { const r = c.createDiv({ cls: 'los-row' }); r.createEl('a', { text: m.file.basename }).addEventListener('click', () => this.plugin.openFile(m.file)); r.createSpan({ cls: 'los-muted', text: moment(m.date, F).format('D MMM') + (m.time ? ' ' + m.time : '') }); });
    ctx.people.slice(0, 4).forEach((x) => { const r = c.createDiv({ cls: 'los-row' }); r.createEl('a', { text: '🎂 ' + x.file.basename }).addEventListener('click', () => this.plugin.openFile(x.file)); r.createSpan({ cls: 'los-muted', text: x.diff === 0 ? 'сегодня' : x.date.format('D MMM') }); });
    this.btn(c, 'Картотека', () => { const f = this.plugin.app.vault.getAbstractFileByPath(this.plugin.settings.root + '/Rolodex'); if (f) this.plugin.app.workspace.getLeavesOfType('file-explorer')[0]?.view?.revealInFolder?.(f); else new Notice('Папка картотеки появится после первого человека'); });
  }
  cGoals(ctx) {
    const c = this.card('goals', 'Цели');
    if (!ctx.goals.length) c.createDiv({ cls: 'los-muted', text: 'Создай заметку с type: goal и progress: 0–100.' });
    ctx.goals.slice(0, 6).forEach((g) => {
      const r = c.createDiv({ cls: 'los-goal' }); r.createEl('a', { text: g.file.basename }).addEventListener('click', () => this.plugin.openFile(g.file));
      const b = r.createDiv({ cls: 'los-xpbar small' }); b.createDiv({ cls: 'los-xpfill' }).style.width = clamp(+g.progress || 0, 0, 100) + '%';
    });
  }
  cIdeas() {
    const p = this.plugin; const c = this.card('ideas', 'Входящие идеи'); this.addInput(c, 'Новая идея и Enter', (t) => p.addIdea(t));
    const items = p.db.ideas.filter((i) => !i.done); if (!items.length) c.createDiv({ cls: 'los-muted', text: 'Пусто. Пиши идеи боту в Telegram.' });
    items.slice(0, 8).forEach((i) => {
      const r = c.createDiv({ cls: 'los-row' }); r.createSpan({ text: i.text }); const g = r.createDiv({ cls: 'los-mini' });
      this.btn(g, 'в заметку', () => p.ideaToNote(i)); this.btn(g, '×', () => { p.db.ideas = p.db.ideas.filter((x) => x !== i); p.saveDb(); });
    });
  }
  cLater() {
    const p = this.plugin; const c = this.card('later', 'Посмотреть позже'); this.addInput(c, 'Название и Enter', (t) => p.addLater(t));
    const items = p.db.later.filter((i) => !i.done); if (!items.length) c.createDiv({ cls: 'los-muted', text: 'Список пуст.' });
    items.slice(0, 8).forEach((i) => {
      const r = c.createDiv({ cls: 'los-row' }); r.createSpan({ text: i.text }); const g = r.createDiv({ cls: 'los-mini' });
      this.btn(g, 'готово', () => { i.done = true; p.saveDb(); }); this.btn(g, '×', () => { p.db.later = p.db.later.filter((x) => x !== i); p.saveDb(); });
    });
  }
  addInput(parent, ph, fn) {
    const i = parent.createEl('input', { type: 'text', placeholder: ph, cls: 'los-input' });
    i.addEventListener('keydown', (e) => { if (e.key === 'Enter' && i.value.trim()) { fn(i.value.trim()); i.value = ''; } });
  }
}

/* ======================= АНИМЕ / ФИЛЬМЫ ======================= */
class MediaView extends ItemView {
  constructor(leaf, plugin) { super(leaf); this.plugin = plugin; this.kind = 'anime'; this.tab = 'watching'; this.q = ''; }
  getViewType() { return VIEW_MEDIA; }
  getDisplayText() { return this.kind === 'anime' ? 'Life OS: аниме' : 'Life OS: фильмы и сериалы'; }
  getIcon() { return this.kind === 'anime' ? 'tv' : 'film'; }
  getState() { return { kind: this.kind }; }
  async setState(state, result) { this.kind = (state && state.kind) || 'anime'; await this.render(); return super.setState(state, result); }
  async onOpen() { this.contentEl.addClass('los-root'); await this.render(); }
  async render() {
    const p = this.plugin; const root = this.contentEl; root.empty(); root.addClass('los-media');
    const list = this.kind === 'anime' ? p.db.anime : p.db.movies;
    const head = root.createDiv({ cls: 'los-media-head' });
    head.createEl('h3', { text: this.kind === 'anime' ? 'Аниме' : 'Фильмы и сериалы' });
    const tools = head.createDiv({ cls: 'los-btns' });
    if (this.kind === 'anime') { new obsidian.ButtonComponent(tools).setButtonText('Синхронизировать Shikimori').onClick(() => p.syncShikimori(true)); if (p.db.shikiAt) tools.createSpan({ cls: 'los-muted', text: 'обновлено ' + moment(p.db.shikiAt).format('D MMM HH:mm') }); }
    else {
      new obsidian.ButtonComponent(tools).setButtonText('Синхронизировать CUB').onClick(() => p.syncCub(true));
      new obsidian.ButtonComponent(tools).setButtonText('Добавить').onClick(() => this.editItem(null));
      new obsidian.ButtonComponent(tools).setButtonText('Импорт JSON').onClick(() => p.importMoviesJson());
    }
    const tabs = root.createDiv({ cls: 'los-tabs' });
    MEDIA_STATUSES.forEach(([k, l]) => {
      const b = tabs.createEl('button', { text: `${l} · ${list.filter((x) => x.status === k).length}`, cls: this.tab === k ? 'is-active' : '' });
      b.addEventListener('click', () => { this.tab = k; this.render(); });
    });
    const search = tabs.createEl('input', { type: 'text', placeholder: 'Поиск', cls: 'los-input' }); search.value = this.q;
    search.addEventListener('input', () => { this.q = search.value; this.renderGrid(grid, list); }); const grid = root.createDiv({ cls: 'los-grid-media' }); this.renderGrid(grid, list);
  }
  renderGrid(grid, list) {
    grid.empty(); const q = this.q.toLowerCase();
    const items = list.filter((x) => x.status === this.tab && (!q || x.title.toLowerCase().includes(q))).sort((a, b) => (b.score || 0) - (a.score || 0));
    if (!items.length) grid.createDiv({ cls: 'los-muted', text: 'Здесь пока ничего нет.' });
    items.forEach((x) => {
      const c = grid.createDiv({ cls: 'los-poster' }); const im = c.createDiv({ cls: 'los-cover' });
      if (x.cover) { const img = im.createEl('img'); img.src = x.cover; img.loading = 'lazy'; img.setAttribute('referrerpolicy', 'no-referrer'); }
      if (x.score) im.createDiv({ cls: 'los-score', text: '★ ' + x.score });
      c.createDiv({ cls: 'los-ptitle', text: x.title });
      c.createDiv({ cls: 'los-muted', text: x.total ? `серия ${x.progress} из ${x.total}` : (x.progress ? `серия ${x.progress}` : statusLabel(x.status)) });
      c.addEventListener('click', () => (x.source === 'shikimori' && x.url ? window.open(x.url) : this.editItem(x)));
    });
  }
  editItem(item) {
    const p = this.plugin; const it = item || { id: 'man-' + uid(), source: 'manual', status: this.tab, score: 0, progress: 0, total: 0, title: '', cover: '', url: '' };
    new FormModal(this.app, item ? 'Изменить' : 'Добавить', [
      { key: 'title', label: 'Название', value: it.title }, { key: 'status', label: 'Статус', type: 'select', options: MEDIA_STATUSES, value: it.status },
      { key: 'score', label: 'Оценка (0–10)', value: String(it.score) }, { key: 'progress', label: 'Серия', value: String(it.progress) }, { key: 'total', label: 'Всего серий', value: String(it.total) },
      { key: 'cover', label: 'Ссылка на обложку', value: it.cover },
    ], (v) => {
      Object.assign(it, { title: v.title, status: v.status, score: num(v.score) || 0, progress: num(v.progress) || 0, total: num(v.total) || 0, cover: v.cover });
      if (!item) p.db.movies.push(it); p.saveDb();
    }, 'Сохранить').open();
  }
}

/* ======================= НАСТРОЙКИ ======================= */
class LifeSettingTab extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
  display() {
    const { containerEl: el } = this; el.empty(); const s = this.plugin.settings; const p = this.plugin;
    const text = (name, desc, key, ph, obj) => new Setting(el).setName(name).setDesc(desc || '').addText((t) => t.setPlaceholder(ph || '').setValue(String((obj || s)[key])).onChange(async (v) => { (obj || s)[key] = v.trim(); await p.saveSettings(); }));
    el.createEl('h3', { text: 'Основное' });
    text('Корневая папка', 'Здесь лежат данные, проекты, люди, встречи', 'root', 'LifeOS');
    text('Привычки', 'Через запятую', 'habits'); text('Категории людей', 'Через запятую', 'categories');
    text('Статусы «закрытых» проектов', 'Эти проекты не показываются на дашборде', 'doneStatuses'); text('Валюта', '', 'currency');
    new Setting(el).setName('Цель по работе, часов в неделю').addText((t) => t.setValue(String(s.weeklyWorkTarget)).onChange(async (v) => { s.weeklyWorkTarget = num(v) || 20; await p.saveSettings(); }));
    new Setting(el).setName('Цель по сну, часов').addText((t) => t.setValue(String(s.sleepTarget)).onChange(async (v) => { s.sleepTarget = num(v) || 8; await p.saveSettings(); }));
    new Setting(el).setName('Запускать при старте Obsidian').setDesc('Нет заметки дня — открыть план дня, иначе — дашборд').addToggle((t) => t.setValue(s.autoStart).onChange(async (v) => { s.autoStart = v; await p.saveSettings(); }));
    el.createEl('h3', { text: 'Календарь' }); text('Ссылка ICS', 'Google Календарь → «Секретный адрес в формате iCal». Повторяющиеся события не разворачиваются.', 'icsUrl');
    el.createEl('h3', { text: 'Telegram-бот' }); text('Токен бота', 'От @BotFather', 'tgToken'); text('Chat ID', 'Напиши боту /start — он ответит твоим id', 'tgChatId');
    el.createEl('h3', { text: 'Shikimori' }); text('Ник', '', 'shikiNick');
    el.createEl('h3', { text: 'CUB' }); text('Базовый адрес API', '', 'cubBase'); text('Токен', 'Получить на cub.rip/add (6-значный код → токен)', 'cubToken'); text('ID профиля', 'Необязательно', 'cubProfile'); text('Путь запроса закладок', 'Подстрой, если синхронизация не находит данные', 'cubPath');
    el.createEl('h3', { text: 'Шаблоны Templater (необязательно)' });
    el.createEl('p', { cls: 'setting-item-description', text: 'Путь к своему шаблону, например Templates/Meeting.md. Если указан и Templater включён — используется он, иначе встроенный шаблон.' });
    [['daily', 'План дня (не используется, зарезервировано)'], ['meeting', 'Встреча'], ['person', 'Человек'], ['project', 'Проект'], ['travel', 'Путешествие']].forEach(([k, l]) => text(l, '', k, 'Templates/...', s.templates));
  }
}
