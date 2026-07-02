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
    ANIM_MS: 220,
    ANIM_TAIL_MS: 350,
    ELEVATED_HOLD_MS: 180,
    MAX_HEIGHT: 600,
    DEFAULT_ASPECT: 16 / 9,
    PIP_OPEN_DEBOUNCE_MS: 1500,
    PIP_OBSERVE_TIMEOUT_MS: 3000,
  });
  const ANIM_TRANSITION = `opacity ${CONFIG.ANIM_MS}ms ease, transform ${CONFIG.ANIM_MS}ms ease`;

  const MUSIC_PLAYER_SELECTORS =
    "#zen-media-controls-toolbar, .zen-sidebar-bottom-buttons";
  const TAB_LIST_SELECTORS =
    "#tabbrowser-arrowscrollbox, #zen-tabs-wrapper, #tabbrowser-tabs";
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
      will-change: opacity, transform;
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
    #zen-sidebar-pip-toggle {
      flex: 0 0 auto;
      max-width: 24px !important;
      max-height: 24px !important;
      width: 24px !important;
      height: 24px !important;
      margin: 0 2px !important;
      padding: 0 !important;
      box-sizing: border-box !important;
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
  let animating = false;
  let animateOutTimer = null;
  let videoAspect = CONFIG.DEFAULT_ASPECT;

  function setSourceDimensions(w, h) {
    if (!(w > 0) || !(h > 0)) return;
    if (canvasEl.width !== w) canvasEl.width = w;
    if (canvasEl.height !== h) canvasEl.height = h;
    const nextAspect = w / h;
    if (nextAspect !== videoAspect) {
      videoAspect = nextAspect;
      lastTop = lastLeft = lastWidth = -1;
      bump();
    }
  }

  let lastTabPad = -1;
  let paddedTab = null;
  let tabsContainer = null;
  function getTabsContainer() {
    if (tabsContainer && tabsContainer.isConnected) return tabsContainer;
    tabsContainer = document.querySelector("#tabbrowser-arrowscrollbox, #zen-tabs-wrapper, #tabbrowser-tabs");
    return tabsContainer;
  }
  function findBottomMostTab() {
    const container = getTabsContainer();
    const tabs = container ? container.querySelectorAll(".tabbrowser-tab") : document.querySelectorAll(".tabbrowser-tab");
    for (let i = tabs.length - 1; i >= 0; i--) {
      const t = tabs[i];
      if (t.hidden || t.style.display === "none" || t.getAttribute("collapsed") === "true") {
        continue;
      }
      if (t.offsetWidth === 0 || t.offsetHeight === 0) {
        continue;
      }
      return t;
    }
    return null;
  }
  function clearPaddedTab() {
    if (paddedTab && paddedTab.isConnected) {
      if (paddedTab.style.marginBottom !== "") {
        paddedTab.style.marginBottom = "";
      }
    }
    paddedTab = null;
  }
  function setTabListPadding(px) {
    const target = px > 0 ? findBottomMostTab() : null;
    if (px === lastTabPad && target === paddedTab) return;
    lastTabPad = px;

    const value = px > 0 ? px + "px" : "";
    for (const sel of [
      "#tabbrowser-arrowscrollbox",
      "#zen-tabs-wrapper",
      "#tabbrowser-tabs",
    ]) {
      const el = document.querySelector(sel);
      if (el && el.style.paddingBottom !== value) {
        el.style.paddingBottom = value;
      }
    }

    if (target !== paddedTab) clearPaddedTab();
    if (target) {
      if (target.style.marginBottom !== value) {
        target.style.marginBottom = value;
      }
      paddedTab = target;
    }
  }

  function getMediaTopEdge(walkDescendants) {
    const baseRect = musicPlayerUI.getBoundingClientRect();
    let top = baseRect.top;
    if (walkDescendants && (hoverActive || performance.now() < activeUntil)) {
      const kids = musicPlayerUI.querySelectorAll("*");
      for (let i = 0; i < kids.length; i++) {
        const r = kids[i].getBoundingClientRect();
        if (r.width !== 0 && r.height !== 0 && r.top < top) top = r.top;
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
    const effectivelyVisible = visible && !userHidden && !sourceTabActive;
    if (effectivelyVisible !== lastVisible) {
      pipContainer.style.visibility = effectivelyVisible ? "visible" : "hidden";
      lastVisible = effectivelyVisible;
    }
    if (!animating) {
      const op = userHidden ? 0 : opacity;
      if (op !== lastOpacity) {
        pipContainer.style.opacity = String(op);
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

        const availableHeight = mediaTop - CONFIG.GAP;
        let width = playerWidth;
        let height = width / videoAspect;
        const effectiveMaxHeight = Math.min(playerWidth, availableHeight);
        if (height > effectiveMaxHeight) {
          height = effectiveMaxHeight;
          width = height * videoAspect;
        }
        const adjustedLeft = left + (playerWidth - width) / 2;

        const top = mediaTop - CONFIG.GAP - height;
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
        const padHeight = Math.min(height, playerWidth / CONFIG.DEFAULT_ASPECT);
        setTabListPadding(userHidden ? 0 : Math.ceil(padHeight + CONFIG.GAP * 2));
      }
    } else {
      setTabListPadding(0);
    }

    if (hoverActive || performance.now() < activeUntil) schedule();
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

  function startTracking() {
    lastTop = lastLeft = lastWidth = -1;
    lastVisible = null;
    lastOpacity = NaN;
    bump();
  }
  function stopTracking() {
    activeUntil = 0;
    hoverActive = false;
    lastElevatedTop = null;
    lastElevatedAt = 0;
    setTabListPadding(0);
    sourceTabActive = false;
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

  let toggleBtn = null;
  let nativePipBtn = null;

  function parkNativePipButton(btn) {
    if (!btn || btn === toggleBtn) return;
    nativePipBtn = btn;
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
    btn.id = "zen-sidebar-pip-toggle";
    btn.setAttribute("tooltiptext", "Toggle sidebar PiP");
    for (const a of STRIPPED_ATTRS) btn.removeAttribute(a);
    btn.style.listStyleImage = EYE_URL;
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      userHidden = !userHidden;
      btn.style.listStyleImage = userHidden ? EYE_OFF_URL : EYE_URL;
      bump();
    });
    toggleBtn = btn;
    return btn;
  }

  function findExistingPipButton() {
    const candidates = musicPlayerUI.querySelectorAll(PIP_BUTTON_SELECTORS);
    for (const c of candidates) if (c !== toggleBtn) return c;
    return null;
  }

  function placeToggle() {
    if (toggleBtn && toggleBtn.isConnected) {
      if (!nativePipBtn || !nativePipBtn.isConnected) {
        parkNativePipButton(findExistingPipButton());
      } else {
        parkNativePipButton(nativePipBtn);
      }
      return true;
    }
    const existing = findExistingPipButton();
    if (existing && existing.parentNode) {
      const parent = existing.parentNode;
      const btn = buildToggle(existing);

      parent.insertBefore(btn, existing);
      return true;
    }
    return false;
  }

  if (!placeToggle()) {
    const obs = new MutationObserver(() => {
      if (placeToggle()) obs.disconnect();
    });
    obs.observe(musicPlayerUI, { childList: true, subtree: true });
  }
  new MutationObserver(() => {
    placeToggle();
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
        setSourceDimensions(width, height);
        const img = new ImageData(new Uint8ClampedArray(buf), width, height);
        canvasCtx.putImageData(img, 0, 0);
      } catch (e) {
        err("drawFrame error:", e?.name, e?.message);
      }
    },
    setSourceTabActive(active) {
      if (sourceTabActive === active) return;
      sourceTabActive = active;
      if (isStreaming) bump();
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

      if (sourceBC && isTabPlaying(sourceBC)) {
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
      sourceBC = nextSourceBC;

      if (sourceBC) {
        try {
          sourceTabActive = gBrowser?.selectedBrowser?.browsingContext?.id === sourceBC.id;
        } catch (_) {
          sourceTabActive = false;
        }
      }

      if (animateOutTimer) {
        clearTimeout(animateOutTimer);
        animateOutTimer = null;
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

      const info = actorRegistry.get(browsingContext.id);
      if (info) info.startTick(info.win || window);
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
        sourceBC = null;
        s.display = "none";
        s.transition = "";
        s.transform = "";
        isStreaming = false;
        stopTracking();
        lastOpacity = NaN;
        lastVisible = null;
      }, CONFIG.ANIM_MS + 60);
    },
  };

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
      parent: { esModuleURI: "resource://zen-sidebar-pip/parent-actor.js" },
      child: {
        esModuleURI: "resource://zen-sidebar-pip/content-actor.js",
        events: {
          playing: { capture: true, mozSystemGroup: true },
          pause: { capture: true, mozSystemGroup: true },
          volumechange: { capture: true, mozSystemGroup: true },
        },
      },
      messageManagerGroups: ["browsers"],
      allFrames: true,
    });
  } catch (e) {
    if (e.name !== "NotSupportedError")
      err("Failed to register JSWindowActor:", e);
  }

  log("Zenslop initialized.");
})();
