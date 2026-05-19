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
  const safe = (fn) => { try { return fn(); } catch (_) { return undefined; } };

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

  const MUSIC_PLAYER_SELECTORS = "#zen-media-controls-toolbar, .zen-sidebar-bottom-buttons";
  const TAB_LIST_SELECTORS = "#tabbrowser-arrowscrollbox, #zen-tabs-wrapper, #tabbrowser-tabs";
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

  // Inject a single stylesheet rather than inlining cssText on every node.
  const styleEl = document.createElement("style");
  styleEl.textContent = `
    #zen-sidebar-pip-container {
      position: fixed;
      background: transparent;
      display: none;
      border-radius: var(--zen-border-radius);
      overflow: hidden;
      contain: size layout;
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
    }
  `;
  document.documentElement.appendChild(styleEl);

  const pipContainer = document.createElement("div");
  pipContainer.id = "zen-sidebar-pip-container";
  const canvasEl = document.createElement("canvas");
  const canvasCtx = canvasEl.getContext("2d", { alpha: false, desynchronized: true });
  pipContainer.appendChild(canvasEl);
  document.documentElement.appendChild(pipContainer);

  // Position state
  let lastTop = -1, lastLeft = -1, lastWidth = -1;
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

  // Pad the tab list so the last tabs can scroll above the floating video.
  // Strategy: apply margin-bottom directly to the bottom-most visible tab.
  // This always extends the scrollable content regardless of which ancestor
  // is the actual scroll container — host-level padding on Zen's
  // arrowscrollbox doesn't reach the shadow-DOM scrollbox.
  let lastTabPad = -1;
  let paddedTab = null;
  function findBottomMostTab() {
    const tabs = document.querySelectorAll(".tabbrowser-tab");
    let best = null, bestBottom = -Infinity;
    for (const t of tabs) {
      if (t.hidden) continue;
      const r = t.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.bottom > bestBottom) {
        bestBottom = r.bottom;
        best = t;
      }
    }
    return best;
  }
  function clearPaddedTab() {
    if (paddedTab && paddedTab.isConnected) paddedTab.style.marginBottom = "";
    paddedTab = null;
  }
  function setTabListPadding(px) {
    const target = px > 0 ? findBottomMostTab() : null;
    if (px === lastTabPad && target === paddedTab) return;
    lastTabPad = px;

    // Also pad every known candidate container — cheap and may help in
    // browser variants where the host padding actually works.
    const value = px > 0 ? px + "px" : "";
    for (const sel of ["#tabbrowser-arrowscrollbox", "#zen-tabs-wrapper", "#tabbrowser-tabs"]) {
      const el = document.querySelector(sel);
      if (el) el.style.paddingBottom = value;
    }

    if (target !== paddedTab) clearPaddedTab();
    if (target) {
      target.style.marginBottom = value;
      paddedTab = target;
    }
  }

  function getMediaTopEdge(walkDescendants) {
    const baseRect = musicPlayerUI.getBoundingClientRect();
    let top = baseRect.top;
    if (walkDescendants) {
      const kids = musicPlayerUI.querySelectorAll("*");
      for (let i = 0; i < kids.length; i++) {
        const r = kids[i].getBoundingClientRect();
        if (r.width !== 0 && r.height !== 0 && r.top < top) top = r.top;
      }
    }
    return { top, baseTop: baseRect.top, left: baseRect.left, width: baseRect.width };
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
    const effectivelyVisible = visible && !userHidden;
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
      const { top: mediaTopRaw, baseTop, left, width: playerWidth } = getMediaTopEdge(true);
      if (playerWidth !== 0) {
        // Fit the video into a box capped by player width and MAX_HEIGHT.
        let width = playerWidth;
        let height = width / videoAspect;
        if (height > CONFIG.MAX_HEIGHT) {
          height = CONFIG.MAX_HEIGHT;
          width = height * videoAspect;
        }
        const adjustedLeft = left + (playerWidth - width) / 2;

        // Hold an elevated (popup-extended) top through brief glitch frames
        // where the descendant walk doesn't surface it.
        const now = performance.now();
        let mediaTop = mediaTopRaw;
        if (mediaTopRaw < baseTop - 1) {
          lastElevatedTop = mediaTopRaw;
          lastElevatedAt = now;
        } else if (lastElevatedTop !== null && now - lastElevatedAt < CONFIG.ELEVATED_HOLD_MS) {
          mediaTop = lastElevatedTop;
          schedule();
        } else {
          lastElevatedTop = null;
        }

        const top = mediaTop - CONFIG.GAP - height;
        if (top !== lastTop || adjustedLeft !== lastLeft || width !== lastWidth) {
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
        setTabListPadding(userHidden ? 0 : Math.ceil(height + CONFIG.GAP * 2));
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
  }

  // Event-driven triggers — far cheaper than polling every frame.
  musicPlayerUI.addEventListener("mouseenter", () => { hoverActive = true; bump(); });
  musicPlayerUI.addEventListener("mouseleave", () => { hoverActive = false; bump(); });
  for (const ev of ["transitionrun", "transitionend", "animationstart", "animationend"]) {
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

  // Toggle button (eye / eye-off) injected next to the existing PiP button.
  const EYE_SVG =
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='context-fill' fill-opacity='context-fill-opacity'>" +
    "<path d='M12 5c-7 0-11 7-11 7s4 7 11 7 11-7 11-7-4-7-11-7zm0 11a4 4 0 1 1 0-8 4 4 0 0 1 0 8z'/></svg>";
  const EYE_OFF_SVG =
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='context-fill' fill-opacity='context-fill-opacity'>" +
    "<path d='M2 2l20 20-1.4 1.4-3.5-3.5A12 12 0 0 1 12 21C5 21 1 14 1 14a20 20 0 0 1 4.6-5.6L.6 3.4 2 2zm10 6a4 4 0 0 1 4 4c0 .6-.1 1.1-.3 1.6l-5.3-5.3c.5-.2 1-.3 1.6-.3zM12 5c7 0 11 7 11 7a20 20 0 0 1-3.7 4.6l-2.1-2.1A8 8 0 0 0 12 7c-.7 0-1.4.1-2 .3L7.7 5C9 4.4 10.4 5 12 5z'/></svg>";
  const eyeUrl = (svg) => `url("data:image/svg+xml;utf8,${encodeURIComponent(svg)}")`;
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
    btn.style.display = "none";
    btn.setAttribute("aria-hidden", "true");
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
      parkNativePipButton(nativePipBtn);
      return true;
    }
    const existing = findExistingPipButton();
    if (existing && existing.parentNode) {
      const parent = existing.parentNode;
      const btn = buildToggle(existing);
      const parent = existing.parentNode;
      parent.insertBefore(btn, existing.nextSibling);
      // The parent container may be sized only for visible controls (e.g. when
      // the native PiP button is hidden). Ensure it always expands to fit all
      // children, including our injected button.
      parent.style.minWidth = "fit-content";
      parent.style.overflow = "visible";
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

  // BrowsingContext bookkeeping for click-to-focus origin tab.
  let sourceBC = null;
  let lastPipOpenAt = 0;

  function getActiveActor() {
    if (!sourceBC) return null;
    return safe(() => sourceBC.currentWindowGlobal?.getActor("ZenSidebarPiP")) || null;
  }

  // Catch the next PiP window that opens so we can clean up the observer
  // once it's served its purpose.
  function awaitNextPipWindow() {
    let timeoutId = null;
    const unregister = () => safe(() => Services.ww.unregisterNotification(observer));
    const observer = {
      observe(subject, topic) {
        if (topic !== "domwindowopened") return;
        subject.addEventListener("load", () => {
          const wt = subject.document?.documentElement?.getAttribute("windowtype");
          if (wt !== "Toolkit:PictureInPicture") return;
          unregister();
          if (timeoutId) clearTimeout(timeoutId);
        }, { once: true });
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

  // Public controller surface invoked by the parent JSWindowActor.
  window.ZenPiPController = {
    drawFrame(frame) {
      try {
        canvasCtx.drawImage(frame, 0, 0, canvasEl.width, canvasEl.height);
      } catch (_) {}
    },
    showVideo(width, height, browsingContext) {
      setSourceDimensions(width, height);
      const previousSourceBC = sourceBC;
      const nextSourceBC = browsingContext || null;
      const sourceChanged = previousSourceBC && nextSourceBC && previousSourceBC !== nextSourceBC;
      sourceBC = nextSourceBC;

      if (animateOutTimer) {
        clearTimeout(animateOutTimer);
        animateOutTimer = null;
      }

      const wasStreaming = isStreaming;
      isStreaming = true;
      startTracking();

      if (wasStreaming && !sourceChanged) {
        const s = pipContainer.style;
        s.opacity = userHidden ? "0" : "1";
        s.visibility = userHidden ? "hidden" : "visible";
        s.transform = "";
        return;
      }

      const s = pipContainer.style;
      s.display = "block";
      s.visibility = userHidden ? "hidden" : "visible";

      animating = true;
      // Commit the start state with NO transition. Forcing layout via
      // getBoundingClientRect alone isn't enough — the browser may coalesce
      // a same-task `transition: none` -> `transition: ANIM_TRANSITION` swap,
      // and the opacity:0 start is never observed under no-transition. Using
      // a double rAF ensures the start frame is painted before we re-enable
      // the transition and target the end state.
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
      }, CONFIG.ANIM_MS + 60);
    },

    hideVideo() {
      if (!isStreaming && !animating) return;
      if (animateOutTimer) {
        clearTimeout(animateOutTimer);
        animateOutTimer = null;
      }

      animating = true;
      const s = pipContainer.style;
      // Pin the current visual state explicitly under no-transition, then
      // flip transitions on in a rAF so the change to opacity:0 actually
      // animates from a known starting point.
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
        s.transition = "none";
        s.transform = "";
        isStreaming = false;
        stopTracking();
        lastOpacity = NaN;
        lastVisible = null;
      }, CONFIG.ANIM_MS + 60);
    },
  };

  // Register the JSWindowActor that bridges the e10s process gap.
  try {
    const profileDir = Services.dirsvc.get("ProfD", Ci.nsIFile);
    const modDir = profileDir.clone();
    for (const seg of ["chrome", "sine-mods", "Zenslop"]) modDir.append(seg);
    const modUri = Services.io.newFileURI(modDir);
    const resProto = Services.io.getProtocolHandler("resource").QueryInterface(Ci.nsIResProtocolHandler);
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
    if (e.name !== "NotSupportedError") err("Failed to register JSWindowActor:", e);
  }

  log("Zenslop initialized.");
})();
