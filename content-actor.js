// Content-process side of the bridge. Captures the playing <video> stream
// and forwards it to the chrome process via WebRTC.
//
// Reliability rules:
//  * Only one stream is mirrored per actor at a time. If a new video starts
//    playing we keep the existing one; if the existing one ends/pauses we
//    free the slot so a future `playing` can take it.
//  * Any signal that the source is gone (pause, ended, emptied, pagehide,
//    track.onended) tears down and notifies the parent so the chrome UI hides.
//  * Encode is bitrate/framerate capped — software encode of full-res YouTube
//    will otherwise pin a core.

const MAX_BITRATE_BPS = 8_000_000; // ~8 Mbps — vertical sources are pixel-dense
const MIN_BITRATE_BPS = 2_500_000; // floor so the encoder doesn't crawl up from ~300kbps
const MAX_FRAMERATE = 60;

export class ZenSidebarPiPChild extends JSWindowActorChild {
  async handleEvent(event) {
    const target = event.target;
    if (!target || target.tagName !== "VIDEO") return;

    if (event.type === "playing") {
      await this._tryStart(target);
      return;
    }

    if (event.type === "volumechange") {
      // Mute/unmute is the strongest signal that a <video> is an ad vs. actual
      // content the user wants to watch. Sites autoplay ads muted; the user
      // unmutes the thing they actually want to see.
      if (this._isAudible(target)) {
        if (!this._pc && !target.paused && !target.ended) {
          await this._tryStart(target);
        }
      } else if (target === this._video) {
        this._stopAndNotify();
      }
      return;
    }

    if (event.type === "pause" || event.type === "ended" || event.type === "emptied") {
      if (target !== this._video) return;
      this._stopAndNotify();
    }
  }

  _isAudible(video) {
    return !video.muted && video.volume > 0;
  }

  async _tryStart(target) {
    if (this._pc) return; // already mirroring something
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
      return;
    }
    if (!stream || stream.getVideoTracks().length === 0) return;

    this._stream = stream;
    this._video = target;
    this._attachVideoListeners(target);
    await this._startPeer(stream);
  }

  _attachVideoListeners(video) {
    // Catch end-of-stream and src changes that don't always fire pause first.
    const onEnd = () => this._stopAndNotify();
    video.addEventListener("ended", onEnd, { once: true });
    video.addEventListener("emptied", onEnd, { once: true });
    this._videoListeners = { onEnd };

    // Page navigation kills the capture without a clean event; pre-empt it.
    if (!this._pageHideBound) {
      this._pageHideBound = () => this._stopAndNotify();
      this.contentWindow.addEventListener("pagehide", this._pageHideBound, {
        once: true,
      });
    }
  }

  async _startPeer(stream) {
    const win = this.contentWindow;
    const pc = new win.RTCPeerConnection();
    this._pc = pc;

    for (const track of stream.getTracks()) {
      const sender = pc.addTrack(track, stream);
      // Track lifecycle: if the underlying source dies, tear down promptly.
      track.addEventListener("ended", () => {
        if (this._video && track.kind === "video") this._stopAndNotify();
      });
      if (track.kind === "video") this._capSenderEncoding(sender);
    }

    pc.onicecandidate = (e) => {
      if (!e.candidate) return;
      this.sendAsyncMessage("ZenPiP:IceChild", {
        candidate: e.candidate.toJSON(),
      });
    };

    pc.oniceconnectionstatechange = () => {
      const s = pc.iceConnectionState;
      if (s === "failed" || s === "disconnected" || s === "closed") {
        this._stopAndNotify();
      }
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    this.sendAsyncMessage("ZenPiP:Offer", {
      offer: { type: offer.type, sdp: offer.sdp },
    });
  }

  async _capSenderEncoding(sender) {
    // Firefox rejects setParameters() outright if it sees an unknown field on
    // the encoding object — and that rejection silently dropped ALL our caps,
    // including maxBitrate, leaving the encoder at its ~300 kbps default with
    // aggressive resolution downscaling. Try the rich config first, then fall
    // back to the well-supported subset if Firefox refuses it.
    const baseParams = sender.getParameters();
    if (!baseParams.encodings || baseParams.encodings.length === 0) {
      baseParams.encodings = [{}];
    }
    const baseEnc = baseParams.encodings[0];

    const safeEnc = {
      ...baseEnc,
      maxBitrate: MAX_BITRATE_BPS,
      maxFramerate: MAX_FRAMERATE,
      scaleResolutionDownBy: 1,
    };
    const safeParams = {
      ...baseParams,
      encodings: [safeEnc],
      // Balanced — let the encoder trade off resolution and framerate together
      // under bitrate pressure instead of sacrificing either one wholesale.
      degradationPreference: "balanced",
    };

    // Optional / less-portable hints. If Firefox accepts them, great.
    const richEnc = {
      ...safeEnc,
      minBitrate: MIN_BITRATE_BPS,
      priority: "high",
      networkPriority: "high",
    };
    const richParams = { ...safeParams, encodings: [richEnc] };

    try {
      await sender.setParameters(richParams);
      return;
    } catch (_) {}
    try {
      await sender.setParameters(safeParams);
    } catch (e) {
      console.warn("[Zenslop] setParameters failed:", e);
    }
  }

  _stopAndNotify() {
    if (!this._pc && !this._video) return;
    this._teardown();
    try {
      this.sendAsyncMessage("ZenPiP:VideoStopped", {});
    } catch (e) {}
  }

  _teardown() {
    if (this._pc) {
      try {
        this._pc.close();
      } catch (e) {}
      this._pc = null;
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
    const win = this.contentWindow;
    if (!this._pc || !win) return;

    if (msg.name === "ZenPiP:Answer") {
      try {
        await this._pc.setRemoteDescription(new win.RTCSessionDescription(msg.data.answer));
      } catch (e) {}
    } else if (msg.name === "ZenPiP:IceParent" && msg.data.candidate) {
      try {
        await this._pc.addIceCandidate(new win.RTCIceCandidate(msg.data.candidate));
      } catch (e) {}
    } else if (msg.name === "ZenPiP:Stop") {
      this._stopAndNotify();
    }
  }

  didDestroy() {
    this._teardown();
  }
}
