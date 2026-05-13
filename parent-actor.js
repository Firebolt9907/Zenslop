// Chrome-process side. Receives encoded video chunks from the content actor,
// decodes them with WebCodecs, and paints the decoded VideoFrames directly
// onto the sidebar canvas via ZenPiPController.drawFrame().
//
// MediaStreamTrackGenerator isn't available in the chrome window in modern
// Firefox, so we render to a canvas instead of synthesizing a MediaStream.

export class ZenSidebarPiPParent extends JSWindowActorParent {
  async receiveMessage(msg) {
    if (msg.name === "ZenPiP:Debug") {
      console.log(...(msg.data?.args || []));
      return;
    }
    console.log("[Zenslop/parent]", msg.name);

    const win = this.browsingContext.topChromeWindow;
    if (!win) return;

    switch (msg.name) {
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

    const decoder = new win.VideoDecoder({
      output: (frame) => {
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
