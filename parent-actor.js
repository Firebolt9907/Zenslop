// Chrome-process side. Receives encoded video chunks from the content actor,
// decodes them with WebCodecs, feeds the resulting frames into a
// MediaStreamTrackGenerator, and hands the synthesized MediaStream to the
// chrome window's ZenPiPController.
//
// Replaces the previous WebRTC loopback bridge — chrome-process
// RTCPeerConnection no longer gathers ICE candidates in modern Firefox.

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
    if (!win.MediaStreamTrackGenerator || !win.VideoDecoder) {
      console.log("[Zenslop/parent] WebCodecs unavailable in chrome window",
        "hasGen=", !!win.MediaStreamTrackGenerator, "hasDec=", !!win.VideoDecoder);
      return false;
    }

    let generator;
    try {
      generator = new win.MediaStreamTrackGenerator({ kind: "video" });
    } catch (e) {
      console.log("[Zenslop/parent] MediaStreamTrackGenerator threw:", e?.message || e);
      return false;
    }
    this._generator = generator;
    this._writer = generator.writable.getWriter();

    const decoder = new win.VideoDecoder({
      output: (frame) => {
        if (!this._writer) {
          frame.close();
          return;
        }
        this._writer.write(frame).catch((e) => {
          console.log("[Zenslop/parent] writer.write rejected:", e?.message || e);
          try { frame.close(); } catch (_) {}
        });
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

    const stream = new win.MediaStream([generator]);
    if (win.ZenPiPController) {
      console.log("[Zenslop/parent] calling showVideo");
      win.ZenPiPController.showVideo(stream, this.browsingContext);
      this._win = win;
    } else {
      console.log("[Zenslop/parent] ZenPiPController missing on win");
    }
    return true;
  }

  _handleStop() {
    if (this._writer) {
      try { this._writer.close(); } catch (_) {}
      this._writer = null;
    }
    if (this._decoder) {
      try { this._decoder.close(); } catch (_) {}
      this._decoder = null;
    }
    this._generator = null;

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
