const MAX_FRAME_DIMENSION = 480;
const MAX_FRAMERATE = 30;

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

  _encodeSize(w, h, maxDim = MAX_FRAME_DIMENSION) {
    const scale = Math.min(1, maxDim / Math.max(w, h));
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

    const ctxOpts = { alpha: false, willReadFrequently: true };
    try {
      if (typeof win.OffscreenCanvas === "function") {
        this._scaleCanvas = new win.OffscreenCanvas(tw, th);
      } else {
        this._scaleCanvas = win.document.createElement("canvas");
        this._scaleCanvas.width = tw;
        this._scaleCanvas.height = th;
      }
      this._scaleCtx = this._scaleCanvas.getContext("2d", ctxOpts);
    } catch (e) {
      try {
        this._scaleCanvas = win.document.createElement("canvas");
        this._scaleCanvas.width = tw;
        this._scaleCanvas.height = th;
        this._scaleCtx = this._scaleCanvas.getContext("2d", ctxOpts);
      } catch (err2) {
        this._debug("[Zenslop/content] canvas creation failed:", err2);
        this._stopAndNotify("canvas:construct");
        return;
      }
    }

    this._video = video;
    this._capturing = false;
    this._startTime = win.performance.now();
    this.sendAsyncMessage("ZenPiP:MirrorStarted", {
      width: srcWidth,
      height: srcHeight,
    });

    const doc = this.contentWindow?.document;
    if (doc && !this._visBound) {
      this._visBound = () => {
        const d = this.contentWindow?.document;
        if (d) this.sendAsyncMessage("ZenPiP:SourceVisibility", { hidden: d.hidden });
      };
      doc.addEventListener("visibilitychange", this._visBound);
    }
    if (doc) {
      this.sendAsyncMessage("ZenPiP:SourceVisibility", { hidden: doc.hidden });
    }
  }

  _captureFrame(quality) {
    const video = this._video;
    const ctx = this._scaleCtx;
    const canvas = this._scaleCanvas;
    const win = this.contentWindow;
    if (!video || !ctx || !canvas || !win) return;
    if (!(video.videoWidth > 0) || video.readyState < 2) return;

    // Drop ticks that land while a previous frame is still encoding so the
    // async encode/IPC pipeline can't queue up and fall behind.
    if (this._capturing) return;

    const maxDim = parseInt(quality, 10) || MAX_FRAME_DIMENSION;
    const { tw, th } = this._encodeSize(video.videoWidth, video.videoHeight, maxDim);

    this._capturing = true;

    // Encode the drawn canvas and ship it. Prefer a JPEG blob (small IPC
    // payload) and fall back to a transferable raw RGBA buffer.
    const shipCanvas = () => {
      const done = () => { this._capturing = false; };

      const sendBlob = (blob) => {
        if (blob && this._video) {
          this.sendAsyncMessage("ZenPiP:Frame", { blob, width: tw, height: th });
        }
        done();
      };

      const sendRaw = () => {
        try {
          const img = ctx.getImageData(0, 0, tw, th);
          this.sendAsyncMessage("ZenPiP:Frame", {
            buf: img.data.buffer,
            width: tw,
            height: th,
          }, [img.data.buffer]);
        } catch (e) {
          this._debug("[Zenslop/content] raw fallback failed:", String(e));
        } finally {
          done();
        }
      };

      if (typeof canvas.convertToBlob === "function") {
        canvas.convertToBlob({ type: "image/jpeg", quality: 0.8 })
          .then(sendBlob)
          .catch((err) => {
            this._debug("[Zenslop/content] convertToBlob failed:", String(err));
            if (typeof canvas.toBlob === "function") {
              canvas.toBlob(sendBlob, "image/jpeg", 0.8);
            } else {
              sendRaw();
            }
          });
      } else if (typeof canvas.toBlob === "function") {
        canvas.toBlob(sendBlob, "image/jpeg", 0.8);
      } else {
        sendRaw();
      }
    };

    // GPU-accelerated downscale via createImageBitmap; fall back to a direct
    // drawImage from the video element if it's unavailable or throws.
    const drawDirect = () => {
      if (canvas.width !== tw || canvas.height !== th) {
        canvas.width = tw;
        canvas.height = th;
      }
      ctx.drawImage(video, 0, 0, tw, th);
      shipCanvas();
    };

    if (typeof win.createImageBitmap === "function") {
      win.createImageBitmap(video, {
        resizeWidth: tw,
        resizeHeight: th,
        resizeQuality: "low",
      })
        .then((bitmap) => {
          if (!this._video) {
            bitmap.close();
            this._capturing = false;
            return;
          }
          if (canvas.width !== tw || canvas.height !== th) {
            canvas.width = tw;
            canvas.height = th;
          }
          try {
            ctx.drawImage(bitmap, 0, 0);
            bitmap.close();
            shipCanvas();
          } catch (e) {
            this._debug("[Zenslop/content] drawImage(bitmap) failed:", String(e));
            this._capturing = false;
          }
        })
        .catch((e) => {
          this._debug("[Zenslop/content] createImageBitmap failed, falling back:", String(e));
          try {
            if (!this._video) {
              this._capturing = false;
              return;
            }
            drawDirect();
          } catch (err2) {
            this._debug("[Zenslop/content] fallback drawImage failed:", String(err2));
            this._capturing = false;
          }
        });
    } else {
      try {
        drawDirect();
      } catch (e) {
        this._debug("[Zenslop/content] _captureFrame threw:", String(e), e?.name, e?.message);
        this._capturing = false;
      }
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
    if (this._visBound) {
      try {
        this.contentWindow?.document.removeEventListener("visibilitychange", this._visBound);
      } catch (_) {}
      this._visBound = null;
    }
    this._video = null;
    this._videoListeners = null;
    this._scaleCanvas = null;
    this._scaleCtx = null;
    this._capturing = false;
  }

  async receiveMessage(msg) {
    if (msg.name === "ZenPiP:Tick") {
      this._captureFrame(msg.data?.quality);
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
