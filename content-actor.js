// Content-process side of the bridge. Captures the playing <video> stream,
// downscales its frames to an OffscreenCanvas, and forwards the raw RGBA
// buffers to the chrome process via JSWindowActor IPC.
//
// Reliability rules:
//  * Only one stream is mirrored per actor at a time.
//  * Any signal that the source is gone (pause, ended, emptied, pagehide)
//    tears down and notifies the parent so the chrome UI hides.

const MAX_FRAME_DIMENSION = 480;
const MAX_FRAMERATE = 30;

// Debug logging hops the process boundary via IPC on every call, so it must
// stay off in normal use. Flip to true only when diagnosing.
const DEBUG = false;

export class ZenSidebarPiPChild extends JSWindowActorChild {
  _debug(...args) {
    if (!DEBUG) return;
    try {
      this.sendAsyncMessage("ZenPiP:Debug", { args: args.map(a => {
        try { return typeof a === "object" ? JSON.stringify(a) : String(a); }
        catch (_) { return String(a); }
      }) });
    } catch (_) {}
  }

  // Longest-edge-capped, even-numbered target dimensions.
  _encodeSize(w, h) {
    const scale = Math.min(1, MAX_FRAME_DIMENSION / Math.max(w, h));
    let tw = Math.max(2, Math.round(w * scale));
    let th = Math.max(2, Math.round(h * scale));
    tw -= tw % 2;
    th -= th % 2;
    return { tw, th };
  }

  handleEvent(event) {
    const target = event.target;
    this._debug("[Zenslop/content]", event.type, target?.tagName, "muted=", target?.muted, "vw=", target?.videoWidth);
    if (!target || target.tagName !== "VIDEO") return;

    if (event.type === "playing") {
      this._tryStart(target);
      return;
    }

    if (event.type === "volumechange") {
      if (this._isAudible(target)) {
        if (!this._video && !target.paused && !target.ended) {
          this._tryStart(target);
        }
      } else if (target === this._video) {
        this._stopAndNotify("volumechange:muted");
      }
      return;
    }

    if (event.type === "pause" || event.type === "ended" || event.type === "emptied") {
      if (target !== this._video) return;
      this._stopAndNotify("event:" + event.type);
    }
  }

  _isAudible(video) {
    return !video.muted && video.volume > 0;
  }

  _tryStart(target) {
    this._debug("[Zenslop/content] tryStart readyState=", target.readyState, "vw=", target.videoWidth, "audible=", this._isAudible(target), "hasVideo=", !!this._video);
    if (this._video) return;
    if (target.readyState < 2 || target.videoWidth === 0) return;
    if (!this._isAudible(target)) return;

    this._attachVideoListeners(target);
    this._startMirror(target);
  }

  _attachVideoListeners(video) {
    const onEnd = (e) => this._stopAndNotify("listener:" + e.type);
    video.addEventListener("ended", onEnd, { once: true });
    video.addEventListener("emptied", onEnd, { once: true });
    this._videoListeners = { onEnd };

    if (!this._pageHideBound) {
      this._pageHideBound = () => this._stopAndNotify("pagehide");
      this.contentWindow.addEventListener("pagehide", this._pageHideBound, {
        once: true,
      });
    }
  }

  _startMirror(video) {
    const win = this.contentWindow;
    const srcWidth = video.videoWidth;
    const srcHeight = video.videoHeight;
    const { tw, th } = this._encodeSize(srcWidth, srcHeight);

    try {
      this._scaleCanvas = new win.OffscreenCanvas(tw, th);
      this._scaleCtx = this._scaleCanvas.getContext("2d", { alpha: false });
    } catch (e) {
      this._debug("[Zenslop/content] OffscreenCanvas creation failed:", e);
      this._stopAndNotify("canvas:construct");
      return;
    }

    this._video = video;
    this._startTime = win.performance.now();
    this._captureFrame();
  }

  _captureFrame() {
    const video = this._video;
    const ctx = this._scaleCtx;
    const canvas = this._scaleCanvas;
    if (!video || !ctx || !canvas) return;
    if (!(video.videoWidth > 0) || video.readyState < 2) return;

    const tw = canvas.width;
    const th = canvas.height;

    try {
      ctx.drawImage(video, 0, 0, tw, th);
      const img = ctx.getImageData(0, 0, tw, th);
      this.sendAsyncMessage("ZenPiP:Frame", {
        buf: img.data.buffer,
        width: tw,
        height: th,
      });
    } catch (e) {
      this._debug("[Zenslop/content] _captureFrame threw:", String(e), e?.name, e?.message);
    }
  }

  _stopAndNotify(reason) {
    this._debug("[Zenslop/content] stopAndNotify reason=", reason, "hadVideo=", !!this._video);
    if (!this._video) return;
    this._teardown();
    try {
      this.sendAsyncMessage("ZenPiP:VideoStopped", { reason });
    } catch (e) {}
  }

  _teardown() {
    if (this._video && this._videoListeners) {
      try {
        this._video.removeEventListener("ended", this._videoListeners.onEnd);
        this._video.removeEventListener("emptied", this._videoListeners.onEnd);
      } catch (_) {}
    }
    if (this._pageHideBound) {
      try {
        this.contentWindow?.removeEventListener("pagehide", this._pageHideBound);
      } catch (_) {}
      this._pageHideBound = null;
    }
    this._video = null;
    this._videoListeners = null;
    this._scaleCanvas = null;
    this._scaleCtx = null;
  }

  async receiveMessage(msg) {
    if (msg.name === "ZenPiP:Tick") {
      this._captureFrame();
      return;
    }
    if (msg.name === "ZenPiP:Stop") {
      this._stopAndNotify("parent:stop");
    }
  }

  didDestroy() {
    this._teardown();
  }
}
