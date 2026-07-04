const TICK_INTERVAL_MS = 33;

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

        if (!this._tickInterval) {
          this._startTicking(win);
        }

        try {
          controller.drawFrame(msg.data);
        } catch (e) {
          console.error("[Zenslop/parent] drawFrame error:", e?.name, e?.message);
        }
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

      case "ZenPiP:VideoStopped": {
        console.log("[Zenslop/parent] VideoStopped reason:", msg.data?.reason);
        const controller = win.ZenPiPController;
        if (controller) {
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
    this._tickInterval = win.setInterval(() => {
      try {
        let quality = "480";
        try {
          quality = Services.prefs.getStringPref("mod.zenslop.quality", "480");
        } catch (_) {}
        this.sendAsyncMessage("ZenPiP:Tick", { quality });
      } catch (e) {
        console.error("[Zenslop/parent] Tick error:", e?.name, e?.message);
      }
    }, TICK_INTERVAL_MS);
    dlog("[Zenslop/parent] Ticking started");
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

  didDestroy() {
    this._stopTicking();
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
