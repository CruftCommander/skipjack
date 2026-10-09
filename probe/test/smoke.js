// Smoke test: runs probe.js against a mocked YouTube page in Node.
// Usage: node probe/test/smoke.js
// It runs two scenarios, a normal page and a page with stale data, each in
// its own child process because the probe keeps module-level state.
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { spawnSync } = require("child_process");

if (!process.env.SKIPJACK_SCENARIO) {
  let failed = false;
  for (const scenario of ["normal", "stale"]) {
    console.log("=== " + scenario);
    const child = spawnSync(process.execPath, [__filename], { env: { ...process.env, SKIPJACK_SCENARIO: scenario }, stdio: "inherit" });
    if (child.status !== 0) failed = true;
  }
  console.log(failed ? "SMOKE TEST FAILED" : "SMOKE TEST PASSED");
  process.exit(failed ? 1 : 0);
}

const probeDir = path.join(__dirname, "..");
const src = fs.readFileSync(path.join(probeDir, "probe.js"), "utf8");
const manifest = JSON.parse(fs.readFileSync(path.join(probeDir, "manifest.json"), "utf8"));

const VIDEO = "abc123XYZ_-";
const listeners = {};
let ccOn = false;
let perfCb = null;

function el(tag) {
  const e = {
    tag, children: [], style: {}, attrs: {}, textContent: "",
    append(...c) { this.children.push(...c); },
    remove() { if (panelHolder.panel === this) panelHolder.panel = null; },
    addEventListener(t, f) { (this.handlers ||= {})[t] = f; },
    setAttribute(k, v) { this.attrs[k] = v; },
    getAttribute(k) { return this.attrs[k] ?? null; },
    click() { this.handlers?.click?.(); },
  };
  return e;
}
const panelHolder = { panel: null };
const ccButton = el("button");
ccButton.getAttribute = () => (ccOn ? "true" : "false");
ccButton.click = () => {
  ccOn = !ccOn;
  if (ccOn) perfCb({ getEntries: () => [{ name: `https://www.youtube.com/api/timedtext?v=${VIDEO}&pot=TOKEN&lang=en&fmt=json3` }] });
};

const playerResponse = {
  videoDetails: { videoId: VIDEO, title: "T", author: "A", lengthSeconds: "600", shortDescription: "Thanks to our sponsor!\nUse code SKIP for 20% off https://example.com/x\n0:00 Intro\n1:02 Sponsor\n2:30 Main" },
  captions: { playerCaptionsTracklistRenderer: { captionTracks: [{ baseUrl: `https://www.youtube.com/api/timedtext?v=${VIDEO}&lang=en&signature=M`, languageCode: "en", name: { simpleText: "English" } }, { baseUrl: `https://www.youtube.com/api/timedtext?v=${VIDEO}&lang=en&kind=asr&signature=S`, languageCode: "en", kind: "asr", name: { simpleText: "English (auto-generated)" } }] } },
  paidContentOverlay: { paidContentOverlayRenderer: { text: { runs: [{ text: "Includes paid promotion" }] } } },
  storyboards: { playerStoryboardSpecRenderer: { spec: "https://i.ytimg.com/sb/x/storyboard3_L$L/$N.jpg|48#27#100#10#10#0#default#rs$a|80#45#120#10#10#5000#M$M#rs$b" } },
};
const initialData = {
  currentVideoEndpoint: { watchEndpoint: { videoId: VIDEO } },
  playerOverlays: { x: { markersMap: [
    { key: "DESCRIPTION_CHAPTERS", value: { chapters: [
      { chapterRenderer: { title: { simpleText: "Sponsor" }, timeRangeStartMillis: 62000 } },
      { chapterRenderer: { title: { simpleText: "Intro" }, timeRangeStartMillis: 0 } } ] } },
    { key: "HEATSEEKER", value: { heatmap: { heatmapRenderer: { heatMarkers: [
      { heatMarkerRenderer: { startMillis: 0, durationMillis: 6000, intensityScoreNormalized: 1 } },
      { heatMarkerRenderer: { startMillis: 6000, durationMillis: 6000, intensityScoreNormalized: 0.2 } } ] } } } } ] } },
  engagementPanels: [{ a: { getTranscriptEndpoint: { params: "PARAMS" } } }],
};
const player = el("div");
player.getPlayerResponse = () => playerResponse;

const json3 = JSON.stringify({ events: [{ tStartMs: 0, dDurationMs: 2000, segs: [{ utf8: "this video is" }, { utf8: " sponsored", tOffsetMs: 900 }] }, { tStartMs: 2000, segs: [{ utf8: "\n" }] }, { tStartMs: 2100, dDurationMs: 1500, segs: [{ utf8: "by nobody" }] }] });
const fetchLog = [];
const sandbox = {
  console: { log() {}, warn: console.warn, error: console.error }, setTimeout, clearTimeout, URL, URLSearchParams, Blob, Date, JSON, Promise, Set, Number, String, Boolean, Object, Array,
  location: { pathname: "/watch", search: `?v=${VIDEO}`, origin: "https://www.youtube.com" },
  navigator: { userAgent: "node-mock", clipboard: { writeText: async () => {} } },
  PerformanceObserver: class { constructor(cb) { perfCb = cb; } observe() {} },
  CSSStyleSheet: class { replaceSync(css) { this.css = css; } },
  document: {
    body: { append(p) { panelHolder.panel = p; } },
    documentElement: { append(p) { panelHolder.panel = p; } },
    createElement: el,
    adoptedStyleSheets: [],
    getElementById: (id) => (id === "movie_player" ? player : id === "skipjack-probe-panel" ? panelHolder.panel : null),
    querySelector: (s) => (s === ".ytp-subtitles-button" ? ccButton : null),
    addEventListener: (t, f) => { listeners[t] = f; },
  },
  fetch: async (url, init) => {
    fetchLog.push([String(url), init?.method ?? "GET"]);
    const u = String(url);
    if (u.includes("/api/timedtext")) {
      perfCb({ getEntries: () => [{ name: u }] });
      // The direct URL has no pot token: answer it like a rate-limited request,
      // with an empty body after a redirect to another host.
      if (!u.includes("pot=")) return { status: 200, redirected: true, url: "https://www.google.com/sorry/index", text: async () => "" };
      return { status: 200, redirected: false, url: u, text: async () => json3 };
    }
    if (u.includes("get_transcript")) {
      return { status: 200, json: async () => ({ actions: [{ x: { initialSegments: [{ transcriptSegmentRenderer: { startMs: "0", endMs: "2000", snippet: { runs: [{ text: "this video is sponsored" }] } } }] } }] }) };
    }
    throw new Error("unexpected fetch " + u);
  },
};
sandbox.window = sandbox;
sandbox.window.addEventListener = (t, f) => { listeners["window:" + t] = f; };
sandbox.ytcfg = { get: (k) => (k === "INNERTUBE_CONTEXT" ? { client: { clientName: "WEB" } } : "2.0") };
sandbox.ytInitialData = { currentVideoEndpoint: { watchEndpoint: { videoId: "STALE" } } };

vm.createContext(sandbox);
vm.runInContext(src, sandbox);

(async () => {
  const STALE = process.env.SKIPJACK_SCENARIO === "stale";
  listeners["yt-navigate-finish"]({ detail: { response: { response: STALE ? null : initialData } } });
  listeners["window:load"]();
  const deadline = Date.now() + 25000;
  while (!sandbox.__skipjackProbe.reports.length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  const r = sandbox.__skipjackProbe.reports[0];
  if (!r) { console.error("NO REPORT"); process.exit(1); }
  const assert = (name, cond) => { console.log((cond ? "PASS " : "FAIL ") + name); if (!cond) process.exitCode = 1; };
  assert("exactly one report (load listener did not start a second run)", sandbox.__skipjackProbe.reports.length === 1);
  assert("route B never reused the probe's own route A URL", r.captions.playerRequest.hasPot === true && r.captions.playerRequest.usable === true);
  assert("report version matches manifest.json", r.probeVersion === manifest.version);
  assert("redirect recorded with final host", r.captions.directFetch.redirected === true && r.captions.directFetch.finalHost === "www.google.com");
  assert("no redirect recorded on the player route", r.captions.playerRequest.redirected === false);
  assert("captions overlay hidden during the toggle, then restored", r.captions.playerRequest.captionsHidden === true && sandbox.document.adoptedStyleSheets.length === 0);
  assert("toggle duration recorded", typeof r.captions.playerRequest.captionsOnMs === "number");
  assert("heatmap DOM check skipped without a DOM", r.heatmapDom.checked === false);
  const plain = JSON.parse(sandbox.__skipjackProbe.buildJson(r, false));
  const full = JSON.parse(sandbox.__skipjackProbe.buildJson(r, true));
  assert("plain download has no transcript and no cue list", plain.transcript === undefined && plain.captions.playerRequest.allCues === undefined);
  assert("transcript download has every cue", full.transcript.cues.length === 2 && full.transcript.track.kind === "manual" && full.transcript.cues[0][2].includes("sponsored"));
  assert("transcript download carries no token values", !JSON.stringify(full).includes("TOKEN"));
  const tt = await sandbox.__skipjackProbe.toggleTest(true);
  assert("toggle test: overlay hidden, captions restored off, sheet removed", tt.overlayHidden === true && tt.restoredOff === true && ccOn === false && sandbox.document.adoptedStyleSheets.length === 0 && tt.onMs >= 1000);
  assert("toggle test recorded in the next download", JSON.parse(sandbox.__skipjackProbe.buildJson(r, false)).toggleTests.length === 1);
  ccOn = true;
  const skipped = await sandbox.__skipjackProbe.toggleTest(true);
  ccOn = false;
  assert("toggle test refuses to run when captions are on", Boolean(skipped.skipped));
  const reuse = r.captions.tokenReuse;
  assert("token reuse: player requested the manual track", reuse.playerRequestedTrack.kind === "manual" && reuse.sameTrack.track.kind === "manual");
  assert("token reuse: token copied onto the asr track and it read", reuse.otherTrack.track.kind === "asr" && reuse.otherTrack.usable && reuse.otherTrack.copiedParams.includes("pot"));
  assert("token reuse: track identity not copied", !reuse.otherTrack.copiedParams.some((p) => ["lang", "kind", "fmt", "v"].includes(p)));
  assert("token reuse: asr target kept kind=asr", fetchLog.some(([u]) => u.includes("kind=asr") && u.includes("pot=TOKEN")));
  assert("player api listed, nothing called", r.captions.playerApi.setOption === false && Object.keys(r.captions.playerApi).length === 8);
  assert("heat keys seen", Array.isArray(r.heatmap ? r.heatmap.heatKeysSeen || [] : []));
  if (STALE) {
    assert("stale: flagged", r.initialData.matchesVideo === false);
    assert("stale: transcript endpoint not called", r.captions.getTranscript.reason === "stale page data" && !fetchLog.some(([u]) => u.includes("get_transcript")));
    assert("stale: chapters and heatmap unavailable", Boolean(r.chapters.unavailable && r.heatmap.unavailable));
    assert("stale: usableRoutes excludes getTranscript", JSON.stringify(r.captions.usableRoutes) === '["playerRequest"]');
    assert("stale: no errors", r.errors.length === 0);
    console.log(panelHolder.panel.children.filter((c) => c.tag === "div").map((c) => c.textContent).join("\n"));
    return;
  }
  assert("initial data from navigate event", r.initialData.source === "navigate-event" && r.initialData.matchesVideo);
  assert("direct fetch empty -> unusable", r.captions.directFetch.usable === false && r.captions.directFetch.reason === "empty body");
  assert("player route usable, toggled, 2 cues", r.captions.playerRequest.usable && r.captions.playerRequest.toggledCaptions && r.captions.playerRequest.cues === 2 && r.captions.playerRequest.hasPot);
  assert("captions restored to off", ccOn === false);
  assert("word-level timing detected", r.captions.playerRequest.wordLevelTiming === true);
  assert("get_transcript usable", r.captions.getTranscript.usable && r.captions.getTranscript.segments === 1);
  assert("usableRoutes", JSON.stringify(r.captions.usableRoutes) === '["playerRequest","getTranscript"]');
  assert("chapters sorted + sponsor labeled", r.chapters.count === 2 && r.chapters.items[0].title === "Intro" && r.chapters.sponsorLabeled.length === 1);
  assert("marker keys", r.chapters.markerKeys.includes("HEATSEEKER"));
  assert("paid flag", r.paidPromotion.flag && r.paidPromotion.text === "Includes paid promotion");
  assert("heatmap", r.heatmap.count === 2 && r.heatmap.markers[1][2] === 0.2);
  assert("description", r.description.urlCount === 1 && r.description.promoLines.length === 3 && r.description.timestampLines.length === 3);
  assert("storyboards", r.storyboards.levels.length === 2 && r.storyboards.levels[1].intervalMs === 5000);
  assert("no errors", r.errors.length === 0);
  assert("no token values in report", !JSON.stringify(r).includes("TOKEN") && !JSON.stringify(r).includes("signature="));
  assert("panel rendered", panelHolder.panel && panelHolder.panel.children.length >= 10);
  await new Promise((r) => setTimeout(r, 1500));
  assert("still one report after settling", sandbox.__skipjackProbe.reports.length === 1);
  console.log(panelHolder.panel.children.filter((c) => c.tag === "div").map((c) => c.textContent).join("\n"));
})();
