const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness, deferred, ElementStub } = require('./harness.cjs');

function parseNativeRegexQuery(query) {
  // Obsidian's native query tokenizer ends a literal at any unescaped slash,
  // including a slash inside a character class. Mirror that delimiter behavior.
  function takeLiteral(input) {
    assert.equal(input[0], '/', 'A native regex must start with a slash');
    let source = '';
    for (let index = 1; index < input.length; index++) {
      if (input[index] === '\\') {
        const next = input[++index];
        assert.notEqual(next, undefined, 'A regex cannot end in a dangling escape');
        // Native search removes delimiter escapes but preserves regex escapes,
        // including paired backslashes, before constructing RegExp.
        source += next === '/' ? '/' : '\\' + next;
        continue;
      }
      if (input[index] === '/') {
        return { regex: new RegExp(source), rest: input.slice(index + 1) };
      }
      source += input[index];
    }
    assert.fail('Missing closing regex delimiter');
  }
  const content = takeLiteral(query);
  if (!content.rest) return [content.regex];
  assert.ok(content.rest.startsWith(' OR path:'), 'Unexpected native-search syntax outside the regex');
  const filePath = takeLiteral(content.rest.slice(' OR path:'.length));
  assert.equal(filePath.rest, '', 'Do not leak pattern text into native-search operators');
  return [content.regex, filePath.regex];
}

function nativeNonemptyMatch(source, text, matchCase = false) {
  const regex = new RegExp(source, matchCase ? 'gm' : 'gmi');
  let match;
  while ((match = regex.exec(text))) {
    if (match[0].length > 0) return match;
    // Obsidian discards zero-length search matches instead of showing them.
    regex.lastIndex++;
  }
  return null;
}

for (const extension of ['canvas', 'base', 'pdf', 'md']) {
  test(`CMDK opens .${extension} through Obsidian's native file dispatcher`, async () => {
    const h = createHarness();
    const modal = new h.FloatSearchCmdkModal(h.plugin);
    const file = new h.TFile(`notes/example.${extension}`);
    await modal.onChooseSuggestion({ type: 'file', file }, {});
    await h.clock.microtasks();
    assert.equal(h.mainLeaf.opened.length, 1, 'Use leaf.openFile so the registered native view type is preserved');
    assert.equal(h.mainLeaf.opened[0].file, file);
    assert.equal(h.mainLeaf.opened[0].options.active, true);
    assert.equal(h.mainLeaf.viewStates.length, 0, 'Do not force a markdown view for native file formats');
  });
}

test('an empty result set immediately clears the old preview and cancels a pending selection', async () => {
  const h = createHarness();
  const modal = new h.FloatSearchCmdkModal(h.plugin);
  modal.onOpen();
  const stale = { type: 'file', file: new h.TFile('old.md') };
  await modal.showPreview(stale);
  const oldPreview = modal.previewEl;
  const leaf = h.spawned[0].leaf;
  modal.onSelectedChange(stale, null);
  modal.inputEl.value = 'no-match';
  modal.updateSuggestions();
  assert.equal(modal.chooser.suggestions.length, 0);
  assert.ok(oldPreview.hidden || oldPreview.detached || oldPreview.style.display === 'none', 'Stale preview must disappear synchronously');
  assert.equal(modal.modalEl.hasClass('float-search-cmdk-expanded'), false);
  await h.clock.tick(200);
  assert.equal(leaf.opened.length, 1, 'Old debounced selection must not reopen the preview');
  assert.deepEqual(h.clock.errors, []);
});

test('closing CMDK cancels content results whose cachedRead is already pending', async () => {
  const h = createHarness();
  const pending = deferred();
  const file = new h.TFile('ordinary.md');
  h.app.vault.getFiles = () => [file];
  let readStarted = false;
  h.app.vault.cachedRead = () => { readStarted = true; return pending.promise; };
  const modal = new h.FloatSearchCmdkModal(h.plugin);
  modal.onOpen();
  modal.inputEl.value = 'needle';
  modal.updateSuggestions();
  await h.clock.tick(50);
  assert.equal(readStarted, true, 'Exercise cancellation after I/O begins');
  modal.onClose();
  pending.resolve('a matching needle remains in this document');
  await h.clock.microtasks();
  assert.equal(modal.chooser.added.length, 0, 'A closed chooser must not receive stale results');
  assert.deepEqual(h.clock.errors, []);
});

test('closing CMDK during preview openFile prevents late focus', async () => {
  const h = createHarness();
  const pending = deferred();
  const leaf = h.makeLeaf();
  let readStarted = false;
  leaf.openFile = () => { readStarted = true; return pending.promise; };
  h.leafModule.nextLeaf = leaf;
  const modal = new h.FloatSearchCmdkModal(h.plugin);
  modal.onOpen();
  const preview = modal.showPreview({ type: 'file', file: new h.TFile('slow.canvas') });
  await h.clock.microtasks();
  assert.equal(readStarted, true, 'Exercise close while openFile is pending');
  modal.onClose();
  pending.resolve();
  await preview;
  await h.clock.tick(200);
  assert.equal(leaf.detached, true);
  assert.equal(modal.inputEl.focusCount, 0, 'An awaited preview must not steal focus after close');
  assert.deepEqual(h.clock.errors, []);
});

test('closing the native modal while its search leaf initializes stops post-await setup', async () => {
  const h = createHarness();
  const pending = deferred();
  const leaf = h.makeLeaf();
  leaf.setViewState = () => pending.promise;
  let stateWrites = 0;
  leaf.view.setState = async () => { stateWrites++; };
  h.leafModule.nextLeaf = leaf;
  const modal = new h.FloatSearchModal(() => {}, h.plugin, { query: 'needle' });
  const continued = [];
  for (const name of ['initFilterBar', 'initInput', 'initContent']) {
    modal[name] = () => continued.push(name);
  }
  const opening = modal.onOpen();
  modal.onClose();
  pending.resolve();
  await opening;
  await h.clock.tick(100);
  assert.deepEqual(continued, [], 'Closing before init resolves must not install listeners, filters or focus');
  assert.equal(stateWrites, 0, 'Detached search leaf must not receive delayed state writes');
  assert.equal(leaf.view.searchComponent.inputEl.selectionCount || 0, 0);
  assert.deepEqual(h.clock.errors, []);
});

test('closing the native modal during a preview read prevents late focus', async () => {
  const h = createHarness();
  const pending = deferred();
  const leaf = h.makeLeaf();
  let readStarted = false;
  leaf.openFile = () => { readStarted = true; return pending.promise; };
  h.leafModule.nextLeaf = leaf;
  const modal = new h.FloatSearchModal(() => {}, h.plugin, { query: 'needle' });
  modal.searchLeaf = h.makeLeaf();
  modal.searchEmbeddedView = { unload() {} };
  const input = modal.searchLeaf.view.searchComponent.inputEl;
  const preview = modal.initFileView(new h.TFile('slow.md'), undefined);
  await h.clock.microtasks();
  assert.equal(readStarted, true, 'Exercise close while native preview openFile is pending');
  modal.onClose();
  pending.resolve();
  await preview;
  await h.clock.tick(100);
  assert.equal(input.focusCount, 0, 'Native preview completion must not focus the closed search input');
  assert.deepEqual(h.clock.errors, []);
});

test('native regex helper submits a real regex and safely escapes slash delimiters', () => {
  const h = createHarness();
  h.plugin.settings.filterUseRegex = true;
  assert.equal(typeof h.filters.buildNativeRegexQuery, 'function');
  for (const query of ['alpha|beta', 'folder/note', String.raw`folder\/note`, '[a-z]+', '[/]', '[//]',
    String.raw`\/`, String.raw`\\/`, String.raw`[\/]`, 'folder/subfolder/note',
    'foo/ OR path:/bar', 'first\nsecond', '']) {
    const nativeQuery = h.filters.buildNativeRegexQuery(h.plugin, query);
    if (!query) { assert.equal(nativeQuery, ''); continue; }
    const compiled = parseNativeRegexQuery(nativeQuery);
    for (const regex of compiled) {
      // Escaping a slash inside a character class changes .source but not meaning.
      // Compare actual matching, including literal backslashes next to slashes.
      for (const sample of ['alpha', 'beta', 'folder/note', 'folder/subfolder/note', '/', '//',
        '\\/', 'foo/ OR path:/bar', 'first\nsecond', '[a-z]+', query]) {
        const expected = new RegExp(query).exec(sample);
        const actual = regex.exec(sample);
        assert.equal(actual?.[0], expected?.[0], `Match mismatch for ${JSON.stringify({ query, sample })}`);
        assert.equal(actual?.index, expected?.index, `Offset mismatch for ${JSON.stringify({ query, sample })}`);
      }
    }
  }
});

test('native regex helper makes invalid patterns match nothing and preserves plain queries', () => {
  const h = createHarness();
  assert.equal(typeof h.filters.buildNativeRegexQuery, 'function');
  const literalQuery = 'path:notes hello';
  assert.equal(h.filters.buildNativeRegexQuery(h.plugin, literalQuery), literalQuery);
  h.plugin.settings.filterUseRegex = true;
  for (const invalid of ['[', '(', '*']) {
    const nativeQuery = h.filters.buildNativeRegexQuery(h.plugin, invalid);
    for (const regex of parseNativeRegexQuery(nativeQuery)) {
      for (const text of ['', invalid, 'an arbitrary ordinary document']) {
        assert.equal(regex.test(text), false, 'Invalid syntax cannot silently fall back to an unfiltered search');
      }
    }
  }
});

for (const [type, detail, expected] of [
  ['heading', { heading: 'Section one' }, { subpath: '#Section one' }],
  ['content', { line: 0 }, { line: 0 }],
]) {
  test(`CMDK preserves ${type} location when opening a new tab`, async () => {
    const h = createHarness();
    const requested = [];
    h.app.workspace.getLeaf = (kind) => { requested.push(kind); return h.mainLeaf; };
    h.app.workspace.getMostRecentLeaf = () => { throw new Error('Shift must choose a new tab'); };
    const modal = new h.FloatSearchCmdkModal(h.plugin);
    const file = new h.TFile('note.md');
    await modal.onChooseSuggestion({ type, file, ...detail }, { shiftKey: true });
    await h.clock.microtasks();
    assert.deepEqual(requested, ['tab']);
    assert.equal(h.mainLeaf.ephemeralStates.length, 1);
    assert.deepEqual({ ...h.mainLeaf.ephemeralStates[0] }, expected);
  });
}

test('changing the query cancels a cachedRead result already in flight', async () => {
  const h = createHarness();
  const pending = deferred();
  h.app.vault.getFiles = () => [new h.TFile('ordinary.md')];
  h.app.vault.cachedRead = () => pending.promise;
  const modal = new h.FloatSearchCmdkModal(h.plugin);
  modal.onOpen();
  modal.inputEl.value = 'oldneedle';
  modal.updateSuggestions();
  await h.clock.tick(50);
  modal.inputEl.value = 'newneedle';
  modal.updateSuggestions();
  pending.resolve('oldneedle is the only match');
  await h.clock.tick(50);
  assert.equal(modal.chooser.added.length, 0, 'The earlier query must not append results to the new chooser');
  assert.deepEqual(h.clock.errors, []);
});

test('rapid CMDK selection changes keep the newest preview and suppress stale focus', async () => {
  const h = createHarness();
  const pending = deferred();
  const leaf = h.makeLeaf();
  const opened = [];
  leaf.openFile = (file) => {
    opened.push(file.path);
    return opened.length === 1 ? pending.promise : Promise.resolve();
  };
  h.leafModule.nextLeaf = leaf;
  const modal = new h.FloatSearchCmdkModal(h.plugin);
  modal.onOpen();
  const first = modal.showPreview({ type: 'heading', file: new h.TFile('old.md'), heading: 'Old' });
  await h.clock.microtasks();
  assert.deepEqual(opened, ['old.md']);
  const latest = modal.showPreview({ type: 'heading', file: new h.TFile('latest.md'), heading: 'Latest' });
  await h.clock.microtasks();
  pending.resolve();
  await Promise.all([first, latest]);
  await h.clock.microtasks();
  assert.equal(opened.at(-1), 'latest.md');
  assert.equal(modal.inputEl.focusCount, 1, 'Only the newest preview may restore input focus');
  assert.deepEqual(leaf.ephemeralStates.map((state) => state.subpath), ['#Latest']);
});

test('native search clears its preview when no result is focused', async () => {
  const h = createHarness();
  const modal = new h.FloatSearchModal(() => {}, h.plugin, { query: 'needle' });
  modal.searchLeaf = h.makeLeaf();
  modal.searchLeaf.view.dom = { focusedItem: undefined };
  await modal.initFileView(new h.TFile('previous.md'), undefined);
  const preview = h.spawned[0];
  modal.autoPreviewFocusedItem();
  assert.equal(preview.leaf.detached, true);
  assert.equal(preview.embedded.unloaded, true);
  assert.equal(modal.modalEl.hasClass('float-search-width'), false);
  assert.equal(modal.fileLeaf, undefined);
});

test('native initialization cannot change selection after closing during delayed setState', async () => {
  const h = createHarness();
  const pending = deferred();
  const leaf = h.makeLeaf();
  let setStateStarted = false;
  leaf.view.setState = () => { setStateStarted = true; return pending.promise; };
  h.leafModule.nextLeaf = leaf;
  const modal = new h.FloatSearchModal(() => {}, h.plugin, { query: 'needle' });
  await modal.initSearchView(new ElementStub());
  await h.clock.tick(0);
  assert.equal(setStateStarted, true);
  modal.onClose();
  pending.resolve();
  await h.clock.microtasks();
  assert.equal(leaf.view.searchComponent.inputEl.selectionCount || 0, 0);
  assert.deepEqual(h.clock.errors, []);
});

test('native regex adapter transforms the search query but preserves input and saved state', () => {
  const h = createHarness();
  h.plugin.settings.filterUseRegex = true;
  let rawQuery = '^alpha|beta$';
  const getValue = function () { return rawQuery; };
  const component = { getValue };
  const runs = [];
  const view = {
    searchComponent: component,
    getState() { return { query: this.searchComponent.getValue() }; },
    startSearch() {
      const search = this.searchComponent.getValue();
      const saved = this.getState().query;
      runs.push({ search, saved });
      return 'started';
    },
  };
  assert.equal(typeof h.filters.bindNativeRegexSearch, 'function');
  const cleanup = h.filters.bindNativeRegexSearch(view, h.plugin);
  assert.equal(view.startSearch(), 'started');
  assert.equal(runs[0].search, h.filters.buildNativeRegexQuery(h.plugin, rawQuery));
  assert.equal(runs[0].saved, rawQuery);
  assert.equal(component.getValue, getValue);
  assert.equal(component.getValue(), rawQuery);
  rawQuery = 'folder/note';
  view.startSearch();
  assert.equal(runs[1].search, h.filters.buildNativeRegexQuery(h.plugin, rawQuery));
  assert.equal(runs[1].saved, rawQuery);
  h.plugin.settings.filterUseRegex = false;
  view.startSearch();
  assert.equal(runs[2].search, rawQuery, 'Disabling regex must immediately restore ordinary native query syntax');
  cleanup();
  view.startSearch();
  assert.equal(runs[3].search, rawQuery, 'Unloading the modal must restore native search behavior');
  assert.equal(runs[3].saved, rawQuery);
});

test('native regex adapter restores getValue even when startSearch throws', () => {
  const h = createHarness();
  h.plugin.settings.filterUseRegex = true;
  const component = { getValue: () => 'raw-pattern' };
  const original = component.getValue;
  const view = {
    searchComponent: component,
    startSearch() { throw new Error('native search unavailable'); },
  };
  assert.equal(typeof h.filters.bindNativeRegexSearch, 'function');
  const cleanup = h.filters.bindNativeRegexSearch(view, h.plugin);
  assert.throws(() => view.startSearch(), /native search unavailable/);
  assert.equal(component.getValue, original);
  cleanup();
});

test('native regex adapter is safe on an unsupported search view', () => {
  const h = createHarness();
  assert.equal(typeof h.filters.bindNativeRegexSearch, 'function');
  assert.doesNotThrow(() => h.filters.bindNativeRegexSearch({}, h.plugin)());
  assert.doesNotThrow(() => h.filters.bindNativeRegexSearch({ startSearch() {} }, h.plugin)());
});

test('CMDK and native regex share case and multiline anchor semantics', () => {
  const h = createHarness();
  h.plugin.settings.filterUseRegex = true;
  for (const matchCase of [false, true]) {
    h.plugin.settings.filterMatchCase = matchCase;
    for (const query of ['^needle$', '^NEEDLE$', 'folder/note', 'need(le|les)', 'invalid[']) {
      const native = parseNativeRegexQuery(h.filters.buildNativeRegexQuery(h.plugin, query));
      for (const sample of ['before\nneedle\nafter', 'before\nNEEDLE\nafter', 'folder/note', 'needles', 'invalid[']) {
        // Obsidian's native regex matcher uses gm/gmi; compare observable matches.
        const nativeMatches = native.some((regex) => nativeNonemptyMatch(regex.source, sample, matchCase) !== null);
        assert.equal(h.filters.textMatches(h.plugin, sample, query), nativeMatches,
          `Mode mismatch for ${JSON.stringify({ matchCase, query, sample })}`);
      }
    }
  }
});

test('native result filtering preserves engine matches hidden by collapsed snippets', () => {
  const h = createHarness();
  h.plugin.settings.filterUseRegex = true;
  const el = new ElementStub();
  el.textContent = 'A collapsed result with no visible matching line';
  const view = {
    getState: () => ({ query: '^needle$' }),
    dom: { vChildren: { _children: [{ file: new h.TFile('ordinary.md'), el }] } },
  };
  h.filters.applyNativeResultFilters(view, h.plugin);
  assert.equal(el.style.display, '', 'Let the native engine decide regex matches instead of rechecking rendered snippets');
});

test('native result filtering still enforces file-type and bookmark restrictions', () => {
  const h = createHarness();
  const files = ['ordinary.md', 'board.canvas', 'table.base'].map((name) => new h.TFile(name));
  const children = files.map((file) => ({ file, el: new ElementStub() }));
  const view = { getState: () => ({ query: '' }), dom: { vChildren: { _children: children } } };
  h.plugin.settings.filterIncludeBases = false;
  h.plugin.settings.filterIncludeCanvas = false;
  h.filters.applyNativeResultFilters(view, h.plugin);
  assert.deepEqual(children.map((child) => child.el.style.display), ['', 'none', 'none']);
  h.plugin.settings.filterIncludeBases = true;
  h.plugin.settings.filterIncludeCanvas = true;
  h.plugin.settings.filterStarredOnly = true;
  h.app.internalPlugins = { getEnabledPluginById: () => ({ getBookmarks: () => [{ type: 'file', path: 'board.canvas' }] }) };
  h.filters.applyNativeResultFilters(view, h.plugin);
  assert.deepEqual(children.map((child) => child.el.style.display), ['none', '', 'none']);
});

function createNativeTypingView(h) {
  const component = {
    inputEl: new ElementStub(),
    getValue() { return this.inputEl.value; },
    onChange(callback) { this.changeCallback = callback; return this; },
    onChanged() { this.changeCallback?.(this.getValue()); },
  };
  const view = {
    searchComponent: component,
    infoEl: new ElementStub(),
    runs: [],
    getState() { return { query: component.getValue() }; },
    startSearch() {
      const search = component.getValue();
      this.runs.push({ search, saved: this.getState().query });
    },
  };
  // Obsidian's SearchView constructor caches a bound startSearch before a plugin
  // can patch the instance. TextComponent likewise binds onChanged early, but
  // onChanged dynamically looks up changeCallback each time it is invoked.
  const constructedStartSearch = view.startSearch.bind(view);
  const constructedOnChanged = component.onChanged.bind(component);
  let originalTimer;
  component.onChange((query) => {
    if (query) {
      h.clock.clearTimeout(originalTimer);
      originalTimer = h.clock.setTimeout(constructedStartSearch, 0);
    } else {
      view.startSearch();
    }
    view.infoEl.hide();
  });
  const originalCallback = component.changeCallback;
  return { view, component, originalCallback, type(value) {
    component.inputEl.value = value;
    constructedOnChanged();
  } };
}

test('typing through the constructor-bound native handler still submits compiled regex', async () => {
  const h = createHarness();
  h.plugin.settings.filterUseRegex = true;
  const input = createNativeTypingView(h);
  const cleanup = h.filters.bindNativeRegexSearch(input.view, h.plugin);
  input.type('alpha|beta');
  await h.clock.tick(0);
  assert.equal(input.view.runs.length, 1);
  assert.equal(input.view.runs[0].search, h.filters.buildNativeRegexQuery(h.plugin, 'alpha|beta'),
    'Typing must not bypass the adapter through the native constructor\'s cached bound method');
  assert.equal(input.view.runs[0].saved, 'alpha|beta');
  input.type('folder/note');
  await h.clock.tick(0);
  assert.equal(input.view.runs[1].search, h.filters.buildNativeRegexQuery(h.plugin, 'folder/note'));
  cleanup();
});

test('native adapter cleanup cancels pending typed search and restores the original callback', async () => {
  const h = createHarness();
  h.plugin.settings.filterUseRegex = true;
  const input = createNativeTypingView(h);
  const cleanup = h.filters.bindNativeRegexSearch(input.view, h.plugin);
  input.type('pending|regex');
  cleanup();
  assert.equal(input.component.changeCallback, input.originalCallback);
  await h.clock.tick(0);
  assert.equal(input.view.runs.length, 0, 'Closing before a debounce fires must cancel the queued search');
  input.type('normal-search');
  await h.clock.tick(0);
  assert.equal(input.view.runs.length, 1);
  assert.equal(input.view.runs[0].search, 'normal-search', 'Original input behavior resumes after cleanup');
});

test('native adapter cleanup preserves a newer change callback installed by someone else', () => {
  const h = createHarness();
  const input = createNativeTypingView(h);
  const cleanup = h.filters.bindNativeRegexSearch(input.view, h.plugin);
  const replacement = () => {};
  input.component.onChange(replacement);
  cleanup();
  assert.equal(input.component.changeCallback, replacement);
});

test('native clear-button callback clears preview and searches immediately without an input event', async () => {
  const h = createHarness();
  h.plugin.settings.filterUseRegex = true;
  const input = createNativeTypingView(h);
  let clearPreviewCount = 0;
  const cleanup = h.filters.bindNativeRegexSearch(input.view, h.plugin, () => { clearPreviewCount++; });
  // This follows TextComponent's clear-button onChanged route; no DOM input event.
  input.type('');
  assert.equal(clearPreviewCount, 1, 'The query-change hook must also run for programmatic clear');
  assert.equal(input.view.runs.length, 1, 'Empty query search should be synchronous');
  assert.equal(input.view.runs[0].search, '');
  assert.equal(input.view.infoEl.hidden, true);
  await h.clock.tick(0);
  assert.equal(input.view.runs.length, 1);
  cleanup();
});

test('plugin unload closes both the native search and CMDK modal', () => {
  const h = createHarness();
  const closed = [];
  h.default.prototype.onunload.call({
    modal: { close() { closed.push('native'); } },
    cmdkModal: { close() { closed.push('cmdk'); } },
  });
  assert.deepEqual(closed.sort(), ['cmdk', 'native']);
});

test('CMDK discards zero-length regex matches exactly like native search', () => {
  const h = createHarness();
  h.plugin.settings.filterUseRegex = true;
  for (const matchCase of [true, false]) {
    h.plugin.settings.filterMatchCase = matchCase;
    for (const query of ['^', '$', String.raw`\b`, '(?=needle)', 'a*', 'needle|$', '(?:|needle)']) {
      for (const text of ['', 'baaa', 'needle', 'first\nneedle\nlast', 'BAAA']) {
        const expected = nativeNonemptyMatch(query, text, matchCase);
        const actual = h.filters.matchAsSearchResult(h.plugin, text, query);
        assert.equal(actual !== null, expected !== null,
          `Zero-width parity mismatch for ${JSON.stringify({ query, text, matchCase })}`);
        if (expected) {
          assert.equal(actual.matches[0][0], expected.index);
          assert.equal(actual.matches[0][1], expected.index + expected[0].length);
        }
      }
    }
  }
  h.plugin.settings.filterMatchCase = false;
  const afterEmpty = h.filters.matchAsSearchResult(h.plugin, 'baaa', 'a*');
  assert.deepEqual(Array.from(afterEmpty.matches[0]), [1, 4], 'Skip the empty match at zero and find the later nonempty run');
  assert.equal(h.filters.matchAsSearchResult(h.plugin, 'needle', '^'), null);
});

test('native match-case synchronization uses its dedicated setter without resetting view state', () => {
  const h = createHarness();
  const modal = new h.FloatSearchModal(() => {}, h.plugin, { query: 'needle' });
  const calls = [];
  let matchingCase = false;
  const view = {
    getState: () => ({ query: 'needle', matchingCase }),
    setMatchingCase(value) { calls.push(value); matchingCase = value; },
    setState() { throw new Error('setState would trigger the existing modal-opening hook'); },
  };
  h.plugin.settings.filterMatchCase = true;
  modal.syncNativeMatchCase(view);
  assert.deepEqual(calls, [true]);
  assert.equal(matchingCase, true);
  modal.syncNativeMatchCase(view);
  assert.deepEqual(calls, [true], 'An unchanged match-case setting needs no new setter call');
  h.plugin.settings.filterMatchCase = false;
  modal.syncNativeMatchCase(view);
  assert.deepEqual(calls, [true, false]);
});

test('native initialization applies the filter match-case setting to initial and delayed state', async () => {
  const h = createHarness();
  h.plugin.settings.filterMatchCase = true;
  const leaf = h.makeLeaf();
  const delayed = [];
  leaf.view.setState = async (state) => { delayed.push(state); };
  h.leafModule.nextLeaf = leaf;
  const modal = new h.FloatSearchModal(() => {}, h.plugin, { query: '^Needle$', matchingCase: false });
  await modal.initSearchView(new ElementStub());
  assert.equal(leaf.viewStates[0].state.matchingCase, true);
  assert.equal(leaf.viewStates[0].state.query, '^Needle$');
  await h.clock.tick(0);
  assert.equal(delayed[0].matchingCase, true);
  assert.equal(delayed[0].query, '^Needle$');
});

test('clearing native search cancels an earlier typed debounce', async () => {
  const h = createHarness();
  const input = createNativeTypingView(h);
  let cleared = 0;
  const cleanup = h.filters.bindNativeRegexSearch(input.view, h.plugin, () => { cleared++; });
  input.type('waiting');
  input.type('');
  assert.equal(cleared, 2);
  assert.equal(input.view.runs.length, 1);
  assert.equal(input.view.runs[0].search, '');
  await h.clock.tick(0);
  assert.equal(input.view.runs.length, 1, 'The cancelled typed query must not run after the clear action');
  cleanup();
});

test('native match-case fallback state marks the update as plugin-originated', () => {
  const h = createHarness();
  h.plugin.settings.filterMatchCase = true;
  const modal = new h.FloatSearchModal(() => {}, h.plugin, { query: 'needle' });
  const updates = [];
  const view = {
    getState: () => ({ query: 'needle', matchingCase: false }),
    setState(state) { updates.push(state); },
  };
  modal.syncNativeMatchCase(view);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].matchingCase, true);
  assert.equal(updates[0].triggerBySelf, true, 'The legacy fallback must not reopen the floating modal');
  assert.equal(updates[0].query, 'needle');
});

test('native modal wires clear-button changes to preview cleanup and clears old result focus', async () => {
  const h = createHarness();
  const input = createNativeTypingView(h);
  input.view.containerEl = new ElementStub();
  input.view.dom = { focusedItem: null, setFocusedItem(item) { this.focusedItem = item; } };
  input.view.setMatchingCase = () => {};
  const modal = new h.FloatSearchModal(() => {}, h.plugin, { query: 'needle' });
  modal.searchLeaf = h.makeLeaf();
  modal.searchLeaf.view = input.view;
  modal.searchCtnEl = new ElementStub();
  modal.searchEmbeddedView = { unload() {} };
  modal.initFilterBar();
  const file = new h.TFile('previous.md');
  await modal.initFileView(file, undefined);
  const previewLeaf = h.spawned[0].leaf;
  input.view.dom.focusedItem = { file };
  modal.debouncedAutoPreview();
  input.type('');
  assert.equal(previewLeaf.detached, true, 'Programmatic clearing must detach the existing preview');
  assert.equal(input.view.dom.focusedItem, null, 'A new query cannot retain a selectable stale result');
  await h.clock.tick(250);
  assert.equal(h.spawned.length, 1, 'Cancelled auto-preview must not recreate a stale preview');
  assert.deepEqual(h.clock.errors, []);
  modal.onClose();
});

for (const reusePreview of [false, true]) {
  test(`CMDK keeps ${reusePreview ? 'an existing' : 'a new'} preview hidden until openFile finishes`, async () => {
    const h = createHarness();
    const modal = new h.FloatSearchCmdkModal(h.plugin);
    modal.onOpen();
    let leaf;
    if (reusePreview) {
      await modal.showPreview({ type: 'file', file: new h.TFile('old.md') });
      leaf = h.spawned[0].leaf;
      assert.equal(modal.previewEl.hidden, false);
    } else {
      leaf = h.makeLeaf();
      h.leafModule.nextLeaf = leaf;
    }
    const pending = deferred();
    let started = false;
    leaf.openFile = () => { started = true; return pending.promise; };
    const loading = modal.showPreview({ type: 'file', file: new h.TFile('new.md') });
    if (reusePreview) assert.equal(modal.previewEl.hidden, true, 'Hide the old content as soon as the new selection starts');
    await h.clock.microtasks();
    assert.equal(started, true);
    assert.equal(modal.previewEl.hidden, true, 'Loading must not reveal the old file or an unfinished preview');
    pending.resolve();
    await loading;
    assert.equal(modal.previewEl.hidden, false);
    assert.equal(modal.modalEl.hasClass('float-search-cmdk-expanded'), true);
  });
}

test('a preview invalidated by an empty result set never becomes visible when its read finishes', async () => {
  const h = createHarness();
  const modal = new h.FloatSearchCmdkModal(h.plugin);
  modal.onOpen();
  const leaf = h.makeLeaf();
  const pending = deferred();
  leaf.openFile = () => pending.promise;
  h.leafModule.nextLeaf = leaf;
  const loading = modal.showPreview({ type: 'file', file: new h.TFile('late.md') });
  await h.clock.microtasks();
  const previewEl = modal.previewEl;
  let lateShows = 0;
  const originalShow = previewEl.show.bind(previewEl);
  previewEl.show = () => { lateShows++; originalShow(); };
  modal.inputEl.value = 'no-results';
  modal.updateSuggestions();
  pending.resolve();
  await loading;
  assert.equal(lateShows, 0);
  assert.equal(previewEl.hidden, true);
  assert.equal(modal.modalEl.hasClass('float-search-cmdk-expanded'), false);
});
