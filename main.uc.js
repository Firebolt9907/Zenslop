// ==UserScript==
// @name           Zen Sidebar PiP
// @version        0.1.0
// @description    Hooks into Zen's sidebar to render active video streams.
// ==/UserScript==

console.log("[ZenPiP] main.uc.js TOP-LEVEL executed");

(function () {
  // Prevent multiple injections if the script reloads
  if (window.__zenSidebarPiPLoaded) return;
  window.__zenSidebarPiPLoaded = true;

  // 1. Hijack the Zen Sidebar DOM
  // Note: You will need to use the Browser Toolbox (Cmd+Opt+Shift+I)
  // to find the exact ID or class of Zen's music player element.
  const musicPlayerUI =
    document.querySelector("#zen-media-controls-toolbar") || document.querySelector(".zen-sidebar-bottom-buttons");

  if (!musicPlayerUI) {
    console.error("Zen Sidebar PiP: Could not find the music player UI.");
    return;
  }

  // 2. Create the PiP Video Container
  const pipContainer = document.createElement("div");
  pipContainer.id = "zen-sidebar-pip-container";
  pipContainer.style.cssText = `
        position: fixed;
        background: transparent;
        display: none; /* Hidden until video plays */
        border-radius: 18px;
        border: 3px solid #ff9ecf;
        box-shadow:
          0 0 0 1px rgba(255, 255, 255, 0.85) inset,
          0 6px 28px rgba(255, 143, 200, 0.42),
          0 0 48px rgba(255, 182, 218, 0.38);
        overflow: hidden;
        contain: size layout;
        z-index: 10;
        pointer-events: auto;
        cursor: pointer;
        transform-origin: 50% 100%;
        will-change: opacity, transform;
    `;

  const videoEl = document.createElement("video");
  videoEl.autoplay = true;
  videoEl.muted = true; // Prevent echo from the original tab
  videoEl.style.cssText = `
        width: 100%;
        height: 100%;
        max-width: 100%;
        max-height: 100%;
        min-width: 0;
        min-height: 0;
        object-fit: contain;
        display: block;
        border-radius: 14px;
        box-shadow: 0 0 0 2px #ffd6ef, 0 0 20px rgba(255, 153, 204, 0.25);
    `;

  pipContainer.appendChild(videoEl);

  // Float the container in the chrome window so it can track the music
  // player's position even when other mods translate/animate the player.
  document.documentElement.appendChild(pipContainer);

  const GAP = 6; // px between video bottom and music player top
  const ANIM_TAIL_MS = 350; // keep ticking briefly after a state change
  const ELEVATED_HOLD_MS = 180; // hold elevated top through brief glitch frames
  let lastTop = -1,
    lastLeft = -1,
    lastWidth = -1;
  let lastVisible = null,
    lastOpacityStr = "";
  let isStreaming = false;
  let userHidden = false;
  let scheduled = false;
  let activeUntil = 0; // ms timestamp; rAF re-schedules until then
  let hoverActive = false;
  let lastElevatedTop = null; // most recent top from a popup-extended frame
  let lastElevatedAt = 0; // ms timestamp of that frame
  let animating = false;
  let animateOutTimer = null;
  let videoAspect = 16 / 9; // updated from videoEl metadata
  videoEl.addEventListener("loadedmetadata", () => {
    if (videoEl.videoWidth > 0 && videoEl.videoHeight > 0) {
      videoAspect = videoEl.videoWidth / videoEl.videoHeight;
      lastTop = lastLeft = lastWidth = -1; // force re-layout
      bump();
    }
  });
  const ANIM_MS = 220;
  const ANIM_TRANSITION = `opacity ${ANIM_MS}ms ease, transform ${ANIM_MS}ms ease`;

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
    const effectivelyVisible = visible && !userHidden;
    if (effectivelyVisible !== lastVisible) {
      pipContainer.style.visibility = effectivelyVisible ? "visible" : "hidden";
      lastVisible = effectivelyVisible;
    }
    if (!animating) {
      const opStr = userHidden ? "0" : String(opacity);
      if (opStr !== lastOpacityStr) {
        pipContainer.style.opacity = opStr;
        lastOpacityStr = opStr;
      }
    }

    if (effectivelyVisible) {
      // Always walk descendants — the popup-open state isn't always inside
      // an "animation tail", and skipping the walk causes the video to drop
      // onto the controls. The walk is a single querySelectorAll over a
      // small toolbar; cost is negligible vs. the previous flicker.
      const { top: mediaTopRaw, baseTop, left, width: playerWidth } = getMediaTopEdge(true);
      if (playerWidth !== 0) {
        // Fit the video's natural aspect into a box capped by the player's
        // width and the 16:9 height that width would imply. Vertical videos
        // shrink in width and stay centered over the player; landscape fills.
        const maxHeight = 600;
        let width = playerWidth;
        let height = width / videoAspect;
        if (height > maxHeight) {
          height = maxHeight;
          width = height * videoAspect;
        }
        const adjustedLeft = left + (playerWidth - width) / 2;
        // Decide which mediaTop to use. If the walk surfaced an elevated
        // (above-base) top, trust it and remember it. If it didn't, but we
        // saw an elevated top very recently, treat this frame as a glitch
        // and hold the elevated value — re-poll until the hold expires.
        const now = performance.now();
        let mediaTop = mediaTopRaw;
        if (mediaTopRaw < baseTop - 1) {
          lastElevatedTop = mediaTopRaw;
          lastElevatedAt = now;
        } else if (lastElevatedTop !== null && now - lastElevatedAt < ELEVATED_HOLD_MS) {
          mediaTop = lastElevatedTop;
          schedule();
        } else {
          lastElevatedTop = null;
        }

        const top = mediaTop - GAP - height;
        if (top !== lastTop || adjustedLeft !== lastLeft || width !== lastWidth) {
          pipContainer.style.width = width + "px";
          pipContainer.style.height = height + "px";
          pipContainer.style.left = adjustedLeft + "px";
          pipContainer.style.top = top + "px";
          lastTop = top;
          lastLeft = adjustedLeft;
          lastWidth = width;
          // Position is moving — keep ticking through the animation tail.
          activeUntil = performance.now() + ANIM_TAIL_MS;
        }
      }
    }

    if (isStreaming && (hoverActive || performance.now() < activeUntil)) {
      schedule();
    }
  }

  function schedule() {
    if (scheduled || !isStreaming) return;
    scheduled = true;
    requestAnimationFrame(syncPosition);
  }

  function bump() {
    activeUntil = performance.now() + ANIM_TAIL_MS;
    schedule();
  }

  function startTracking() {
    lastTop = lastLeft = lastWidth = -1;
    lastVisible = null;
    lastOpacityStr = "";
    bump();
  }
  function stopTracking() {
    activeUntil = 0;
    hoverActive = false;
    lastElevatedTop = null;
    lastElevatedAt = 0;
  }

  // Event-driven triggers — far cheaper than polling every frame.
  musicPlayerUI.addEventListener("mouseenter", () => {
    hoverActive = true;
    bump();
  });
  musicPlayerUI.addEventListener("mouseleave", () => {
    hoverActive = false;
    bump(); // animate back down
  });
  musicPlayerUI.addEventListener("transitionrun", bump);
  musicPlayerUI.addEventListener("transitionend", bump);
  musicPlayerUI.addEventListener("animationstart", bump);
  musicPlayerUI.addEventListener("animationend", bump);

  try {
    new ResizeObserver(bump).observe(musicPlayerUI);
    new ResizeObserver(bump).observe(document.documentElement);
  } catch (e) {}

  new MutationObserver(bump).observe(musicPlayerUI, {
    attributes: true,
    attributeFilter: ["hidden", "style", "class", "open"],
  });
  window.addEventListener("resize", bump);

  // Inject toggle button (eye / eye-off) into the media controls.
  // Use list-style-image so the icon flows through the same .toolbarbutton-icon
  // slot as the other expanded buttons — that's what gets centered by Zen's CSS.
  const EYE_SVG =
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='%23ff69b4' fill-opacity='1'>" +
    "<path d='M12 5c-7 0-11 7-11 7s4 7 11 7 11-7 11-7-4-7-11-7zm0 11a4 4 0 1 1 0-8 4 4 0 0 1 0 8z'/></svg>";
  const EYE_OFF_SVG =
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='%23ff8dc7' fill-opacity='0.92'>" +
    "<path d='M2 2l20 20-1.4 1.4-3.5-3.5A12 12 0 0 1 12 21C5 21 1 14 1 14a20 20 0 0 1 4.6-5.6L.6 3.4 2 2zm10 6a4 4 0 0 1 4 4c0 .6-.1 1.1-.3 1.6l-5.3-5.3c.5-.2 1-.3 1.6-.3zM12 5c7 0 11 7 11 7a20 20 0 0 1-3.7 4.6l-2.1-2.1A8 8 0 0 0 12 7c-.7 0-1.4.1-2 .3L7.7 5C9 4.4 10.4 5 12 5z'/></svg>";
  const eyeUrl = (svg) => `url("data:image/svg+xml;utf8,${encodeURIComponent(svg)}")`;

  let toggleBtn = null;

  function buildToggle(template) {
    // Clone deep so we get the inner .toolbarbutton-icon image element that
    // Zen's CSS centers and sizes.
    const btn = template.cloneNode(true);
    btn.id = "zen-sidebar-pip-toggle";
    btn.setAttribute("tooltiptext", "\u2728 Toggle sidebar PiP \u2661\uFE0F \u2728");
    btn.removeAttribute("command");
    btn.removeAttribute("oncommand");
    btn.removeAttribute("onclick");
    btn.removeAttribute("data-l10n-id");
    btn.removeAttribute("style");
    btn.style.listStyleImage = eyeUrl(EYE_SVG);
    btn.style.borderRadius = "9999px";
    btn.style.background = "linear-gradient(180deg, rgba(255, 240, 248, 0.55), rgba(255, 214, 234, 0.45))";
    btn.style.boxShadow = "0 0 0 2px #ffc2e6, 0 2px 10px rgba(255, 143, 200, 0.35)";

    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      userHidden = !userHidden;
      btn.style.listStyleImage = eyeUrl(userHidden ? EYE_OFF_SVG : EYE_SVG);
      // Force an immediate visibility/opacity sync so the toggle feels instant.
      bump();
    });

    toggleBtn = btn;
    return btn;
  }

  function findExistingPipButton() {
    const selectors = [
      '[id*="pictureinpicture" i]',
      '[class*="pictureinpicture" i]',
      '[command*="pictureinpicture" i]',
      '[id*="pip" i]',
      '[class*="pip" i]',
      '[anonid*="pictureinpicture" i]',
    ];
    for (const sel of selectors) {
      const found = musicPlayerUI.querySelector(sel);
      if (found && found !== toggleBtn) return found;
    }
    return null;
  }

  function placeToggle() {
    if (toggleBtn && toggleBtn.isConnected) return true;
    const existing = findExistingPipButton();
    if (existing && existing.parentNode) {
      const btn = buildToggle(existing);
      existing.parentNode.insertBefore(btn, existing.nextSibling);
      return true;
    }
    return false;
  }

  if (!placeToggle()) {
    // Expanded menu likely isn't built yet — wait for it to appear.
    const obs = new MutationObserver(() => {
      if (placeToggle()) obs.disconnect();
    });
    obs.observe(musicPlayerUI, { childList: true, subtree: true });
  }

  // Track which BrowsingContext is being mirrored, so a click can focus
  // the originating tab in the chrome window.
  let sourceBC = null;
  let lastPipOpenAt = 0; // performance.now() of most recent open
  const PIP_OPEN_DEBOUNCE_MS = 1500;

  function getActiveActor() {
    if (!sourceBC) return null;
    try {
      return sourceBC.currentWindowGlobal?.getActor("ZenSidebarPiP") || null;
    } catch (e) {
      return null;
    }
  }
  function yieldAppFocus() {
    try {
      Cc["@mozilla.org/widget/macdocksupport;1"].getService(Ci.nsIMacDockSupport).activateApplication(false);
    } catch (e) {}
  }

  // Catch the next PiP window that opens (regardless of who triggered it).
  function awaitNextPipWindow() {
    let timeoutId = null;
    const observer = {
      observe(subject, topic) {
        if (topic !== "domwindowopened") return;
        const win = subject;
        win.addEventListener(
          "load",
          () => {
            const wt = win.document?.documentElement?.getAttribute("windowtype");
            if (wt !== "Toolkit:PictureInPicture") return;
            try {
              Services.ww.unregisterNotification(observer);
            } catch (e) {}
            if (timeoutId) clearTimeout(timeoutId);
          },
          { once: true },
        );
      },
    };
    Services.ww.registerNotification(observer);
    timeoutId = setTimeout(() => {
      try {
        Services.ww.unregisterNotification(observer);
      } catch (e) {}
    }, 3000);
  }

  // `activate` / `deactivate` fire only on OS-level focus changes of the
  // whole browser window.
  window.addEventListener("deactivate", () => {
    if (!isStreaming) return;
    // yieldAppFocus() itself causes another `deactivate` shortly after we
    // open — debounce so we don't open a second PiP for the echo event.
    if (performance.now() - lastPipOpenAt < PIP_OPEN_DEBOUNCE_MS) return;
    const actor = getActiveActor();
    if (!actor) return;
    awaitNextPipWindow();
    lastPipOpenAt = performance.now();
  });

  pipContainer.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!sourceBC) return;
    try {
      const browserEl = sourceBC.top.embedderElement;
      if (!browserEl) return;
      const gb = window.gBrowser;
      if (!gb) return;
      const tab = gb.getTabForBrowser(browserEl);
      if (tab) gb.selectedTab = tab;
    } catch (err) {
      console.warn("[ZenPiP] focus source tab failed:", err);
    }
  });

  // 3. Define the UI Toggle Logic
  window.ZenPiPController = {
    showVideo: function (stream, browsingContext) {
      // Swap cleanly if a previous stream is still attached.
      if (videoEl.srcObject && videoEl.srcObject !== stream) {
        try {
          videoEl.pause();
        } catch (e) {}
      }
      videoEl.srcObject = stream;
      sourceBC = browsingContext || null;

      // Cancel a pending animate-out so a quick unmute reuses the same node.
      if (animateOutTimer) {
        clearTimeout(animateOutTimer);
        animateOutTimer = null;
      }

      const wasStreaming = isStreaming;
      isStreaming = true;
      startTracking();

      if (wasStreaming) {
        // Already on screen — just swap the stream, no entrance animation.
        pipContainer.style.opacity = userHidden ? "0" : "1";
        pipContainer.style.visibility = userHidden ? "hidden" : "visible";
        pipContainer.style.transform = "";
        return;
      }

      pipContainer.style.display = "block";
      pipContainer.style.visibility = userHidden ? "hidden" : "visible";

      // Set entrance start state without a transition so it doesn't animate
      // from whatever the previous opacity/transform was.
      animating = true;
      pipContainer.style.transition = "none";
      pipContainer.style.opacity = "0";
      pipContainer.style.transform = "scale(0.9) translateY(8px)";
      // Force a reflow so the transition picks up the start state.
      void pipContainer.getBoundingClientRect();
      pipContainer.style.transition = ANIM_TRANSITION;

      requestAnimationFrame(() => {
        pipContainer.style.opacity = userHidden ? "0" : "1";
        pipContainer.style.transform = "scale(1) translateY(0)";
      });
      setTimeout(() => {
        animating = false;
        // Hand opacity control back to syncPosition.
        lastOpacityStr = "";
      }, ANIM_MS + 30);
    },
    hideVideo: function () {
      if (!isStreaming && !animating) return;
      if (animateOutTimer) {
        clearTimeout(animateOutTimer);
        animateOutTimer = null;
      }

      animating = true;
      pipContainer.style.transition = ANIM_TRANSITION;
      pipContainer.style.opacity = "0";
      pipContainer.style.transform = "scale(0.9) translateY(8px)";

      animateOutTimer = setTimeout(() => {
        animateOutTimer = null;
        animating = false;
        try {
          videoEl.pause();
        } catch (e) {}
        videoEl.srcObject = null;
        videoEl.removeAttribute("src");
        try {
          videoEl.load();
        } catch (e) {}
        sourceBC = null;
        pipContainer.style.display = "none";
        pipContainer.style.transition = "none";
        pipContainer.style.transform = "";
        isStreaming = false;
        stopTracking();
        lastOpacityStr = "";
        lastVisible = null;
      }, ANIM_MS + 10);
    },
  };

  // 4. Register the JSWindowActor to bridge the E10s process gap.
  // Map a resource:// URI to this mod's directory so the actor modules
  // (which must be loaded by URI, not inline) are reachable.
  try {
    const { Services } = globalThis;
    const profileDir = Services.dirsvc.get("ProfD", Ci.nsIFile);
    const modDir = profileDir.clone();
    for (const seg of ["chrome", "sine-mods", "PIP Customizations"]) {
      modDir.append(seg);
    }
    const modUri = Services.io.newFileURI(modDir);
    const resProto = Services.io.getProtocolHandler("resource").QueryInterface(Ci.nsIResProtocolHandler);
    if (!resProto.hasSubstitution("zen-sidebar-pip")) {
      resProto.setSubstitution("zen-sidebar-pip", modUri);
    }
    console.log("[ZenPiP] resource mapped to:", modUri.spec, "exists:", modDir.exists());
    ChromeUtils.registerWindowActor("ZenSidebarPiP", {
      parent: {
        esModuleURI: "resource://zen-sidebar-pip/parent-actor.js",
      },
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
    if (e.name !== "NotSupportedError") {
      console.error("Failed to register JSWindowActor:", e);
    }
  }

  console.log("Zen Sidebar PiP initialized.");
})();
