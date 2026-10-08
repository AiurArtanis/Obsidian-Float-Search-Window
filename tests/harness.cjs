const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { transformSync } = require('esbuild');

class ElementStub {
  constructor() {
    this.children = [];
    this.classes = new Set();
    this.style = {};
    this.value = '';
    this.hidden = false;
    this.focusCount = 0;
    this.listeners = new Map();
    this.classList = {
      add: (...names) => names.forEach((name) => this.classes.add(name)),
      remove: (...names) => names.forEach((name) => this.classes.delete(name)),
      contains: (name) => this.classes.has(name),
    };
  }
  createDiv(options) { return this.createEl('div', options); }
  createSpan(options) { return this.createEl('span', options); }
  createEl(_tag, options = {}) {
    const el = new ElementStub();
    const cls = typeof options === 'string' ? options : options.cls;
    if (cls) cls.split(' ').forEach((name) => el.classes.add(name));
    if (options.text) el.textContent = options.text;
    this.appendChild(el);
    return el;
  }
  appendChild(el) { this.children.push(el); el.parentElement = this; return el; }
  insertBefore(el) { return this.appendChild(el); }
  addClass(name) { this.classes.add(name); }
  removeClass(name) { this.classes.delete(name); }
  hasClass(name) { return this.classes.has(name); }
  toggleClass(name, on) { on ? this.addClass(name) : this.removeClass(name); }
  empty() { this.children = []; this.textContent = ''; }
  detach() { this.detached = true; }
  remove() { this.detach(); }
  hide() { this.hidden = true; this.style.display = 'none'; }
  show() { this.hidden = false; this.style.display = ''; }
  focus() { this.focusCount++; }
  setText(text) { this.textContent = text; }
  appendText() {}
  setAttribute() {}
  addEventListener(name, callback) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name).add(callback);
  }
  removeEventListener(name, callback) { this.listeners.get(name)?.delete(callback); }
  dispatchEvent(event) {
    for (const callback of this.listeners.get(event.type) || []) callback(event);
  }
  closest() { return null; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  getElementsByTagName() { return []; }
  setSelectionRange() { this.selectionCount = (this.selectionCount || 0) + 1; }
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function createHarness() {
  let nextTimer = 0;
  let now = 0;
  const timers = new Map();
  const clock = {
    setTimeout(callback, delay = 0) {
      const id = ++nextTimer;
      timers.set(id, { callback, at: now + delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    async tick(ms = 0) {
      const end = now + ms;
      let steps = 0;
      while (true) {
        const entries = [...timers.entries()].filter(([, timer]) => timer.at <= end);
        entries.sort((a, b) => a[1].at - b[1].at || a[0] - b[0]);
        if (!entries.length) break;
        if (++steps > 1000) throw new Error('Timer loop did not settle');
        const [id, timer] = entries[0];
        timers.delete(id);
        now = timer.at;
        // Do not await callbacks: this deliberately models a pending I/O await.
        const pending = timer.callback();
        if (pending?.catch) pending.catch((error) => clock.errors.push(error));
        await clock.microtasks();
      }
      now = end;
      await clock.microtasks();
    },
    async microtasks() {
      for (let n = 0; n < 8; n++) await Promise.resolve();
    },
    errors: [],
  };

  class Modal {
    constructor(app) {
      this.app = app;
      this.contentEl = new ElementStub();
      this.modalEl = new ElementStub();
      this.containerEl = new ElementStub();
      this.scope = { register() {}, unregister() {} };
    }
    open() { return this.onOpen(); }
    close() { return this.onClose(); }
    onOpen() {}
    onClose() {}
  }
  class SuggestModal extends Modal {
    constructor(app) {
      super(app);
      this.inputEl = new ElementStub();
      this.resultContainerEl = new ElementStub();
      this.chooser = {
        suggestions: [], added: [],
        setSuggestions(items) { this.suggestions = items; },
        addSuggestion(item) { this.added.push(item); this.suggestions.push(item); },
      };
    }
    setPlaceholder() {}
    setInstructions() {}
  }
  class TFile {
    constructor(filePath) {
      this.path = filePath;
      this.name = filePath.split('/').at(-1);
      this.extension = this.name.split('.').at(-1);
      this.basename = this.name.slice(0, -(this.extension.length + 1));
      this.stat = { mtime: 1, ctime: 1 };
      this.parent = { path: filePath.includes('/') ? filePath.slice(0, filePath.lastIndexOf('/')) : '/' };
    }
  }
  const obsidian = {
    Modal, SuggestModal, TFile,
    Plugin: class {}, PluginSettingTab: class {},
    Workspace: class {}, WorkspaceLeaf: class {}, WorkspaceContainer: class {},
    debounce(callback, delay) {
      let timer;
      const run = function (...args) {
        clock.clearTimeout(timer);
        timer = clock.setTimeout(() => callback.apply(this, args), delay);
      };
      run.cancel = () => clock.clearTimeout(timer);
      return run;
    },
    Keymap: {
      isModEvent: (event) => !!(event.ctrlKey || event.metaKey || event.shiftKey),
      isModifier: (event, modifier) => modifier === 'Mod' ? !!(event.ctrlKey || event.metaKey) : !!event.shiftKey,
    },
    prepareFuzzySearch: (query) => (text) => {
      const index = text.toLowerCase().indexOf(query.toLowerCase());
      return index < 0 ? null : { score: 1, matches: [[index, index + query.length]] };
    },
    requireApiVersion: () => true,
    getLanguage: () => 'en',
    setIcon() {}, addIcon() {}, renderResults() {},
  };
  const spawned = [];
  function makeLeaf() {
    const leaf = {
      opened: [], viewStates: [], ephemeralStates: [], detached: false,
      setPinned() {},
      async openFile(file, options) { this.opened.push({ file, options }); },
      async setViewState(state) { this.viewStates.push(state); },
      setEphemeralState(state) { this.ephemeralStates.push(state); },
      detach() { this.detached = true; },
      view: {
        getState: () => ({ query: 'needle' }),
        setState: async () => {},
        searchComponent: { inputEl: new ElementStub() },
      },
    };
    return leaf;
  }
  const leafModule = {
    spawnLeafView() {
      const leaf = leafModule.nextLeaf || makeLeaf();
      leafModule.nextLeaf = undefined;
      const embedded = { unloaded: false, unload() { this.unloaded = true; } };
      spawned.push({ leaf, embedded });
      return [leaf, embedded];
    },
    EmbeddedView: class {},
    isEmebeddedLeaf: () => false,
  };
  const sourceRoot = process.env.FLOAT_SEARCH_TEST_SOURCE_ROOT || path.resolve(__dirname, '..');
  const loaded = new Map();
  function load(name) {
    if (loaded.has(name)) return loaded.get(name);
    const filename = path.join(sourceRoot, 'src', `${name}.ts`);
    let source = fs.readFileSync(filename, 'utf8');
    // Test-only exports leave the plugin's public API unchanged.
    if (name === 'floatSearchIndex') source += '\nexport { FloatSearchCmdkModal, FloatSearchModal };\n';
    const { code } = transformSync(source, { loader: 'ts', format: 'cjs', target: 'node18', sourcefile: filename });
    const module = { exports: {} };
    loaded.set(name, module.exports);
    const context = {
      module, exports: module.exports, console,
      require(id) {
        if (id === 'obsidian') return obsidian;
        if (id === './leafView') return leafModule;
        if (id === './i18n') return { strings: () => ({}) };
        if (id === './filterBar') return load('filterBar');
        if (id === 'monkey-around') return require('monkey-around');
        throw new Error(`Unexpected dependency: ${id}`);
      },
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      AbortController, performance: { now: () => now },
      createDiv: () => new ElementStub(),
      document: { createElement: () => new ElementStub() },
      window: {}, navigator: { language: 'en' },
      MutationObserver: class { observe() {} disconnect() {} },
    };
    vm.runInNewContext(code, context, { filename });
    loaded.set(name, module.exports);
    return module.exports;
  }
  const mainLeaf = makeLeaf();
  const app = {
    vault: { getFiles: () => [], cachedRead: async () => '', getAbstractFileByPath: () => null },
    metadataCache: { getFileCache: () => null },
    workspace: {
      getMostRecentLeaf: () => mainLeaf,
      getLeaf: () => mainLeaf,
      activeCalls: [],
      setActiveLeaf(leaf, options) { this.activeCalls.push({ leaf, options }); },
    },
  };
  const plugin = {
    app,
    settings: {
      showInstructions: false, filterIncludeBases: true, filterIncludeCanvas: true,
      filterStarredOnly: false, filterMatchCase: false, filterUseRegex: false,
      cmdkQuickCreate: false,
    },
    async saveSettings() {},
  };
  return { ...load('floatSearchIndex'), filters: load('filterBar'), clock, app, plugin,
    mainLeaf, makeLeaf, leafModule, spawned, TFile, ElementStub };
}

module.exports = { createHarness, deferred, ElementStub };
