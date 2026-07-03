/* HDHomeRun Web Viewer frontend */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const els = {
    tabs: document.querySelectorAll("#tabs .tab"),
    views: { watch: $("watchView"), guide: $("guideView"), device: $("deviceView") },
    nowStreamingBtn: $("nowStreamingBtn"),
    deviceSelect: $("deviceSelect"), rescanBtn: $("rescanBtn"), addIpBtn: $("addIpBtn"),
    search: $("search"), channelList: $("channelList"),
    filterModeChips: document.querySelectorAll("#modeSeg .mode"),
    hideUnavailChip: $("hideUnavailChip"),
    sigTestChip: $("sigTestChip"),
    themeBtn: $("themeBtn"),
    updateBadge: $("updateBadge"),
    aboutInfo: $("aboutInfo"),
    appVersion: $("appVersion"),
    classicBtn: $("classicBtn"), classicView: $("classicView"), classicExit: $("classicExit"),
    classicRows: $("classicRows"), classicClock: $("classicClock"), classicDate: $("classicDate"),
    classicTicker: $("classicTicker"),
    clSlots: [$("clSlot0"), $("clSlot1"), $("clSlot2")],
    playerWrap: $("playerWrap"), playerIdle: $("playerIdle"),
    playerLoading: $("playerLoading"), loadingText: $("loadingText"),
    playerError: $("playerError"), errorText: $("errorText"), retryBtn: $("retryBtn"),
    video: $("video"), npChannel: $("npChannel"), npProgram: $("npProgram"),
    qualitySelect: $("qualitySelect"), stopBtn: $("stopBtn"),
    guideGrid: $("guideGrid"), guideScroll: $("guideScroll"),
    guideNowBtn: $("guideNowBtn"), guidePrevBtn: $("guidePrevBtn"), guideNextBtn: $("guideNextBtn"),
    guideRangeLabel: $("guideRangeLabel"),
    guideDetail: $("guideDetail"), gdImage: $("gdImage"), gdTitle: $("gdTitle"),
    gdMeta: $("gdMeta"), gdSynopsis: $("gdSynopsis"), gdWatchBtn: $("gdWatchBtn"), gdCloseBtn: $("gdCloseBtn"),
    deviceInfo: $("deviceInfo"), tunerList: $("tunerList"),
    scanSource: $("scanSource"), scanStartBtn: $("scanStartBtn"), scanAbortBtn: $("scanAbortBtn"),
    scanProgressWrap: $("scanProgressWrap"), scanProgressBar: $("scanProgressBar"),
    scanProgressText: $("scanProgressText"), scanResult: $("scanResult"),
  };

  const GUIDE_HOURS = 4;
  const PX_PER_MIN = 4;
  const CH_COL_PX = 190;

  const state = {
    view: "watch",
    devices: [],
    lineup: [],
    nowTitles: {},            // GuideNumber -> current program title
    guidePages: {},           // pageStart(sec) -> raw guide array
    guidePage: null,          // current page start; null = "now"
    favorites: new Set(JSON.parse(localStorage.getItem("hdhr_favs") || "[]")),
    unavailable: new Set(),   // GuideNumbers that returned "no signal"; per device
    filterMode: localStorage.getItem("hdhr_fmode") || "all",
    hideUnavail: localStorage.getItem("hdhr_hideunavail") === "1",
    versionInfo: null,        // {version, latest, updateAvailable, repo}
    signals: {},              // major channel -> {status, strength, quality}
    sigScan: { running: false, progress: 0, total: 0, ts: null },
    current: null,
    sessionId: null,
    hls: null,
    pendingClassic: false,
    timers: { guideNow: null, tuners: null, scan: null, nowline: null, sig: null, classic: null },
  };

  // ---- API ----------------------------------------------------------------

  async function api(path, opts) {
    const resp = await fetch(path, opts);
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data.error || ("HTTP " + resp.status));
    return data;
  }

  const post = (path, body) => api(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const deviceIp = () => els.deviceSelect.value;

  // ---- Devices ------------------------------------------------------------

  async function discover(manualIp) {
    els.channelList.innerHTML = '<div class="placeholder">Scanning for HDHomeRun devices…</div>';
    try {
      const url = manualIp ? "/api/discover?ip=" + encodeURIComponent(manualIp) : "/api/discover";
      const data = await api(url);
      if (manualIp) {
        for (const d of data.devices) {
          if (!state.devices.some((x) => x.IP === d.IP)) state.devices.push(d);
        }
        if (data.errors.length) alert("Could not reach device: " + data.errors[0].error);
      } else {
        state.devices = data.devices;
      }
      renderDevices();
      if (state.devices.length) {
        await onDeviceChanged();
      } else {
        els.channelList.innerHTML =
          '<div class="placeholder">No HDHomeRun devices found.<br><br>' +
          'Check that the tuner is powered on, then hit ⟳ — or add it by IP with ＋ IP.</div>';
      }
    } catch (e) {
      els.channelList.innerHTML = '<div class="placeholder">Discovery failed: ' + escapeHtml(e.message) + "</div>";
    }
  }

  function renderDevices() {
    const prev = els.deviceSelect.value;
    els.deviceSelect.innerHTML = "";
    for (const d of state.devices) {
      const opt = document.createElement("option");
      opt.value = d.IP;
      opt.textContent = (d.FriendlyName || d.ModelNumber || "HDHomeRun") + " (" + d.IP + ")";
      els.deviceSelect.appendChild(opt);
    }
    if (prev && state.devices.some((d) => d.IP === prev)) els.deviceSelect.value = prev;
  }

  async function onDeviceChanged() {
    const ip = deviceIp();
    if (!ip) return;
    loadUnavailable(ip);
    state.guidePages = {};
    state.guidePage = null;
    state.nowTitles = {};
    state.signals = {};
    fetchSignals();
    await loadLineup(ip);
    if (state.view === "guide") renderGuide();
    if (state.view === "device") enterDeviceView();
  }

  // ---- Lineup + now-playing ------------------------------------------------

  async function loadLineup(ip) {
    els.channelList.innerHTML = '<div class="placeholder">Loading channel lineup…</div>';
    try {
      const data = await api("/api/lineup?device=" + encodeURIComponent(ip));
      state.lineup = data.lineup || [];
      renderChannels();
      loadGuideNow(ip);
      if (state.timers.guideNow) clearInterval(state.timers.guideNow);
      state.timers.guideNow = setInterval(() => loadGuideNow(deviceIp()), 5 * 60 * 1000);
    } catch (e) {
      els.channelList.innerHTML = '<div class="placeholder">Could not load lineup: ' + escapeHtml(e.message) + "</div>";
    }
  }

  async function loadGuideNow(ip) {
    if (!ip) return;
    try {
      const data = await api("/api/guide?device=" + encodeURIComponent(ip));
      state.guidePages[0] = data.guide || [];
      const now = Date.now() / 1000;
      const titles = {};
      for (const ch of state.guidePages[0]) {
        for (const prog of ch.Guide || []) {
          if (prog.StartTime <= now && now < prog.EndTime) { titles[ch.GuideNumber] = prog.Title; break; }
        }
      }
      state.nowTitles = titles;
      renderChannels();
      updateNowPlayingBar();
      if (state.view === "guide" && state.guidePage === null) renderGuide();
      if (state.pendingClassic) { state.pendingClassic = false; classicOpen(); }
      else if (!els.classicView.classList.contains("hidden")) buildClassic();
    } catch (e) { /* guide is best-effort */ }
  }

  // ---- Filters ------------------------------------------------------------

  function loadUnavailable(ip) {
    try {
      state.unavailable = new Set(JSON.parse(localStorage.getItem("hdhr_unavail_" + ip) || "[]"));
    } catch (e) { state.unavailable = new Set(); }
  }

  function saveUnavailable() {
    localStorage.setItem("hdhr_unavail_" + deviceIp(), JSON.stringify([...state.unavailable]));
  }

  function markUnavailable(num, isUnavail) {
    if (isUnavail) state.unavailable.add(num);
    else state.unavailable.delete(num);
    saveUnavailable();
    renderChannels();
  }

  // ---- Version / update check -----------------------------------------------

  async function loadVersion() {
    try {
      state.versionInfo = await api("/api/version");
    } catch (e) {
      state.versionInfo = null;
    }
    renderVersion();
  }

  function renderVersion() {
    const v = state.versionInfo;
    els.appVersion.textContent = v ? "v" + v.version : "";
    const hubUrl = v ? "https://hub.docker.com/r/" + v.repo + "/tags" : "#";
    els.updateBadge.classList.toggle("hidden", !(v && v.updateAvailable));
    if (v && v.updateAvailable) {
      els.updateBadge.textContent = "⬆ Update v" + v.latest;
      els.updateBadge.href = hubUrl;
      els.updateBadge.title = "Version " + v.latest + " is available (you have v" + v.version +
        "). Docker: docker compose pull && docker compose up -d";
    }
    renderAbout();
  }

  function renderAbout() {
    const v = state.versionInfo;
    if (!v) {
      els.aboutInfo.innerHTML = kvRows({ "App": "HDHomeRun Web Viewer", "Version": "unknown" });
      return;
    }
    const status = v.updateAvailable
      ? '<span class="update-avail">Version ' + escapeHtml(v.latest) + " available</span> — Docker: <code>docker compose pull</code>, then <code>up -d</code>"
      : (v.latest ? "Up to date" : "Update check unavailable (no internet?)");
    els.aboutInfo.innerHTML = kvRows({
      "App": "HDHomeRun Web Viewer",
      "Version": "v" + escapeHtml(v.version),
      "Updates": status,
      "Image": '<a href="https://hub.docker.com/r/' + escapeHtml(v.repo) + '" target="_blank" rel="noopener">' + escapeHtml(v.repo) + "</a>",
    });
  }

  // ---- Signal survey --------------------------------------------------------

  function signalFor(ch) {
    return state.signals[String(ch.GuideNumber).split(".")[0]] || null;
  }

  function noSignal(ch) {
    const sig = signalFor(ch);
    return state.unavailable.has(ch.GuideNumber) || (sig && sig.status === "none");
  }

  function signalDotHtml(ch) {
    const sig = signalFor(ch);
    if (!sig || sig.status === "unknown") {
      // No survey data — but a failed play attempt is still worth a red dot.
      if (state.unavailable.has(ch.GuideNumber)) {
        return '<span class="sig-dot none" title="No signal on the last attempt — click to retry"></span>';
      }
      return "";
    }
    const labels = { good: "Good signal", weak: "Weak signal — may glitch", none: "No signal" };
    let tip = labels[sig.status] || "";
    if (sig.strength != null) tip += " — strength " + sig.strength + "%";
    if (sig.quality != null) tip += ", quality " + sig.quality + "%";
    if (state.sigScan.ts) tip += " (tested " + new Date(state.sigScan.ts * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) + ")";
    return '<span class="sig-dot ' + sig.status + '" title="' + escapeHtml(tip) + '"></span>';
  }

  async function fetchSignals() {
    if (!deviceIp()) return;
    try {
      const data = await api("/api/signal/status?device=" + encodeURIComponent(deviceIp()));
      state.signals = data.results || {};
      state.sigScan = { running: !!data.running, progress: data.progress || 0, total: data.total || 0, ts: data.ts };
      renderSigChip();
      renderChannels();
      if (state.view === "guide") renderGuide();
      if (data.running) {
        if (!state.timers.sig) state.timers.sig = setInterval(fetchSignals, 2500);
      } else {
        stopTimer("sig");
      }
    } catch (e) { /* best-effort */ }
  }

  function renderSigChip() {
    if (state.sigScan.running) {
      els.sigTestChip.textContent = "📶 Testing " + state.sigScan.progress + "/" + state.sigScan.total + "…";
      els.sigTestChip.disabled = true;
    } else {
      els.sigTestChip.textContent = "📶 Test signal";
      els.sigTestChip.disabled = false;
    }
  }

  els.sigTestChip.addEventListener("click", async () => {
    if (!deviceIp() || state.sigScan.running) return;
    if (!confirm("Test signal on every transmitter in the lineup?\n\nThis briefly tunes each one (a couple of minutes total) using a spare tuner. You can keep watching while it runs.")) return;
    try {
      await post("/api/signal/scan", { device: deviceIp() });
      state.sigScan = { running: true, progress: 0, total: 0, ts: null };
      renderSigChip();
      if (!state.timers.sig) state.timers.sig = setInterval(fetchSignals, 2500);
    } catch (e) {
      alert("Could not start signal test: " + e.message);
    }
  });

  // ---- Filtering ------------------------------------------------------------

  function filteredLineup() {
    const q = els.search.value.trim().toLowerCase();
    return state.lineup.filter((ch) => {
      if (state.filterMode === "fav" && !state.favorites.has(ch.GuideNumber)) return false;
      if (state.filterMode === "hd" && !ch.HD) return false;
      if (state.hideUnavail && noSignal(ch)) return false;
      if (q && !(String(ch.GuideNumber).includes(q) ||
                 (ch.GuideName || "").toLowerCase().includes(q) ||
                 (state.nowTitles[ch.GuideNumber] || "").toLowerCase().includes(q))) return false;
      return true;
    }).sort(channelSort);
  }

  function channelSort(a, b) {
    const fa = state.favorites.has(a.GuideNumber) ? 0 : 1;
    const fb = state.favorites.has(b.GuideNumber) ? 0 : 1;
    if (fa !== fb) return fa - fb;
    return parseFloat(a.GuideNumber) - parseFloat(b.GuideNumber) ||
           String(a.GuideNumber).localeCompare(String(b.GuideNumber));
  }

  function renderFilterChips() {
    els.filterModeChips.forEach((c) =>
      c.classList.toggle("active", c.dataset.mode === state.filterMode));
    els.hideUnavailChip.classList.toggle("active", state.hideUnavail);
  }

  // ---- Channel list -------------------------------------------------------

  function renderChannels() {
    renderFilterChips();
    const list = filteredLineup();
    els.channelList.innerHTML = "";
    if (!list.length) {
      els.channelList.innerHTML = '<div class="placeholder">No channels match.</div>';
      return;
    }
    for (const ch of list) {
      const row = document.createElement("div");
      const unavail = noSignal(ch);
      row.className = "channel" +
        (state.current && state.current.GuideNumber === ch.GuideNumber ? " active" : "") +
        (unavail ? " unavail" : "");

      const badges = [];
      if (ch.HD) badges.push('<span class="badge">HD</span>');
      if (ch.DRM) badges.push('<span class="badge drm">DRM</span>');

      const nowTitle = state.nowTitles[ch.GuideNumber] || "";
      const faved = state.favorites.has(ch.GuideNumber);

      row.innerHTML =
        signalDotHtml(ch) +
        '<div class="ch-num">' + escapeHtml(ch.GuideNumber) + "</div>" +
        '<div class="ch-info"><div class="ch-name">' + escapeHtml(ch.GuideName || "Unknown") + "</div>" +
        (nowTitle ? '<div class="ch-now">' + escapeHtml(nowTitle) + "</div>" : "") + "</div>" +
        '<div class="ch-badges">' + badges.join("") + "</div>" +
        '<button class="fav-btn' + (faved ? " faved" : "") + '" title="Favorite">' + (faved ? "★" : "☆") + "</button>";

      row.querySelector(".fav-btn").addEventListener("click", (ev) => {
        ev.stopPropagation();
        toggleFavorite(ch.GuideNumber);
      });
      row.addEventListener("click", () => {
        if (ch.DRM) { alert("This channel is DRM-protected and cannot be streamed."); return; }
        playChannel(ch);
      });
      els.channelList.appendChild(row);
    }
  }

  function toggleFavorite(num) {
    if (state.favorites.has(num)) state.favorites.delete(num);
    else state.favorites.add(num);
    localStorage.setItem("hdhr_favs", JSON.stringify([...state.favorites]));
    renderChannels();
    if (state.view === "guide") renderGuide();
  }

  // ---- Views --------------------------------------------------------------

  function setView(view) {
    state.view = view;
    if (("#" + view) !== location.hash) {
      try { history.replaceState(null, "", "#" + view); } catch (e) {}
    }
    els.tabs.forEach((t) => t.classList.toggle("active", t.dataset.view === view));
    for (const [name, el] of Object.entries(els.views)) el.classList.toggle("hidden", name !== view);
    updateNowStreamingBtn();
    stopTimer("tuners"); stopTimer("nowline");
    if (view === "guide") renderGuide();
    if (view === "device") enterDeviceView();
  }

  function stopTimer(name) {
    if (state.timers[name]) { clearInterval(state.timers[name]); state.timers[name] = null; }
  }

  function updateNowStreamingBtn() {
    const show = state.sessionId && state.view !== "watch" && state.current;
    els.nowStreamingBtn.classList.toggle("hidden", !show);
    if (show) {
      els.nowStreamingBtn.textContent = "● " + state.current.GuideNumber + " " + (state.current.GuideName || "");
    }
  }

  // ---- Guide view ---------------------------------------------------------

  function guideWindow() {
    const nowBucket = Math.floor(Date.now() / 1000 / 1800) * 1800;
    const start = state.guidePage === null ? nowBucket : state.guidePage;
    return { start, end: start + GUIDE_HOURS * 3600 };
  }

  async function fetchGuidePage(pageStart) {
    const key = pageStart === null ? 0 : pageStart;
    if (state.guidePages[key]) return state.guidePages[key];
    const url = "/api/guide?device=" + encodeURIComponent(deviceIp()) +
      (pageStart === null ? "" : "&start=" + pageStart);
    const data = await api(url);
    state.guidePages[key] = data.guide || [];
    return state.guidePages[key];
  }

  async function renderGuide() {
    if (!deviceIp()) {
      els.guideGrid.innerHTML = '<div class="placeholder" style="padding:40px">No device selected.</div>';
      return;
    }
    const win = guideWindow();
    els.guideRangeLabel.textContent = fmtDay(win.start) + " " + fmtTime(win.start) + " – " + fmtTime(win.end);
    els.guidePrevBtn.disabled = state.guidePage === null;

    let guide;
    try {
      els.guideGrid.innerHTML = '<div class="placeholder" style="padding:40px">Loading guide…</div>';
      guide = await fetchGuidePage(state.guidePage);
    } catch (e) {
      els.guideGrid.innerHTML = '<div class="placeholder" style="padding:40px">Could not load guide: ' + escapeHtml(e.message) + "</div>";
      return;
    }
    if (!guide.length) {
      els.guideGrid.innerHTML = '<div class="placeholder" style="padding:40px">No guide data available. The guide needs internet access on the server machine.</div>';
      return;
    }

    const byNum = {};
    for (const g of guide) byNum[g.GuideNumber] = g;
    const channels = filteredLineup();
    const timelineWidth = GUIDE_HOURS * 60 * PX_PER_MIN;
    const now = Date.now() / 1000;

    const grid = document.createElement("div");
    grid.style.width = (CH_COL_PX + timelineWidth) + "px";

    // header row with half-hour ticks
    const header = document.createElement("div");
    header.className = "g-row g-header";
    header.innerHTML = '<div class="g-ch g-corner"></div>';
    const headTl = document.createElement("div");
    headTl.className = "g-tl";
    headTl.style.width = timelineWidth + "px";
    for (let t = win.start; t < win.end; t += 1800) {
      const tick = document.createElement("div");
      tick.className = "g-tick";
      tick.style.left = ((t - win.start) / 60 * PX_PER_MIN) + "px";
      tick.textContent = fmtTime(t);
      headTl.appendChild(tick);
    }
    header.appendChild(headTl);
    grid.appendChild(header);

    for (const ch of channels) {
      const row = document.createElement("div");
      row.className = "g-row";
      const chCell = document.createElement("div");
      chCell.className = "g-ch";
      chCell.innerHTML = signalDotHtml(ch) +
        '<span class="g-ch-num">' + escapeHtml(ch.GuideNumber) + "</span>" +
        '<span class="g-ch-name">' + escapeHtml(ch.GuideName || "") + "</span>" +
        (state.favorites.has(ch.GuideNumber) ? '<span class="g-fav">★</span>' : "");
      chCell.title = "Watch " + ch.GuideNumber + " " + (ch.GuideName || "");
      chCell.addEventListener("click", () => { if (!ch.DRM) playChannel(ch); });
      row.appendChild(chCell);

      const tl = document.createElement("div");
      tl.className = "g-tl";
      tl.style.width = timelineWidth + "px";
      const progs = (byNum[ch.GuideNumber] || {}).Guide || [];
      let any = false;
      for (const prog of progs) {
        const s = Math.max(prog.StartTime, win.start);
        const e = Math.min(prog.EndTime, win.end);
        if (e - s <= 0) continue;
        any = true;
        const block = document.createElement("div");
        const airing = prog.StartTime <= now && now < prog.EndTime;
        block.className = "g-prog" + (airing ? " airing" : "");
        block.style.left = ((s - win.start) / 60 * PX_PER_MIN) + "px";
        block.style.width = Math.max(((e - s) / 60 * PX_PER_MIN) - 3, 12) + "px";
        block.innerHTML = '<div class="g-prog-title">' + escapeHtml(prog.Title || "") + "</div>" +
          '<div class="g-prog-time">' + fmtTime(prog.StartTime) + "</div>";
        block.addEventListener("click", () => showGuideDetail(prog, ch, airing));
        tl.appendChild(block);
      }
      if (!any) {
        const none = document.createElement("div");
        none.className = "g-none";
        none.textContent = "No guide data";
        tl.appendChild(none);
      }
      row.appendChild(tl);
      grid.appendChild(row);
    }

    // "now" indicator line
    if (now >= win.start && now < win.end) {
      const line = document.createElement("div");
      line.className = "g-nowline";
      line.style.left = (CH_COL_PX + (now - win.start) / 60 * PX_PER_MIN) + "px";
      grid.appendChild(line);
      stopTimer("nowline");
      state.timers.nowline = setInterval(() => {
        const n = Date.now() / 1000;
        if (n >= win.end || state.view !== "guide") { stopTimer("nowline"); return; }
        line.style.left = (CH_COL_PX + (n - win.start) / 60 * PX_PER_MIN) + "px";
      }, 60 * 1000);
    }

    els.guideGrid.innerHTML = "";
    els.guideGrid.appendChild(grid);
  }

  function showGuideDetail(prog, ch, airing) {
    els.gdTitle.textContent = prog.Title || "";
    els.gdMeta.textContent = ch.GuideNumber + " " + (ch.GuideName || "") + " · " +
      fmtTime(prog.StartTime) + " – " + fmtTime(prog.EndTime) +
      (prog.EpisodeNumber ? " · " + prog.EpisodeNumber : "") +
      (prog.EpisodeTitle ? " · " + prog.EpisodeTitle : "");
    els.gdSynopsis.textContent = prog.Synopsis ||
      (prog.OriginalAirdate ? "Original airdate: " + new Date(prog.OriginalAirdate * 1000).toLocaleDateString() : "");
    if (prog.ImageURL) {
      els.gdImage.src = prog.ImageURL;
      els.gdImage.classList.remove("hidden");
    } else {
      els.gdImage.classList.add("hidden");
    }
    els.gdWatchBtn.classList.toggle("hidden", !airing || !!ch.DRM);
    els.gdWatchBtn.onclick = () => { hideGuideDetail(); playChannel(ch); };
    els.guideDetail.classList.remove("hidden");

    // The bulk guide feed omits synopses; fetch the channel's extended guide.
    if (!prog.Synopsis) {
      const url = "/api/guide?device=" + encodeURIComponent(deviceIp()) +
        "&channel=" + encodeURIComponent(ch.GuideNumber) + "&start=" + prog.StartTime;
      api(url).then((data) => {
        const entry = ((data.guide || [])[0] || {}).Guide || [];
        const match = entry.find((p) => p.StartTime === prog.StartTime);
        if (match && els.gdTitle.textContent === (prog.Title || "")) {
          if (match.Synopsis) els.gdSynopsis.textContent = match.Synopsis;
          if (match.EpisodeTitle && !prog.EpisodeTitle) {
            els.gdMeta.textContent += " · " + match.EpisodeTitle;
          }
        }
      }).catch(() => {});
    }
  }

  function hideGuideDetail() { els.guideDetail.classList.add("hidden"); }

  // ---- Classic guide channel (Prevue-style) -----------------------------------

  function classicOpen() {
    els.classicView.classList.remove("hidden");
    buildClassic();
    classicTickClock();
    stopTimer("classic");
    state.timers.classic = setInterval(classicTickClock, 1000);
    // Rebuild on the half-hour so the slots roll over
    state.classicRebuildAt = (Math.floor(Date.now() / 1000 / 1800) + 1) * 1800;
    try { els.classicView.requestFullscreen(); } catch (e) {}
  }

  function classicClose() {
    els.classicView.classList.add("hidden");
    stopTimer("classic");
    if (document.fullscreenElement) {
      try { document.exitFullscreen(); } catch (e) {}
    }
  }

  function classicTickClock() {
    const d = new Date();
    els.classicClock.textContent = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
    els.classicDate.textContent = d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" }).toUpperCase();
    if (state.classicRebuildAt && Date.now() / 1000 >= state.classicRebuildAt) {
      state.classicRebuildAt = (Math.floor(Date.now() / 1000 / 1800) + 1) * 1800;
      buildClassic();
    }
  }

  async function buildClassic() {
    let guide = state.guidePages[0];
    if (!guide) {
      try { guide = await fetchGuidePage(null); } catch (e) { guide = []; }
    }
    const byNum = {};
    for (const g of guide || []) byNum[g.GuideNumber] = g;

    const slot0 = Math.floor(Date.now() / 1000 / 1800) * 1800;
    const slots = [slot0, slot0 + 1800, slot0 + 3600];
    const end = slot0 + 5400;
    els.clSlots.forEach((el, i) => { el.textContent = fmtTime(slots[i]); });

    const channels = state.lineup
      .filter((ch) => !(state.hideUnavail && noSignal(ch)))
      .sort((a, b) => parseFloat(a.GuideNumber) - parseFloat(b.GuideNumber));

    let html = "";
    for (const ch of channels) {
      const progs = (byNum[ch.GuideNumber] || {}).Guide || [];
      let cells = "";
      let i = 0;
      while (i < 3) {
        const t = slots[i];
        const prog = progs.find((p) => p.StartTime <= t && t < p.EndTime);
        if (!prog) {
          cells += '<div class="cl-cell" style="width:' + (100 / 3) + '%"><span class="cl-none">—</span></div>';
          i += 1;
          continue;
        }
        let span = 1;
        while (i + span < 3 && prog.EndTime > slots[i + span]) span += 1;
        const cont = prog.StartTime < slot0 ? "&lt; " : "";
        const runs = prog.EndTime > end ? " &gt;" : "";
        cells += '<div class="cl-cell" style="width:' + (span * 100 / 3) + '%">' +
          '<span class="cl-title">' + cont + escapeHtml(prog.Title || "") + runs + "</span></div>";
        i += span;
      }
      html += '<div class="cl-row" data-num="' + escapeHtml(ch.GuideNumber) + '">' +
        '<div class="cl-ch"><span class="cl-num">' + escapeHtml(ch.GuideNumber) + "</span>" +
        '<span class="cl-name">' + escapeHtml((ch.GuideName || "").toUpperCase()) + "</span></div>" +
        '<div class="cl-slots">' + cells + "</div></div>";
    }
    if (!html) {
      html = '<div class="cl-row"><div class="cl-ch"><span class="cl-name">NO LISTINGS</span></div></div>';
    }

    // Duplicate the rows so the CSS loop (translateY -50%) is seamless.
    els.classicRows.innerHTML = html + html;
    const rowCount = channels.length || 1;
    els.classicRows.style.animationDuration = Math.max(30, rowCount * 2.2) + "s";

    // Ticker: what's on the current channel, else a rotating tagline
    const nowTitle = state.current ? (state.nowTitles[state.current.GuideNumber] || "") : "";
    els.classicTicker.textContent = state.current
      ? ("NOW WATCHING  " + state.current.GuideNumber + " " + (state.current.GuideName || "").toUpperCase() + (nowTitle ? "  •  " + nowTitle.toUpperCase() : ""))
      : "ALL TIMES LOCAL  •  " + channels.length + " CHANNELS  •  CLICK A ROW TO WATCH";
  }

  els.classicBtn.addEventListener("click", classicOpen);
  els.classicExit.addEventListener("click", classicClose);
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && !els.classicView.classList.contains("hidden")) classicClose();
  });
  els.classicRows.addEventListener("click", (ev) => {
    const row = ev.target.closest(".cl-row");
    if (!row || !row.dataset.num) return;
    const ch = state.lineup.find((c) => String(c.GuideNumber) === row.dataset.num);
    if (ch && !ch.DRM) { classicClose(); playChannel(ch); }
  });

  // ---- Device view ----------------------------------------------------------

  function currentDevice() {
    return state.devices.find((d) => d.IP === deviceIp());
  }

  async function enterDeviceView() {
    const d = currentDevice();
    if (!d) {
      els.deviceInfo.innerHTML = '<div class="placeholder">No device selected.</div>';
      els.tunerList.innerHTML = "";
      return;
    }
    els.deviceInfo.innerHTML = kvRows({
      "Name": d.FriendlyName || "—",
      "Model": d.ModelNumber || "—",
      "Device ID": d.DeviceID || "—",
      "Firmware": (d.FirmwareVersion || "—") + (d.UpgradeAvailable ? " (update " + d.UpgradeAvailable + " available — install from the device page)" : ""),
      "Tuners": d.TunerCount || "—",
      "Address": '<a href="http://' + escapeHtml(d.IP) + '/" target="_blank" rel="noopener">' + escapeHtml(d.IP) + "</a>",
    });
    refreshTuners();
    stopTimer("tuners");
    state.timers.tuners = setInterval(refreshTuners, 5000);
    refreshScanStatus(true);
  }

  function kvRows(obj) {
    return Object.entries(obj).map(([k, v]) =>
      '<div class="kv-row"><span class="kv-k">' + k + '</span><span class="kv-v">' + v + "</span></div>").join("");
  }

  async function refreshTuners() {
    if (state.view !== "device") return;
    try {
      const data = await api("/api/device/status?device=" + encodeURIComponent(deviceIp()));
      const tuners = data.data || [];
      els.tunerList.innerHTML = tuners.map((t) => {
        const active = t.VctNumber || t.Frequency;
        if (!active) {
          return '<div class="tuner idle"><span class="tuner-name">' + escapeHtml(t.Resource || "") +
                 '</span><span class="tuner-state">idle</span></div>';
        }
        const rate = t.NetworkRate ? (t.NetworkRate / 1000000).toFixed(1) + " Mbps" : "";
        return '<div class="tuner"><div class="tuner-head"><span class="tuner-name">' + escapeHtml(t.Resource || "") +
          '</span><span class="tuner-ch">' + escapeHtml(t.VctNumber || "") + " " + escapeHtml(t.VctName || "") +
          '</span><span class="tuner-rate">' + rate + "</span></div>" +
          signalBar("Signal", t.SignalStrengthPercent) +
          signalBar("Quality", t.SignalQualityPercent) +
          signalBar("Symbol", t.SymbolQualityPercent) +
          "</div>";
      }).join("") || '<div class="placeholder">No tuner status available.</div>';
    } catch (e) {
      els.tunerList.innerHTML = '<div class="placeholder">Could not read tuner status: ' + escapeHtml(e.message) + "</div>";
    }
  }

  function signalBar(label, pct) {
    if (pct === undefined || pct === null) return "";
    const cls = pct >= 70 ? "good" : pct >= 45 ? "ok" : "bad";
    return '<div class="sig-row"><span class="sig-label">' + label + '</span>' +
      '<div class="sig-track"><div class="sig-fill ' + cls + '" style="width:' + pct + '%"></div></div>' +
      '<span class="sig-pct">' + pct + "%</span></div>";
  }

  // ---- Channel scan ---------------------------------------------------------

  async function refreshScanStatus(populateSources) {
    try {
      const data = await api("/api/device/scan_status?device=" + encodeURIComponent(deviceIp()));
      const st = data.data || {};
      if (populateSources && Array.isArray(st.SourceList)) {
        els.scanSource.innerHTML = "";
        for (const s of st.SourceList) {
          const opt = document.createElement("option");
          opt.value = s; opt.textContent = s;
          els.scanSource.appendChild(opt);
        }
        if (st.Source) els.scanSource.value = st.Source;
      }
      updateScanUi(st);
      return st;
    } catch (e) { return {}; }
  }

  function updateScanUi(st) {
    const scanning = !!st.ScanInProgress;
    els.scanStartBtn.classList.toggle("hidden", scanning);
    els.scanAbortBtn.classList.toggle("hidden", !scanning);
    els.scanProgressWrap.classList.toggle("hidden", !scanning);
    els.scanSource.disabled = scanning;
    if (scanning) {
      const pct = st.Progress || 0;
      els.scanProgressBar.style.width = pct + "%";
      els.scanProgressText.textContent = "Scanning… " + pct + "% — " + (st.Found || 0) + " channels found";
      if (!state.timers.scan) state.timers.scan = setInterval(pollScan, 2000);
    } else {
      stopTimer("scan");
    }
  }

  async function pollScan() {
    const st = await refreshScanStatus(false);
    if (!st.ScanInProgress) {
      stopTimer("scan");
      els.scanResult.textContent = "Scan complete — " + (st.Found !== undefined ? st.Found + " channels found. " : "") + "Reloading lineup…";
      els.scanResult.classList.remove("hidden");
      await loadLineup(deviceIp());
      els.scanResult.textContent = "Scan complete. Lineup updated (" + state.lineup.length + " channels).";
    }
  }

  els.scanStartBtn.addEventListener("click", async () => {
    if (!deviceIp()) return;
    if (!confirm("Start a channel scan on source \"" + els.scanSource.value + "\"?\n\nThis takes several minutes and will interrupt any active streams or DVR recordings.")) return;
    els.scanResult.classList.add("hidden");
    try {
      await stopStream(true);
      await post("/api/device/scan", { device: deviceIp(), action: "start", source: els.scanSource.value });
      updateScanUi({ ScanInProgress: 1, Progress: 0, Found: 0 });
    } catch (e) {
      alert("Could not start scan: " + e.message);
    }
  });

  els.scanAbortBtn.addEventListener("click", async () => {
    try {
      await post("/api/device/scan", { device: deviceIp(), action: "abort" });
    } catch (e) { /* status poll will reconcile */ }
  });

  // ---- Player ---------------------------------------------------------------

  function showPane(pane) {
    els.playerWrap.classList.toggle("hidden", pane !== "player");
    els.playerIdle.classList.toggle("hidden", pane !== "idle");
    els.playerLoading.classList.toggle("hidden", pane !== "loading");
    els.playerError.classList.toggle("hidden", pane !== "error");
  }

  function updateNowPlayingBar() {
    if (!state.current) return;
    els.npChannel.textContent = state.current.GuideNumber + " " + (state.current.GuideName || "");
    els.npProgram.textContent = state.nowTitles[state.current.GuideNumber] || "";
  }

  async function playChannel(ch) {
    setView("watch");
    await stopStream(false);
    state.current = ch;
    renderChannels();
    updateNowPlayingBar();
    els.loadingText.textContent = "Tuning " + ch.GuideNumber + " " + (ch.GuideName || "") + "… (first start takes a few seconds)";
    showPane("loading");

    try {
      const data = await post("/api/stream/start", {
        device: deviceIp(),
        channel: String(ch.GuideNumber),
        quality: els.qualitySelect.value,
      });
      state.sessionId = data.id;
      if (state.unavailable.has(ch.GuideNumber)) markUnavailable(ch.GuideNumber, false);
      const sig = signalFor(ch);
      if (sig && sig.status === "none") { sig.status = "unknown"; renderChannels(); }
      attachPlayer(data.playlist);
      updateNowStreamingBtn();
    } catch (e) {
      if (/no signal/i.test(e.message)) markUnavailable(ch.GuideNumber, true);
      showError(e.message);
    }
  }

  function attachPlayer(playlist) {
    const video = els.video;
    destroyHls();

    if (window.Hls && Hls.isSupported()) {
      const hls = new Hls({
        liveDurationInfinity: true,
        maxBufferLength: 12,
        liveSyncDurationCount: 3,
        manifestLoadingMaxRetry: 6,
        levelLoadingMaxRetry: 6,
        fragLoadingMaxRetry: 6,
      });
      state.hls = hls;
      hls.loadSource(playlist);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        showPane("player");
        video.play().catch(() => {});
      });
      hls.on(Hls.Events.ERROR, (_ev, data) => {
        if (!data.fatal) return;
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad();
        else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
        else showError("Playback failed (" + data.details + ").");
      });
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = playlist;
      video.play().catch(() => {});
      showPane("player");
    } else {
      showError("This browser cannot play HLS video.");
    }
  }

  function destroyHls() {
    if (state.hls) { state.hls.destroy(); state.hls = null; }
    els.video.removeAttribute("src");
    try { els.video.load(); } catch (e) {}
  }

  async function stopStream(showIdle) {
    destroyHls();
    const sid = state.sessionId;
    state.sessionId = null;
    updateNowStreamingBtn();
    if (sid) {
      try { await post("/api/stream/stop", { id: sid }); } catch (e) { /* reaper cleans up */ }
    }
    if (showIdle !== false) {
      state.current = null;
      renderChannels();
      showPane("idle");
    }
  }

  function showError(msg) {
    els.errorText.textContent = msg || "Something went wrong.";
    showPane("error");
  }

  // ---- Events ---------------------------------------------------------------

  els.tabs.forEach((t) => t.addEventListener("click", () => setView(t.dataset.view)));
  els.nowStreamingBtn.addEventListener("click", () => setView("watch"));

  function syncThemeIcon() {
    const light = document.documentElement.dataset.theme === "light";
    els.themeBtn.textContent = light ? "🌙" : "☀️";
    els.themeBtn.title = light ? "Switch to dark theme" : "Switch to light theme";
  }
  els.themeBtn.addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
    document.documentElement.dataset.theme = next;
    localStorage.setItem("hdhr_theme", next);
    syncThemeIcon();
  });
  syncThemeIcon();

  els.rescanBtn.addEventListener("click", () => discover());
  els.addIpBtn.addEventListener("click", () => {
    const ip = prompt("HDHomeRun IP address (e.g. 192.168.1.100):");
    if (ip) discover(ip.trim());
  });
  els.deviceSelect.addEventListener("change", () => { stopStream(true); onDeviceChanged(); });

  els.search.addEventListener("input", () => {
    renderChannels();
    if (state.view === "guide") renderGuide();
  });
  els.filterModeChips.forEach((chip) => chip.addEventListener("click", () => {
    state.filterMode = chip.dataset.mode;
    localStorage.setItem("hdhr_fmode", state.filterMode);
    renderChannels();
    if (state.view === "guide") renderGuide();
  }));
  els.hideUnavailChip.addEventListener("click", () => {
    state.hideUnavail = !state.hideUnavail;
    localStorage.setItem("hdhr_hideunavail", state.hideUnavail ? "1" : "0");
    renderChannels();
    if (state.view === "guide") renderGuide();
  });

  els.stopBtn.addEventListener("click", () => stopStream(true));
  els.retryBtn.addEventListener("click", () => {
    if (state.current) playChannel(state.current);
    else showPane("idle");
  });
  els.qualitySelect.addEventListener("change", () => { if (state.current) playChannel(state.current); });

  els.guideNowBtn.addEventListener("click", () => { state.guidePage = null; renderGuide(); });
  els.guideNextBtn.addEventListener("click", () => {
    const win = guideWindow();
    state.guidePage = win.start + GUIDE_HOURS * 3600;
    renderGuide();
  });
  els.guidePrevBtn.addEventListener("click", () => {
    if (state.guidePage === null) return;
    const prev = state.guidePage - GUIDE_HOURS * 3600;
    const nowBucket = Math.floor(Date.now() / 1000 / 1800) * 1800;
    state.guidePage = prev <= nowBucket ? null : prev;
    renderGuide();
  });
  els.gdCloseBtn.addEventListener("click", hideGuideDetail);

  window.addEventListener("beforeunload", () => {
    if (state.sessionId && navigator.sendBeacon) {
      navigator.sendBeacon("/api/stream/stop",
        new Blob([JSON.stringify({ id: state.sessionId })], { type: "application/json" }));
    }
  });

  // ---- Utilities ------------------------------------------------------------

  function fmtTime(unix) {
    return new Date(unix * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
  function fmtDay(unix) {
    return new Date(unix * 1000).toLocaleDateString([], { weekday: "short" });
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // ---- Boot -----------------------------------------------------------------

  renderFilterChips();
  const initialView = location.hash.slice(1);
  if (initialView === "guide" || initialView === "device") setView(initialView);
  if (initialView === "classic") state.pendingClassic = true;
  loadVersion();
  setInterval(loadVersion, 12 * 60 * 60 * 1000); // long-lived tabs re-check twice a day
  discover();
})();
