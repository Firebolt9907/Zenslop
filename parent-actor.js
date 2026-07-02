// Chrome-process side. Receives downscaled raw RGBA frames from the content actor
// and paints them directly onto the sidebar canvas via ZenPiPController.drawFrame().
//
// Frame extraction is driven by a chrome-process setInterval that ticks the
// content actor at TICK_INTERVAL_MS — rVFC on the content side is throttled
// to zero in background tabs, which would otherwise stall the mirror whenever
// the user navigates away from the source tab.

const TICK_INTERVAL_MS = 33; // ~30 fps

// Flip to true only when diagnosing. Logging on the hot path (every frame, at
// 30 fps) is a serious performance drain, so it must stay off in normal use.
const DEBUG = false;
const dlog = DEBUG ? (...a) => console.log(...a) : () => {};

export class ZenSidebarPiPParent extends JSWindowActorParent {
  async receiveMessage(msg) {
    if (msg.name === "ZenPiP:Debug") {
      if (DEBUG) {
        const argsArr = Array.isArray(msg.data?.args) ? msg.data.args : null;
        if (argsArr && argsArr.length > 0) console.log(...argsArr);
      }
      return;
    }

    const win = this.browsingContext.topChromeWindow;
    if (!win) return;

    switch (msg.name) {
      case "ZenPiP:Frame": {
        const controller = win.ZenPiPController;
        if (!controller) return;

        const activeBC = typeof controller.getActiveBC === "function" ? controller.getActiveBC() : null;
        if (this._tickInterval) {
          if (activeBC && activeBC.id !== this.browsingContext.id) {
            this._handleStop();
            return;
          }
        } else {
          this._startTicking(win);
          try {
            controller.showVideo(msg.data.width, msg.data.height, this.browsingContext);
          } catch (e) {
            dlog("[Zenslop/parent] showVideo threw:", e?.name, e?.message || e);
          }
          this._win = win;
        }

        try {
          controller.drawFrame(msg.data);
        } catch (e) {
          dlog("[Zenslop/parent] drawFrame threw:", e?.name, e?.message || e);
        }
        break;
      }
      case "ZenPiP:VideoStopped": {
        this._handleStop();
        break;
      }
    }
  }

  _startTicking(win) {
    this._stopTicking();
    dlog("[Zenslop/parent] starting tick interval");
    this._timerWindow = win;
    this._tickInterval = win.setInterval(() => {
      try {
        let quality = "480";
        try {
          quality = win.Services.prefs.getStringPref("mod.zenslop.quality", "480");
        } catch (_) {}
        this.sendAsyncMessage("ZenPiP:Tick", { quality });
      } catch (_) {}
    }, TICK_INTERVAL_MS);
  }

  _stopTicking() {
    if (this._tickInterval) {
      const win = this._timerWindow || this.browsingContext?.topChromeWindow;
      try {
        win?.clearInterval(this._tickInterval);
      } catch (_) {}
      this._tickInterval = null;
      this._timerWindow = null;
    }
  }

  _handleStop() {
    this._stopTicking();
    try {
      this.sendAsyncMessage("ZenPiP:Stop", {});
    } catch (_) {}
    const win = this._win || this.browsingContext?.topChromeWindow;
    if (win && win.ZenPiPController) {
      const activeBC = typeof win.ZenPiPController.getActiveBC === "function" ? win.ZenPiPController.getActiveBC() : null;
      if (!activeBC || activeBC.id === this.browsingContext.id) {
        win.ZenPiPController.hideVideo();
      }
    }
    this._win = null;
  }

  didDestroy() {
    this._handleStop();
  }
}
