const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness, deferred, ElementStub } = require('./harness.cjs');

function parseNativeRegexQuery(query) {
  // A small parser for the intended Obsidian content-regex OR path-regex query.
  // Unlike splitting on '/', this also validates escaped slash delimiters.
  function takeLiteral(input) {
    assert.equal(input[0], '/', 'A native regex must start with a slash');
    let escaped = false;
    for (let index = 1; index < input.length; index++) {
      if (escaped) { escaped = false; continue; }
      if (input[index] === '\\') { escaped = true; continue; }
      if (input[index] === '/') {
        const literal = input.slice(0, index + 1);
        return { regex: require('node:vm').runInNewContext(literal), rest: input.slice(index + 1) };
      }
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
  for (const query of ['alpha|beta', 'folder/note', String.raw`folder\/note`, '[a-z]+', '']) {
    const nativeQuery = h.filters.buildNativeRegexQuery(h.plugin, query);
    if (!query) { assert.equal(nativeQuery, ''); continue; }
    const compiled = parseNativeRegexQuery(nativeQuery);
    for (const regex of compiled) {
      assert.equal(regex.source, new RegExp(query).source, 'Native and CMDK patterns must retain the same meaning');
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
  cleanup();
  view.startSearch();
  assert.equal(runs[2].search, rawQuery, 'Unloading the modal must restore native search behavior');
  assert.equal(runs[2].saved, rawQuery);
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
        const nativeMatches = native.some((regex) => new RegExp(regex.source, matchCase ? 'gm' : 'gmi').test(sample));
        assert.equal(h.filters.textMatches(h.plugin, sample, query), nativeMatches,
          `Mode mismatch for ${JSON.stringify({ matchCase, query, sample })}`);
      }
    }
  }
});
