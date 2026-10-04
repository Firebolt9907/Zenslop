import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

globalThis.JSWindowActorChild = class {};
let referencedSource;
globalThis.ChromeUtils = {
  importESModule: () => ({ ContentDOMReference: { resolve: () => referencedSource } }),
};
const { ZenSidebarNativeChild } = await import('../native-actor.sys.mjs');

function receiver() {
  const timers = new Map();
  const listeners = new Map();
  let timerId = 0;
  const win = {
    setTimeout(fn) { timers.set(++timerId, fn); return timerId; },
    clearTimeout(id) { timers.delete(id); },
    addEventListener(name, fn) { listeners.set(name, fn); },
    removeEventListener(name) { listeners.delete(name); },
    windowGlobalChild: { innerWindowId: 42 },
  };
  let target;
  const doc = {
    documentURI: 'about:blank', hidden: true, defaultView: win,
    nodePrincipal: { originAttributes: { userContextId: 2, privateBrowsingId: 0 } },
    body: { style: {}, appendChild(node) { node.isConnected = true; } },
    createElement() {
      target = {
        style: {}, isConnected: false, mozPaintedFrames: 0,
        requestVideoFrameCallback(fn) { this.frameCallback = fn; return 7; },
        cancelVideoFrameCallback() { this.frameCallback = null; },
        getBoundingClientRect: () => ({ width: 320, height: 180 }),
        remove() { this.isConnected = false; source.isCloningElementVisually = false; },
      };
      return target;
    },
  };
  const source = referencedSource = {
    isConnected: true, localName: 'video', ownerDocument: doc,
    currentSrc: 'video.webm', srcObject: null, currentTime: 10, paused: false,
    isCloningElementVisually: false,
    cloneElementVisually(node) {
      assert.equal(node, target);
      this.isCloningElementVisually = true;
      return Promise.resolve();
    },
    stopCloningElementVisually() { assert.fail('Must not stop unrelated source clones'); },
  };
  const actor = new ZenSidebarNativeChild();
  actor.document = doc;
  actor.contentWindow = win;
  const start = (sessionId = 1) => actor.receiveMessage({ name: 'ZenPiP:NativeStart',
    data: { sessionId, documentId: 42, videoRef: { id: 1 } } });
  const health = (sessionId = 1) => actor.receiveMessage({ name: 'ZenPiP:NativeHealth', data: { sessionId } });
  return { actor, source, doc, timers, listeners, start, health, get target() { return target; } };
}

test('native receiver shares output, proves a frame, and releases only its target', () => {
  const r = receiver();
  assert.equal(r.start().started, true);
  assert.equal(r.target.muted, true);
  assert.equal(r.health().presented, false);
  r.target.frameCallback();
  assert.equal(r.health().presented, true);
  r.actor.didDestroy();
  assert.equal(r.target.isConnected, false);
  assert.equal(r.source.paused, false);
  assert.equal(r.timers.size, 0);
  assert.equal(r.listeners.size, 0);
});

test('existing user PiP is left untouched', () => {
  const r = receiver();
  r.source.isCloningElementVisually = true;
  assert.throws(r.start, /already has a PiP clone/);
  assert.equal(r.source.isCloningElementVisually, true);
});

test('expired references, visible sources, and unexpected receiver documents are rejected', () => {
  const r = receiver();
  r.doc.defaultView.windowGlobalChild.innerWindowId = 43;
  assert.throws(r.start, /reference expired/);
  r.doc.defaultView.windowGlobalChild.innerWindowId = 42;
  r.doc.hidden = false;
  assert.throws(r.start, /visible/);
  r.doc.hidden = true;
  r.doc.documentURI = 'https://example.com/';
  assert.throws(r.start, /about:blank/);
});

test('container/private mismatches cannot attach native output', () => {
  const r = receiver();
  r.source.ownerDocument = { ...r.doc,
    nodePrincipal: { originAttributes: { userContextId: 3, privateBrowsingId: 1 } } };
  assert.throws(r.start, /context differs/);
});

test('stale stop and attachment rejection cannot affect a replacement session', async () => {
  const r = receiver();
  let rejectAttachment;
  r.source.cloneElementVisually = () => {
    r.source.isCloningElementVisually = true;
    return new Promise((_, reject) => { rejectAttachment = reject; });
  };
  r.start(1);
  const rejectOld = rejectAttachment;
  r.start(2);
  rejectOld(new Error('late old attachment failure'));
  await Promise.resolve();
  r.actor.receiveMessage({ name: 'ZenPiP:NativeStop', data: { sessionId: 1 } });
  assert.equal(r.health(2).ok, true);
  r.actor.didDestroy();
});

test('navigation, source replacement, and source visibility end the native session', () => {
  const r = receiver();
  r.start();
  r.source.currentSrc = 'replacement.webm';
  assert.equal(r.health().ok, false);
  r.source.currentSrc = 'video.webm';
  r.doc.hidden = false;
  assert.equal(r.health().ok, false);
  r.doc.hidden = true;
  r.listeners.get('pagehide')();
  assert.equal(r.health().ok, false);
});

// Execute the real controller's renderer functions with mocked browser plumbing.
// This checks the canvas/native handoff, rather than duplicating its algorithm.
const main = await readFile(new URL('../main.uc.js', import.meta.url), 'utf8');
const rendering = main.slice(main.indexOf('  const availableSources = new Map();'),
  main.indexOf('  const captionsPrefObserver ='));
const notify = main.slice(main.indexOf('  function _notifyTickState()'),
  main.indexOf('  function awaitNextPipWindow()'));

function controller({ processMismatch = false, failure = false, mode = 'auto' } = {}) {
  const attrs = { userContextId: 2, privateBrowsingId: 0 };
  const global = { innerWindowId: 42, domProcess: { childID: 9, remoteType: 'web' },
    documentPrincipal: { originAttributes: attrs } };
  const bc = { id: 1, currentWindowGlobal: global, group: { id: 8 } };
  bc.top = bc;
  const canvas = { isConnected: true, remove() { this.isConnected = false; } };
  const calls = [];
  const browser = {
    setAttribute() {}, remove() { calls.push('receiver removed'); }, loadURI() {},
    browsingContext: { currentWindowGlobal: {
      ...global,
      domProcess: { childID: processMismatch ? 10 : 9 },
      getActor: () => ({
        sendQuery(name) {
          calls.push(name);
          if (name === 'ZenPiP:NativeReady') return Promise.resolve({ ready: true });
          if (name === 'ZenPiP:NativeStart' && failure) return Promise.reject(new Error('clone busy'));
          return Promise.resolve({ ok: true, presented: true, width: 320, height: 180 });
        },
        sendAsyncMessage(name) { calls.push(name); },
      }),
    } },
  };
  const context = vm.createContext({
    setTimeout, clearTimeout, Date, Promise,
    sourceBC: bc, isStreaming: true, userHidden: false, sourceTabActive: false,
    browserWindowActive: true, captionMode: 'youtube', captionsWhenPipHidden: false,
    safe: fn => { try { return fn(); } catch {} }, warn() {}, log() {},
    getMediaPlayerVisibility: () => ({ visible: true, opacity: 1 }),
    canvasEl: canvas,
    pipContainer: { insertBefore() {}, appendChild(node) { node.isConnected = true; } },
    document: { createXULElement: () => browser },
    window: { addEventListener() {} },
    gBrowser: { tabs: [{ linkedBrowser: { browsingContext: bc, frameLoader: {} } }] },
    Services: {
      prefs: { addObserver() {}, removeObserver() {}, getStringPref: () => mode },
      io: { newURI: value => value },
      scriptSecurityManager: { getSystemPrincipal: () => ({}) },
    },
    RENDERER_PREF: 'mod.zenslop.renderer',
  });
  vm.runInContext(rendering + notify + `
    nativeSources.set(sourceBC.id, { videoRef: { id: 1 }, documentId: 42 });
    actorRegistry.set(sourceBC.id, {
      setProcessingActive: (...args) => captureState = args,
      startTick: () => ticking = true, stopTick: () => ticking = false,
    });
    globalThis.inspect = () => ({ ready: !!nativeSession?.ready,
      fallback: nativeFallbackReason, ticking, captureState });
    globalThis.begin = _notifyTickState;
    globalThis.hide = () => { userHidden = true; _notifyTickState(); };
    globalThis.switchSource = () => {
      const previous = sourceBC;
      sourceBC = { ...previous, id: 2 };
      sourceBC.top = sourceBC;
      gBrowser.tabs = [{ linkedBrowser: { browsingContext: sourceBC, frameLoader: {} } }];
      nativeSources.set(2, { videoRef: { id: 2 }, documentId: 42 });
      actorRegistry.set(2, actorRegistry.get(previous.id));
      _notifyTickState();
    };
  `, context);
  return { context, calls, canvas, async settle() {
    for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
  } };
}

test('native presentation stops pixel ticks but keeps captions; hide restores canvas', async () => {
  const c = controller();
  try {
    c.context.begin();
    await c.settle();
    assert.equal(c.context.inspect().ready, true);
    assert.equal(c.context.inspect().ticking, false);
    assert.equal(c.context.inspect().captureState[2], true);
    assert.equal(c.canvas.isConnected, false);
    c.context.hide();
    assert.equal(c.canvas.isConnected, true);
    assert.equal(c.context.inspect().ready, false);
    assert.ok(c.calls.includes('ZenPiP:NativeStop'));
  } finally { c.context.hide(); }
});

for (const [label, options] of [
  ['clone conflict', { failure: true }],
  ['receiver process mismatch', { processMismatch: true }],
]) {
  test(`${label} keeps canvas running without retrying every visibility update`, async () => {
    const c = controller(options);
    try {
      c.context.begin();
      await c.settle();
      assert.equal(c.context.inspect().ready, false);
      assert.equal(c.context.inspect().ticking, true);
      assert.ok(c.context.inspect().fallback);
      const count = c.calls.length;
      c.context.begin();
      assert.equal(c.calls.length, count);
      assert.equal(c.canvas.isConnected, true);
    } finally { c.context.hide(); }
  });
}

test('canvas preference bypasses native receiver setup', () => {
  const c = controller({ mode: 'canvas' });
  c.context.begin();
  assert.equal(c.calls.length, 0);
  assert.equal(c.context.inspect().ticking, true);
  c.context.hide();
});

test('hiding during async startup cancels the receiver before attachment', async () => {
  const c = controller();
  c.context.begin();
  c.context.hide();
  await c.settle();
  assert.equal(c.context.inspect().ready, false);
  assert.equal(c.canvas.isConnected, true);
  assert.equal(c.calls.includes('ZenPiP:NativeStart'), false);
});

test('switching sources during startup cannot commit the old receiver', async () => {
  const c = controller();
  try {
    c.context.begin();
    c.context.switchSource();
    await c.settle();
    assert.equal(c.context.inspect().ready, true);
    assert.equal(c.calls.filter(name => name === 'ZenPiP:NativeStart').length, 1);
    assert.ok(c.calls.includes('ZenPiP:NativeStop'));
    assert.equal(c.canvas.isConnected, false);
  } finally { c.context.hide(); }
});
