// ==UserScript==
// @name           Zenslop
// @version        0.1.0
// @description    Hooks into Zen's sidebar to render active video streams.
// ==/UserScript==

(function () {
  if (window.__zenslopLoaded) return;
  window.__zenslopLoaded = true;

  const LOG_PREFIX = "[Zenslop]";
  const log = (...a) => console.log(LOG_PREFIX, ...a);
  const warn = (...a) => console.warn(LOG_PREFIX, ...a);
  const err = (...a) => console.error(LOG_PREFIX, ...a);
  const safe = (fn) => {
    try {
      return fn();
    } catch (_) {
      return undefined;
    }
  };

  const CONFIG = Object.freeze({
    GAP: 6,
    TAB_LIST_GAP: 6,
    ANIM_MS: 220,
    LAYOUT_ANIM_MS: 180,
    CAPTION_ANIM_MS: 180,
    CAPTION_GAP_GRACE_MS: 1000,
    ANIM_TAIL_MS: 350,
    ELEVATED_HOLD_MS: 180,
    // A downward move of the player's top edge larger than this (px) is only
    // committed after the lower edge holds stable for DOWN_HOLD_MS. YouTube's
    // controls make the measured edge oscillate for a few seconds after a
    // fast-forward into buffered content while hovered; this asymmetric hold
    // lets the PiP rise instantly but resists transient drops.
    TOP_SPIKE_MAX: 32,
    DOWN_HOLD_MS: 400,
    MAX_HEIGHT: 600,
    DEFAULT_ASPECT: 16 / 9,
    PIP_OPEN_DEBOUNCE_MS: 1500,
    PIP_OBSERVE_TIMEOUT_MS: 3000,
  });
  const LAYOUT_TRANSITION =
    `top ${CONFIG.LAYOUT_ANIM_MS}ms ease-out, ` +
    `left ${CONFIG.LAYOUT_ANIM_MS}ms ease-out, ` +
    `width ${CONFIG.LAYOUT_ANIM_MS}ms ease-out, ` +
    `height ${CONFIG.LAYOUT_ANIM_MS}ms ease-out`;
  const ANIM_TRANSITION =
    `opacity ${CONFIG.ANIM_MS}ms ease, ` +
    `transform ${CONFIG.ANIM_MS}ms ease, ${LAYOUT_TRANSITION}`;

  const MUSIC_PLAYER_SELECTORS =
    "#zen-media-controls-toolbar, .zen-sidebar-bottom-buttons";
  const TAB_LIST_SELECTORS =
    "#zen-tabs-wrapper, #tabbrowser-arrowscrollbox, #tabbrowser-tabs";
  const PIP_BUTTON_SELECTORS = [
    '[id*="pictureinpicture" i]',
    '[class*="pictureinpicture" i]',
    '[command*="pictureinpicture" i]',
    '[id*="pip" i]',
    '[class*="pip" i]',
    '[anonid*="pictureinpicture" i]',
  ].join(",");

  const musicPlayerUI = document.querySelector(MUSIC_PLAYER_SELECTORS);
  if (!musicPlayerUI) {
    err("Could not find the music player UI.");
    return;
  }

  const styleEl = document.createElement("style");
  styleEl.textContent = `
    #zen-sidebar-pip-container {
      position: fixed;
      background: transparent;
      display: none;
      border-radius: var(--zen-border-radius);
      overflow: hidden;
      contain: strict;
      z-index: 10;
      pointer-events: none;
      transform-origin: 50% 100%;
      transition: ${LAYOUT_TRANSITION};
      will-change: opacity, transform, top, left, width, height;
    }
    #zen-sidebar-pip-container::after {
      content: "";
      position: absolute;
      inset: 0;
      border-radius: inherit;
      box-shadow: inset 0 0 0 1px color-mix(in srgb, white 8%, transparent);
      z-index: 1;
      pointer-events: none;
    }
    #zen-sidebar-pip-container > canvas {
      width: 100%;
      height: 100%;
      max-width: 100%;
      max-height: 100%;
      min-width: 0;
      min-height: 0;
      object-fit: contain;
      display: block;
    }
    #zen-sidebar-pip-caption {
      position: fixed;
      display: none;
      box-sizing: border-box;
      padding: 7px 10px;
      color: white;
      background: color-mix(in srgb, black 78%, transparent);
      border: 1px solid color-mix(in srgb, white 8%, transparent);
      border-radius: var(--zen-border-radius);
      box-shadow: 0 3px 12px rgb(0 0 0 / 28%);
      font: 600 12px/1.35 system-ui, sans-serif;
      text-align: center;
      text-wrap: balance;
      overflow-wrap: anywhere;
      max-height: calc(4.05em + 14px);
      overflow: hidden;
      z-index: 11;
      pointer-events: none;
      opacity: 0;
      transform: translateY(4px) scale(0.96);
      transform-origin: 50% 100%;
      transition: opacity ${CONFIG.CAPTION_ANIM_MS}ms ease,
                  transform ${CONFIG.CAPTION_ANIM_MS}ms ease,
                  top ${CONFIG.LAYOUT_ANIM_MS}ms ease-out;
      will-change: opacity, transform, top;
    }
    #zen-sidebar-pip-caption[zenslop-caption-visible="true"] {
      opacity: var(--zenslop-caption-opacity, 1);
      transform: translateY(0) scale(1);
    }
    [zenslop-tab-list-sized="true"] {
      box-sizing: border-box !important;
      min-height: 0 !important;
      height: var(--zenslop-tab-list-height) !important;
      max-height: var(--zenslop-tab-list-height) !important;
      flex: 0 1 var(--zenslop-tab-list-height) !important;
      padding-bottom: 0 !important;
    }
    .zen-sidebar-pip-toggle {
      flex: 0 0 auto;
      max-width: 24px !important;
      max-height: 24px !important;
      width: 24px !important;
      height: 24px !important;
      margin: 0 2px !important;
      padding: 0 !important;
      box-sizing: border-box !important;
    }
    .zen-media-card:not([can-pip]) .zen-sidebar-pip-toggle {
      display: none !important;
    }
    [zenslop-parked="true"] {
      display: none !important;
      visibility: collapse !important;
      width: 0 !important;
      height: 0 !important;
      margin: 0 !important;
      padding: 0 !important;
      border: none !important;
    }
  `;
  document.documentElement.appendChild(styleEl);

  const pipContainer = document.createElement("div");
  pipContainer.id = "zen-sidebar-pip-container";
  const canvasEl = document.createElement("canvas");
  const canvasCtx = canvasEl.getContext("2d", {
    alpha: false,
    desynchronized: true,
  });
  pipContainer.appendChild(canvasEl);
  document.documentElement.appendChild(pipContainer);

  const captionContainer = document.createElement("div");
  captionContainer.id = "zen-sidebar-pip-caption";
  captionContainer.setAttribute("aria-live", "off");
  document.documentElement.appendChild(captionContainer);

  let lastTop = -1,
    lastLeft = -1,
    lastWidth = -1;
  let lastVisible = null;
  let lastOpacity = NaN;
  let isStreaming = false;
  let userHidden = false;
  let scheduled = false;
  let activeUntil = 0;
  let hoverActive = false;
  let lastElevatedTop = null;
  let lastElevatedAt = 0;
  let lastCommittedMediaTop = null;
  let pendingDownAt = 0;
  let animating = false;
  let animateOutTimer = null;
  let videoAspect = CONFIG.DEFAULT_ASPECT;
  let captionText = "";
  let captionHideTimer = null;
  let captionExitTimer = null;
  let browserWindowActive = true;
  let captureMaxDimension = -1;

  function setCanvasDimensions(w, h) {
    if (!(w > 0) || !(h > 0)) return;
    if (canvasEl.width !== w) canvasEl.width = w;
    if (canvasEl.height !== h) canvasEl.height = h;
  }

  function setSourceDimensions(w, h) {
    if (!(w > 0) || !(h > 0)) return;
    setCanvasDimensions(w, h);
    const nextAspect = w / h;
    if (nextAspect !== videoAspect) {
      videoAspect = nextAspect;
      lastTop = lastLeft = lastWidth = -1;
      bump();
    }
  }

  let lastTabListHeight = -1;
  let sizedTabList = null;
  function getTabListTarget() {
    if (sizedTabList?.isConnected) return sizedTabList;
    return document.querySelector(TAB_LIST_SELECTORS);
  }
  function clearTabListHeight() {
    if (sizedTabList?.isConnected) {
      sizedTabList.removeAttribute("zenslop-tab-list-sized");
      sizedTabList.style.removeProperty("--zenslop-tab-list-height");
    }
    sizedTabList = null;
    lastTabListHeight = -1;
  }
  function setTabListHeight(px) {
    const target = px >= 0 ? getTabListTarget() : null;
    if (px === lastTabListHeight && target === sizedTabList) return;

    if (target !== sizedTabList) clearTabListHeight();
    if (target) {
      // Clean up the attribute and property used by versions that reserved
      // space with bottom padding instead of changing the list height.
      target.removeAttribute("zenslop-tab-padding");
      target.style.removeProperty("--zenslop-tab-list-padding");
      target.setAttribute("zenslop-tab-list-sized", "true");
      target.style.setProperty("--zenslop-tab-list-height", px + "px");
      sizedTabList = target;
      lastTabListHeight = px;
    }
  }

  function getMediaTopEdge(walkDescendants) {
    const baseRect = musicPlayerUI.getBoundingClientRect();
    let top = baseRect.top;
    if (walkDescendants && (hoverActive || performance.now() < activeUntil)) {
      const kids = musicPlayerUI.querySelectorAll("*");
      for (let i = 0; i < kids.length; i++) {
        const kid = kids[i];
        const r = kid.getBoundingClientRect();
        if (r.width !== 0 && r.height !== 0 && r.top < top) {
          const style = window.getComputedStyle(kid);
          if (style.position === "absolute" || style.position === "fixed") {
            continue;
          }
          if (style.visibility === "hidden" || style.display === "none" || style.opacity === "0") {
            continue;
          }
          top = r.top;
        }
      }
    }
    return {
      top,
      baseTop: baseRect.top,
      left: baseRect.left,
      width: baseRect.width,
    };
  }

  function getMediaPlayerVisibility() {
    if (musicPlayerUI.hidden || musicPlayerUI.hasAttribute("hidden")) {
      return { visible: false, opacity: 0 };
    }
    const cs = window.getComputedStyle(musicPlayerUI);
    if (cs.display === "none" || cs.visibility === "hidden") {
      return { visible: false, opacity: 0 };
    }
    if (musicPlayerUI.offsetParent === null && cs.position !== "fixed") {
      return { visible: false, opacity: 0 };
    }
    const r = musicPlayerUI.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) {
      return { visible: false, opacity: 0 };
    }
    return { visible: true, opacity: parseFloat(cs.opacity) };
  }

  function syncPosition() {
    scheduled = false;
    if (!isStreaming) return;

    const { visible, opacity } = getMediaPlayerVisibility();
    const effectivelyVisible =
      visible &&
      opacity > 0.01 &&
      !userHidden &&
      !sourceTabActive &&
      browserWindowActive;
    if (effectivelyVisible !== lastVisible) {
      pipContainer.style.visibility = effectivelyVisible ? "visible" : "hidden";
      captionContainer.style.visibility = effectivelyVisible
        ? "visible"
        : "hidden";
      lastVisible = effectivelyVisible;
    }
    if (!animating) {
      const op = userHidden ? 0 : opacity;
      if (op !== lastOpacity) {
        pipContainer.style.opacity = String(op);
        captionContainer.style.setProperty(
          "--zenslop-caption-opacity",
          String(op),
        );
        lastOpacity = op;
      }
    }

    if (effectivelyVisible) {
      const {
        top: mediaTopRaw,
        baseTop,
        left,
        width: playerWidth,
      } = getMediaTopEdge(true);
      if (playerWidth !== 0) {
        const now = performance.now();
        let mediaTop = mediaTopRaw;
        if (mediaTopRaw < baseTop - 1) {
          lastElevatedTop = mediaTopRaw;
          lastElevatedAt = now;
        } else if (
          lastElevatedTop !== null &&
          now - lastElevatedAt < CONFIG.ELEVATED_HOLD_MS
        ) {
          mediaTop = lastElevatedTop;
          schedule();
        } else {
          lastElevatedTop = null;
        }

        // Asymmetric hold for the player's top edge: the PiP may rise
        // immediately (to stay above the controls), but a downward move is only
        // committed once the lower edge has held stable for DOWN_HOLD_MS. While
        // holding we substitute the last committed (higher) edge rather than
        // skipping the frame, so the position still updates (left/width/aspect)
        // and always has a value — but doesn't drop for the transient control
        // oscillation YouTube emits for a few seconds after a fast-forward or a
        // pause/play while the controls are hovered. The reference persists
        // across stop/restart (see stopTracking) so pause/play keeps its stable
        // pre-pause baseline instead of re-seeding mid-oscillation.
        if (
          lastCommittedMediaTop !== null &&
          mediaTop - lastCommittedMediaTop > CONFIG.TOP_SPIKE_MAX
        ) {
          if (pendingDownAt === 0) pendingDownAt = now;
          if (now - pendingDownAt < CONFIG.DOWN_HOLD_MS) {
            mediaTop = lastCommittedMediaTop;
            schedule();
          } else {
            pendingDownAt = 0;
            lastCommittedMediaTop = mediaTop;
          }
        } else {
          pendingDownAt = 0;
          lastCommittedMediaTop = mediaTop;
        }

        let captionHeight = 0;
        let videoBottom = mediaTop - CONFIG.GAP;
        if (captionText) {
          const cs = captionContainer.style;
          cs.display = "block";
          cs.width = playerWidth + "px";
          cs.left = left + "px";
          captionHeight = Math.ceil(captionContainer.getBoundingClientRect().height);
          const captionTop = mediaTop - CONFIG.GAP - captionHeight;
          cs.top = captionTop + "px";
          videoBottom = captionTop - CONFIG.GAP;
        } else {
          captionContainer.style.display = "none";
        }

        const availableHeight = Math.max(2, videoBottom);
        let width = playerWidth;
        let height = width / videoAspect;
        const effectiveMaxHeight = Math.max(
          2,
          Math.min(playerWidth, availableHeight),
        );
        if (height > effectiveMaxHeight) {
          height = effectiveMaxHeight;
          width = height * videoAspect;
        }
        const adjustedLeft = left + (playerWidth - width) / 2;

        const nextCaptureMaxDimension = Math.max(
          160,
          Math.ceil(Math.max(width, height)),
        );
        if (nextCaptureMaxDimension !== captureMaxDimension) {
          captureMaxDimension = nextCaptureMaxDimension;
          const info = sourceBC ? actorRegistry.get(sourceBC.id) : null;
          info?.setMaxDimension?.(captureMaxDimension);
        }

        const top = videoBottom - height;
        if (
          top !== lastTop ||
          adjustedLeft !== lastLeft ||
          width !== lastWidth
        ) {
          const s = pipContainer.style;
          s.width = width + "px";
          s.height = height + "px";
          s.left = adjustedLeft + "px";
          s.top = top + "px";
          lastTop = top;
          lastLeft = adjustedLeft;
          lastWidth = width;
          activeUntil = now + CONFIG.ANIM_TAIL_MS;
        }
        const tabList = getTabListTarget();
        if (tabList) {
          const tabListTop = tabList.getBoundingClientRect().top;
          // Keep a small separation between the final tab and the fixed PiP.
          const availableTabListHeight = Math.max(
            0,
            Math.floor(top - CONFIG.TAB_LIST_GAP - tabListTop),
          );
          setTabListHeight(availableTabListHeight);
        }
      }
    } else {
      captionContainer.style.display = "none";
      clearTabListHeight();
    }

    if (performance.now() < activeUntil) schedule();
  }

  function schedule() {
    if (scheduled || !isStreaming) return;
    scheduled = true;
    requestAnimationFrame(syncPosition);
  }

  function bump() {
    activeUntil = performance.now() + CONFIG.ANIM_TAIL_MS;
    schedule();
  }

  function clearCaptionTimers() {
    if (captionHideTimer) {
      clearTimeout(captionHideTimer);
      captionHideTimer = null;
    }
    if (captionExitTimer) {
      clearTimeout(captionExitTimer);
      captionExitTimer = null;
    }
  }

  function clearCaptionImmediately() {
    clearCaptionTimers();
    captionContainer.removeAttribute("zenslop-caption-visible");
    captionContainer.textContent = "";
    captionContainer.style.display = "none";
    captionText = "";
    lastTop = lastLeft = lastWidth = -1;
  }

  function showCaption(next) {
    const wasEmpty = !captionText;
    clearCaptionTimers();
    captionText = next;
    captionContainer.textContent = next;
    lastTop = lastLeft = lastWidth = -1;
    if (isStreaming) bump();

    if (wasEmpty) {
      captionContainer.removeAttribute("zenslop-caption-visible");
      requestAnimationFrame(() => {
        if (!captionText) return;
        // syncPosition has now made the caption measurable and positioned it.
        // Flush that hidden state so the following attribute change transitions.
        void captionContainer.getBoundingClientRect();
        captionContainer.setAttribute("zenslop-caption-visible", "true");
      });
    } else {
      captionContainer.setAttribute("zenslop-caption-visible", "true");
    }
  }

  function hideCaptionNow() {
    clearCaptionTimers();
    if (!captionText) {
      captionContainer.removeAttribute("zenslop-caption-visible");
      return;
    }
    captionContainer.removeAttribute("zenslop-caption-visible");
    captionExitTimer = setTimeout(() => {
      captionExitTimer = null;
      captionText = "";
      captionContainer.textContent = "";
      lastTop = lastLeft = lastWidth = -1;
      if (isStreaming) bump();
    }, CONFIG.CAPTION_ANIM_MS);
  }

  function hideCaptionAfterGap() {
    if (!captionText || captionHideTimer || captionExitTimer) return;
    captionHideTimer = setTimeout(() => {
      captionHideTimer = null;
      captionContainer.removeAttribute("zenslop-caption-visible");
      captionExitTimer = setTimeout(() => {
        captionExitTimer = null;
        captionText = "";
        captionContainer.textContent = "";
        lastTop = lastLeft = lastWidth = -1;
        if (isStreaming) bump();
      }, CONFIG.CAPTION_ANIM_MS);
    }, CONFIG.CAPTION_GAP_GRACE_MS);
  }

  function startTracking() {
    lastTop = lastLeft = lastWidth = -1;
    lastVisible = null;
    lastOpacity = NaN;
    captureMaxDimension = -1;
    bump();
    _notifyTickState();
  }
  function stopTracking() {
    activeUntil = 0;
    hoverActive = false;
    lastElevatedTop = null;
    lastElevatedAt = 0;
    // NB: lastCommittedMediaTop is intentionally NOT reset here. The sidebar
    // player's top edge is stable across a pause/play, so keeping the reference
    // lets the asymmetric hold resist the transient control oscillation on
    // restart instead of re-seeding mid-glitch. (pendingDownAt is reset — a
    // fresh timer per stream is fine and self-heals on the next up-frame.)
    pendingDownAt = 0;
    clearTabListHeight();
    sourceTabActive = false;
    _notifyTickState();
  }

  musicPlayerUI.addEventListener("mouseenter", () => {
    hoverActive = true;
    bump();
  });
  musicPlayerUI.addEventListener("mouseleave", () => {
    hoverActive = false;
    bump();
  });
  for (const ev of [
    "transitionrun",
    "transitionend",
    "animationstart",
    "animationend",
  ]) {
    musicPlayerUI.addEventListener(ev, bump);
  }

  safe(() => {
    const ro = new ResizeObserver(bump);
    ro.observe(musicPlayerUI);
    ro.observe(document.documentElement);
  });

  new MutationObserver(bump).observe(musicPlayerUI, {
    attributes: true,
    attributeFilter: ["hidden", "style", "class", "open"],
  });
  window.addEventListener("resize", bump);

  function updateBrowserActivity() {
    const nextActive =
      document.visibilityState !== "hidden" &&
      window.windowState !== window.STATE_MINIMIZED &&
      safe(() => Services.focus.activeWindow === window) !== false;
    if (nextActive === browserWindowActive) return;
    browserWindowActive = nextActive;
    if (!browserWindowActive) {
      pipContainer.style.visibility = "hidden";
      captionContainer.style.visibility = "hidden";
      clearTabListHeight();
    }
    if (isStreaming) bump();
    _notifyTickState();
  }

  window.addEventListener("activate", updateBrowserActivity);
  window.addEventListener("deactivate", updateBrowserActivity);
  window.addEventListener("sizemodechange", updateBrowserActivity);
  document.addEventListener("visibilitychange", updateBrowserActivity);
  setTimeout(updateBrowserActivity, 0);

  const EYE_SVG =
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='context-fill' fill-opacity='context-fill-opacity'>" +
    "<path d='M12 5c-7 0-11 7-11 7s4 7 11 7 11-7 11-7-4-7-11-7zm0 11a4 4 0 1 1 0-8 4 4 0 0 1 0 8z'/></svg>";
  const EYE_OFF_SVG =
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='context-fill' fill-opacity='context-fill-opacity'>" +
    "<path d='M2 2l20 20-1.4 1.4-3.5-3.5A12 12 0 0 1 12 21C5 21 1 14 1 14a20 20 0 0 1 4.6-5.6L.6 3.4 2 2zm10 6a4 4 0 0 1 4 4c0 .6-.1 1.1-.3 1.6l-5.3-5.3c.5-.2 1-.3 1.6-.3zM12 5c7 0 11 7 11 7a20 20 0 0 1-3.7 4.6l-2.1-2.1A8 8 0 0 0 12 7c-.7 0-1.4.1-2 .3L7.7 5C9 4.4 10.4 5 12 5z'/></svg>";
  const eyeUrl = (svg) =>
    `url("data:image/svg+xml;utf8,${encodeURIComponent(svg)}")`;
  const EYE_URL = eyeUrl(EYE_SVG);
  const EYE_OFF_URL = eyeUrl(EYE_OFF_SVG);
  const STRIPPED_ATTRS = [
    "command",
    "oncommand",
    "onclick",
    "data-l10n-id",
    "style",
    "hidden",
    "collapsed",
    "disabled",
    "aria-hidden",
  ];

  const togglesByNativeButton = new Map();

  function syncToggleIcons() {
    for (const [nativeButton, toggle] of togglesByNativeButton) {
      if (!nativeButton.isConnected || !toggle.isConnected) {
        togglesByNativeButton.delete(nativeButton);
        continue;
      }
      const icon = userHidden ? EYE_OFF_URL : EYE_URL;
      if (toggle.style.listStyleImage !== icon) {
        toggle.style.listStyleImage = icon;
      }
    }
  }

  function parkNativePipButton(btn) {
    if (!btn || btn.hasAttribute("zenslop-toggle")) return;
    if (btn.getAttribute("zenslop-parked") !== "true") {
      btn.setAttribute("zenslop-parked", "true");
    }
    if (btn.style.display !== "none") {
      btn.style.display = "none";
    }
    if (btn.getAttribute("aria-hidden") !== "true") {
      btn.setAttribute("aria-hidden", "true");
    }
  }

  function buildToggle(template) {
    const btn = template.cloneNode(true);
    btn.removeAttribute("id");
    btn.classList.remove("zen-media-pip-button");
    btn.classList.add("zen-sidebar-pip-toggle");
    btn.removeAttribute("zenslop-parked");
    btn.setAttribute("zenslop-toggle", "true");
    btn.setAttribute("tooltiptext", "Toggle sidebar PiP");
    for (const a of STRIPPED_ATTRS) btn.removeAttribute(a);
    btn.style.listStyleImage = userHidden ? EYE_OFF_URL : EYE_URL;
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      userHidden = !userHidden;
      syncToggleIcons();
      if (userHidden) clearTabListHeight();
      bump();
      _notifyTickState();
    });
    return btn;
  }

  function placeToggles() {
    for (const [nativeButton, toggle] of togglesByNativeButton) {
      if (!nativeButton.isConnected || !toggle.isConnected) {
        togglesByNativeButton.delete(nativeButton);
      }
    }

    const nativeButtons = musicPlayerUI.querySelectorAll(PIP_BUTTON_SELECTORS);
    for (const nativeButton of nativeButtons) {
      if (nativeButton.hasAttribute("zenslop-toggle")) continue;
      const existingToggle = togglesByNativeButton.get(nativeButton);
      if (existingToggle?.isConnected) {
        parkNativePipButton(nativeButton);
        continue;
      }
      if (!nativeButton.parentNode) continue;
      const toggle = buildToggle(nativeButton);
      nativeButton.parentNode.insertBefore(toggle, nativeButton);
      togglesByNativeButton.set(nativeButton, toggle);
      parkNativePipButton(nativeButton);
    }
    syncToggleIcons();
  }

  placeToggles();
  new MutationObserver(() => {
    placeToggles();
  }).observe(musicPlayerUI, {
    attributes: true,
    attributeFilter: ["hidden", "style", "class", "collapsed"],
    childList: true,
    subtree: true,
  });

  let sourceBC = null;
  let sourceTabActive = false;
  let lastPipOpenAt = 0;
  const availableSources = new Map();
  const actorRegistry = new Map();

  function isTabPlaying(bc) {
    if (!bc) return false;
    try {
      for (const tab of gBrowser.tabs) {
        if (tab.linkedBrowser?.browsingContext?.id === bc.id) {
          return tab.hasAttribute("soundplaying");
        }
      }
    } catch (_) {}
    return false;
  }

  function getActiveActor() {
    if (!sourceBC) return null;
    return (
      safe(() => sourceBC.currentWindowGlobal?.getActor("ZenSidebarPiP")) ||
      null
    );
  }

  function _notifyTickState() {
    const effectivelyVisible =
      !userHidden && !sourceTabActive && browserWindowActive;
    const info = sourceBC ? actorRegistry.get(sourceBC.id) : null;
    if (!info) return;

    const processingActive = isStreaming && effectivelyVisible;
    info.setProcessingActive?.(processingActive);
    if (processingActive) {
      info.startTick(info.win || window);
    } else {
      info.stopTick();
    }
  }

  function awaitNextPipWindow() {
    let timeoutId = null;
    const unregister = () =>
      safe(() => Services.ww.unregisterNotification(observer));
    const observer = {
      observe(subject, topic) {
        if (topic !== "domwindowopened") return;
        subject.addEventListener(
          "load",
          () => {
            const wt =
              subject.document?.documentElement?.getAttribute("windowtype");
            if (wt !== "Toolkit:PictureInPicture") return;
            unregister();
            if (timeoutId) clearTimeout(timeoutId);
          },
          { once: true },
        );
      },
    };
    Services.ww.registerNotification(observer);
    timeoutId = setTimeout(unregister, CONFIG.PIP_OBSERVE_TIMEOUT_MS);
  }

  window.addEventListener("deactivate", () => {
    if (!isStreaming) return;
    if (performance.now() - lastPipOpenAt < CONFIG.PIP_OPEN_DEBOUNCE_MS) return;
    if (!getActiveActor()) return;
    awaitNextPipWindow();
    lastPipOpenAt = performance.now();
  });

  window.ZenPiPController = {
    getActiveBC() {
      return sourceBC;
    },
    drawFrame({ buf, width, height }) {
      try {
        // Adaptive capture resolution is independent from layout. The source
        // aspect is established by MirrorStarted/offerVideo; using each
        // downscaled frame here created a resolution -> aspect -> layout
        // feedback loop because even-number rounding slightly changes ratios.
        setCanvasDimensions(width, height);
        const img = new ImageData(new Uint8ClampedArray(buf), width, height);
        canvasCtx.putImageData(img, 0, 0);
      } catch (e) {
        err("drawFrame error:", e?.name, e?.message);
      }
    },
    setCaption(text) {
      const next = String(text || "").replace(/\s+/g, " ").trim().slice(0, 1000);
      if (next) {
        if (next === captionText && !captionHideTimer && !captionExitTimer) return;
        showCaption(next);
      } else {
        hideCaptionAfterGap();
      }
    },
    hideCaption() {
      hideCaptionNow();
    },
    setSourceTabActive(active) {
      if (sourceTabActive === active) return;
      sourceTabActive = active;
      if (sourceTabActive) clearTabListHeight();
      if (isStreaming) bump();
      _notifyTickState();
    },
    registerSource(id, callbacks) {
      if (!actorRegistry.has(id)) {
        actorRegistry.set(id, callbacks);
      }
    },
    unregisterSource(id) {
      actorRegistry.delete(id);
    },
    offerVideo(width, height, browsingContext) {
      const id = browsingContext.id;
      if (availableSources.has(id)) return;
      availableSources.set(id, { bc: browsingContext, width, height });

      // Only defer when a *different* tab is already mirroring. A re-offer from
      // the same tab (e.g. YouTube swapping an ad for the real video on the same
      // <video>, which fires emptied -> playing) must re-activate immediately
      // instead of queuing behind its own in-flight hide animation.
      if (sourceBC && sourceBC.id !== id && isTabPlaying(sourceBC)) {
        log("source queued (existing still playing):", id, "active:", sourceBC.id);
        return;
      }

      this._activateSource(width, height, browsingContext);
    },
    notifySourceStopped(bc) {
      availableSources.delete(bc.id);

      if (sourceBC && sourceBC.id === bc.id) {
        if (availableSources.size > 0) {
          this._activateSourceAfterHide();
        } else {
          this.hideVideo();
        }
      }
    },
    _activateSourceAfterHide() {
      if (animateOutTimer) return;
      const s = pipContainer.style;
      animating = true;
      s.transition = "none";
      s.opacity = userHidden ? "0" : "1";
      s.transform = "scale(1) translateY(0)";
      void pipContainer.getBoundingClientRect();

      requestAnimationFrame(() => {
        s.transition = ANIM_TRANSITION;
        requestAnimationFrame(() => {
          s.opacity = "0";
          s.transform = "scale(0.9) translateY(8px)";
        });
      });

      animateOutTimer = setTimeout(() => {
        animateOutTimer = null;
        animating = false;
        sourceBC = null;
        isStreaming = false;
        stopTracking();

        if (availableSources.size > 0) {
          const next = availableSources.values().next().value;
          this._activateSource(next.width, next.height, next.bc);
        }
      }, CONFIG.ANIM_MS + 60);
    },
    _activateSource(width, height, browsingContext) {
      availableSources.delete(browsingContext.id);
      log("showVideo", width, "x", height, "tab", browsingContext?.id);
      setSourceDimensions(width, height);
      const previousSourceBC = sourceBC;
      const nextSourceBC = browsingContext || null;
      const sourceChanged =
        previousSourceBC && nextSourceBC && previousSourceBC.id !== nextSourceBC.id;
      if (sourceChanged) clearCaptionImmediately();
      sourceBC = nextSourceBC;

      if (sourceBC) {
        try {
          sourceTabActive = gBrowser?.selectedBrowser?.browsingContext?.id === sourceBC.id;
        } catch (_) {
          sourceTabActive = false;
        }
      }

      if (animateOutTimer) {
        // We're pre-empting an in-flight hide to re-activate; we're no longer
        // animating out, so clear the flag or it stays stuck true.
        clearTimeout(animateOutTimer);
        animateOutTimer = null;
        animating = false;
      }

      const wasStreaming = isStreaming;
      isStreaming = true;
      startTracking();

      if (wasStreaming && !sourceChanged) {
        const s = pipContainer.style;
        s.opacity = userHidden || sourceTabActive ? "0" : "1";
        s.visibility = userHidden || sourceTabActive ? "hidden" : "visible";
        s.transform = "";
        return;
      }

      const s = pipContainer.style;
      s.display = "block";
      s.visibility = userHidden || sourceTabActive ? "hidden" : "visible";

      if (sourceTabActive) {
        isStreaming = true;
        animating = false;
        startTracking();
      } else {
        animating = true;
        s.transition = "none";
        s.opacity = "0";
        s.transform = "scale(0.9) translateY(8px)";
        void pipContainer.getBoundingClientRect();

        requestAnimationFrame(() => {
          s.transition = ANIM_TRANSITION;
          requestAnimationFrame(() => {
            s.opacity = userHidden ? "0" : "1";
            s.transform = "scale(1) translateY(0)";
          });
        });
        setTimeout(() => {
          animating = false;
          lastOpacity = NaN;
          s.transition = "";
        }, CONFIG.ANIM_MS + 60);
      }
    },

    hideVideo() {
      log("hideVideo");
      if (!isStreaming && !animating) return;
      if (animateOutTimer) {
        clearTimeout(animateOutTimer);
        animateOutTimer = null;
      }

      animating = true;
      const s = pipContainer.style;
      s.transition = "none";
      s.opacity = userHidden ? "0" : "1";
      s.transform = "scale(1) translateY(0)";
      void pipContainer.getBoundingClientRect();

      requestAnimationFrame(() => {
        s.transition = ANIM_TRANSITION;
        requestAnimationFrame(() => {
          s.opacity = "0";
          s.transform = "scale(0.9) translateY(8px)";
        });
      });

      animateOutTimer = setTimeout(() => {
        animateOutTimer = null;
        animating = false;
        safe(() => canvasCtx.clearRect(0, 0, canvasEl.width, canvasEl.height));
        clearCaptionImmediately();
        sourceBC = null;
        s.display = "none";
        s.transition = "";
        s.transform = "";
        isStreaming = false;
        stopTracking();
        lastOpacity = NaN;
        lastVisible = null;

        // A different source may have been queued while this hide was running;
        // drain it so it isn't stranded until the next pause/play.
        if (availableSources.size > 0) {
          const next = availableSources.values().next().value;
          this._activateSource(next.width, next.height, next.bc);
        }
      }, CONFIG.ANIM_MS + 60);
    },
  };

  function instantiateActorForOpenTabs() {
    try {
      for (const browser of gBrowser?.browsers || []) {
        const pending = [browser.browsingContext];
        while (pending.length) {
          const bc = pending.pop();
          if (!bc) continue;
          safe(() => bc.currentWindowGlobal?.getActor("ZenSidebarPiP"));
          safe(() => pending.push(...bc.children));
        }
      }
    } catch (e) {
      warn("Could not initialize actors for open tabs:", e);
    }
  }

  try {
    const profileDir = Services.dirsvc.get("ProfD", Ci.nsIFile);
    const modDir = profileDir.clone();
    for (const seg of ["chrome", "sine-mods", "Zenslop"]) modDir.append(seg);
    const modUri = Services.io.newFileURI(modDir);
    const resProto = Services.io
      .getProtocolHandler("resource")
      .QueryInterface(Ci.nsIResProtocolHandler);
    if (!resProto.hasSubstitution("zen-sidebar-pip")) {
      resProto.setSubstitution("zen-sidebar-pip", modUri);
    }
    log("resource mapped to:", modUri.spec, "exists:", modDir.exists());

    ChromeUtils.registerWindowActor("ZenSidebarPiP", {
      parent: {
        esModuleURI: "resource://zen-sidebar-pip/parent-actor.sys.mjs",
      },
      child: {
        esModuleURI: "resource://zen-sidebar-pip/content-actor.sys.mjs",
        events: {
          DOMContentLoaded: {},
          pageshow: {},
          play: { capture: true, mozSystemGroup: true },
          playing: { capture: true, mozSystemGroup: true },
          loadedmetadata: { capture: true, mozSystemGroup: true },
          canplay: { capture: true, mozSystemGroup: true },
          pause: { capture: true, mozSystemGroup: true },
          ended: { capture: true, mozSystemGroup: true },
          emptied: { capture: true, mozSystemGroup: true },
          volumechange: { capture: true, mozSystemGroup: true },
        },
      },
      messageManagerGroups: ["browsers"],
      allFrames: true,
      safeForUntrustedWebProcess: true,
    });
  } catch (e) {
    if (e.name !== "NotSupportedError")
      err("Failed to register JSWindowActor:", e);
  }

  // Actor registration is process-global and lazy. Force an instance for
  // already-open documents so restored playback is discovered, then retry as
  // the registration reaches existing content processes.
  instantiateActorForOpenTabs();
  setTimeout(instantiateActorForOpenTabs, 500);
  setTimeout(instantiateActorForOpenTabs, 1500);

  log("Zenslop initialized.");
})();
