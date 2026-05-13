// Content-process side of the bridge. Captures the playing <video> stream,
// encodes its frames with WebCodecs, and forwards the encoded chunks to the
// chrome process via JSWindowActor IPC.
//
// Why not WebRTC? Modern Firefox (post the WebRTC-out-of-parent-process
// refactor) doesn't gather ICE candidates for an RTCPeerConnection constructed
// in a chrome window, so a loopback PC between content and chrome never
// converges. WebCodecs over IPC is the working substitute: encoded chunks are
// ArrayBuffers and transfer cleanly across the actor boundary.
//
// Reliability rules:
//  * Only one stream is mirrored per actor at a time.
//  * Any signal that the source is gone (pause, ended, emptied, pagehide,
//    track.onended) tears down and notifies the parent so the chrome UI hides.
//  * Encode is bitrate/framerate capped — software encode of full-res YouTube
//    will otherwise pin a core.

const MAX_BITRATE_BPS = 8_000_000;
const MAX_FRAMERATE = 60;
const CODEC = "vp8";
const KEYFRAME_INTERVAL = 60;

export class ZenSidebarPiPChild extends JSWindowActorChild {
  _debug(...args) {
    try {
      this.sendAsyncMessage("ZenPiP:Debug", { args: args.map(a => {
        try { return typeof a === "object" ? JSON.stringify(a) : String(a); }
        catch (_) { return String(a); }
      }) });
    } catch (_) {}
  }

  async handleEvent(event) {
    const target = event.target;
    this._debug("[Zenslop/content]", event.type, target?.tagName, "muted=", target?.muted, "vw=", target?.videoWidth);
    if (!target || target.tagName !== "VIDEO") return;

    if (event.type === "playing") {
      await this._tryStart(target);
      return;
    }

    if (event.type === "volumechange") {
      if (this._isAudible(target)) {
        if (!this._encoder && !target.paused && !target.ended) {
          await this._tryStart(target);
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

  async _tryStart(target) {
    this._debug("[Zenslop/content] tryStart readyState=", target.readyState, "vw=", target.videoWidth, "audible=", this._isAudible(target), "encoderExists=", !!this._encoder);
    if (this._encoder) return;
    if (target.readyState < 2 || target.videoWidth === 0) return;
    if (!this._isAudible(target)) return;

    let stream;
    try {
      if (typeof target.captureStream === "function") {
        stream = target.captureStream();
      } else if (typeof target.mozCaptureStream === "function") {
        stream = target.mozCaptureStream();
      }
    } catch (e) {
      this._debug("[Zenslop/content] captureStream threw:", e?.name, e?.message);
      return;
    }
    const videoTracks = stream?.getVideoTracks?.() || [];
    this._debug("[Zenslop/content] stream tracks=", videoTracks.length);
    if (videoTracks.length === 0) return;

    this._stream = stream;
    this._video = target;
    this._attachVideoListeners(target);
    await this._startEncoder(target);
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

  async _startEncoder(video) {
    const win = this.contentWindow;
    const hasVF = typeof win.VideoFrame === "function";
    const hasEnc = typeof win.VideoEncoder === "function";
    const hasRVFC = typeof video.requestVideoFrameCallback === "function";
    if (!hasVF || !hasEnc || !hasRVFC) {
      this._debug("[Zenslop/content] WebCodecs unavailable", "hasVF=", hasVF, "hasEnc=", hasEnc, "hasRVFC=", hasRVFC);
      this._stopAndNotify("webcodecs:unavailable");
      return;
    }

    const width = video.videoWidth;
    const height = video.videoHeight;
    let configSent = false;
    const epoch = ++this._epoch;

    let outputCount = 0;
    const encoder = new win.VideoEncoder({
      output: (chunk, metadata) => {
        if (outputCount < 3) this._debug("[Zenslop/content] encoder output", outputCount, "type=", chunk.type, "bytes=", chunk.byteLength, "hasConfig=", !!metadata?.decoderConfig);
        outputCount++;
        if (this._epoch !== epoch) return;
        const buf = new ArrayBuffer(chunk.byteLength);
        chunk.copyTo(buf);
        const payload = {
          data: buf,
          timestamp: chunk.timestamp,
          duration: chunk.duration,
          type: chunk.type,
        };
        if (!configSent && metadata?.decoderConfig) {
          const dc = metadata.decoderConfig;
          payload.config = {
            codec: dc.codec,
            codedWidth: dc.codedWidth,
            codedHeight: dc.codedHeight,
          };
          if (dc.description) {
            const descBuf = new ArrayBuffer(dc.description.byteLength);
            new Uint8Array(descBuf).set(new Uint8Array(dc.description));
            payload.config.description = descBuf;
          }
          configSent = true;
        }
        try {
          this.sendAsyncMessage("ZenPiP:Frame", payload);
        } catch (_) {}
      },
      error: (e) => {
        this._debug("[Zenslop/content] encoder error:", e?.message || String(e));
        this._stopAndNotify("encoder:error");
      },
    });

    try {
      encoder.configure({
        codec: CODEC,
        width,
        height,
        bitrate: MAX_BITRATE_BPS,
        framerate: MAX_FRAMERATE,
        latencyMode: "realtime",
      });
    } catch (e) {
      this._debug("[Zenslop/content] encoder.configure threw:", e?.name, e?.message);
      this._stopAndNotify("encoder:configure");
      return;
    }
    this._encoder = encoder;
    this._debug("[Zenslop/content] encoder configured", width, "x", height);

    let frameCount = 0;
    const onFrame = (_now, metadata) => {
      if (frameCount < 3) this._debug("[Zenslop/content] rVFC fired", frameCount, "qsize=", encoder.encodeQueueSize, "state=", encoder.state);
      if (this._epoch !== epoch || !this._encoder) return;
      if (encoder.state !== "configured") return;
      if (encoder.encodeQueueSize <= 2) {
        let frame;
        try {
          const ts = Math.round((metadata?.mediaTime ?? 0) * 1_000_000);
          frame = new win.VideoFrame(video, { timestamp: ts });
          if (frameCount < 3) this._debug("[Zenslop/content] VideoFrame constructed", frame.codedWidth, "x", frame.codedHeight);
        } catch (e) {
          this._debug("[Zenslop/content] VideoFrame ctor threw:", e?.name, e?.message);
          this._stopAndNotify("videoframe:construct");
          return;
        }
        try {
          encoder.encode(frame, { keyFrame: frameCount % KEYFRAME_INTERVAL === 0 });
          if (frameCount < 3) this._debug("[Zenslop/content] encode called", frameCount);
        } catch (e) {
          this._debug("[Zenslop/content] encode threw:", e?.name, e?.message);
        }
        frame.close();
        frameCount++;
      }
      try { video.requestVideoFrameCallback(onFrame); } catch (_) {}
    };
    this._debug("[Zenslop/content] scheduling rVFC");
    try { video.requestVideoFrameCallback(onFrame); } catch (e) {
      this._debug("[Zenslop/content] rVFC schedule threw:", e?.name, e?.message);
      this._stopAndNotify("rvfc:schedule");
    }
  }

  _stopAndNotify(reason) {
    this._debug("[Zenslop/content] stopAndNotify reason=", reason, "hadEnc=", !!this._encoder, "hadVideo=", !!this._video);
    if (!this._encoder && !this._video) return;
    this._teardown();
    try {
      this.sendAsyncMessage("ZenPiP:VideoStopped", { reason });
    } catch (e) {}
  }

  _teardown() {
    this._epoch = (this._epoch || 0) + 1;
    if (this._encoder) {
      try { this._encoder.close(); } catch (_) {}
      this._encoder = null;
    }
    if (this._stream) {
      try {
        for (const t of this._stream.getTracks()) t.stop();
      } catch (e) {}
      this._stream = null;
    }
    this._video = null;
    this._videoListeners = null;
  }

  async receiveMessage(msg) {
    if (msg.name === "ZenPiP:Stop") {
      this._stopAndNotify("parent:stop");
    }
  }

  didDestroy() {
    this._teardown();
  }
}
