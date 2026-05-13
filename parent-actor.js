// Chrome-process side. Receives encoded video chunks from the content actor,
// decodes them with WebCodecs, and paints the decoded VideoFrames directly
// onto the sidebar canvas via ZenPiPController.drawFrame().
//
// MediaStreamTrackGenerator isn't available in the chrome window in modern
// Firefox, so we render to a canvas instead of synthesizing a MediaStream.
//
// Frame extraction is driven by a chrome-process setInterval that ticks the
// content actor at TICK_INTERVAL_MS — rVFC on the content side is throttled
// to zero in background tabs, which would otherwise stall the mirror whenever
// the user navigates away from the source tab.

const TICK_INTERVAL_MS = 33; // ~30 fps

export class ZenSidebarPiPParent extends JSWindowActorParent {
  async receiveMessage(msg) {
    // Dump everything for diagnosis.
    const argsArr = Array.isArray(msg.data?.args) ? msg.data.args : null;
    if (argsArr) {
      console.log("[Zenslop/parent RX]", msg.name, JSON.stringify(argsArr));
    } else {
      console.log("[Zenslop/parent RX]", msg.name, JSON.stringify(msg.data));
    }

    if (msg.name !== "ZenPiP:VideoStopped" && !this._tickInterval) {
      this._startTicking();
    }

    if (msg.name === "ZenPiP:Debug") {
      if (argsArr && argsArr.length > 0) console.log(...argsArr);
      return;
    }
    console.log("[Zenslop/parent]", msg.name);

    const win = this.browsingContext.topChromeWindow;
    if (!win) return;

    switch (msg.name) {
      case "ZenPiP:EncoderReady": {
        // Tick already started above; nothing else needed here.
        break;
      }
      case "ZenPiP:Frame": {
        await this._handleFrame(win, msg.data);
        break;
      }
      case "ZenPiP:VideoStopped": {
        this._handleStop();
        break;
      }
    }
  }

  _startTicking() {
    this._stopTicking();
    console.log("[Zenslop/parent] starting tick interval");
    this._tickInterval = setInterval(() => {
      try {
        this.sendAsyncMessage("ZenPiP:Tick", {});
      } catch (_) {}
    }, TICK_INTERVAL_MS);
  }

  _stopTicking() {
    if (this._tickInterval) {
      clearInterval(this._tickInterval);
      this._tickInterval = null;
    }
  }

  async _handleFrame(win, payload) {
    if (!this._decoder) {
      if (!payload.config) return;
      const ok = this._setupDecoder(win, payload.config);
      if (!ok) return;
    }

    let chunk;
    try {
      chunk = new win.EncodedVideoChunk({
        type: payload.type,
        timestamp: payload.timestamp,
        duration: payload.duration,
        data: payload.data,
      });
    } catch (e) {
      console.log("[Zenslop/parent] EncodedVideoChunk threw:", e?.message || e);
      return;
    }

    try {
      this._decoder.decode(chunk);
    } catch (e) {
      console.log("[Zenslop/parent] decode threw:", e?.message || e);
    }
  }

  _setupDecoder(win, config) {
    if (typeof win.VideoDecoder !== "function") {
      console.log("[Zenslop/parent] VideoDecoder unavailable in chrome window");
      return false;
    }
    if (!win.ZenPiPController) {
      console.log("[Zenslop/parent] ZenPiPController missing on win");
      return false;
    }

    let decodedCount = 0;
    const decoder = new win.VideoDecoder({
      output: (frame) => {
        decodedCount++;
        if (decodedCount <= 3 || decodedCount % 120 === 0) {
          console.log("[Zenslop/parent] decoded frame", decodedCount, "ts=", frame.timestamp);
        }
        try {
          win.ZenPiPController.drawFrame(frame);
        } catch (e) {
          console.log("[Zenslop/parent] drawFrame threw:", e?.message || e);
        }
        try { frame.close(); } catch (_) {}
      },
      error: (e) => {
        console.log("[Zenslop/parent] decoder error:", e?.message || e);
        this._handleStop();
      },
    });

    try {
      const cfg = {
        codec: config.codec,
        codedWidth: config.codedWidth,
        codedHeight: config.codedHeight,
      };
      if (config.description) cfg.description = config.description;
      decoder.configure(cfg);
    } catch (e) {
      console.log("[Zenslop/parent] decoder.configure threw:", e?.message || e);
      return false;
    }
    this._decoder = decoder;
    console.log("[Zenslop/parent] decoder configured", config.codedWidth, "x", config.codedHeight);

    win.ZenPiPController.showVideo(config.codedWidth, config.codedHeight, this.browsingContext);
    this._win = win;
    return true;
  }

  _handleStop() {
    this._stopTicking();
    if (this._decoder) {
      try { this._decoder.close(); } catch (_) {}
      this._decoder = null;
    }
    const win = this._win || this.browsingContext?.topChromeWindow;
    if (win && win.ZenPiPController) {
      win.ZenPiPController.hideVideo();
    }
    this._win = null;
  }

  didDestroy() {
    this._handleStop();
  }
}
