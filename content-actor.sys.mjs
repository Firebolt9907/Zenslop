const MAX_FRAME_DIMENSION = 480;

const DEBUG = false;

export class ZenSidebarPiPChild extends JSWindowActorChild {
  actorCreated() {
    this._processingActive = false;
    this._lastCaptionText = "";
    this._captionText = "";
    this._debug(
      "[Zenslop/content] actorCreated",
      this.contentWindow?.location?.href,
    );
    // Sine can register this actor after session-restore has already resumed a
    // video. In that case none of the media events below are replayed, so do
    // an immediate scan as soon as the actor is forced into existence.
    this._scanForPlayingVideo();

    const win = this.contentWindow;
    const doc = win?.document;
    if (!win || !doc || this._videoObserver) return;

    try {
      this._videoObserver = new win.MutationObserver(() => {
        if (!this._video) this._scanForPlayingVideo();
      });
      this._videoObserver.observe(doc, { childList: true, subtree: true });
    } catch (_) {
      this._videoObserver = null;
    }
  }

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
    if (event.type === "DOMContentLoaded" || event.type === "pageshow") {
      this._scanForPlayingVideo();
      return;
    }

    if (!target || target.tagName !== "VIDEO") return;

    if (
      event.type === "play" ||
      event.type === "playing" ||
      event.type === "loadedmetadata" ||
      event.type === "canplay"
    ) {
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

  _scanForPlayingVideo() {
    if (this._video) return;
    let videos;
    try {
      videos = this.contentWindow?.document?.querySelectorAll("video");
    } catch (_) {
      return;
    }
    if (!videos) return;

    for (const video of videos) {
      if (
        !video.paused &&
        !video.ended &&
        video.readyState >= 2 &&
        video.videoWidth > 0 &&
        this._isAudible(video)
      ) {
        this._tryStart(video);
        break;
      }
    }
  }

  _tryStart(target) {
    this._debug("[Zenslop/content] tryStart readyState=", target.readyState, "vw=", target.videoWidth, "audible=", this._isAudible(target), "hasVideo=", !!this._video);
    if (this._video) return;
    if (target.paused || target.ended) return;
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

    this._video = video;
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

    if (this._processingActive) this._startCaptionTracking();
  }

  _isYouTubeDocument() {
    try {
      const host = this.contentWindow?.location?.hostname || "";
      return (
        host === "youtube.com" ||
        host.endsWith(".youtube.com") ||
        host === "youtube-nocookie.com" ||
        host.endsWith(".youtube-nocookie.com")
      );
    } catch (_) {
      return false;
    }
  }

  _startCaptionTracking() {
    if (!this._video || !this._processingActive || !this._isYouTubeDocument()) {
      return;
    }
    if (this._captionRootObserver) {
      this._refreshCaptionRoot();
      this._syncCaption();
      return;
    }

    const win = this.contentWindow;
    const doc = win?.document;
    const player = doc?.querySelector(".html5-video-player") || doc?.documentElement;
    if (!win || !player) return;

    try {
      // This lightweight observer only looks for YouTube replacing its caption
      // container. Caption text itself is observed on the much smaller
      // container below, rather than on the entire player subtree.
      this._captionRootObserver = new win.MutationObserver(() => {
        this._refreshCaptionRoot();
      });
      this._captionRootObserver.observe(player, {
        childList: true,
        subtree: true,
      });

      const ccButton = doc.querySelector(".ytp-subtitles-button");
      if (ccButton) {
        this._ccButtonObserver = new win.MutationObserver(() => {
          this._queueCaptionSync();
        });
        this._ccButtonObserver.observe(ccButton, {
          attributes: true,
          attributeFilter: ["aria-pressed"],
        });
      }
    } catch (_) {
      this._captionRootObserver = null;
      this._ccButtonObserver = null;
    }
    this._refreshCaptionRoot();
    this._syncCaption();
  }

  _refreshCaptionRoot() {
    const win = this.contentWindow;
    const doc = win?.document;
    const nextRoot = doc?.querySelector(".ytp-caption-window-container") || null;
    if (nextRoot === this._captionRoot) return;

    try {
      this._captionObserver?.disconnect();
    } catch (_) {}
    this._captionObserver = null;
    this._captionRoot = nextRoot;

    if (win && nextRoot) {
      this._captionObserver = new win.MutationObserver(() => {
        this._queueCaptionSync();
      });
      this._captionObserver.observe(nextRoot, {
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter: ["class", "style", "aria-hidden"],
        subtree: true,
      });
    }
    this._queueCaptionSync();
  }

  _queueCaptionSync() {
    if (this._captionSyncQueued || !this._processingActive) return;
    const win = this.contentWindow;
    if (!win) return;
    this._captionSyncQueued = true;
    win.queueMicrotask(() => {
      this._captionSyncQueued = false;
      this._syncCaption();
    });
  }

  _visibleCaptionText(root) {
    const win = this.contentWindow;
    if (!win || !root) return "";
    const pieces = [];
    const visit = (node) => {
      if (node.nodeType === 3) {
        pieces.push(node.nodeValue || "");
        return;
      }
      if (node.nodeType !== 1) return;
      if (node.getAttribute("aria-hidden") === "true") return;
      const style = win.getComputedStyle(node);
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        style.visibility === "collapse" ||
        Number.parseFloat(style.opacity) === 0
      ) {
        return;
      }
      for (const child of node.childNodes) visit(child);
    };
    visit(root);
    return pieces.join("").replace(/\s+/g, " ").trim();
  }

  _syncCaption() {
    if (!this._video || !this._processingActive || !this._isYouTubeDocument()) {
      this._captionText = "";
      return "";
    }

    const doc = this.contentWindow?.document;
    if (!doc) return this._captionText;
    const ccButton = doc.querySelector(".ytp-subtitles-button");
    const captionsEnabled =
      !ccButton ||
      ccButton.getAttribute("aria-pressed") === "true" ||
      ccButton.classList.contains("ytp-button-active");

    let text = "";
    if (captionsEnabled) {
      const parts = [];
      for (const segment of doc.querySelectorAll(".ytp-caption-segment")) {
        const windowEl = segment.closest(".caption-window");
        const windowStyle = windowEl
          ? this.contentWindow.getComputedStyle(windowEl)
          : null;
        if (
          windowStyle?.display === "none" ||
          windowStyle?.visibility === "hidden" ||
          windowStyle?.opacity === "0"
        ) {
          continue;
        }
        // YouTube sometimes inserts a complete automatic-caption cue and
        // reveals its descendants word by word. Reading only visible text
        // keeps those rolling words incremental instead of exposing the full
        // cue early.
        const value = this._visibleCaptionText(segment);
        if (value) parts.push(value);
      }
      text = parts.join(" ").replace(/\s+/g, " ").trim();
    }

    this._captionText = text;
    return text;
  }

  _sendCaption(text) {
    if (text === this._lastCaptionText) return;
    this._lastCaptionText = text;
    try {
      this.sendAsyncMessage("ZenPiP:Caption", { text });
    } catch (_) {}
  }

  _stopCaptionTracking(clear = true) {
    try {
      this._captionObserver?.disconnect();
      this._captionRootObserver?.disconnect();
      this._ccButtonObserver?.disconnect();
    } catch (_) {}
    this._captionObserver = null;
    this._captionRootObserver = null;
    this._captionRoot = null;
    this._ccButtonObserver = null;
    this._captionSyncQueued = false;
    this._captionText = "";
    if (clear) this._sendCaption("");
  }

  _setProcessingActive(active) {
    active = Boolean(active);
    if (this._processingActive === active) return;
    this._processingActive = active;
    if (active) {
      this._startCaptionTracking();
    } else {
      this._stopCaptionTracking(false);
    }
  }

  _ensureScaleContext(tw, th) {
    if (this._scaleCtx) return this._scaleCtx;
    const win = this.contentWindow;
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
        this._scaleCanvas = null;
        this._scaleCtx = null;
        this._stopAndNotify("canvas:construct");
      }
    }
    return this._scaleCtx;
  }

  _captureFrame(quality) {
    const video = this._video;
    if (!video || !this._processingActive) return;
    if (!(video.videoWidth > 0) || video.readyState < 2) return;
    // Note: we intentionally do NOT bail on video.seeking here. Holding the
    // last frame through a fast-forward reads as a disruptive "buffering"
    // freeze, and for music videos the visual is secondary — keeping the feed
    // live is preferable to a stall.

    const maxDim = parseInt(quality, 10) || MAX_FRAME_DIMENSION;
    const { tw, th } = this._encodeSize(video.videoWidth, video.videoHeight, maxDim);

    const ctx = this._ensureScaleContext(tw, th);
    const canvas = this._scaleCanvas;
    if (!ctx || !canvas) return;
    if (canvas.width !== tw || canvas.height !== th) {
      canvas.width = tw;
      canvas.height = th;
    }

    try {
      // Read the caption in the same turn as the video surface and transfer
      // both in one actor message. Sending DOM mutations independently made a
      // fresh caption race an older frame while the source tab was throttled.
      // A frame-paced snapshot also preserves YouTube's incremental ASR word
      // updates without introducing a second timer.
      const caption = this._syncCaption();
      // Synchronous downscale + readback, shipped as a transferable RGBA
      // buffer. An ImageBitmap cannot cross the JSActor boundary — Gecko's
      // structured clone restricts it to same-process scope — so a copied
      // ArrayBuffer is the wire format. willReadFrequently keeps the
      // getImageData readback cheap.
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      this.sendAsyncMessage("ZenPiP:Frame", {
        buf: img.data.buffer,
        width: canvas.width,
        height: canvas.height,
        caption,
      }, [img.data.buffer]);
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
    this._stopCaptionTracking(true);
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
  }

  async receiveMessage(msg) {
    if (msg.name === "ZenPiP:Tick") {
      // No doc.hidden gate here: the mirror is shown precisely when the
      // source tab is backgrounded, so hidden is the state we capture in.
      // Visibility gating is controlled by the chrome-window controller.
      this._captureFrame(msg.data?.quality);
      return;
    }
    if (msg.name === "ZenPiP:Stop") {
      this._stopAndNotify("parent:stop");
      return;
    }
    if (msg.name === "ZenPiP:SetProcessingState") {
      this._setProcessingActive(msg.data?.active);
    }
  }

  didDestroy() {
    try {
      this._videoObserver?.disconnect();
    } catch (_) {}
    this._videoObserver = null;
    this._teardown();
  }
}
