// Skipjack step 1 probe.
//
// Runs in the page's own JavaScript world on youtube.com and reports which
// sponsor-detection signals are readable before playback reaches them:
// captions (three access routes), chapters, the paid promotion flag, the
// "most replayed" heatmap, description links, and storyboard specs.
//
// It reads only. It skips nothing and keeps no data of its own. Every request
// it makes is addressed to youtube.com; a caption request that YouTube
// redirects is followed, and the report records the host it ended on.
// The report leaves the page only when you select Copy or Download.
(() => {
  "use strict";

  if (window.__skipjackProbe) return;

  const VERSION = "0.0.6";
  const TAG = "[Skipjack probe]";
  const PANEL_ID = "skipjack-probe-panel";
  const state = { version: VERSION, reports: [], run: null };
  window.__skipjackProbe = state;

  // ---------------------------------------------------------------------
  // Observe the player's own caption requests. Since 2025 the caption URLs
  // in the player response often return an empty body unless they carry a
  // proof-of-origin token ("pot") that only the player adds, so the URL the
  // player itself requests is the fallback route.
  //
  // The observer also sees the probe's own caption fetches. Those are
  // recorded in ownTimedtextFetches before they start and are left out, so
  // route B only ever reuses a URL the player requested.
  // ---------------------------------------------------------------------
  const timedtextUrls = [];
  const ownTimedtextFetches = new Set();
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.name.includes("/api/timedtext") && !ownTimedtextFetches.has(entry.name)) timedtextUrls.push(entry.name);
      }
    }).observe({ type: "resource", buffered: true });
  } catch (err) {
    console.warn(TAG, "PerformanceObserver unavailable", err);
  }

  // ---------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function waitFor(fn, timeoutMs, stepMs = 250) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      let value = null;
      try {
        value = fn();
      } catch (err) {
        value = null;
      }
      if (value) return value;
      if (Date.now() >= deadline) return null;
      await sleep(stepMs);
    }
  }

  // Collects every value stored under `key` anywhere in a JSON-like tree.
  // YouTube moves these fields between releases, so the probe searches by
  // key name instead of hard-coding a path.
  function findAll(root, key, limit = 5000) {
    const out = [];
    const stack = [root];
    const seen = new Set();
    while (stack.length && out.length < limit) {
      const node = stack.pop();
      if (!node || typeof node !== "object" || seen.has(node)) continue;
      seen.add(node);
      if (Array.isArray(node)) {
        for (let i = node.length - 1; i >= 0; i--) stack.push(node[i]);
        continue;
      }
      const keys = Object.keys(node);
      for (let i = keys.length - 1; i >= 0; i--) {
        const k = keys[i];
        if (k === key) out.push(node[k]);
        stack.push(node[k]);
      }
    }
    return out;
  }

  // Lists the distinct key names anywhere in a tree that match a pattern.
  // Used to tell "this video has no such data" apart from "the data is there
  // under a name the probe does not know yet".
  function keysMatching(root, pattern, cap = 30) {
    const names = new Set();
    const stack = [root];
    const seen = new Set();
    while (stack.length && names.size < cap) {
      const node = stack.pop();
      if (!node || typeof node !== "object" || seen.has(node)) continue;
      seen.add(node);
      if (Array.isArray(node)) {
        for (const item of node) stack.push(item);
        continue;
      }
      for (const k of Object.keys(node)) {
        if (pattern.test(k)) names.add(k);
        stack.push(node[k]);
      }
    }
    return [...names].sort();
  }

  function text(t) {
    if (t == null) return null;
    if (typeof t === "string") return t;
    if (typeof t.simpleText === "string") return t.simpleText;
    if (Array.isArray(t.runs)) return t.runs.map((r) => r.text ?? "").join("");
    return null;
  }

  const clip = (s, n) => (s.length > n ? s.slice(0, n) + "..." : s);

  // ---------------------------------------------------------------------
  // Captions
  // ---------------------------------------------------------------------
  function summarizeJson3(body) {
    if (!body) return { usable: false, reason: "empty body" };
    let json;
    try {
      json = JSON.parse(body);
    } catch (err) {
      return { usable: false, reason: "not JSON", head: body.slice(0, 120) };
    }
    const cues = (json.events ?? [])
      .filter((e) => Array.isArray(e.segs))
      .map((e) => ({
        startMs: e.tStartMs ?? 0,
        durMs: e.dDurationMs ?? 0,
        text: e.segs.map((s) => s.utf8 ?? "").join("").trim(),
        wordTimed: e.segs.some((s) => typeof s.tOffsetMs === "number"),
      }))
      .filter((c) => c.text);
    if (!cues.length) return { usable: false, reason: "no cues", cues: 0 };
    const last = cues[cues.length - 1];
    const summary = {
      usable: true,
      cues: cues.length,
      wordLevelTiming: cues.some((c) => c.wordTimed),
      firstCueMs: cues[0].startMs,
      lastCueEndMs: last.startMs + last.durMs,
      sample: cues.slice(0, 3).map((c) => ({ startMs: c.startMs, durMs: c.durMs, text: clip(c.text, 120) })),
    };
    // The full cue list rides along as a non-enumerable property, so it stays
    // out of the report unless the transcript download asks for it.
    Object.defineProperty(summary, "allCues", { value: cues.map((c) => [c.startMs, c.durMs, c.text]), enumerable: false });
    return summary;
  }

  // The report keeps the parameter names of a caption URL and drops the
  // values, because the values include signatures and session tokens.
  async function fetchTimedtext(rawUrl) {
    const url = new URL(rawUrl, location.origin);
    url.searchParams.set("fmt", "json3");
    const result = {
      paramNames: [...new Set(url.searchParams.keys())].sort(),
      hasPot: url.searchParams.has("pot"),
    };
    ownTimedtextFetches.add(url.href);
    try {
      const response = await fetch(url.href);
      const body = await response.text();
      result.status = response.status;
      result.bytes = body.length;
      // Redirects are followed. Record where the request ended up, because a
      // rate-limited request can be sent to a verification page on another host.
      result.redirected = Boolean(response.redirected);
      if (response.redirected) {
        try {
          result.finalHost = new URL(response.url).host;
        } catch (err) {
          result.finalHost = null;
        }
      }
      const summary = summarizeJson3(body);
      Object.assign(result, summary);
      if (summary.allCues) Object.defineProperty(result, "allCues", { value: summary.allCues, enumerable: false });
    } catch (err) {
      result.usable = false;
      result.error = String(err);
    }
    return result;
  }

  function observedTimedtextUrl(videoId) {
    for (let i = timedtextUrls.length - 1; i >= 0; i--) {
      try {
        if (new URL(timedtextUrls[i]).searchParams.get("v") === videoId) return timedtextUrls[i];
      } catch (err) {
        // Ignore an unparseable entry.
      }
    }
    return null;
  }

  // Route B: reuse the URL the player requests. If the player has not asked
  // for captions yet, switch captions on briefly to make it ask, then put the
  // setting back the way it was.
  // Hides the caption overlay and returns a function that shows it again, or
  // null if the browser refused. A constructed stylesheet is used because it
  // needs no inline <style> element.
  function hideCaptionOverlay() {
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(".ytp-caption-window-container, .caption-window { visibility: hidden !important; }");
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
      return () => {
        document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== sheet);
      };
    } catch (err) {
      return null;
    }
  }

  // The transcript read through the player's URL for the current video. Held
  // in memory only; it leaves the page only through "Download + transcript".
  let lastTranscript = null;

  // The player's caption URL for the current video. Held in memory only so
  // the token test can reuse it; it is never written to a report.
  let lastPlayerUrl = null;

  async function probePlayerRequest(player, videoId, isCurrent) {
    let url = observedTimedtextUrl(videoId);
    const result = { observed: Boolean(url), toggledCaptions: false, toggleMethod: null };

    if (!url && isCurrent()) {
      const button = document.querySelector(".ytp-subtitles-button");
      if (button && typeof button.click === "function") {
        const wasOn = button.getAttribute("aria-pressed") === "true";
        result.toggleMethod = "subtitles-button";
        result.toggledCaptions = true;
        if (wasOn) {
          button.click();
          await sleep(400);
        }
        // When captions were off, hide the caption overlay for the moment
        // they are on, so the viewer does not see them flash.
        const showOverlay = wasOn ? null : hideCaptionOverlay();
        result.captionsHidden = Boolean(showOverlay);
        const onAt = Date.now();
        button.click();
        try {
          url = await waitFor(() => observedTimedtextUrl(videoId), 6000, 100);
        } finally {
          if (!wasOn) button.click();
          result.captionsOnMs = Date.now() - onAt;
          if (showOverlay) {
            await sleep(300);
            showOverlay();
          }
        }
      } else if (typeof player.toggleSubtitles === "function") {
        result.toggleMethod = "player.toggleSubtitles";
        result.toggledCaptions = true;
        player.toggleSubtitles();
        try {
          url = await waitFor(() => observedTimedtextUrl(videoId), 6000);
        } finally {
          player.toggleSubtitles();
        }
      }
      result.observed = Boolean(url);
    }

    if (!url) return { ...result, usable: false, reason: "player made no caption request" };
    lastPlayerUrl = { videoId, url };
    const fetched = await fetchTimedtext(url);
    if (fetched.usable && fetched.allCues) {
      const params = new URL(url).searchParams;
      lastTranscript = {
        videoId,
        track: { languageCode: params.get("lang"), kind: params.get("kind") || "manual" },
        cues: fetched.allCues,
      };
    }
    return { ...result, ...fetched };
  }

  // Toggle test: switches captions on for a full second and off again, on
  // demand, so the hiding can be judged while someone is speaking on screen.
  // The real toggle lasts about a tenth of a second; one second is the harsh
  // case. With hidden=false the overlay is left visible, as a control that
  // shows what an unhidden flash looks like.
  const toggleTests = [];
  let toggleTestRunning = false;

  async function toggleTest(hidden) {
    if (toggleTestRunning) return null;
    const button = document.querySelector(".ytp-subtitles-button");
    const player = document.getElementById("movie_player");
    const entry = {
      at: new Date().toISOString(),
      videoId: new URLSearchParams(location.search).get("v"),
      mode: hidden ? "hidden" : "visible",
      fullscreen: Boolean(document.fullscreenElement),
    };
    if (!button || typeof button.click !== "function") return { ...entry, skipped: "no captions button" };
    if (button.getAttribute("aria-pressed") === "true") return { ...entry, skipped: "captions are on, turn them off first" };
    toggleTestRunning = true;
    try {
      entry.videoTimeSec = player && typeof player.getCurrentTime === "function" ? Math.round(player.getCurrentTime()) : null;
      const showOverlay = hidden ? hideCaptionOverlay() : null;
      entry.overlayHidden = Boolean(showOverlay);
      const onAt = Date.now();
      button.click();
      await sleep(1000);
      // Whether a caption line existed while captions were on. If none did,
      // nobody was speaking and the test proves nothing either way.
      entry.captionTextPresent = Boolean(document.querySelector(".ytp-caption-segment"));
      button.click();
      entry.onMs = Date.now() - onAt;
      if (showOverlay) {
        await sleep(300);
        showOverlay();
      }
      entry.restoredOff = button.getAttribute("aria-pressed") !== "true";
    } finally {
      toggleTestRunning = false;
    }
    toggleTests.push(entry);
    console.log(TAG, "toggle test", entry);
    return entry;
  }

  function describeToggleTest(t) {
    if (!t) return "A toggle test is already running.";
    if (t.skipped) return "Toggle test skipped: " + t.skipped + ".";
    return (
      "Toggle test (" + t.mode + "): captions on " + t.onMs + " ms at " + t.videoTimeSec + " s, caption line present: " +
      (t.captionTextPresent ? "yes" : "no, so this run proves nothing") + ", overlay hidden: " + (t.overlayHidden ? "yes" : "no") + "."
    );
  }

  // Token test: does the token the player obtained for one caption track also
  // unlock other tracks of the same video? If it does, one player request is
  // enough to read any track, including the auto-generated one, which is the
  // track that carries per-word timing.
  //
  // The test starts from a track's own URL and adds every parameter the
  // player's URL has that the track URL lacks, except the parameters that
  // identify the track or the format.
  const TRACK_PARAMS = new Set(["lang", "kind", "name", "tlang", "fmt", "v"]);

  async function probeTokenReuse(tracks, pick, videoId) {
    if (!lastPlayerUrl || lastPlayerUrl.videoId !== videoId) return null;
    const source = new URL(lastPlayerUrl.url);
    const kindOf = (t) => t.kind ?? "manual";
    const requested = { languageCode: source.searchParams.get("lang"), kind: source.searchParams.get("kind") || "manual" };

    const transplant = async (track) => {
      const target = new URL(track.baseUrl, location.origin);
      const copied = [];
      for (const [k, v] of source.searchParams) {
        if (TRACK_PARAMS.has(k) || target.searchParams.has(k)) continue;
        target.searchParams.set(k, v);
        copied.push(k);
      }
      const fetched = await fetchTimedtext(target.href);
      return { track: { languageCode: track.languageCode ?? null, kind: kindOf(track) }, copiedParams: copied.sort(), ...fetched };
    };

    const english = (t) => typeof t.languageCode === "string" && t.languageCode.startsWith("en");
    const same = tracks.find((t) => t.languageCode === requested.languageCode && kindOf(t) === requested.kind) || pick;
    const other =
      tracks.find((t) => t !== same && english(t) && t.kind === "asr") ||
      tracks.find((t) => t !== same && english(t)) ||
      tracks.find((t) => t !== same) ||
      null;

    return {
      playerRequestedTrack: requested,
      sameTrack: same && same.baseUrl ? await transplant(same) : null,
      otherTrack: other && other.baseUrl ? await transplant(other) : null,
    };
  }

  // Which caption-related methods the player object exposes. Read-only: the
  // probe checks that they exist and calls none of them here.
  function probePlayerApi(player) {
    const names = ["loadModule", "unloadModule", "getOption", "getOptions", "setOption", "toggleSubtitles", "toggleSubtitlesOn", "isSubtitlesOn"];
    const out = {};
    for (const name of names) out[name] = typeof player[name] === "function";
    return out;
  }

  // Route C: the endpoint behind the "Show transcript" panel. The request
  // carries your normal youtube.com cookies but no Authorization header, so a
  // signed-in session may be refused; status and errorStatus in the report
  // say what came back.
  async function probeGetTranscript(initialData) {
    if (!initialData) return { paramsFound: false, usable: false, reason: "stale page data" };
    const endpoint = findAll(initialData, "getTranscriptEndpoint")[0];
    if (!endpoint || !endpoint.params) return { paramsFound: false, usable: false, reason: "no transcript endpoint in page data" };
    const cfg = window.ytcfg;
    const context =
      (cfg && typeof cfg.get === "function" && cfg.get("INNERTUBE_CONTEXT")) ||
      (cfg && cfg.data_ && cfg.data_.INNERTUBE_CONTEXT) ||
      null;
    if (!context) return { paramsFound: true, usable: false, reason: "no INNERTUBE_CONTEXT" };
    const result = { paramsFound: true };
    try {
      const response = await fetch("/youtubei/v1/get_transcript?prettyPrint=false", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ context, params: endpoint.params }),
      });
      result.status = response.status;
      const json = await response.json().catch(() => null);
      const segments = findAll(json, "transcriptSegmentRenderer", 200000);
      result.segments = segments.length;
      result.usable = segments.length > 0;
      result.sample = segments.slice(0, 3).map((s) => ({
        startMs: Number(s.startMs),
        endMs: Number(s.endMs),
        text: clip(text(s.snippet) ?? "", 120),
      }));
      if (!segments.length) result.errorStatus = (json && json.error && json.error.status) || null;
    } catch (err) {
      result.usable = false;
      result.error = String(err);
    }
    return result;
  }

  async function probeCaptions(player, playerResponse, initialData, videoId, isCurrent) {
    const tracks =
      (playerResponse.captions &&
        playerResponse.captions.playerCaptionsTracklistRenderer &&
        playerResponse.captions.playerCaptionsTracklistRenderer.captionTracks) ||
      [];
    const out = {
      tracks: tracks.map((t) => ({
        languageCode: t.languageCode ?? null,
        kind: t.kind ?? "manual",
        name: text(t.name),
        isTranslatable: Boolean(t.isTranslatable),
      })),
      pickedTrack: null,
      directFetch: null,
      playerRequest: null,
      tokenReuse: null,
      getTranscript: null,
      playerApi: probePlayerApi(player),
    };

    const english = (t) => typeof t.languageCode === "string" && t.languageCode.startsWith("en");
    const pick = tracks.find((t) => english(t) && t.kind !== "asr") || tracks.find(english) || tracks[0] || null;

    if (pick && pick.baseUrl) {
      out.pickedTrack = { languageCode: pick.languageCode ?? null, kind: pick.kind ?? "manual" };
      out.directFetch = await fetchTimedtext(pick.baseUrl);
    }
    if (tracks.length && isCurrent()) out.playerRequest = await probePlayerRequest(player, videoId, isCurrent);
    if (out.playerRequest && out.playerRequest.usable && isCurrent()) out.tokenReuse = await probeTokenReuse(tracks, pick, videoId);
    if (isCurrent()) out.getTranscript = await probeGetTranscript(initialData);

    out.usableRoutes = ["directFetch", "playerRequest", "getTranscript"].filter((k) => out[k] && out[k].usable);
    return out;
  }

  // ---------------------------------------------------------------------
  // Metadata signals
  // ---------------------------------------------------------------------
  const SPONSOR_WORDS = /\b(sponsor(ed|s|ship)?|ad(vert(isement)?)?s?|paid promotion|promo(tion)?|brought to you)\b/i;

  function probeChapters(initialData) {
    const markerKeys = findAll(initialData, "markersMap")
      .flat()
      .map((m) => m && m.key)
      .filter(Boolean);
    const seen = new Set();
    const items = [];
    for (const r of findAll(initialData, "chapterRenderer")) {
      const item = { title: text(r.title) ?? "", startMs: Number(r.timeRangeStartMillis ?? 0) };
      const id = item.startMs + "|" + item.title;
      if (seen.has(id)) continue;
      seen.add(id);
      items.push(item);
    }
    items.sort((a, b) => a.startMs - b.startMs);
    return {
      markerKeys: [...new Set(markerKeys)],
      count: items.length,
      items,
      sponsorLabeled: items.filter((c) => SPONSOR_WORDS.test(c.title)),
    };
  }

  function probeHeatmap(initialData) {
    const markers = [];
    for (const r of findAll(initialData, "heatMarkerRenderer")) {
      markers.push([Number(r.startMillis ?? r.timeRangeStartMillis ?? 0), Number(r.durationMillis ?? r.markerDurationMillis ?? 0), Number(r.intensityScoreNormalized ?? r.heatMarkerIntensityScoreNormalized ?? 0)]);
    }
    let source = markers.length ? "heatMarkerRenderer" : null;
    if (!markers.length) {
      for (const entity of findAll(initialData, "macroMarkersListEntity")) {
        const list = entity && entity.markersList;
        if (!list || !/HEATMAP/.test(String(list.markerType)) || !Array.isArray(list.markers)) continue;
        for (const m of list.markers) {
          markers.push([Number(m.startMillis ?? 0), Number(m.durationMillis ?? 0), Number(m.intensityScoreNormalized ?? 0)]);
        }
        source = "macroMarkersListEntity";
      }
    }
    markers.sort((a, b) => a[0] - b[0]);
    return { source, count: markers.length, heatKeysSeen: keysMatching(initialData, /heat/i), format: "[startMs, durationMs, intensity0to1]", markers };
  }

  // The player draws the "most replayed" graph as SVG paths in its own DOM.
  // This reads those elements, as a second source when the page data has no
  // heatmap markers.
  function probeHeatmapDom(player) {
    if (!player || typeof player.querySelectorAll !== "function") return { checked: false };
    const nodes = [...player.querySelectorAll('[class*="heat"]')];
    const classes = new Set();
    const paths = new Set();
    for (const node of nodes) {
      for (const c of String(node.getAttribute("class") || "").split(/\s+/)) {
        if (/heat/i.test(c)) classes.add(c);
      }
      if (String(node.tagName).toLowerCase() === "path") paths.add(node);
      for (const p of node.querySelectorAll("path")) paths.add(p);
    }
    const shapes = [...paths].map((p) => p.getAttribute("d") || "").filter(Boolean);
    return {
      checked: true,
      elements: nodes.length,
      classes: [...classes].sort().slice(0, 20),
      paths: shapes.length,
      pathLengths: shapes.slice(0, 20).map((d) => d.length),
      samplePath: shapes.length ? clip(shapes[0], 200) : null,
    };
  }

  function probePaidPromotion(playerResponse, initialData) {
    const renderer = findAll(playerResponse, "paidContentOverlayRenderer")[0] || findAll(initialData, "paidContentOverlayRenderer")[0] || null;
    return { flag: Boolean(renderer), text: renderer ? text(renderer.text) : null };
  }

  const PROMO_LINE = /\b(sponsor\w*|promo(tion)?\s*code|coupon|discount|use (the )?code|\d{1,3}\s?% off|free trial|affiliate|paid promotion)\b/i;
  const TIMESTAMP_LINE = /^\s*[([]?\d{1,2}:\d{2}(:\d{2})?/;

  function probeDescription(playerResponse) {
    const description = (playerResponse.videoDetails && playerResponse.videoDetails.shortDescription) || "";
    const lines = description.split(/\r?\n/);
    const urls = description.match(/https?:\/\/[^\s)\]]+/g) || [];
    return {
      length: description.length,
      urlCount: urls.length,
      urls: [...new Set(urls)].slice(0, 50),
      promoLines: lines.filter((l) => PROMO_LINE.test(l)).slice(0, 20).map((l) => clip(l.trim(), 200)),
      timestampLines: lines.filter((l) => TIMESTAMP_LINE.test(l)).slice(0, 60).map((l) => clip(l.trim(), 200)),
    };
  }

  // Spec format: "<url template>|<w>#<h>#<count>#<cols>#<rows>#<intervalMs>#<name>#<sig>|..."
  function probeStoryboards(playerResponse) {
    const sb = playerResponse.storyboards || {};
    const spec = (sb.playerStoryboardSpecRenderer && sb.playerStoryboardSpecRenderer.spec) || (sb.playerLiveStoryboardSpecRenderer && sb.playerLiveStoryboardSpecRenderer.spec) || null;
    if (!spec) return { specPresent: false, levels: [] };
    const levels = spec
      .split("|")
      .slice(1)
      .map((part) => part.split("#"))
      .filter((f) => f.length >= 6)
      .map((f) => ({ width: Number(f[0]), height: Number(f[1]), frames: Number(f[2]), cols: Number(f[3]), rows: Number(f[4]), intervalMs: Number(f[5]) }));
    return { specPresent: true, levels };
  }

  // ---------------------------------------------------------------------
  // Page data
  // ---------------------------------------------------------------------
  let navData = null;

  function dataVideoId(data) {
    const id = data && data.currentVideoEndpoint && data.currentVideoEndpoint.watchEndpoint && data.currentVideoEndpoint.watchEndpoint.videoId;
    return id || null;
  }

  // After an in-site navigation window.ytInitialData is stale, so prefer the
  // response attached to the navigation event and check both against the URL.
  function pickInitialData(videoId) {
    const candidates = [
      ["navigate-event", navData],
      ["ytInitialData", window.ytInitialData],
    ];
    for (const [source, data] of candidates) {
      if (data && dataVideoId(data) === videoId) return { source, data, matchesVideo: true };
    }
    for (const [source, data] of candidates) {
      if (data) return { source, data, matchesVideo: false };
    }
    return { source: null, data: null, matchesVideo: false };
  }

  // ---------------------------------------------------------------------
  // Run
  // ---------------------------------------------------------------------
  let runToken = 0;
  let timer = null;
  let everScheduled = false;

  // Scheduling a run cancels any run already in flight: the token changes
  // here, and the running probe checks it before each step.
  function schedule() {
    everScheduled = true;
    runToken++;
    clearTimeout(timer);
    timer = setTimeout(() => {
      run().catch((err) => console.error(TAG, "run failed", err));
    }, 600);
  }

  async function run() {
    const token = ++runToken;
    removePanel();
    if (location.pathname !== "/watch") return null;
    const videoId = new URLSearchParams(location.search).get("v");
    if (!videoId) return null;

    showStatus("Skipjack probe: reading " + videoId + "...");

    const found = await waitFor(() => {
      const player = document.getElementById("movie_player");
      if (!player || typeof player.getPlayerResponse !== "function") return null;
      const response = player.getPlayerResponse();
      if (!response || !response.videoDetails || response.videoDetails.videoId !== videoId) return null;
      return { player, response };
    }, 20000);
    if (token !== runToken) return null;
    if (!found) {
      showStatus("Skipjack probe: the player response for " + videoId + " never appeared.");
      return null;
    }

    const { player, response } = found;
    const isCurrent = () => token === runToken;

    // While an ad plays, the player does not request the video's captions,
    // so wait for the ad to end before probing.
    const adIsShowing = () => Boolean(player.classList && player.classList.contains("ad-showing"));
    const adSeen = adIsShowing();
    if (adSeen) {
      showStatus("Skipjack probe: waiting for the ad to finish...");
      await waitFor(() => !adIsShowing() || !isCurrent(), 90000, 500);
    }
    if (!isCurrent()) return null;

    // Give the page a moment to attach chapter and heatmap data, and after
    // an in-site navigation, time to deliver data for this video.
    await sleep(1500);
    await waitFor(() => pickInitialData(videoId).matchesVideo || !isCurrent(), 5000);
    if (!isCurrent()) return null;

    // Page data for a different video is never used: it would report the
    // previous video's transcript, chapters, and heatmap as this video's.
    const initial = pickInitialData(videoId);
    const pageData = initial.matchesVideo ? initial.data : null;
    const stale = { unavailable: "stale page data" };
    const details = response.videoDetails;
    const errors = [];
    const guard = async (name, fn, fallback) => {
      try {
        return await fn();
      } catch (err) {
        errors.push(name + ": " + String(err));
        return fallback;
      }
    };

    const cfg = window.ytcfg;
    const report = {
      probeVersion: VERSION,
      capturedAt: new Date().toISOString(),
      userAgent: navigator.userAgent,
      clientVersion: (cfg && typeof cfg.get === "function" && cfg.get("INNERTUBE_CLIENT_VERSION")) || null,
      videoId,
      title: details.title ?? null,
      channel: details.author ?? null,
      lengthSeconds: Number(details.lengthSeconds ?? 0),
      isLive: Boolean(details.isLiveContent),
      initialData: { source: initial.source, matchesVideo: initial.matchesVideo },
      adSeenAtStart: adSeen,
      adStillShowing: adIsShowing(),
    };
    report.captions = await guard("captions", () => probeCaptions(player, response, pageData, videoId, isCurrent), null);
    if (!isCurrent()) return null;
    report.chapters = await guard("chapters", () => (pageData ? probeChapters(pageData) : stale), null);
    report.paidPromotion = await guard("paidPromotion", () => probePaidPromotion(response, pageData), null);
    report.heatmap = await guard("heatmap", () => (pageData ? probeHeatmap(pageData) : stale), null);
    report.heatmapDom = await guard("heatmapDom", () => probeHeatmapDom(player), null);
    report.description = await guard("description", () => probeDescription(response), null);
    report.storyboards = await guard("storyboards", () => probeStoryboards(response), null);
    report.errors = errors;

    if (token !== runToken) return null;
    state.reports.push(report);
    console.log(TAG, report);
    showReport(report);
    return report;
  }
  state.run = run;

  // ---------------------------------------------------------------------
  // Panel. YouTube enforces Trusted Types, so the panel is built with DOM
  // calls and textContent only, never innerHTML.
  // ---------------------------------------------------------------------
  function removePanel() {
    const old = document.getElementById(PANEL_ID);
    if (old) old.remove();
  }

  function makePanel() {
    removePanel();
    const panel = document.createElement("div");
    panel.id = PANEL_ID;
    panel.style.cssText =
      "position:fixed;right:16px;bottom:16px;z-index:2147483647;max-width:420px;padding:12px 14px;" +
      "background:#101418;color:#e8eaed;border:1px solid #3c4043;border-radius:8px;" +
      "font:12px/1.5 ui-monospace,Consolas,monospace;box-shadow:0 4px 16px rgba(0,0,0,.5)";
    (document.body || document.documentElement).append(panel);
    return panel;
  }

  function showStatus(message) {
    const panel = makePanel();
    panel.textContent = message;
  }

  function summaryRows(r) {
    const c = r.captions;
    const route = (x) => (!x ? "not tried" : x.usable ? "OK, " + (x.cues ?? x.segments) + " cues" : "no (" + (x.reason || x.errorStatus || x.error || "status " + x.status) + ")");
    const rows = [];
    rows.push(["Caption tracks", c ? String(c.tracks.length) + (c.pickedTrack ? " (using " + c.pickedTrack.languageCode + ", " + c.pickedTrack.kind + ")" : "") : "error"]);
    rows.push(["A. Direct caption URL", c ? route(c.directFetch) : "error"]);
    rows.push(["B. Player's caption URL", c ? route(c.playerRequest) : "error"]);
    const reuse = c && c.tokenReuse;
    if (reuse && reuse.otherTrack) {
      const o = reuse.otherTrack;
      const p = c.playerRequest;
      if (p && p.toggledCaptions) rows.push(["Captions toggle", (p.captionsOnMs ?? "?") + " ms on, overlay " + (p.captionsHidden ? "hidden" : "visible")]);
      rows.push(["Token on " + o.track.languageCode + " " + o.track.kind + " track", route(o) + (o.usable ? ", word timing " + (o.wordLevelTiming ? "yes" : "no") : "")]);
    }
    rows.push(["C. Transcript endpoint", c ? route(c.getTranscript) : "error"]);
    const na = (x) => (!x ? "error" : x.unavailable ? "unavailable (" + x.unavailable + ")" : null);
    if (r.adStillShowing) rows.push(["Warning", "an ad was still playing, caption results are unreliable"]);
    if (!r.initialData.matchesVideo) rows.push(["Warning", "page data was stale, reload the page and rerun"]);
    rows.push(["Chapters", na(r.chapters) || r.chapters.count + ", sponsor-labeled " + r.chapters.sponsorLabeled.length]);
    rows.push(["Paid promotion flag", r.paidPromotion ? (r.paidPromotion.flag ? "yes" : "no") : "error"]);
    rows.push(["Heatmap markers", na(r.heatmap) || String(r.heatmap.count) + (r.heatmap.count === 0 && r.heatmap.heatKeysSeen.length ? " (unparsed keys present)" : "")]);
    if (r.heatmapDom && r.heatmapDom.checked) rows.push(["Heatmap in player DOM", r.heatmapDom.paths + " paths, " + r.heatmapDom.elements + " elements"]);
    rows.push(["Description", r.description ? r.description.urlCount + " links, " + r.description.promoLines.length + " promo lines" : "error"]);
    rows.push(["Storyboard levels", r.storyboards ? String(r.storyboards.levels.length) : "error"]);
    return rows;
  }

  // Builds the JSON for a download or copy. Toggle tests for the video are
  // always included; the full transcript only when asked for.
  function buildJson(report, withTranscript) {
    const out = { ...report, toggleTests: toggleTests.filter((t) => t.videoId === report.videoId) };
    if (withTranscript && lastTranscript && lastTranscript.videoId === report.videoId) {
      out.transcript = { track: lastTranscript.track, format: "[startMs, durationMs, text]", cues: lastTranscript.cues };
    }
    return JSON.stringify(out, null, 2);
  }
  state.buildJson = buildJson;
  state.toggleTest = toggleTest;

  let currentNote = null;

  function showReport(report) {
    const panel = makePanel();

    const heading = document.createElement("div");
    heading.style.cssText = "font-weight:700;margin-bottom:6px";
    const transcriptOk = report.captions && report.captions.usableRoutes.length > 0;
    heading.textContent = "Skipjack probe " + VERSION + " - transcript: " + (transcriptOk ? "READABLE" : "NOT READABLE");
    panel.append(heading);

    for (const [label, value] of summaryRows(report)) {
      const row = document.createElement("div");
      row.textContent = label + ": " + value;
      panel.append(row);
    }

    const bar = document.createElement("div");
    bar.style.cssText = "margin-top:8px;display:flex;flex-wrap:wrap;gap:6px";
    const note = document.createElement("div");
    note.style.cssText = "margin-top:6px;color:#9aa0a6";
    currentNote = note;

    const button = (label, onClick) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      b.style.cssText = "font:inherit;padding:3px 8px;cursor:pointer;background:#2a2f35;color:#e8eaed;border:1px solid #5f6368;border-radius:4px";
      b.addEventListener("click", onClick);
      bar.append(b);
    };

    const download = (withTranscript) => {
      const name = "skipjack-probe-" + report.videoId + (withTranscript ? "-transcript" : "") + ".json";
      const href = URL.createObjectURL(new Blob([buildJson(report, withTranscript)], { type: "application/json" }));
      const link = document.createElement("a");
      link.href = href;
      link.download = name;
      panel.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(href), 10000);
      note.textContent = "Download started: " + name;
    };

    button("Download JSON", () => download(false));
    button("Download + transcript", () => download(true));
    button("Toggle test (hidden)", () => toggleTest(true).then((t) => (note.textContent = describeToggleTest(t))));
    button("Toggle test (visible)", () => toggleTest(false).then((t) => (note.textContent = describeToggleTest(t))));
    button("Copy JSON", () => {
      navigator.clipboard.writeText(buildJson(report, false)).then(
        () => {
          note.textContent = "Copied the report to the clipboard.";
        },
        () => {
          note.textContent = "Clipboard was refused. Use Download JSON.";
        }
      );
    });
    button("Rerun", () => schedule());
    button("Close", () => removePanel());

    panel.append(bar, note);
  }

  // ---------------------------------------------------------------------
  // Triggers. yt-navigate-finish fires on in-site navigation and normally on
  // first load too; the load listener covers the case where it does not.
  // ---------------------------------------------------------------------
  document.addEventListener("yt-navigate-finish", (event) => {
    const detail = event && event.detail;
    navData = (detail && detail.response && detail.response.response) || null;
    schedule();
  });
  window.addEventListener("load", () => {
    if (!everScheduled) schedule();
  });

  // Alt+Shift+K runs the hidden toggle test and Alt+Shift+J the visible one.
  // The shortcuts exist because the panel is not shown in fullscreen.
  document.addEventListener(
    "keydown",
    (event) => {
      if (!event.altKey || !event.shiftKey || (event.code !== "KeyK" && event.code !== "KeyJ")) return;
      event.preventDefault();
      event.stopPropagation();
      toggleTest(event.code === "KeyK").then((t) => {
        if (currentNote) currentNote.textContent = describeToggleTest(t);
      });
    },
    true
  );
})();
