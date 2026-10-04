// Runs only in the about:blank sidebar receiver. The parent creates this
// receiver in the source process; no video pixels pass through JSActor IPC.
export class ZenSidebarNativeChild extends JSWindowActorChild {
  receiveMessage({ name, data = {} }) {
    switch (name) {
      case "ZenPiP:NativeReady":
        return { ready: this.document?.documentURI === "about:blank" &&
          !!this.document.body };
      case "ZenPiP:NativeStart":
        return this._start(data);
      case "ZenPiP:NativeHealth":
        return this._health(data.sessionId);
      case "ZenPiP:NativeStop":
        if (this._session?.id === data.sessionId) this._stop();
        return true;
    }
    return undefined;
  }

  _start({ videoRef, documentId, sessionId }) {
    const doc = this.document;
    if (doc?.documentURI !== "about:blank" || !doc.body) {
      throw new Error("Native receiver must be an initialized about:blank document");
    }
    this._stop();
    const { ContentDOMReference } = ChromeUtils.importESModule(
      "resource://gre/modules/ContentDOMReference.sys.mjs",
    );
    const source = ContentDOMReference.resolve(videoRef);
    if (!source?.isConnected || source.localName !== "video" ||
        source.ownerDocument.defaultView.windowGlobalChild.innerWindowId !== documentId) {
      throw new Error("Native source reference expired or is in another process");
    }
    const sourceAttrs = source.ownerDocument.nodePrincipal.originAttributes;
    const targetAttrs = doc.nodePrincipal.originAttributes;
    if ((sourceAttrs.userContextId || 0) !== (targetAttrs.userContextId || 0) ||
        (sourceAttrs.privateBrowsingId || 0) !== (targetAttrs.privateBrowsingId || 0)) {
      throw new Error("Native receiver context differs from source");
    }
    if (!source.ownerDocument.hidden) throw new Error("Source video is visible");
    if (source.isCloningElementVisually) throw new Error("Source already has a PiP clone");
    if (typeof source.cloneElementVisually !== "function") {
      throw new Error("Native cloning is unavailable");
    }

    doc.body.style.cssText = "margin:0;overflow:hidden;background:black";
    const target = doc.createElement("video");
    target.muted = target.defaultMuted = true;
    target.style.cssText = "position:fixed;inset:0;width:100%;height:100%;object-fit:contain;background:black";
    doc.body.appendChild(target);
    const session = this._session = {
      id: sessionId, source, target, src: source.currentSrc,
      srcObject: source.srcObject, frames: 0, lastFrameAt: 0,
    };
    session.onHide = () => {
      if (this._session === session) this._stop();
    };
    source.ownerDocument.defaultView.addEventListener("pagehide", session.onHide);
    if (typeof target.requestVideoFrameCallback === "function") {
      const onFrame = () => {
        if (this._session !== session) return;
        session.frames++;
        session.lastFrameAt = Date.now();
        // Prove the first frame immediately, then sample at low frequency.
        session.timer = this.contentWindow.setTimeout(() => {
          if (this._session === session) {
            session.callback = target.requestVideoFrameCallback(onFrame);
          }
        }, 2000);
      };
      session.callback = target.requestVideoFrameCallback(onFrame);
    }
    try {
      // Gecko may never settle this promise. Parent-side startup is bounded
      // and proves presentation separately rather than awaiting attachment.
      Promise.resolve(source.cloneElementVisually(target)).catch(error => {
        if (this._session === session) session.error = String(error);
      });
    } catch (error) {
      this._stop();
      throw error;
    }
    return { started: true };
  }

  _health(sessionId) {
    const s = this._session;
    if (!s || s.id !== sessionId) return { ok: false, error: "Native session stopped" };
    const ok = !s.error && s.source.isConnected && s.target.isConnected &&
      s.source.ownerDocument.hidden && s.source.isCloningElementVisually &&
      s.source.currentSrc === s.src && s.source.srcObject === s.srcObject;
    const rect = s.target.getBoundingClientRect();
    return {
      ok, error: s.error || (ok ? "" : "Native source changed or clone disconnected"),
      presented: s.frames > 0 || s.target.mozPaintedFrames > 0,
      frames: s.frames, lastFrameAt: s.lastFrameAt,
      width: rect.width, height: rect.height,
      paused: s.source.paused, time: s.source.currentTime,
    };
  }

  _stop() {
    const s = this._session;
    if (!s) return;
    this._session = null;
    this.contentWindow.clearTimeout(s.timer);
    try { s.target.cancelVideoFrameCallback?.(s.callback); } catch (_) {}
    try {
      s.source.ownerDocument.defaultView.removeEventListener("pagehide", s.onHide);
    } catch (_) {}
    // Detachment ends this clone. A source-wide stop could terminate a newer
    // PiP belonging to the user, so never call stopCloningElementVisually here.
    s.target.remove();
  }

  didDestroy() {
    this._stop();
  }
}
