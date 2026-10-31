const QUALITY_TIERS = ["640", "480", "360", "240"];
const DEFAULT_FPS = 15;
const SLOW_FRAME_RATIO = 1.5;
const FAST_FRAME_RATIO = 0.5;
const SLOW_FRAMES_BEFORE_DOWNGRADE = 3;
const FAST_FRAMES_BEFORE_UPGRADE = 30;
// Keepalive re-tick when a frame never comes back (tab throttled, video not
// ready, capture threw). Keeps the loop alive at ~2fps instead of dead.
const SAFETY_TICK_MS = 500;
const CAPTION_TICK_MS = 50;

const DEBUG = false;
const dlog = DEBUG ? (...a) => console.log(...a) : () => {};

export class ZenSidebarPiPParent extends JSWindowActorParent {
  actorCreated() {
    dlog(
      "[Zenslop/parent] actorCreated for browsing context",
      this.browsingContext?.id,
    );
  }

  async receiveMessage(msg) {
    if (msg.name === "ZenPiP:Debug") {
      if (DEBUG) {
        const argsArr = Array.isArray(msg.data?.args) ? msg.data.args : null;
        if (argsArr && argsArr.length > 0) console.log(...argsArr);
      }
      return;
    }

    const win = this.browsingContext.topChromeWindow;
    if (!win) {
      console.error("[Zenslop/parent] No chrome window available");
      return;
    }

    switch (msg.name) {
      case "ZenPiP:ReelRescan": {
        if (this._reelRescanTimeout != null) break;
        this._reelTimerWindow = win;
        this._reelRescanTimeout = win.setTimeout(() => {
          this._reelRescanTimeout = null;
          try { this.sendAsyncMessage("ZenPiP:ReelRescan", {}); } catch (_) {}
        }, 16);
        break;
      }
      case "ZenPiP:FeedBoundary": {
        if (msg.data?.active) await this._wakeFeed(win);
        else this._endFeedWake();
        break;
      }
      case "ZenPiP:NavigationWatch": {
        this._setNavigationWatch(msg.data?.active === true, win);
        break;
      }
      case "ZenPiP:MirrorStarted": {
        this._sourceSerial = msg.data.sourceSerial;
        console.log("[Zenslop/parent] MirrorStarted from tab", this.browsingContext.id, msg.data.width, "x", msg.data.height);
        const controller = win.ZenPiPController;
        if (controller) {
          controller.registerSource(this.browsingContext.id, {
            startTick: (w) => { this._startTicking(w); },
            stopTick: () => { this._stopTicking(); },
            setProcessingActive: (active, captionMode, captionsActive) => {
              this._setProcessingActive(active, captionMode, captionsActive);
            },
            setMaxDimension: (maxDimension) => {
              this._setMaxDimension(maxDimension);
            },
            win,
          });
          controller.offerVideo(msg.data.width, msg.data.height, this.browsingContext, {
            videoRef: msg.data.videoRef,
            sourceSerial: msg.data.sourceSerial,
            shortVideoKind: ["reel", "short"].includes(msg.data.shortVideoKind)
              ? msg.data.shortVideoKind : null,
            documentId: msg.data.documentId,
          });
          // A replacement video should not wait behind the prior frame timer
          // or its background-tab safety timeout.
          if (this._tickScheduled) this._sendTick();
        }
        break;
      }

      case "ZenPiP:Frame": {
        const controller = win.ZenPiPController;
        if (!controller) return;

        const activeBC = typeof controller.getActiveBC === "function" ? controller.getActiveBC() : null;
        if (!activeBC || activeBC.id !== this.browsingContext.id) {
          return;
        }

        // Deliberately no tick restart here: frames only exist in response to
        // ticks, so a stray in-flight frame arriving after capture is stopped
        // must not resurrect the loop while the mirror is hidden. Still draw
        // it — it's the freshest frame we have.
        try {
          controller.drawFrame(msg.data);
        } catch (e) {
          console.error("[Zenslop/parent] drawFrame error:", e?.name, e?.message);
        }

        this._onFrameDelivered();
        this._scheduleNextTick();
        break;
      }

      case "ZenPiP:SourceVisibility": {
        const controller = win.ZenPiPController;
        if (!controller) break;
        const activeBC = typeof controller.getActiveBC === "function" ? controller.getActiveBC() : null;
        if (activeBC && activeBC.id === this.browsingContext.id) {
          const selected = win.gBrowser?.selectedBrowser;
          controller.setSourceTabActive(selected
            ? selected.browsingContext?.id === this.browsingContext.top.id
            : !msg.data.hidden);
        }
        break;
      }

      case "ZenPiP:Caption": {
        if (this._captionMode === "off") break;
        const controller = win.ZenPiPController;
        const activeBC = controller?.getActiveBC?.();
        if (activeBC && activeBC.id === this.browsingContext.id) {
          controller.setCaption(msg.data?.text || "");
        }
        break;
      }

      case "ZenPiP:VideoStopped": {
        if (msg.data?.sourceSerial != null && this._sourceSerial != null &&
            msg.data.sourceSerial !== this._sourceSerial) break;
        const reason = msg.data?.reason || "";
        console.log("[Zenslop/parent] VideoStopped reason:", reason);
        const controller = win.ZenPiPController;
        if (controller) {
          if (controller.getActiveBC?.()?.id === this.browsingContext.id) {
            if (reason.includes("pause")) {
              controller.hideCaption?.();
            } else {
              controller.setCaption?.("");
            }
          }
          controller.unregisterSource(this.browsingContext.id);
          controller.notifySourceStopped(this.browsingContext);
        }
        this._setProcessingActive(false);
        this._stopTicking();
        // The child has already torn down this video. Echoing Stop back can
        // arrive after the next Reel starts and tear down that newer source.
        break;
      }

    }
  }

  async _wakeFeed(win) {
    if (this._feedWake) return;
    const browser = this.browsingContext.top.embedderElement;
    if (!browser || browser === win.gBrowser?.selectedBrowser) return;
    const lease = this._feedWake = { win, browser, active: browser.docShellIsActive, activated: false };
    lease.onSelect = () => {
      if (browser === win.gBrowser?.selectedBrowser) this._endFeedWake();
    };
    win.addEventListener("TabSelect", lease.onSelect);
    lease.timer = win.setTimeout(() => this._endFeedWake(), 3000);
    try {
      // Install playback protection before visibilitychange can run page JS.
      await this.sendQuery("ZenPiP:FeedWakeState", { active: true });
      if (this._feedWake !== lease) return;
      await win.ZenPiPController?.setSourceFeedLoading?.(this.browsingContext.id, true);
      if (this._feedWake !== lease) return;
      lease.activated = true;
      browser.docShellIsActive = true;
    } catch (_) { this._endFeedWake(); }
  }

  _endFeedWake() {
    const lease = this._feedWake;
    if (!lease) return;
    this._feedWake = null;
    lease.win.clearTimeout(lease.timer);
    lease.win.removeEventListener("TabSelect", lease.onSelect);
    if (lease.activated && lease.browser.isConnected !== false &&
        lease.browser !== lease.win.gBrowser?.selectedBrowser) {
      try { lease.browser.docShellIsActive = lease.active; } catch (_) {}
    }
    try { this.sendAsyncMessage("ZenPiP:FeedWakeState", { active: false }); } catch (_) {}
    Promise.resolve(lease.win.ZenPiPController?.setSourceFeedLoading?.(this.browsingContext.id, false))
      .catch(() => {});
  }

  _setNavigationWatch(active, win) {
    if (this._navigationTimer != null) {
      this._navigationWindow?.clearTimeout(this._navigationTimer);
      this._navigationTimer = null;
    }
    this._navigationWindow = active ? win : null;
    if (!active) return;
    const deadline = Date.now() + 4000;
    const poll = () => {
      this._navigationTimer = null;
      if (this._navigationWindow !== win) return;
      if (Date.now() > deadline) {
        this._navigationWindow = null;
        try { this.sendAsyncMessage("ZenPiP:NavigationTimeout", {}); } catch (_) {}
        return;
      }
      try { this.sendAsyncMessage("ZenPiP:NavigationCheck", {}); }
      catch (_) { this._navigationWindow = null; return; }
      this._navigationTimer = win.setTimeout(poll, 250);
    };
    this._navigationTimer = win.setTimeout(poll, 0);
  }

  _startTicking(win) {
    if (this._tickScheduled && this._timerWindow === win) return;
    this._stopTicking();
    this._timerWindow = win;
    this._tickScheduled = true;
    this._currentQualityIndex = this._prefQualityIndex();
    this._frameBudgetMs = this._prefFrameBudget();
    this._lastTickSentAt = 0;
    this._consecutiveSlow = 0;
    this._consecutiveFast = 0;
    if (this._captionsActive) this._startCaptionClock();
    this._sendTick();
    dlog("[Zenslop/parent] Ticking started (self-clocking)");
  }

  _setProcessingActive(active, captionMode = "off", captionsActive = active) {
    this._captionMode = captionMode === "on" || captionMode === "youtube"
      ? captionMode
      : "off";
    this._captionsActive = Boolean(captionsActive) &&
      this._captionMode !== "off";
    try {
      this.sendAsyncMessage("ZenPiP:SetProcessingState", {
        active: Boolean(active),
        captionMode: this._captionMode,
        captionsActive: this._captionsActive,
      });
    } catch (_) {}
    if (this._captionsActive) {
      this._startCaptionClock();
    } else {
      this._stopCaptionClock();
    }
  }

  _setMaxDimension(maxDimension) {
    const value = Math.round(Number(maxDimension));
    this._displayMaxDimension = Number.isFinite(value)
      ? Math.max(160, value)
      : null;
  }

  _now() {
    return this._timerWindow?.performance?.now?.() ?? Date.now();
  }

  // The pref names the best tier the adaptive controller may use; under load
  // it can still downgrade below it, and recovery climbs back up to it.
  _prefQualityIndex() {
    let label = "360";
    try {
      label = Services.prefs.getStringPref("mod.zenslop.quality", "360");
    } catch (_) {}
    const idx = QUALITY_TIERS.indexOf(label);
    return idx === -1 ? 0 : idx;
  }

  _prefFrameBudget() {
    let fps = DEFAULT_FPS;
    try {
      fps = parseInt(
        Services.prefs.getStringPref(
          "mod.zenslop.framerate",
          String(DEFAULT_FPS),
        ),
        10,
      );
    } catch (_) {}
    if (!Number.isFinite(fps)) fps = DEFAULT_FPS;
    fps = Math.max(5, Math.min(30, fps));
    return 1000 / fps;
  }

  _sendTick() {
    if (!this._tickScheduled) return;
    this._clearNextTick();
    this._clearSafetyTimeout();

    const minIndex = this._prefQualityIndex();
    this._frameBudgetMs = this._prefFrameBudget();
    if (this._currentQualityIndex < minIndex) {
      this._currentQualityIndex = minIndex;
    }

    this._lastTickSentAt = this._now();
    this._safetyTimeout = (this._timerWindow || this.browsingContext?.topChromeWindow)
      ?.setTimeout(() => {
        this._safetyTimeout = null;
        if (this._tickScheduled) this._sendTick();
      }, SAFETY_TICK_MS);

    try {
      const tierDimension = parseInt(
        QUALITY_TIERS[this._currentQualityIndex],
        10,
      );
      const captureDimension = this._displayMaxDimension
        ? Math.min(tierDimension, this._displayMaxDimension)
        : tierDimension;
      this.sendAsyncMessage("ZenPiP:Tick", {
        quality: String(captureDimension),
      });
    } catch (e) {
      console.error("[Zenslop/parent] Tick error:", e?.name, e?.message);
    }
  }

  _scheduleNextTick() {
    // The pending-timer check keeps this a single chain: a stale frame from a
    // pre-restart tick must not fork a second tick loop.
    if (!this._tickScheduled || this._nextTickTimer) return;
    const win = this._timerWindow || this.browsingContext?.topChromeWindow;
    if (!win) return;
    const elapsed = this._now() - this._lastTickSentAt;
    const delay = Math.max(0, this._frameBudgetMs - elapsed);
    this._nextTickTimer = win.setTimeout(() => {
      this._nextTickTimer = null;
      this._sendTick();
    }, delay);
  }

  _clearNextTick() {
    if (this._nextTickTimer) {
      const win = this._timerWindow || this.browsingContext?.topChromeWindow;
      try { win?.clearTimeout(this._nextTickTimer); } catch (_) {}
      this._nextTickTimer = null;
    }
  }

  _clearSafetyTimeout() {
    if (this._safetyTimeout) {
      const win = this._timerWindow || this.browsingContext?.topChromeWindow;
      try { win?.clearTimeout(this._safetyTimeout); } catch (_) {}
      this._safetyTimeout = null;
    }
  }

  _startCaptionClock() {
    const win = this._timerWindow || this.browsingContext?.topChromeWindow;
    if (!win || this._captionTimer) return;
    const tick = () => {
      if (!this._captionsActive) return;
      try {
        this.sendAsyncMessage("ZenPiP:CaptionTick", {});
      } catch (_) {}
    };
    tick();
    this._captionTimer = win.setInterval(tick, CAPTION_TICK_MS);
  }

  _stopCaptionClock() {
    if (!this._captionTimer) return;
    const win = this._timerWindow || this.browsingContext?.topChromeWindow;
    try { win?.clearInterval(this._captionTimer); } catch (_) {}
    this._captionTimer = null;
  }

  _onFrameDelivered() {
    if (!this._tickScheduled || !this._lastTickSentAt) return;
    const elapsed = this._now() - this._lastTickSentAt;

    if (elapsed > this._frameBudgetMs * SLOW_FRAME_RATIO) {
      this._consecutiveSlow++;
      this._consecutiveFast = 0;
      if (this._consecutiveSlow >= SLOW_FRAMES_BEFORE_DOWNGRADE &&
          this._currentQualityIndex < QUALITY_TIERS.length - 1) {
        this._currentQualityIndex++;
        this._consecutiveSlow = 0;
        dlog(`[Zenslop/parent] Quality ↓ ${QUALITY_TIERS[this._currentQualityIndex]} (${Math.round(elapsed)}ms)`);
      }
    } else if (elapsed < this._frameBudgetMs * FAST_FRAME_RATIO) {
      this._consecutiveFast++;
      this._consecutiveSlow = 0;
      if (this._consecutiveFast >= FAST_FRAMES_BEFORE_UPGRADE &&
          this._currentQualityIndex > this._prefQualityIndex()) {
        this._currentQualityIndex--;
        this._consecutiveFast = 0;
        dlog(`[Zenslop/parent] Quality ↑ ${QUALITY_TIERS[this._currentQualityIndex]} (${Math.round(elapsed)}ms)`);
      }
    } else {
      this._consecutiveSlow = 0;
      this._consecutiveFast = 0;
    }
  }

  _stopTicking() {
    this._tickScheduled = false;
    this._clearNextTick();
    this._clearSafetyTimeout();
    if (!this._captionsActive) this._stopCaptionClock();
    this._timerWindow = null;
  }

  didDestroy() {
    this._endFeedWake();
    this._setNavigationWatch(false);
    if (this._reelRescanTimeout != null) {
      this._reelTimerWindow?.clearTimeout(this._reelRescanTimeout);
      this._reelRescanTimeout = null;
    }
    this._stopTicking();
    this._setProcessingActive(false);
    try {
      this.sendAsyncMessage("ZenPiP:Stop", {});
    } catch (_) {}
    const win = this.browsingContext?.topChromeWindow;
    if (win && win.ZenPiPController) {
      win.ZenPiPController.unregisterSource(this.browsingContext.id);
      win.ZenPiPController.notifySourceStopped(this.browsingContext);
    }
  }
}
