const QUALITY_TIERS = ["640", "480", "360", "240"];
const DEFAULT_FPS = 15;
const SLOW_FRAME_RATIO = 1.5;
const FAST_FRAME_RATIO = 0.5;
const SLOW_FRAMES_BEFORE_DOWNGRADE = 3;
const FAST_FRAMES_BEFORE_UPGRADE = 30;
// Keepalive re-tick when a frame never comes back (tab throttled, video not
// ready, capture threw). Keeps the loop alive at ~2fps instead of dead.
const SAFETY_TICK_MS = 500;

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
      case "ZenPiP:MirrorStarted": {
        console.log("[Zenslop/parent] MirrorStarted from tab", this.browsingContext.id, msg.data.width, "x", msg.data.height);
        const controller = win.ZenPiPController;
        if (controller) {
          controller.registerSource(this.browsingContext.id, {
            startTick: (w) => { this._startTicking(w); },
            stopTick: () => { this._stopTicking(); },
            setProcessingActive: (active) => {
              this._setProcessingActive(active);
            },
            setMaxDimension: (maxDimension) => {
              this._setMaxDimension(maxDimension);
            },
            win,
          });
          controller.offerVideo(msg.data.width, msg.data.height, this.browsingContext);
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
          controller.setSourceTabActive(!msg.data.hidden);
        }
        break;
      }

      case "ZenPiP:Caption": {
        const controller = win.ZenPiPController;
        const activeBC = controller?.getActiveBC?.();
        if (activeBC && activeBC.id === this.browsingContext.id) {
          controller.setCaption(msg.data?.text || "");
        }
        break;
      }

      case "ZenPiP:VideoStopped": {
        console.log("[Zenslop/parent] VideoStopped reason:", msg.data?.reason);
        const controller = win.ZenPiPController;
        if (controller) {
          controller.setCaption?.("");
          controller.unregisterSource(this.browsingContext.id);
          controller.notifySourceStopped(this.browsingContext);
        }
        this._stopTicking();
        try {
          this.sendAsyncMessage("ZenPiP:Stop", {});
        } catch (_) {}
        break;
      }

    }
  }

  _startTicking(win) {
    this._stopTicking();
    this._timerWindow = win;
    this._tickScheduled = true;
    this._currentQualityIndex = this._prefQualityIndex();
    this._frameBudgetMs = this._prefFrameBudget();
    this._lastTickSentAt = 0;
    this._consecutiveSlow = 0;
    this._consecutiveFast = 0;
    this._sendTick();
    dlog("[Zenslop/parent] Ticking started (self-clocking)");
  }

  _setProcessingActive(active) {
    try {
      this.sendAsyncMessage("ZenPiP:SetProcessingState", {
        active: Boolean(active),
      });
    } catch (_) {}
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
    this._timerWindow = null;
  }

  didDestroy() {
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
