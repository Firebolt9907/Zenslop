import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const main = await readFile(new URL('../main.uc.js', import.meta.url), 'utf8');
const selectors = main.slice(main.indexOf('  const MUSIC_PLAYER_SELECTORS ='),
  main.indexOf('  const PIP_BUTTON_SELECTORS ='));
const layout = main.slice(main.indexOf('  let lastTabListHeight ='),
  main.indexOf('  function schedule()'));

function fixture({ innerMissing = false, wrapperContainsControls = false } = {}) {
  const mutations = [];
  const node = (id, rect) => ({
    id, isConnected: true, style: {
      setProperty(key, value) { this[key] = value; },
      removeProperty(key) {
        delete this[key];
        delete this[key.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())];
      },
    },
    attrs: new Map(),
    setAttribute(key, value) { this.attrs.set(key, value); mutations.push([id, key]); },
    removeAttribute(key) { this.attrs.delete(key); },
    hasAttribute(key) { return this.attrs.has(key); },
    getBoundingClientRect: rect,
    contains(other) { return other === this; },
    querySelectorAll: () => [],
    offsetParent: {},
  });
  const strip = node('tabbrowser-tabs', () => ({ top: 100, left: 8, width: 280, height: 700 }));
  const wrapper = node('zen-tabs-wrapper', () => ({ top: 100, left: 8, width: 280, height: 700 }));
  const scroll = node('tabbrowser-arrowscrollbox', wrapper.getBoundingClientRect);
  const media = node('zen-media-controls-toolbar', () => {
    // Reproduce the old feedback: shrinking the outer tab strip shifts the
    // toolbar upwards; sizing its inner viewport leaves the strip unchanged.
    const forced = parseFloat(strip.style['--zenslop-tab-list-height']);
    return { top: Number.isFinite(forced) ? 100 + forced : 800,
      left: 8, width: 280, height: 40 };
  });
  wrapper.contains = other => other === wrapper || (wrapperContainsControls && other === media);
  strip.contains = other => [strip, wrapper, scroll, media].includes(other);
  const foot = node('zen-sidebar-foot-buttons', () => ({ top: 850, left: 8, width: 280, height: 40 }));
  const downloads = node('zen-library-download-list', () => ({ top: 620, left: 8, width: 280, height: 230 }));
  const library = node('zen-library', () => ({}));
  const toolbox = node('navigator-toolbox', () => ({ left: 0, top: 0 }));
  toolbox.computed = { opacity: '1', transform: 'none', transformOrigin: '150px 450px' };
  downloads.computed = { display: 'flex', visibility: 'visible', opacity: '1' };
  const nodes = [strip, ...(!innerMissing ? [wrapper, scroll] : []), media, foot, downloads, toolbox];
  const querySelector = selector => {
    if (selector === 'zen-library[open]') return library.hasAttribute('open') ? library : null;
    // Match browser semantics: selector lists select in DOCUMENT order.
    const ids = selector.split(',').map(part => part.trim().replace(/^#/, ''));
    return nodes.find(item => ids.includes(item.id)) || null;
  };
  const context = vm.createContext({
    CONFIG: { GAP: 6, TAB_LIST_GAP: 6, ELEVATED_HOLD_MS: 180,
      TOP_SPIKE_MAX: 32, DOWN_HOLD_MS: 400, ANIM_TAIL_MS: 350 },
    document: { querySelector, getElementById: id => nodes.find(n => n.id === id) || null },
    window: { getComputedStyle: item => item.computed || {
      display: 'flex', visibility: 'visible', opacity: '1', position: 'relative',
    } },
    musicPlayerUI: media, performance: { now: () => 1000 },
    isStreaming: true, userHidden: false, sourceTabActive: false,
    browserWindowActive: true, captionMode: 'off', captionsWhenPipHidden: false,
    scheduled: false, animating: false, hoverActive: false, activeUntil: 0,
    lastVisible: null, lastOpacity: NaN, lastCaptionOpacity: NaN,
    lastElevatedTop: null, lastElevatedAt: 0, lastCommittedMediaTop: null, pendingDownAt: 0,
    videoAspect: 16 / 9, captureMaxDimension: -1, sourceBC: null,
    lastTop: -1, lastLeft: -1, lastWidth: -1, captionText: '',
    pipContainer: node('pip', () => ({})), captionContainer: node('caption', () => ({})),
    libraryMotionLayer: node('motion', () => ({})),
    DOMMatrixReadOnly: class {
      constructor(transform = '') {
        this.a = this.d = transform.startsWith('scale(') ? parseFloat(transform.slice(6)) : 1;
        this.e = transform.startsWith('translateX(') ? parseFloat(transform.slice(11)) : 0;
        this.f = 0;
      }
    },
    _notifyTickState() {}, schedule() {},
  });
  vm.runInContext(selectors + layout + `
    globalThis.target = getTabListTarget;
    globalThis.sync = syncPosition;
    globalThis.clear = clearTabListHeight;
    globalThis.edge = () => getMediaTopEdge(true).top;
  `, context);
  return { context, strip, wrapper, scroll, media, foot, downloads, library, toolbox, mutations };
}

test('explicit selector priority picks the inner viewport instead of the earlier outer strip', () => {
  const f = fixture();
  assert.equal(f.context.target(), f.wrapper);
  f.context.sync();
  assert.equal(f.wrapper.hasAttribute('zenslop-tab-list-sized'), true);
  assert.equal(f.strip.hasAttribute('zenslop-tab-list-sized'), false);
});

test('repeated layout measurements do not pull media controls towards the top', () => {
  const f = fixture();
  for (let i = 0; i < 30; i++) f.context.sync();
  assert.equal(f.media.getBoundingClientRect().top, 800);
  assert.equal(f.context.pipContainer.style.width, '280px');
  assert.equal(f.context.pipContainer.style.top, '636.5px');
  assert.equal(f.wrapper.style['--zenslop-tab-list-height'], '530px');
  assert.equal(f.mutations.filter(([id]) => id === 'tabbrowser-tabs').length, 0);
});

test('unknown tab layouts leave the outer strip alone', () => {
  const f = fixture({ innerMissing: true });
  f.context.sync();
  assert.equal(f.context.target(), null);
  assert.equal(f.mutations.length, 0);
});

test('a viewport containing media controls is rejected', () => {
  const f = fixture({ wrapperContainsControls: true });
  assert.equal(f.context.target(), f.scroll);
});

test('Library hover positions preview above downloads without moving playback controls', () => {
  const f = fixture();
  f.foot.setAttribute('zen-library-stack-open', 'true');
  f.context.sync();
  assert.equal(f.context.edge(), 620);
  assert.equal(f.context.pipContainer.style.top, '456.5px');
  assert.equal(f.media.getBoundingClientRect().top, 800);
  f.foot.removeAttribute('zen-library-stack-open');
  f.context.sync();
  assert.equal(f.context.edge(), 800);
  assert.equal(f.context.pipContainer.style.top, '636.5px', 'Return starts immediately, without either hold timer');
  assert.equal(f.media.getBoundingClientRect().top, 800);
});

test('hidden downloads do not alter the anchor, and eye toggle releases tab reservation', () => {
  const f = fixture();
  f.foot.setAttribute('zen-library-stack-open', 'true');
  f.downloads.computed.visibility = 'hidden';
  f.context.sync();
  assert.equal(f.context.edge(), 800);
  f.context.userHidden = true;
  f.context.sync();
  assert.equal(f.wrapper.hasAttribute('zenslop-tab-list-sized'), false);
  assert.equal(f.wrapper.style['--zenslop-tab-list-height'], undefined);
  assert.equal(f.media.getBoundingClientRect().top, 800);
});

test('opening Library hides preview and captions and releases tab space until it closes', () => {
  const f = fixture();
  f.context.captionMode = 'youtube';
  f.context.sync();
  assert.equal(f.context.pipContainer.style.visibility, 'visible');
  f.library.setAttribute('open', 'true');
  f.context.sync();
  assert.equal(f.context.pipContainer.style.visibility, 'hidden');
  assert.equal(f.context.captionContainer.style.visibility, 'hidden');
  assert.equal(f.wrapper.hasAttribute('zenslop-tab-list-sized'), false);
  f.library.removeAttribute('open');
  f.context.sync();
  assert.equal(f.context.pipContainer.style.visibility, 'visible');
});

test('Library preview follows toolbox fade and scale around the same screen pivot', () => {
  const f = fixture();
  f.context.sync();
  const top = f.context.pipContainer.style.top;
  f.library.openProgress = 0.1;
  f.library.setAttribute('open', 'true');
  f.toolbox.computed.opacity = '0.7';
  f.toolbox.computed.transform = 'scale(0.988)';
  f.toolbox.getBoundingClientRect = () => ({ left: 1.8, top: 5.4 });
  f.context.sync();
  assert.equal(f.context.libraryMotionLayer.style.opacity, '0.7');
  assert.equal(f.context.pipContainer.style.opacity, '1');
  assert.equal(f.context.pipContainer.style.visibility, 'visible');
  assert.equal(f.context.libraryMotionLayer.style.transform, 'scale(0.988)');
  assert.equal(f.context.libraryMotionLayer.style.transformOrigin, '150px 450px');
  assert.equal(f.context.pipContainer.style.top, top, 'Do not remeasure transformed controls');
  f.library.openProgress = 1;
  f.context.sync();
  assert.equal(f.context.pipContainer.style.visibility, 'hidden');
  f.library.openProgress = 0.1;
  f.context.sync();
  assert.equal(f.context.pipContainer.style.visibility, 'visible', 'Fade back during closing');
  f.library.removeAttribute('open');
  f.context.sync();
  assert.equal(f.context.pipContainer.style.opacity, '1');
  assert.equal(f.context.libraryMotionLayer.style.transform, undefined);
  assert.equal(f.context.libraryMotionLayer.style.opacity, undefined);
});

test('compact Library movement follows toolbox translation in either direction', () => {
  for (const offset of [-150, 150]) {
    const f = fixture();
    f.context.sync();
    f.library.openProgress = 0.2;
    f.library.setAttribute('open', 'true');
    f.toolbox.computed.transform = `translateX(${offset}px)`;
    f.toolbox.getBoundingClientRect = () => ({ left: offset, top: 0 });
    f.context.sync();
    assert.equal(f.context.libraryMotionLayer.style.transform, `translateX(${offset}px)`);
    assert.equal(f.context.pipContainer.style.opacity, '1', 'Compact mode moves without an added fade');
    assert.equal(f.context.libraryMotionLayer.style.transformOrigin, '150px 450px');
  }
});
