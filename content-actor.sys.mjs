const MAX_FRAME_DIMENSION = 480;
const CAPTION_TRACK_CHECK_MS = 2000;

const DEBUG = false;

export class ZenSidebarPiPChild extends JSWindowActorChild {
  actorCreated() {
    this._processingActive = false;
    this._captionsActive = false;
    this._captionMode = "off";
    this._lastCaptionText = "";
    this._captionText = "";
    this._captionCues = null;
    this._captionTrackKey = "";
    this._captionTrackCheckAt = 0;
    this._captionLoadSerial = 0;
    this._captionLoadPendingKey = "";
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
    this._reelScrollBound = () => {
      if (this._shortVideoKind()) this._scheduleReelRescan();
    };
    this._reelScrollEndBound = () => this._refreshShortVideoDetection("scrollend");
    doc.addEventListener("scroll", this._reelScrollBound, true);
    doc.addEventListener("scrollend", this._reelScrollEndBound, true);
    this._shortsNavigateBound = () => {
      if (this._shortVideoKind() === "short") this._refreshShortVideoDetection("navigate");
    };
    win.addEventListener("yt-navigate-finish", this._shortsNavigateBound);

    try {
      this._videoObserver = new win.MutationObserver(() => {
        if (this._shortVideoKind()) {
          this._observeShortVideos();
          this._scheduleReelRescan();
        } else if (!this._video) this._scanForPlayingVideo();
      });
      this._videoObserver.observe(doc, { childList: true, subtree: true,
        attributes: true, attributeFilter: ["src", "is-active"] });
      this._observeShortVideos();
    } catch (_) {
      this._videoObserver = null;
    }
  }

  _observeShortVideos() {
    if (!this._shortVideoKind()) return;
    const win = this.contentWindow;
    if (!this._videoIntersectionObserver && win.IntersectionObserver) {
      this._observedVideos = new Set();
      this._videoIntersectionObserver = new win.IntersectionObserver(() => {
        this._refreshShortVideoDetection("intersection");
      }, { threshold: [0, 0.6, 0.9, 1] });
    }
    if (!this._videoIntersectionObserver) return;
    for (const video of this._observedVideos) {
      if (!video.isConnected) {
        this._videoIntersectionObserver.unobserve(video);
        this._observedVideos.delete(video);
      }
    }
    for (const video of win.document.querySelectorAll("video")) {
      if (this._observedVideos.has(video)) continue;
      this._observedVideos.add(video);
      this._videoIntersectionObserver.observe(video);
    }
  }

  _refreshShortVideoDetection(reason = "change") {
    if (!this._shortVideoKind()) return;
    const waiting = this._waitingReelNavigation;
    if (waiting && !this._reelNavigation) {
      const visible = this._getVisibleReel();
      if (visible && visible !== waiting.previous) this._waitingReelNavigation = null;
      else if (this._getReelScrollTarget(visible || waiting.previous, waiting.direction)) {
        this._waitingReelNavigation = null;
        this._requestShortVideoNavigation(waiting.direction);
      }
    }
    if (this._feedWakeRequested && this._reelFeed?.children?.length > this._feedWakeItemCount) {
      this.sendAsyncMessage("ZenPiP:FeedBoundary", { active: false });
    }
    this._reelNavigation?.check(reason);
    this._resumePendingReel();
    this._scanForPlayingVideo();
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
      event.type === "canplay" ||
      event.type === "loadeddata" ||
      (event.type === "durationchange" && this._shortVideoKind()) ||
      (event.type === "timeupdate" && this._shortVideoKind())
    ) {
      if (this._shortVideoKind()) this._reelNavigation?.check(event.type);
      this._resumePendingReel();
      this._tryStart(target);
      return;
    }

    if (event.type === "volumechange") {
      if (this._isAudible(target)) {
        if (!target.paused && !target.ended) {
          this._tryStart(target);
        }
      } else if (target === this._video) {
        this._stopAndNotify("volumechange:muted");
      }
      return;
    }

    if (event.type === "pause" || event.type === "ended" || event.type === "emptied") {
      if (target !== this._video) return;
      if (event.type === "pause" && this._recoverShortVideoBackgroundPause(target)) return;
      this._stopAndNotify("event:" + event.type);
    }
  }

  _isAudible(video) {
    return !video.muted && video.volume > 0;
  }

  _scanForPlayingVideo() {
    if (this._isInstagramReels()) {
      const visible = this._getVisibleReel();
      const previous = this._video;
      // Background Instagram can move the viewport without updating its URL
      // or starting/unmuting the new video. Transfer existing playback intent
      // by visible element identity, independently of the navigation queue.
      if (visible && previous && visible !== previous &&
          (this.contentWindow.document.hidden || this._feedWakeActive) && !previous.paused && !previous.ended &&
          this._isAudible(previous) && !this._instagramPauseGuard?.allowPagePause) {
        this._pendingReelPlayback = { candidate: visible, previous, volume: previous.volume };
        this._resumePendingReel();
      }
      if (visible) this._tryStart(visible);
      return;
    }
    if (this._shortVideoKind() === "short") {
      const active = this._getVisibleShort();
      if (active) { this._tryStart(active); return; }
    }
    if (this._video) {
      if (this._shortVideoKind() === "short") this._tryStart(this._video);
      return;
    }
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
    if (target.paused || target.ended) return;
    if (target.readyState < 2 || target.videoWidth === 0) return;
    if (!this._isAudible(target)) return;
    if (this._isInstagramReels() && this._getVisibleReel() !== target) {
      this._scheduleReelRescan();
      return;
    }
    if (this._shortVideoKind() === "short") {
      const visible = this._getVisibleShort();
      if (visible && visible !== target) return;
    }
    if (this._video) {
      if (this._video === target) {
        const path = this.contentWindow.location.pathname;
        const src = target.currentSrc || target.src || "";
        const kind = this._shortVideoKind();
        if (kind === "short" && src === this._mirroredMediaSrc) {
          // Shorts swaps the reused player's media before committing its URL.
          // A late URL update is metadata, not another source: restarting here
          // cancels a fresh native attachment and resets the transition again.
          if (path !== this._mirroredShortPath) {
            this._mirroredShortPath = path;
            this._stopCaptionTracking(true);
            if (this._captionsActive) this._startCaptionTracking();
          }
        } else if (kind &&
            (path !== this._mirroredShortPath || src !== this._mirroredMediaSrc)) {
          this._stopCaptionTracking(true);
          this._startMirror(target);
        }
        return;
      }
      // Reels/Shorts can start the next element before pausing the previous
      // one. Hand off immediately instead of discarding that sole play event.
      if (!this._shortVideoKind() && this._video.isConnected &&
          !this._video.paused && !this._video.ended) return;
      this._teardown();
    }

    this._attachVideoListeners(target);
    this._startMirror(target);
  }

  _attachVideoListeners(video) {
    const onEnd = (e) => {
      if (this._video === video) this._stopAndNotify("listener:" + e.type);
    };
    video.addEventListener("ended", onEnd, { once: true });
    video.addEventListener("emptied", onEnd, { once: true });
    this._videoListeners = { onEnd };

    if (!this._pageHideBound) {
      this._pageHideBound = () => {
        this._pendingReelPlayback = null;
        this._waitingReelNavigation = null;
        if (this._feedWakeRequested) this.sendAsyncMessage("ZenPiP:FeedBoundary", { active: false });
        this._feedWakeActive = false;
        this._feedWakeRequested = false;
        this._cancelReelNavigation();
        this._stopAndNotify("pagehide");
      };
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
    if (this._isInstagramReels()) this._lastReelVolume = video.volume;
    this._sourceSerial = (this._sourceSerial || 0) + 1;
    this._mirroredShortPath = win.location.pathname;
    this._mirroredMediaSrc = video.currentSrc || video.src || "";
    this._installInstagramPauseGuard(video);
    this._shortVideoResumeAttempt = null;
    this._shortVideoBackgroundResumeUntil = win.document.hidden
      ? win.performance.now() + 1500 : 0;
    this._startTime = win.performance.now();
    let videoRef = null;
    try {
      const { ContentDOMReference } = ChromeUtils.importESModule(
        "resource://gre/modules/ContentDOMReference.sys.mjs",
      );
      videoRef = ContentDOMReference.get(video);
    } catch (_) { /* Older Gecko builds can still use canvas capture. */ }
    this.sendAsyncMessage("ZenPiP:MirrorStarted", {
      width: srcWidth,
      height: srcHeight,
      sourceSerial: this._sourceSerial,
      videoRef,
      shortVideoKind: this._shortVideoKind(),
      documentId: win.windowGlobalChild?.innerWindowId,
    });

    const doc = this.contentWindow?.document;
    if (doc && !this._visBound) {
      this._visBound = () => {
        const d = this.contentWindow?.document;
        if (d) {
          this._shortVideoBackgroundResumeUntil = d.hidden
            ? this.contentWindow.performance.now() + 1500 : 0;
          this.sendAsyncMessage("ZenPiP:SourceVisibility", { hidden: d.hidden });
        }
      };
      doc.addEventListener("visibilitychange", this._visBound);
    }
    if (doc) {
      this.sendAsyncMessage("ZenPiP:SourceVisibility", { hidden: doc.hidden });
    }

    if (this._captionsActive) this._startCaptionTracking();
  }

  _installInstagramPauseGuard(video) {
    if (!this._isInstagramReels()) return;
    if (this._instagramPauseGuard) {
      this._instagramPauseGuard.allowPagePause = false;
      this._instagramPauseGuard.video = video;
      return;
    }
    try {
      const win = this.contentWindow;
      const pageWindow = win.wrappedJSObject;
      const prototype = pageWindow.HTMLMediaElement.prototype;
      const descriptor = Object.getOwnPropertyDescriptor(prototype, "pause");
      if (!descriptor?.configurable || typeof descriptor.value !== "function") return;
      const guard = { prototype, descriptor, video, wrapper: null, allowPagePause: false };
      const actor = this;
      guard.wrapper = Cu.exportFunction(function () {
        // Browser media controls call Gecko directly, bypassing this page-JS
        // method. Never auto-resume their pause events on Instagram.
        const target = Cu.unwaiveXrays(this);
        if (!guard.allowPagePause && guard.video === target && target.isConnected &&
            actor._isInstagramReels() && (win.document.hidden || actor._feedWakeActive) &&
            !target.ended && actor._isAudible(target)) return undefined;
        return descriptor.value.call(this);
      }, pageWindow);
      Object.defineProperty(prototype, "pause", { ...descriptor, value: guard.wrapper });
      this._instagramPauseGuard = guard;
    } catch (error) {
      this._debug("[Zenslop/content] Instagram pause guard unavailable:", String(error));
    }
  }

  _removeInstagramPauseGuard() {
    const guard = this._instagramPauseGuard;
    if (!guard) return;
    this._instagramPauseGuard = null;
    guard.video = null;
    try {
      // Leave a later page/extension replacement intact.
      if (Object.getOwnPropertyDescriptor(guard.prototype, "pause")?.value === guard.wrapper) {
        Object.defineProperty(guard.prototype, "pause", guard.descriptor);
      }
    } catch (_) {}
  }

  _recoverShortVideoBackgroundPause(video) {
    const win = this.contentWindow;
    // Only recover the first pause immediately after backgrounding a Reel or Short.
    // Continuous auto-play retries would also fight media-key/user pauses.
    if (this._isInstagramReels() && this._instagramPauseGuard) return false;
    if (!this._shortVideoKind() || !win.document.hidden ||
        !video.isConnected || video.ended || !this._isAudible(video) ||
        !this._shortVideoBackgroundResumeUntil ||
        win.performance.now() > this._shortVideoBackgroundResumeUntil) return false;
    this._shortVideoBackgroundResumeUntil = 0;
    const attempt = {};
    this._shortVideoResumeAttempt = attempt;
    Promise.resolve().then(() => {
      if (this._shortVideoResumeAttempt !== attempt || this._video !== video ||
          !win.document.hidden || !video.isConnected || video.ended ||
          !this._isAudible(video)) return;
      return video.play();
    }).catch(() => {
      if (this._shortVideoResumeAttempt === attempt && this._video === video && video.paused) {
        this._stopAndNotify("short-video:background-resume-rejected");
      }
    }).finally(() => {
      if (this._shortVideoResumeAttempt === attempt) this._shortVideoResumeAttempt = null;
    });
    return true;
  }

  _shortVideoKind() {
    if (this._isInstagramReels()) return "reel";
    const location = this.contentWindow?.location;
    if (this._isYouTubeDocument() && /^\/shorts\//.test(location?.pathname || "")) {
      return "short";
    }
    return null;
  }

  _isInstagramReels() {
    const location = this.contentWindow?.location;
    return /(^|\.)instagram\.com$/.test(location?.hostname || "") &&
      /^\/reels?\//.test(location?.pathname || "");
  }

  _getVisibleReel() {
    const win = this.contentWindow;
    let candidate = null;
    let best = 0;
    for (const video of win.document.querySelectorAll("video")) {
      if (!video.isConnected) continue;
      const rect = video.getBoundingClientRect();
      const area = Math.max(0, Math.min(rect.right, win.innerWidth) - Math.max(rect.left, 0)) *
        Math.max(0, Math.min(rect.bottom, win.innerHeight) - Math.max(rect.top, 0));
      const maximum = Math.min(rect.width * rect.height, win.innerWidth * win.innerHeight);
      if (maximum > 0 && area / maximum >= 0.6 && area > best) {
        candidate = video;
        best = area;
      }
    }
    return candidate;
  }

  _scheduleReelRescan() {
    if (this._reelRescanPending) return;
    this._reelRescanPending = true;
    try { this.sendAsyncMessage("ZenPiP:ReelRescan", {}); }
    catch (_) { this._reelRescanPending = false; }
  }

  _requestShortVideoNavigation(direction = 1) {
    direction = direction === -1 ? -1 : 1;
    this._waitingReelNavigation = null;
    if (this._reelNavigation) {
      // Coalesce a burst into one follow-up step instead of cancelling the
      // active handoff (or leaving dozens of delayed skips behind).
      this._queuedShortVideoDirection = direction;
      return;
    }
    this._pendingReelPlayback = null;
    if (this._shortVideoKind() === "short") {
      if (this.contentWindow.document.hidden && !this._feedWakeRequested) {
        // YouTube's scroll/selection work otherwise runs on throttled page
        // timers. The parent bounds this activity lease and preserves PiP.
        this._feedWakeRequested = true;
        this.sendAsyncMessage("ZenPiP:FeedBoundary", { active: true });
      }
      this._followShortsNavigation(direction);
    }
    try { this._scrollNextShortVideo(direction); }
    catch (error) { this._cancelReelNavigation(); throw error; }
  }

  _getVisibleShort() {
    // YouTube does not consistently mark the active renderer with an attribute.
    // Geometry also excludes detached/preloaded videos that can emit play early.
    if (!this.contentWindow.document.querySelectorAll) return null;
    return this._getVisibleReel();
  }

  _getShortsTargetTop(feed, direction) {
    if (!feed) return null;
    const container = feed.querySelector?.("#shorts-inner-container");
    const items = [...(container?.children || [])].filter(item =>
      /^(start|center|end)( |$)/.test(this.contentWindow.getComputedStyle(item).scrollSnapAlign || ""));
    if (!items.length || !feed.getBoundingClientRect) return null;
    const origin = feed.getBoundingClientRect().top + (feed.clientTop || 0);
    let index = 0;
    for (let i = 1; i < items.length; i++) {
      if (Math.abs(items[i].getBoundingClientRect().top - origin) <
          Math.abs(items[index].getBoundingClientRect().top - origin)) index = i;
    }
    const target = items[index + direction];
    return target ? feed.scrollTop + target.getBoundingClientRect().top - origin : null;
  }

  _followShortsNavigation(direction = 1) {
    const win = this.contentWindow;
    const previous = this._getVisibleShort() || this._video;
    const feed = win.document.querySelector?.("ytd-shorts #shorts-container");
    const navigation = { direction, path: win.location.pathname, previous, feedTop: feed?.scrollTop,
      targetTop: this._getShortsTargetTop(feed, direction),
      src: previous?.currentSrc || previous?.src || "", attempts: 0,
      resumeVolume: previous && !previous.paused && this._isAudible(previous) ? previous.volume : null };
    this._reelNavigation = navigation;
    navigation.check = (reason = "fallback") => {
      if (this._reelNavigation !== navigation) return;
      if (this._shortVideoKind() !== "short") { this._cancelReelNavigation(); return; }
      const active = this._getVisibleShort();
      const candidate = active || this._video;
      const changed = candidate && (candidate !== previous ||
        (candidate.currentSrc || candidate.src || "") !== navigation.src);
      // YouTube may replace the feed node while extending/virtualizing it.
      const currentFeed = win.document.querySelector?.("ytd-shorts #shorts-container") || feed;
      const feedTop = currentFeed?.scrollTop;
      const feedMoved = Number.isFinite(feedTop) && feedTop !== navigation.feedTop;
      // Physical scrolling can run ahead of YouTube's selected item and its
      // continuation loader. Wait for the site to acknowledge the new Short.
      const moved = win.location.pathname !== navigation.path;
      if (reason === "scrollend") navigation.scrollEnded = true;
      // The page can scroll to a ready replacement while deferring its
      // background autoplay. Carry the explicit Next/Previous playback intent
      // to that visible player rather than waiting for a delayed play event.
      if (!navigation.playbackTransferred && changed &&
          (moved || feedMoved) && (win.document.hidden || this._feedWakeActive) && navigation.resumeVolume != null) {
        navigation.playbackTransferred = true;
        this._pendingReelPlayback = { candidate, previous, volume: navigation.resumeVolume };
        this._resumePendingReel();
      }
      // Navigation readiness is independent of buffering/audio. Waiting for
      // playback here holds later clicks until the four-second watchdog.
      if (moved) {
        const state = `${win.location.pathname}|${feedTop}|${candidate?.currentSrc || candidate?.src || ""}`;
        const settled = (navigation.state === state && navigation.candidate === candidate) || navigation.scrollEnded;
        navigation.state = state;
        navigation.candidate = candidate;
        if (settled) {
          if (candidate && !candidate.paused && candidate.readyState >= 2) this._tryStart(candidate);
          this._completeReelNavigation();
        }
      } else if (reason === "fallback" && ++navigation.attempts >= 3) {
        // Settle the original one-step destination, even if a native smooth
        // scroll moved partway. Using an absolute target cannot add a skip.
        if (navigation.usedNativeControl && !navigation.fallbackAttempted && currentFeed?.clientHeight > 0) {
          navigation.fallbackAttempted = true;
          const top = navigation.targetTop ??
            ((Number.isFinite(navigation.feedTop) ? navigation.feedTop : (feedTop || 0)) +
              navigation.direction * currentFeed.clientHeight);
          if (currentFeed.scrollTo) currentFeed.scrollTo({ top, behavior: "instant" });
          else currentFeed.scrollBy({ top: top - (feedTop || 0), behavior: "instant" });
        } else if (!feedMoved && !changed) {
          this._completeReelNavigation();
        }
      }

    };
    this.sendAsyncMessage("ZenPiP:NavigationWatch", { active: true });
  }

  _completeReelNavigation() {
    const queued = this._queuedShortVideoDirection;
    if (this._shortVideoKind() === "short" && this._feedWakeRequested && queued == null) {
      this._feedWakeRequested = false;
      this.sendAsyncMessage("ZenPiP:FeedBoundary", { active: false });
    }
    this._cancelReelNavigation();
    const serial = this._navigationQueueSerial;
    if (queued != null) Promise.resolve().then(() => {
      if (this._navigationQueueSerial === serial) this._requestShortVideoNavigation(queued);
    });
  }

  _cancelReelNavigation() {
    this._navigationQueueSerial = (this._navigationQueueSerial || 0) + 1;
    this._queuedShortVideoDirection = null;
    if (!this._reelNavigation) return;
    this._reelNavigation = null;
    // Failed/no-op navigation must leave the current Reel protected and live.
    if (this._instagramPauseGuard && !this._instagramPauseGuard.video && this._video?.isConnected) {
      this._instagramPauseGuard.video = this._video;
    }
    try { this.sendAsyncMessage("ZenPiP:NavigationWatch", { active: false }); } catch (_) {}
  }

  _followReelNavigation(previous, retryNavigation = null, direction = 1) {
    this._cancelReelNavigation();
    const win = this.contentWindow;
    const navigation = { win, previous, direction, volume: previous?.volume ?? this._lastReelVolume ?? 1, attempts: 0,
      path: win.location.pathname, src: previous?.currentSrc || previous?.src || "" };
    this._reelNavigation = navigation;
    const check = (reason = "fallback") => {
      if (this._reelNavigation !== navigation || navigation.handingOff) return;
      if (reason === "fallback") navigation.attempts++;
      if (!this._isInstagramReels() || navigation.attempts > 60) {
        this._cancelReelNavigation();
        return;
      }
      const candidate = this._getVisibleReel();
      if (!candidate && navigation.targetItem?.isConnected && reason === "scrollend") {
        const rect = navigation.targetItem.getBoundingClientRect();
        const visible = Math.max(0, Math.min(rect.bottom, win.innerHeight) - Math.max(rect.top, 0));
        if (rect.height > 0 && visible / Math.min(rect.height, win.innerHeight) >= 0.6) {
          const pending = { item: navigation.targetItem, previous, volume: navigation.volume };
          this._completeReelNavigation();
          this._pendingReelPlayback = pending;
          this._resumePendingReel();
          return;
        }
      }
      const reused = candidate && candidate === previous &&
        (win.location.pathname !== navigation.path ||
         (candidate.currentSrc || candidate.src || "") !== navigation.src);
      // Instagram can ignore a click while its previous scroll is settling.
      // Retry once only while the original Reel is still visibly unchanged.
      const unchanged = candidate === previous && !reused;
      if (unchanged && retryNavigation && !navigation.retrying &&
          ((reason === "fallback" && navigation.attempts === 3) || reason === "change")) {
        // Feed continuation can arrive after the one timed retry. On a DOM
        // change, retry only if a fresh adjacent target is actually available.
        navigation.retrying = true;
        try { retryNavigation(reason === "change"); } catch (_) {}
        finally { navigation.retrying = false; }
        if (this._reelNavigation !== navigation) return;
      }
      if (candidate && (candidate !== previous || reused)) {
        const settled = navigation.candidate === candidate ||
          ["scrollend", "intersection", "playing", "loadeddata", "canplay"].includes(reason);
        navigation.candidate = candidate;
        if (settled) {
          if (this._video === candidate && !candidate.paused && this._isAudible(candidate)) {
            this._completeReelNavigation();
            this._tryStart(candidate);
            if (candidate !== previous) previous?.pause();
            return;
          }
          // The feed has moved even if the next video has not loaded yet.
          // Release navigation now; media events finish playback separately.
          const pending = { candidate, previous, volume: navigation.volume };
          this._completeReelNavigation();
          this._pendingReelPlayback = pending;
          this._resumePendingReel();
          return;
        }
      }
      if (!candidate || (candidate === previous && !reused)) navigation.candidate = null;
    };
    navigation.check = check;
    this.sendAsyncMessage("ZenPiP:NavigationWatch", { active: true });
  }

  _resumePendingReel() {
    const pending = this._pendingReelPlayback;
    if (!pending) return;
    const candidate = pending.candidate || pending.item?.querySelector("video");
    if (!candidate) {
      if (pending.item && !pending.item.isConnected) this._pendingReelPlayback = null;
      return;
    }
    const { previous, volume } = pending;
    const visible = this._getVisibleReel();
    if (!candidate.isConnected || (visible && visible !== candidate)) {
      this._pendingReelPlayback = null;
      return;
    }
    if (visible !== candidate || candidate.readyState < 2 || candidate.videoWidth <= 0) return;
    this._pendingReelPlayback = null;
    this._teardown();
    this._installInstagramPauseGuard(candidate);
    candidate.volume = volume;
    candidate.muted = false;
    if (candidate !== previous) previous?.pause();
    const serial = this._navigationQueueSerial;
    let playback;
    try { playback = candidate.play(); }
    catch (error) { playback = Promise.reject(error); }
    // play() may already have switched paused to false without firing a new
    // playing event (especially for a feed's already-playing replacement).
    // Publish the source before a queued Next can invalidate the async callback.
    if (!candidate.paused) this._tryStart(candidate);
    Promise.resolve(playback).then(() => {
      if (this._navigationQueueSerial !== serial || this._getVisibleReel() !== candidate) return;
      this._tryStart(candidate);
    }).catch(() => {
      if (this._navigationQueueSerial !== serial || this._getVisibleReel() !== candidate) return;
      if (this._video && this._video !== candidate) return;
      this._teardown();
      this.sendAsyncMessage("ZenPiP:VideoStopped", { reason: "reels:navigation-play-rejected" });
    });
  }

  _getReelItemTarget(feed, previous, direction) {
    const win = this.contentWindow;
    const items = [...(feed.children || [])].filter(item =>
      /^(start|center|end)( |$)/.test(win.getComputedStyle(item).scrollSnapAlign || ""));
    const current = items.find(item => {
        const rect = item.getBoundingClientRect();
        const visible = Math.max(0, Math.min(rect.bottom, win.innerHeight) - Math.max(rect.top, 0));
        return rect.height > 0 && visible / Math.min(rect.height, win.innerHeight) >= 0.6;
      }) || items.find(item => previous && item.contains(previous));
    if (!current) return null;
    const index = items.indexOf(current);
    const item = items[index + direction];
    if (!item) return null;
    return { feed, item, top: feed.scrollTop +
      item.getBoundingClientRect().top - current.getBoundingClientRect().top };
  }

  _getReelScrollTarget(previous, direction) {
    if (!previous?.isConnected || !previous?.getBoundingClientRect) {
      return this._reelFeed?.isConnected
        ? this._getReelItemTarget(this._reelFeed, null, direction) : null;
    }
    const win = this.contentWindow;
    for (let feed = previous.parentElement; feed; feed = feed.parentElement) {
      if (!/^(auto|scroll)$/.test(win.getComputedStyle(feed).overflowY) ||
          feed.scrollHeight <= feed.clientHeight + 1) continue;
      this._reelFeed = feed;
      const itemTarget = this._getReelItemTarget(feed, previous, direction);
      if (itemTarget || [...(feed.children || [])].some(item =>
        /^(start|center|end)( |$)/.test(win.getComputedStyle(item).scrollSnapAlign || ""))) return itemTarget;
      const origin = previous.getBoundingClientRect().top;
      let distance = Infinity;
      let delta = 0;
      for (const video of win.document.querySelectorAll("video")) {
        if (video === previous || !video.isConnected || !feed.contains(video)) continue;
        const rect = video.getBoundingClientRect();
        const offset = rect.top - origin;
        if (rect.height > 0 && offset * direction > 1 && Math.abs(offset) < distance) {
          distance = Math.abs(offset);
          delta = offset;
        }
      }
      return distance < Infinity ? { feed, top: feed.scrollTop + delta } : null;
    }
    return null;
  }

  _scrollNextShortVideo(direction = 1) {
    direction = direction === -1 ? -1 : 1;
    const kind = this._shortVideoKind();
    if (!kind) return;
    // During the outgoing pause, _video may already have been torn down.
    // The visible Reel still provides a valid navigation/audio anchor.
    const reel = kind === "reel" ? (this._getVisibleReel() || (this._video?.isConnected ? this._video : null)) : null;
    const win = this.contentWindow;
    const doc = win.document;
    if (this._isInstagramReels()) {
      // Prefer the adjacent rendered Reel's exact position. Playback handoff
      // follows its visible element rather than the site's delayed URL.
      const destination = this._getReelScrollTarget(reel, direction);
      const feed = destination?.feed || this._reelFeed;
      if (!this._feedWakeRequested && doc.hidden && direction === 1 && feed &&
          feed.scrollHeight - feed.scrollTop - feed.clientHeight <= feed.clientHeight * 2) {
        this._feedWakeRequested = true;
        this._feedWakeItemCount = feed.children?.length || 0;
        this.sendAsyncMessage("ZenPiP:FeedBoundary", { active: true });
      }
      const settleScroll = (target = destination) => {
        if (!target) return;
        target.feed.scrollTo({ top: target.top, behavior: "instant" });
        // Geometry is updated synchronously by an instant scroll. Publish the
        // new source in this command, not after background scroll/IO events.
        this._refreshShortVideoDetection("scrollend");
      };
      const label = direction === -1 ? "Navigate to previous Reel" : "Navigate to next Reel";
      const next = doc.querySelector(
        `[role="button"][aria-label="${label}"], button[aria-label="${label}"]`,
      );
      if (next && (next.disabled || next.getAttribute("aria-disabled") === "true")) return;
      if (destination) {
        // One gesture, one movement. A native click plus a forced scroll can
        // make the site's delayed selected index undo the next movement.
        this._followReelNavigation(reel, () => {
          const target = this._getReelScrollTarget(this._getVisibleReel() || reel, direction);
          if (target) settleScroll(target);
        }, direction);
        this._reelNavigation.targetItem = destination.item || null;
        if (this._instagramPauseGuard) this._instagramPauseGuard.video = null;
        settleScroll();
        return;
      }
      if (next && !next.disabled && next.getAttribute("aria-disabled") !== "true") {
        const previous = reel;
        // Controls remain usable while Instagram removes/replaces its video
        // nodes, or a loading/ad item temporarily contains no visible player.
        this._followReelNavigation(previous, onlyIfTarget => {
          const target = this._getReelScrollTarget(this._getVisibleReel() || previous, direction);
          if (target) { settleScroll(target); return; }
          if (onlyIfTarget) return;
          const control = doc.querySelector(
            `[role="button"][aria-label="${label}"], button[aria-label="${label}"]`,
          );
          if (control && !control.disabled && control.getAttribute("aria-disabled") !== "true") control.click();
        }, direction);
        if (this._instagramPauseGuard) this._instagramPauseGuard.video = null;
        try { next.click(); }
        catch (error) { this._cancelReelNavigation(); throw error; }
        return;
      }
      if (next || !reel?.isConnected) return;
    }
    if (this._shortVideoKind() === "short") {
      // Let YouTube update its selected player and continuation loader first.
      // Raw scrolling can move the feed without committing a new Short.
      const selector = direction === -1
        ? "ytd-shorts #navigation-button-up button"
        : "ytd-shorts #navigation-button-down button";
      const button = doc.querySelector(selector);
      if (button) {
        if (!button.disabled && button.getAttribute("aria-disabled") !== "true") {
          if (this._reelNavigation) this._reelNavigation.usedNativeControl = true;
          const navigation = this._reelNavigation;
          button.click();
          // Preserve the site's navigation command, but finish its background
          // smooth scroll at the exact original item instead of waiting for
          // throttled animation or overshooting by the container height.
          if ((doc.hidden || this._feedWakeActive) && navigation?.targetTop != null) {
            const feed = doc.querySelector("ytd-shorts #shorts-container");
            feed?.scrollTo?.({ top: navigation.targetTop, behavior: "instant" });
            this._refreshShortVideoDetection("scrollend");
          }
        }
        return;
      }
      // Navigate the actual feed, never an inner clipped video wrapper.
      // Instant scrolling also works when background animation is throttled.
      const feed = doc.querySelector("ytd-shorts #shorts-container");
      if (feed && feed.clientHeight > 0 && feed.scrollHeight > feed.clientHeight) {
        feed.scrollBy({ top: direction * feed.clientHeight, behavior: "instant" });
        return;
      }

    }
    // Short-video feeds use an inner snap-scrolling feed; scrolling the window alone
    // does nothing when that feed owns the viewport.
    for (let node = (reel || this._video)?.parentElement; node; node = node.parentElement) {
      const overflow = win.getComputedStyle(node).overflowY;
      const scrollable = /^(auto|scroll)$/.test(overflow) ||
        (this._shortVideoKind() === "short" && overflow === "hidden");
      if (scrollable &&
          node.scrollHeight > node.clientHeight + 1 && node.clientHeight > 0) {
        if (kind === "reel") {
          this._followReelNavigation(reel, null, direction);
          if (this._instagramPauseGuard) this._instagramPauseGuard.video = null;
        }
        node.scrollBy({ top: direction * node.clientHeight, behavior: "smooth" });
        return;
      }
    }
    doc.scrollingElement?.scrollBy({ top: direction * win.innerHeight, behavior: "smooth" });
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
    if (!this._video || !this._captionsActive || this._captionMode === "off" ||
        !this._isYouTubeDocument()) {
      return;
    }
    if (this._captionRootObserver) {
      this._refreshCaptionRoot();
      this._syncCaption();
      this._ensureCaptionTrack();
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
    this._ensureCaptionTrack();
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
    if (this._captionSyncQueued || !this._captionsActive) return;
    const win = this.contentWindow;
    if (!win) return;
    this._captionSyncQueued = true;
    win.queueMicrotask(() => {
      this._captionSyncQueued = false;
      const text = this._syncCaption();
      if (!this._captionCues?.length) this._sendCaption(text);
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

  _joinDistinctCaptionWindows(values) {
    const seen = new Set();
    const distinct = [];
    for (const value of values) {
      const normalized = String(value || "").replace(/\s+/g, " ").trim();
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      distinct.push(normalized);
    }
    return distinct.join(" ");
  }

  _sourceCaptionsEnabled() {
    if (this._captionMode === "on") return true;
    if (this._captionMode !== "youtube") return false;

    const doc = this.contentWindow?.document;
    const ccButton = doc?.querySelector(".ytp-subtitles-button");
    if (ccButton) {
      return (
        ccButton.getAttribute("aria-pressed") === "true" ||
        ccButton.classList.contains("ytp-button-active")
      );
    }

    try {
      const player = doc?.querySelector(".html5-video-player");
      const track = player?.getOption?.("captions", "track");
      return Boolean(track?.languageCode);
    } catch (_) {
      return false;
    }
  }

  _appendCaptionText(previous, next) {
    previous = String(previous || "").replace(/\s+/g, " ").trim();
    next = String(next || "").replace(/\s+/g, " ").trim();
    if (!previous) return next;
    if (!next || previous === next || previous.endsWith(` ${next}`)) {
      return previous;
    }
    if (next.startsWith(`${previous} `)) return next;

    const previousWords = previous.split(" ");
    const nextWords = next.split(" ");
    const maxOverlap = Math.min(previousWords.length, nextWords.length);
    for (let count = maxOverlap; count >= 2; count--) {
      if (
        previousWords.slice(-count).join(" ") ===
        nextWords.slice(0, count).join(" ")
      ) {
        return previousWords.concat(nextWords.slice(count)).join(" ");
      }
    }
    return `${previous} ${next}`;
  }

  _syncCaption() {
    if (!this._video || !this._captionsActive || this._captionMode === "off" ||
        !this._isYouTubeDocument()) {
      this._captionText = "";
      return "";
    }

    const doc = this.contentWindow?.document;
    if (!doc) return this._captionText;
    let text = "";
    if (this._sourceCaptionsEnabled()) {
      const windowParts = new Map();
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
        if (!value) continue;
        const windowKey = windowEl || segment;
        const parts = windowParts.get(windowKey) || [];
        parts.push(value);
        windowParts.set(windowKey, parts);
      }
      text = this._joinDistinctCaptionWindows(
        Array.from(windowParts.values(), parts => parts.join(" ")),
      );
    }

    this._captionText = text;
    return text;
  }

  _extractJSONAt(text, start) {
    const objectStart = text.indexOf("{", start);
    if (objectStart < 0) return null;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = objectStart; i < text.length; i++) {
      const char = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === "{") depth++;
      else if (char === "}" && --depth === 0) {
        try {
          return JSON.parse(text.slice(objectStart, i + 1));
        } catch (_) {
          return null;
        }
      }
    }
    return null;
  }

  _getInlinePlayerResponse(doc) {
    const marker = "ytInitialPlayerResponse";
    for (const script of doc?.scripts || []) {
      const text = script.textContent || "";
      let offset = 0;
      while ((offset = text.indexOf(marker, offset)) >= 0) {
        const response = this._extractJSONAt(text, offset + marker.length);
        if (response?.captions?.playerCaptionsTracklistRenderer
          ?.captionTracks?.length) {
          return response;
        }
        offset += marker.length;
      }
    }
    return null;
  }

  _getCaptionTrackInfo() {
    const win = this.contentWindow;
    const doc = win?.document;
    if (!win || !doc) return null;

    try {
      // Prefer the exact caption request YouTube's player made. It can contain
      // session-bound proof tokens that are absent from the public track URL
      // in ytInitialPlayerResponse. Resource timing keeps the request URL even
      // after YouTube has consumed its response.
      const resources = win.performance?.getEntriesByType?.("resource") || [];
      const pageUrl = new win.URL(win.location.href);
      const currentVideoId = pageUrl.searchParams.get("v") ||
        /^\/(?:shorts|embed|live)\/([^/?]+)/.exec(pageUrl.pathname)?.[1] ||
        "";
      for (let i = resources.length - 1; i >= 0; i--) {
        try {
          const url = new win.URL(resources[i].name);
          if (url.hostname.endsWith("youtube.com") &&
              url.pathname.endsWith("/api/timedtext")) {
            const resourceVideoId = url.searchParams.get("v") || "";
            if (currentVideoId && resourceVideoId &&
                resourceVideoId !== currentVideoId) {
              continue;
            }
            const baseUrl = url.href;
            return {
              baseUrl,
              translationCode: "",
              key: `loaded|${baseUrl}`,
            };
          }
        } catch (_) {}
      }

      const pageWindow = win.wrappedJSObject || win;
      const playerElement = doc.querySelector("#movie_player, .html5-video-player");
      const player = playerElement?.wrappedJSObject || playerElement;
      let playerResponse = null;
      try {
        playerResponse = player?.getPlayerResponse?.() || null;
      } catch (_) {}
      let globalResponse = null;
      try {
        globalResponse = pageWindow.ytInitialPlayerResponse || null;
      } catch (_) {}
      const responses = [
        playerResponse,
        globalResponse,
        this._getInlinePlayerResponse(doc),
      ];
      const response = responses.find(candidate =>
        candidate?.captions?.playerCaptionsTracklistRenderer
          ?.captionTracks?.length,
      );
      const renderer = response?.captions?.playerCaptionsTracklistRenderer;
      const tracks = Array.from(renderer?.captionTracks || []);
      if (!tracks.length) return null;

      let selected = null;
      let current = null;
      try {
        current = player?.getOption?.("captions", "track") || null;
      } catch (_) {}

      if (current) {
        selected = tracks.find(track =>
          current.vssId && track.vssId === current.vssId,
        ) || tracks.find(track =>
          current.languageCode &&
          track.languageCode === current.languageCode &&
          (!current.kind || track.kind === current.kind),
        );
      }

      if (!selected) {
        const audioIndex = Number(renderer.defaultAudioTrackIndex) || 0;
        const captionIndex = Number(
          renderer.audioTracks?.[audioIndex]?.defaultCaptionTrackIndex,
        );
        if (Number.isInteger(captionIndex)) selected = tracks[captionIndex];
      }
      selected ||= tracks[0];

      const baseUrl = String(selected?.baseUrl || "");
      if (!baseUrl) return null;
      const translationCode = String(
        current?.translationLanguage?.languageCode ||
        current?.translationLanguage?.id ||
        "",
      );
      const key = [baseUrl, translationCode].join("|");
      return { baseUrl, translationCode, key };
    } catch (_) {
      return null;
    }
  }

  _parseCaptionJSON3(data) {
    if (!Array.isArray(data?.events)) return [];
    const cues = [];
    for (const event of data.events) {
      if (!Array.isArray(event?.segs)) continue;
      const startMs = Number(event.tStartMs);
      if (!Number.isFinite(startMs)) continue;
      const durationMs = Number(event.dDurationMs);
      const endMs = startMs +
        (Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 3000);
      const segments = event.segs
        .map(segment => {
          const text = String(segment?.utf8 || "");
          const offsetMs = Number(segment?.tOffsetMs);
          return {
            text,
            startMs: startMs +
              (Number.isFinite(offsetMs) && offsetMs > 0 ? offsetMs : 0),
          };
        })
        .filter(segment => segment.text && segment.text !== "\n");
      if (!segments.length) continue;
      cues.push({
        startMs,
        endMs,
        segments,
        windowId: event.wWinId,
        append: Boolean(event.aAppend),
      });
    }
    return this._finalizeCaptionCues(cues);
  }

  _parseCaptionXML(text) {
    if (!text) return [];
    const parser = new this.contentWindow.DOMParser();
    const doc = parser.parseFromString(text, "text/xml");
    if (doc.querySelector("parsererror")) return [];
    const cues = [];

    for (const paragraph of doc.querySelectorAll("p")) {
      const startValue = paragraph.getAttribute("t");
      if (startValue === null) continue;
      const startMs = Number(startValue);
      if (!Number.isFinite(startMs)) continue;
      const durationMs = Number(paragraph.getAttribute("d"));
      const segments = Array.from(paragraph.querySelectorAll(":scope > s"))
        .map(segment => ({
          text: segment.textContent || "",
          startMs: startMs + (Number(segment.getAttribute("t")) || 0),
        }))
        .filter(segment => segment.text && segment.text !== "\n");
      if (!segments.length && paragraph.textContent) {
        segments.push({ text: paragraph.textContent, startMs });
      }
      if (!segments.length) continue;
      cues.push({
        startMs,
        endMs: startMs +
          (Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 3000),
        segments,
        windowId: paragraph.getAttribute("w") || undefined,
        append: paragraph.getAttribute("a") === "1",
      });
    }

    for (const node of doc.querySelectorAll("transcript > text")) {
      const startValue = node.getAttribute("start");
      if (startValue === null) continue;
      const startSeconds = Number(startValue);
      if (!Number.isFinite(startSeconds)) continue;
      const durationSeconds = Number(node.getAttribute("dur"));
      const startMs = startSeconds * 1000;
      const value = node.textContent || "";
      if (!value.trim()) continue;
      cues.push({
        startMs,
        endMs: startMs +
          (Number.isFinite(durationSeconds) && durationSeconds > 0
            ? durationSeconds * 1000
            : 3000),
        segments: [{ text: value, startMs }],
        windowId: undefined,
        append: false,
      });
    }
    return this._finalizeCaptionCues(cues);
  }

  _finalizeCaptionCues(cues) {
    cues.sort((a, b) => a.startMs - b.startMs);
    let maxEndThrough = -Infinity;
    for (const cue of cues) {
      maxEndThrough = Math.max(maxEndThrough, cue.endMs);
      cue.maxEndThrough = maxEndThrough;
    }
    return cues;
  }

  async _ensureCaptionTrack() {
    if (!this._video || !this._captionsActive || this._captionMode === "off" ||
        !this._isYouTubeDocument()) {
      return;
    }
    const now = this.contentWindow?.performance?.now?.() ?? Date.now();
    if (now < this._captionTrackCheckAt) return;
    this._captionTrackCheckAt = now + CAPTION_TRACK_CHECK_MS;

    const track = this._getCaptionTrackInfo();
    if (!track) return;
    if (track.key === this._captionTrackKey && this._captionCues) return;
    if (track.key === this._captionLoadPendingKey) return;

    const serial = ++this._captionLoadSerial;
    this._captionTrackKey = track.key;
    this._captionLoadPendingKey = track.key;
    this._captionCues = null;
    const video = this._video;
    try {
      const url = new this.contentWindow.URL(track.baseUrl);
      if (!url.hostname.endsWith("youtube.com") &&
          !url.hostname.endsWith("youtube-nocookie.com")) {
        throw new Error("Unexpected caption host");
      }
      if (track.translationCode) {
        url.searchParams.set("tlang", track.translationCode);
      }
      let cues = [];
      for (const format of ["json3", "srv3", ""]) {
        if (format) url.searchParams.set("fmt", format);
        else url.searchParams.delete("fmt");
        const response = await this.contentWindow.fetch(url.href, {
          credentials: "include",
        });
        if (!response.ok) continue;
        const body = await response.text();
        if (!body) continue;
        if (format === "json3") {
          try {
            cues = this._parseCaptionJSON3(JSON.parse(body));
          } catch (_) {
            cues = [];
          }
        } else {
          cues = this._parseCaptionXML(body);
        }
        if (cues.length) break;
      }
      if (!cues.length) throw new Error("Caption track contained no cues");
      if (serial !== this._captionLoadSerial || video !== this._video) return;
      this._captionLoadPendingKey = "";
      this._captionCues = cues;
      this._updateCaptionFromClock();
    } catch (error) {
      if (serial !== this._captionLoadSerial) return;
      this._captionLoadPendingKey = "";
      this._captionTrackKey = "";
      this._captionCues = null;
      this._debug("[Zenslop/content] caption track load failed:", error);
    }
  }

  _timedCaptionAt(timeMs) {
    const cues = this._captionCues;
    if (!cues?.length) return "";

    // Find the last cue that has started, then walk backward only while some
    // earlier cue can still be active. The prefix maximum handles unusually
    // long manual cues without scanning the full transcript on every tick.
    let low = 0;
    let high = cues.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (cues[mid].startMs <= timeMs) low = mid + 1;
      else high = mid;
    }

    const active = [];
    for (let i = low - 1; i >= 0; i--) {
      const cue = cues[i];
      if (cue.maxEndThrough <= timeMs) break;
      if (timeMs < cue.endMs) active.push([i, cue]);
    }
    active.reverse();

    const windows = new Map();
    for (const [i, cue] of active) {
      const text = cue.segments
        .filter(segment => segment.startMs <= timeMs + 25)
        .map(segment => segment.text)
        .join("")
        .replace(/\s+/g, " ")
        .trim();
      if (!text) continue;
      const windowKey = cue.windowId ?? `cue-${i}`;
      const previous = windows.get(windowKey) || "";
      windows.set(
        windowKey,
        cue.append && previous
          ? this._appendCaptionText(previous, text)
          : text,
      );
    }
    return this._joinDistinctCaptionWindows(windows.values());
  }

  _updateCaptionFromClock() {
    if (!this._video || !this._captionsActive || this._captionMode === "off" ||
        !this._isYouTubeDocument()) {
      return;
    }
    this._ensureCaptionTrack();
    let text = "";
    if (this._sourceCaptionsEnabled()) {
      text = this._captionCues
        ? this._timedCaptionAt(this._video.currentTime * 1000)
        : this._syncCaption();
    }
    this._sendCaption(text);
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
    if (clear) {
      this._captionLoadSerial++;
      this._captionCues = null;
      this._captionTrackKey = "";
      this._captionTrackCheckAt = 0;
      this._captionLoadPendingKey = "";
    }
    if (clear) this._sendCaption("");
  }

  _setProcessingActive(
    active,
    captionMode = "off",
    captionsActive = active,
  ) {
    active = Boolean(active);
    captionMode = captionMode === "on" || captionMode === "youtube"
      ? captionMode
      : "off";
    captionsActive = Boolean(captionsActive) && captionMode !== "off";
    if (this._processingActive === active &&
        this._captionMode === captionMode &&
        this._captionsActive === captionsActive) return;
    this._processingActive = active;
    this._captionMode = captionMode;
    this._captionsActive = captionsActive;
    if (captionsActive) {
      this._startCaptionTracking();
    } else {
      this._stopCaptionTracking(captionMode === "off");
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
      // Synchronous downscale + readback, shipped as a transferable RGBA
      // buffer. An ImageBitmap cannot cross the JSActor boundary — Gecko's
      // structured clone restricts it to same-process scope — so a copied
      // ArrayBuffer is the wire format. willReadFrequently keeps the
      // getImageData readback cheap.
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      this.sendAsyncMessage("ZenPiP:Frame", {
        buf: img.data.buffer,
        sourceSerial: this._sourceSerial,
        width: canvas.width,
        height: canvas.height,
      }, [img.data.buffer]);
    } catch (e) {
      this._debug("[Zenslop/content] _captureFrame threw:", String(e), e?.name, e?.message);
    }
  }

  _stopAndNotify(reason) {
    this._debug("[Zenslop/content] stopAndNotify reason=", reason, "hadVideo=", !!this._video);
    if (!this._video) return;
    this._teardown({ keepInstagramPauseGuard: reason === "event:pause" });
    try {
      this.sendAsyncMessage("ZenPiP:VideoStopped", { reason, sourceSerial: this._sourceSerial });
    } catch (e) {}
  }

  _teardown({ keepInstagramPauseGuard = false } = {}) {
    if (!keepInstagramPauseGuard) this._removeInstagramPauseGuard();
    this._shortVideoResumeAttempt = null;
    this._shortVideoBackgroundResumeUntil = 0;
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

  _inspectSource() {
    const visible = this._shortVideoKind() ? this._getVisibleReel() : null;
    const nextControl = this._isInstagramReels()
      ? this.contentWindow.document.querySelector('[aria-label="Navigate to next Reel"]') : null;
    const describe = video => video ? {
      connected: video.isConnected, paused: video.paused, muted: video.muted,
      readyState: video.readyState, currentTime: video.currentTime,
      width: video.videoWidth, height: video.videoHeight,
      sameAsTracked: video === this._video,
    } : null;
    return {
      path: this.contentWindow.location.pathname,
      mirroredPath: this._mirroredShortPath,
      sourceSerial: this._sourceSerial, processingActive: this._processingActive,
      hidden: this.contentWindow.document.hidden,
      tracked: describe(this._video), visible: describe(visible),
      navigationPending: !!this._reelNavigation,
      waitingForFeed: !!this._waitingReelNavigation,
      wakingFeed: !!this._feedWakeActive,
      nextControl: nextControl ? { disabled: !!nextControl.disabled || nextControl.getAttribute("aria-disabled") === "true" } : null,
      nextTargetAvailable: !!(this._isInstagramReels() && this._getReelScrollTarget(visible || this._video, 1)),
      feed: this._reelFeed ? { items: this._reelFeed.children?.length,
        top: this._reelFeed.scrollTop, height: this._reelFeed.clientHeight,
        totalHeight: this._reelFeed.scrollHeight } : null,
      playbackPending: !!this._pendingReelPlayback,
    };
  }

  async receiveMessage(msg) {
    if (msg.name === "ZenPiP:FeedWakeState") {
      this._feedWakeActive = msg.data?.active === true;
      if (this._feedWakeActive && this._instagramPauseGuard && !this._instagramPauseGuard.video && this._video?.isConnected) {
        this._instagramPauseGuard.video = this._video;
      }
      if (!this._feedWakeActive) this._feedWakeRequested = false;
      return true;
    }
    if (msg.name === "ZenPiP:InspectSource") return this._inspectSource();
    if (msg.name === "ZenPiP:ReelRescan") {
      this._reelRescanPending = false;
      this._refreshShortVideoDetection("change");
      return;
    }
    if (msg.name === "ZenPiP:NavigationTimeout") {
      const navigation = this._reelNavigation;
      if (this._isInstagramReels() && navigation?.previous &&
          this._getVisibleReel() === navigation.previous) {
        // Keep a single intent dormant until the continuation adds a target.
        // Do not keep clicking or polling at an exhausted feed boundary.
        this._waitingReelNavigation = { previous: navigation.previous, direction: navigation.direction };
      }
      this._cancelReelNavigation();
      this._refreshShortVideoDetection("timeout");
      return;
    }
    if (msg.name === "ZenPiP:NavigationCheck") {
      this._reelNavigation?.check();
      return;
    }
    if (msg.name === "ZenPiP:InstagramPlaybackIntent") {
      if (!this._shortVideoKind()) return false;
      if (msg.data?.paused === true) {
        this._pendingReelPlayback = null;
        this._waitingReelNavigation = null;
        if (this._feedWakeRequested) this.sendAsyncMessage("ZenPiP:FeedBoundary", { active: false });
        this._feedWakeActive = false;
        this._feedWakeRequested = false;
        this._cancelReelNavigation();
      }
      if (this._instagramPauseGuard) {
        this._instagramPauseGuard.allowPagePause = msg.data?.paused === true;
      }
      return true;
    }
    if (msg.name === "ZenPiP:NextShortVideo") {
      this._requestShortVideoNavigation();
      return;
    }
    if (msg.name === "ZenPiP:PreviousShortVideo") {
      this._requestShortVideoNavigation(-1);
      return;
    }
    if (msg.name === "ZenPiP:Tick") {
      // No doc.hidden gate here: the mirror is shown precisely when the
      // source tab is backgrounded, so hidden is the state we capture in.
      // Visibility gating is controlled by the chrome-window controller.
      this._captureFrame(msg.data?.quality);
      return;
    }
    if (msg.name === "ZenPiP:CaptionTick") {
      this._updateCaptionFromClock();
      return;
    }
    if (msg.name === "ZenPiP:Stop") {
      this._stopAndNotify("parent:stop");
      return;
    }
    if (msg.name === "ZenPiP:SetProcessingState") {
      this._setProcessingActive(
        msg.data?.active,
        msg.data?.captionMode,
        msg.data?.captionsActive,
      );
    }
  }

  didDestroy() {
    this._pendingReelPlayback = null;
    this._waitingReelNavigation = null;
    this._cancelReelNavigation();
    this._reelRescanPending = false;
    if (this._shortsNavigateBound) {
      this.contentWindow.removeEventListener("yt-navigate-finish", this._shortsNavigateBound);
      this._shortsNavigateBound = null;
    }
    if (this._reelScrollBound) {
      this.contentWindow.document.removeEventListener("scroll", this._reelScrollBound, true);
      this._reelScrollBound = null;
    }
    if (this._reelScrollEndBound) {
      this.contentWindow.document.removeEventListener("scrollend", this._reelScrollEndBound, true);
      this._reelScrollEndBound = null;
    }
    this._videoIntersectionObserver?.disconnect();
    this._videoIntersectionObserver = null;
    this._observedVideos?.clear();
    try {
      this._videoObserver?.disconnect();
    } catch (_) {}
    this._videoObserver = null;
    this._teardown();
  }
}
