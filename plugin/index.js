// SPDX-License-Identifier: AGPL-3.0-only
// Adapted from sogud/mygo-cloudmusic (originally egoist/mygo-cloudmusic).
// See THIRD_PARTY_NOTICES.md for the source revision and scope of the port.
// MyGo Music supplies host and fetch; this module has no Node dependencies.

const SITE = "https://music.163.com";
const EAPI = "https://interfacepc.music.163.com";
// Protocol key shared by the upstream client, not a user's credential.
const EAPI_KEY = "e82ckenh8dichen8";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
const EAPI_UA = "NeteaseMusic 9.0.90/5038 (iPhone; iOS 16.2; zh_CN)";
const PAGE_SIZE = 30;
const PLAYLIST_LIMIT = 1000;
// The host loads a whole playlist in a single call (30 s, 256 MiB VM).
// This is a disclosed safety bound, not a claim of complete synchronization.
const MAX_PLAYLIST_TRACKS = 10000;
const PRIVATE_RADAR = "3136952023";
const COOKIE_NAMES = ["MUSIC_U", "__csrf", "NMTID"];

// MyGo 0.1.6 loads a module while holding the storage mutex. Host calls must
// happen inside an exported action, never during module initialization.
let session = null;
let epoch = 0;
let profileCheckedAt = 0;
let likedCache = null;
const pendingStreams = new Map();
// high is the existing host's name for exhigh. The other names are protocol
// candidates for a future host, not extra settings on the three-level host.
const STREAM_LEVELS = { standard: "standard", high: "exhigh", higher: "higher", exhigh: "exhigh", lossless: "lossless", hires: "hires" };
// Memory-only recommendation state. Replaced on every account/refresh boundary.
let homeCache = new Map();
let homeRevision = 0;
let homeWorkers = 0;
const homeJobs = [];
let stationQueues = new Map();
let loginAttempt = null;
let mutationTail = Promise.resolve();
let likedRevision = 0;

function scope() {
  const active = currentSession();
  const generation = epoch;
  return {
    options: { session: active, generation, deadline: Date.now() + 25000 },
    check() {
      if (active !== session || generation !== epoch) throw fail("cancelled", "账号状态已改变，请重试");
    },
  };
}

function invalidateCaches() {
  profileCheckedAt = 0;
  likedCache = null;
  likedRevision++;
  pendingStreams.clear();
  homeCache = new Map();
  homeRevision++;
  stationQueues = new Map();
  host.storage.remove("syncSummary");
  host.storage.remove("streamSummary");
}

function currentSession() {
  if (!session) session = host.storage.get("session") || { cookies: {}, profile: null };
  return session;
}

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function idOf(value) {
  const id = String(value);
  if (!/^\d+$/.test(id) || !Number.isSafeInteger(Number(id)) || Number(id) <= 0) {
    throw new Error("无效的网易云音乐 ID");
  }
  return id;
}

function pageOffset(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

// host.dir points at the install root for both repository and Zip installs.
// Encode path segments so spaces/non-ASCII names remain valid file URLs.
function coverAsset(name) {
  const directory = String(host.dir).replace(/\\/g, "/").replace(/\/+$/, "");
  return "file://" + (directory.startsWith("/") ? "" : "/") +
    directory.split("/").map(encodeURIComponent).join("/") + `/assets/${name}.png`;
}

function secureURL(value) {
  return typeof value === "string" ? value.replace(/^http:\/\//, "https://") : "";
}

function deviceID() {
  let id = host.storage.get("deviceId");
  if (!id) {
    // This is an install identifier, never a credential or encryption key.
    id = Array.from({ length: 52 }, () => Math.floor(Math.random() * 16).toString(16)).join("").toUpperCase();
    host.storage.set("deviceId", id);
  }
  return id;
}

function cookieHeader(cookies) {
  return COOKIE_NAMES.filter((key) => cookies[key]).map((key) => `${key}=${cookies[key]}`).join("; ");
}

function acceptCookies(response, cookies) {
  // moejs supplies getSetCookie(): do not split a combined header on commas,
  // because an Expires attribute itself contains a comma.
  for (const line of response.headers.getSetCookie()) {
    const pair = line.split(";", 1)[0];
    const separator = pair.indexOf("=");
    const name = pair.slice(0, separator).trim();
    if (separator < 1 || !COOKIE_NAMES.includes(name)) continue;
    const value = pair.slice(separator + 1);
    const maxAge = /;\s*max-age\s*=\s*(-?\d+)/i.exec(line);
    const expires = /;\s*expires\s*=\s*([^;]+)/i.exec(line);
    const expired = maxAge ? Number(maxAge[1]) <= 0 : expires && Date.parse(expires[1]) <= Date.now();
    if (!value || expired) delete cookies[name];
    else cookies[name] = value;
  }
}

function persistSession() {
  if (session.cookies.MUSIC_U) host.storage.set("session", session);
  else host.storage.remove("session");
}

function clearSession() {
  epoch++;
  if (loginAttempt) loginAttempt.state = "cancelled";
  session = { cookies: {}, profile: null };
  invalidateCaches();
  host.storage.remove("session");
  host.storage.remove("validationSummary");
  host.storage.remove("validationStream");
}

function acceptResponseCookies(response, activeSession) {
  const wasSignedIn = !!activeSession.cookies.MUSIC_U;
  acceptCookies(response, activeSession.cookies);
  if (activeSession === session) {
    if (wasSignedIn && !activeSession.cookies.MUSIC_U) {
      clearSession();
      throw fail("signIn", "网易云登录状态已失效，请重新登录");
    }
    persistSession();
  }
}

async function request(path, params = {}, options = {}) {
  const activeSession = options.session || currentSession();
  const startedEpoch = options.generation ?? epoch;
  if (startedEpoch !== epoch) throw fail("cancelled", "账号状态已改变，请重试");
  let url;
  const headers = { "User-Agent": UA, Referer: `${SITE}/` };
  const init = { headers, redirect: "error" };
  if (options.eapi) {
    const now = Date.now();
    const header = {
      osver: "Microsoft-Windows-10-Professional-build-19045-64bit",
      deviceId: deviceID(), os: "pc", appver: "3.1.17.204416",
      versioncode: "140", mobilename: "", buildver: String(Math.floor(now / 1000)),
      resolution: "1920x1080", channel: "netease",
      requestId: `${now}_${String(Math.floor(Math.random() * 1000)).padStart(4, "0")}`,
      __csrf: "", ...activeSession.cookies,
    };
    const text = JSON.stringify({ ...params, header, e_r: false });
    const digest = host.crypto.md5(`nobody${path}use${text}md5forencrypt`);
    const encrypted = host.crypto.aesEcbEncrypt(EAPI_KEY, `${path}-36cd479b6b5-${text}-36cd479b6b5-${digest}`);
    url = EAPI + path.replace(/^\/api\//, "/eapi/");
    init.method = "POST";
    init.body = `params=${encrypted.toUpperCase()}`;
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    headers["User-Agent"] = EAPI_UA;
    headers.Cookie = Object.keys(header).map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(header[key])}`).join("; ");
  } else {
    url = SITE + path;
    if (options.form !== undefined) {
      init.method = "POST";
      init.body = options.form;
      headers["Content-Type"] = "application/x-www-form-urlencoded";
    } else {
      const query = new URLSearchParams(params).toString();
      if (query) url += `?${query}`;
    }
    const cookie = cookieHeader(activeSession.cookies);
    if (cookie) headers.Cookie = cookie;
  }
  const controller = new AbortController();
  const remaining = options.deadline === undefined ? 12000 : Math.min(12000, options.deadline - Date.now());
  if (remaining <= 0) throw fail("timeout", "本次加载已超时，未完成完整同步，请稍后刷新");
  const timer = setTimeout(() => controller.abort(), remaining);
  init.signal = controller.signal;
  let response, body;
  try {
    response = await fetch(url, init);
    if (!response.ok) {
      if (startedEpoch !== epoch) throw fail("cancelled", "账号状态已改变，请重试");
      if (response.status === 401 && path === "/api/nuser/account/get") {
        if (activeSession === session) clearSession();
        throw fail("signIn", "网易云登录状态已失效，请重新登录");
      }
      const code = response.status === 429 ? "rateLimit" : [401, 403].includes(response.status) ? "unavailable" : "network";
      throw fail(code, `网易云请求失败（HTTP ${response.status}），请稍后重试`);
    }
    body = await response.json();
  } catch (error) {
    if (error.code === "signIn") throw error;
    if (startedEpoch !== epoch) throw fail("cancelled", "账号状态已改变，请重试");
    if (controller.signal.aborted) throw fail("timeout", "网易云请求超时，请稍后重试");
    // Never put response bodies, request headers or login cookies in errors.
    if (response && !response.ok) throw error;
    throw fail("network", "无法读取网易云音乐，请检查网络及系统代理后重试");
  } finally {
    clearTimeout(timer);
  }
  if (startedEpoch !== epoch) throw fail("cancelled", "账号状态已改变，请重试");
  if (!body || typeof body !== "object") throw new Error("网易云返回了无效数据");
  const code = Number(body.code);
  const allowed = options.codes || [200];
  if (!allowed.includes(code)) {
    // Content access can be forbidden while the account is still signed in.
    if ((code === 401 || code === 403) && path !== "/api/nuser/account/get") {
      acceptResponseCookies(response, activeSession);
      throw fail("unavailable", "当前账号无权访问该内容");
    }
    if ([301, 302, 401].includes(code)) {
      if (activeSession === session) clearSession();
      throw fail("signIn", "请重新登录网易云音乐");
    }
    if (code === 460 || code === -460) {
      // A refused response can still renew NMTID. Keep the server's cookie
      // update for the same device/account retry, including session expiry.
      acceptResponseCookies(response, activeSession);
      const error = new Error(`网易云暂时拒绝了请求（${code}），请稍后重试`);
      error.neteaseCode = code;
      throw error;
    }
    if (code === 405 || code === 429) throw fail("rateLimit", "网易云暂时限制了请求，请稍后再试");
    throw new Error(`网易云接口返回错误（${Number.isFinite(code) ? code : "未知"}）`);
  }
  acceptResponseCookies(response, activeSession);
  return body;
}

const eapi = (path, params, options = {}) => request(path, params, { ...options, eapi: true });

function toArtist(artist = {}) {
  return { id: String(artist.id || ""), name: artist.name || "", imageUrl: secureURL(artist.img1v1Url || artist.picUrl) };
}

function toAlbum(album = {}) {
  const date = Number(album.publishTime);
  return {
    id: String(album.id || ""), name: album.name || "", imageUrl: secureURL(album.picUrl),
    artists: (album.artists || (album.artist ? [album.artist] : [])).map(toArtist),
    released: date > 0 ? new Date(date).toISOString().slice(0, 10) : "",
  };
}

function toTrack(track) {
  const privilege = track.privilege;
  return {
    id: String(track.id), name: track.name || "",
    artists: (track.ar || track.artists || []).map(toArtist),
    album: toAlbum(track.al || track.album), duration: track.dt || track.duration || 0,
    url: `${SITE}/song?id=${track.id}`,
    unavailable: privilege ? privilege.st < 0 || privilege.pl <= 0 : track.fee === 1 || track.fee === 4,
  };
}

function toPlaylist(playlist) {
  return {
    id: String(playlist.id), name: playlist.name || "",
    imageUrl: secureURL(playlist.coverImgUrl || playlist.picUrl),
    description: playlist.description || "", owner: playlist.creator?.nickname || "",
    trackCount: playlist.trackCount || 0, saved: !!playlist.subscribed,
    mine: !!session?.profile && String(playlist.creator?.userId) === session.profile.id,
    fixed: Number(playlist.specialType) === 5,
  };
}

function toShow(show) {
  return {
    id: String(show.id), name: show.name || "", imageUrl: secureURL(show.picUrl),
    description: show.desc || "", publisher: show.dj?.nickname || "",
    episodeCount: show.programCount || 0, subscribed: !!show.subed,
  };
}

function toEpisode(program, show) {
  const programID = idOf(program.id);
  const audioID = program.mainSong?.id ? idOf(program.mainSong.id) : null;
  const published = new Date(Number(program.createTime));
  return {
    // Keep the program ID for comments and the audio ID for playback. Missing
    // audio stays visible so the host's next offset still counts this episode.
    id: `program:${programID}${audioID ? ":" + audioID : ""}`,
    name: program.name || "", showId: String(show.id),
    artists: show.dj?.nickname ? [{ id: "", name: show.dj.nickname }] : [],
    album: { id: "", name: show.name || "", imageUrl: secureURL(program.coverUrl || show.picUrl) },
    duration: program.duration || program.mainSong?.duration || 0,
    description: program.description || "",
    published: published.getTime() > 0 ? published.toISOString().slice(0, 10) : "",
    url: `${SITE}/program?id=${programID}`, unavailable: !audioID,
  };
}

function trackIdentity(value) {
  const match = /^program:(\d+)(?::(\d+))?$/.exec(String(value));
  if (match) {
    const program = idOf(match[1]);
    return { program, audio: match[2] ? idOf(match[2]) : null, thread: `A_DJ_1_${program}` };
  }
  const audio = idOf(value);
  return { audio, thread: `R_SO_4_${audio}` };
}

function toComment(comment) {
  const quote = (comment.beReplied || []).map(reply =>
    `${reply.user?.nickname || ""}：${reply.content || ""}`).join("\n");
  return {
    id: String(comment.commentId), author: comment.user?.nickname || "",
    avatarUrl: secureURL(comment.user?.avatarUrl),
    text: (comment.content || "") + (quote ? `\n\n回复：${quote}` : ""),
    time: comment.time || 0, likes: comment.likedCount || 0, liked: !!comment.liked,
  };
}

async function songDetails(ids, originals = [], options = {}) {
  if (!ids.length) return [];
  const context = scope();
  options = { ...context.options, ...options };
  const batches = [];
  for (let offset = 0; offset < ids.length; offset += 400) {
    batches.push(ids.slice(offset, offset + 400));
  }
  // Two workers keep large playlists from issuing dozens of simultaneous requests.
  const results = new Array(batches.length);
  let next = 0;
  async function worker() {
    while (next < batches.length) {
      const index = next++;
      const batch = batches[index];
      const data = await eapi("/api/v3/song/detail", { c: JSON.stringify(batch.map((id) => ({ id: Number(idOf(id)) }))) }, options);
      const privileges = new Map((data.privileges || []).map((p) => [String(p.id), p]));
      if (!Array.isArray(data.songs)) throw new Error("网易云未返回歌曲详情，请刷新后重试");
      results[index] = data.songs.map((song) => ({ ...song, privilege: privileges.get(String(song.id)) || song.privilege }));
    }
  }
  await Promise.all([worker(), worker()]);
  context.check();
  const byID = new Map(results.flat().map((song) => [String(song.id), song]));
  const fallback = new Map(originals.map((song) => [String(song.id), song]));
  // MyGo advances offset by the number of returned tracks. Keep a slot for
  // every requested ID, including songs removed from the detail response.
  return ids.map((id) => byID.get(String(id)) || {
    ...(fallback.get(String(id)) || { id, name: "歌曲暂不可用" }),
    privilege: { st: -1, pl: 0 },
  });
}

async function profileFor(activeSession, generation = epoch) {
  const data = await request("/api/nuser/account/get", {}, { session: activeSession, generation });
  const profile = activeSession.cookies.MUSIC_U ? data.profile : null;
  return profile ? { id: idOf(profile.userId), name: profile.nickname || "网易云用户", imageUrl: secureURL(profile.avatarUrl), page: "sync" } : null;
}

export async function account() {
  const activeSession = currentSession();
  if (!activeSession.cookies.MUSIC_U) return null;
  if (activeSession.profile && Date.now() - profileCheckedAt < 60000) return activeSession.profile;
  try {
    const profile = await profileFor(activeSession);
    // Never apply a profile to a session replaced while the request was pending.
    if (activeSession !== session) throw new Error("账号状态已改变，请重试");
    if (!profile) { clearSession(); return null; }
    if (activeSession.profile && activeSession.profile.id !== profile.id) {
      epoch++;
      invalidateCaches();
    }
    activeSession.profile = profile;
    profileCheckedAt = Date.now();
    persistSession();
    return profile;
  } catch (error) {
    if (error.code === "signIn") return null;
    throw error;
  }
}

async function requireAccount() {
  const context = scope();
  const profile = await account();
  if (!profile && !currentSession().cookies.MUSIC_U) throw fail("signIn", "请先扫码登录网易云音乐");
  context.check();
  if (!profile) throw fail("signIn", "请先扫码登录网易云音乐");
  return profile;
}

export async function signIn() {
  if (loginAttempt) loginAttempt.state = "cancelled";
  const startedEpoch = ++epoch;
  invalidateCaches();
  const pending = { cookies: {}, profile: null };
  const attempt = { state: "generating", generation: startedEpoch };
  loginAttempt = attempt;
  const deadline = Date.now() + 180000;
  function checkAttempt() {
    if (epoch !== startedEpoch) throw fail("cancelled", "登录已取消，请重新点击登录");
    if (Date.now() >= deadline) throw fail("timeout", "扫码登录超时，请重新点击登录");
  }
  try {
    host.signInPrompt({ text: "正在生成网易云音乐登录二维码…" });
    const options = { session: pending, generation: startedEpoch };
    const key = await eapi("/api/login/qrcode/unikey", { type: 3 }, options);
    checkAttempt();
    if (!key.unikey) throw new Error("网易云未返回登录二维码，请稍后重试");
    const qr = `${SITE}/login?codekey=${encodeURIComponent(key.unikey)}`;
    attempt.state = "waitingScan";
    host.signInPrompt({ qr, text: "请用网易云音乐 App 扫码确认。停止登录：关闭此框后，进入「账号与同步 → 取消扫码登录」。" });
    while (true) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      checkAttempt();
      const result = await eapi("/api/login/qrcode/client/login", { key: key.unikey, type: 3 }, {
        ...options, codes: [800, 801, 802, 803],
      });
      checkAttempt();
      if (Number(result.code) === 800) throw fail("expired", "二维码已过期，请重新点击登录");
      if (Number(result.code) === 801) attempt.state = "waitingScan";
      if (Number(result.code) === 802) {
        attempt.state = "waitingConfirm";
        host.signInPrompt({ qr, text: "已扫码，请在手机上确认登录" });
      }
      if (Number(result.code) === 803) {
        attempt.state = "validating";
        if (!pending.cookies.MUSIC_U) throw new Error("网易云未返回有效会话，请重新扫码登录");
        pending.profile = await profileFor(pending, startedEpoch);
        if (!pending.profile) throw new Error("无法读取已登录账号，请重新扫码");
        checkAttempt();
        epoch++;
        invalidateCaches();
        session = pending;
        profileCheckedAt = Date.now();
        persistSession();
        attempt.state = "success";
        host.signInPrompt({ text: "登录成功" });
        return pending.profile;
      }
    }
  } catch (error) {
    attempt.state = epoch !== startedEpoch ? "cancelled" :
      ["timeout", "expired"].includes(error.code) ? error.code : "failed";
    if (epoch !== startedEpoch) throw fail("cancelled", "登录已取消，请重新点击登录");
    throw error;
  }
}

function cancelSignIn() {
  if (loginAttempt && ["generating", "waitingScan", "waitingConfirm", "validating"].includes(loginAttempt.state)) {
    epoch++;
    loginAttempt.state = "cancelled";
    invalidateCaches();
  }
}

export function signOut() {
  // Forget this plugin's session. Do not affect other NetEase clients.
  clearSession();
}

async function search({ query, kind = "tracks", offset = 0 }) {
  const context = scope();
  const types = {
    tracks: [1, "songs", "songCount", toTrack], albums: [10, "albums", "albumCount", toAlbum],
    artists: [100, "artists", "artistCount", toArtist], playlists: [1000, "playlists", "playlistCount", toPlaylist],
    shows: [1009, "djRadios", "djRadiosCount", toShow],
  };
  const type = types[kind];
  if (!type) throw fail("unsupported", "支持歌曲、专辑、歌手、歌单和播客搜索");
  const text = String(query || "").trim();
  if (!text) return { [kind]: [], more: false };
  offset = pageOffset(offset);
  const data = await request("/api/cloudsearch/pc", { s: text, type: type[0], limit: PAGE_SIZE, offset, total: "true" }, context.options);
  context.check();
  const result = data.result || {};
  const items = result[type[1]] || [];
  const records = kind === "tracks" ? await songDetails(items.map((song) => song.id), items, context.options) : items;
  return { [kind]: records.map(type[3]), more: items.length > 0 && offset + items.length < (result[type[2]] || 0) };
}

// NetEase serves China-local daily recommendations. A date change requests the
// server again; it does not imply the server has produced a different batch.
function recommendationDay() {
  return new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
}

function runHomeJobs() {
  while (homeWorkers < 2 && homeJobs.length) {
    const job = homeJobs.shift();
    homeWorkers++;
    Promise.resolve().then(job.load).then(job.resolve, job.reject).finally(() => {
      homeWorkers--;
      runHomeJobs();
    });
  }
}

function homeJob(load) {
  return new Promise((resolve, reject) => {
    homeJobs.push({ load, resolve, reject });
    runHomeJobs();
  });
}

function refreshHome() {
  homeCache = new Map();
  homeRevision++;
}

function cachedHome(kind, context, load) {
  const cache = homeCache;
  const revision = homeRevision;
  const key = `${epoch}:${currentSession().profile?.id || "guest"}:${recommendationDay()}:${kind}`;
  const existing = cache.get(key);
  if (existing && Date.now() < existing.expires) return existing.promise;
  // Only the current account/date is retained; no unbounded daily history.
  for (const oldKey of cache.keys()) {
    if (!oldKey.startsWith(key.slice(0, key.lastIndexOf(":") + 1))) cache.delete(oldKey);
  }
  const entry = { expires: Infinity };
  entry.promise = homeJob(async () => {
    context.check();
    if (revision !== homeRevision) throw fail("cancelled", "推荐已刷新，请重试");
    const value = await load();
    context.check();
    if (revision !== homeRevision) throw fail("cancelled", "推荐已刷新，请重试");
    entry.expires = kind === "daily" ? Infinity : Date.now() + 5 * 60000;
    return value;
  }).catch(error => {
    if (cache.get(key) === entry) cache.delete(key);
    throw error;
  });
  cache.set(key, entry);
  return entry.promise;
}

async function recommendationTracks(songs, context) {
  if (!Array.isArray(songs)) throw new Error("网易云未返回推荐歌曲列表");
  const ordered = [...new Map(songs.map(song => [idOf(song.id), song])).values()];
  const missing = ordered.filter(song => !song.name || !(song.ar || song.artists)?.length ||
    !(song.al || song.album)?.picUrl || !(song.dt || song.duration) || !song.privilege);
  const details = [];
  // One detail request at a time within a feed job preserves the two-request
  // home budget even if the server returns more than 400 daily songs.
  for (let offset = 0; offset < missing.length; offset += 400) {
    const batch = missing.slice(offset, offset + 400);
    details.push(...await songDetails(batch.map(song => song.id), batch, context.options));
  }
  context.check();
  const byID = new Map(details.map(song => [String(song.id), song]));
  return ordered.map(song => toTrack(byID.get(String(song.id)) || song));
}

function dailyTracks(context) {
  return cachedHome("daily", context, async () => {
    const data = await request("/api/v3/discovery/recommend/songs", {}, context.options);
    return recommendationTracks(data.data?.dailySongs, context);
  });
}

function recommendedPlaylists(context, personalized) {
  return cachedHome(personalized ? "personalized" : "ordinary", context, async () => {
    const data = await request(personalized ? "/api/v1/discovery/recommend/resource" : "/api/personalized/playlist",
      personalized ? {} : { limit: 24 }, context.options);
    const items = personalized ? data.recommend : data.result;
    if (!Array.isArray(items)) throw new Error("网易云未返回推荐歌单列表");
    return items.map(toPlaylist);
  });
}

function radarCover(context) {
  return cachedHome("radar", context, async () => {
    const data = await request("/api/v6/playlist/detail", { id: PRIVATE_RADAR, n: 1 }, context.options);
    if (String(data.playlist?.id) !== PRIVATE_RADAR) throw fail("unavailable", "私人雷达暂不可用");
    return secureURL(data.playlist.coverImgUrl);
  });
}

async function optionalHome(load, fallback) {
  try { return await load(); }
  catch (error) {
    if (["signIn", "cancelled"].includes(error.code)) throw error;
    return fallback;
  }
}

async function personalizedHome() {
  const context = scope();
  const profile = await account();
  context.check();
  const revision = homeRevision;
  const [daily, recommendations, cover] = await Promise.all([
    profile ? optionalHome(() => dailyTracks(context), null) : Promise.resolve([]),
    optionalHome(() => recommendedPlaylists(context, !!profile), null),
    profile ? optionalHome(() => radarCover(context), "") : Promise.resolve(""),
  ]);
  context.check();
  if (revision !== homeRevision) throw fail("cancelled", "推荐已刷新，请重试");
  const dailySection = {
    title: "每日推荐", pageTitle: "每日歌曲推荐", subtitle: "根据你的音乐口味生成", tracks: daily || [],
    empty: !profile ? "登录后查看每日推荐，请从账号入口扫码登录。" :
      daily === null ? "每日推荐暂时无法加载，可手动刷新重试；其他入口仍可使用。" : "网易云本次没有返回每日推荐歌曲。",
  };
  if (daily?.length) delete dailySection.empty;
  return {
    title: "发现音乐", subtitle: profile ? "网易云音乐 · 为你推荐" : "网易云音乐 · 登录后获取个性化推荐",
    sections: [
      dailySection,
      { title: "探索音乐", links: [
        { title: "私人雷达", subtitle: "网易云音乐 · 私人雷达", page: "radar", imageUrl: cover },
        { title: "个性化歌单", subtitle: "登录后获取网易云推荐", page: "recommendations", imageUrl: recommendations?.[0]?.imageUrl || "" },
        { title: "排行榜", page: "charts", imageUrl: coverAsset("charts") },
      ] },
      { title: "私人漫游", stations: stationList() },
      { title: profile ? "为你推荐的歌单" : "普通推荐（未登录）", playlists: recommendations || [],
        empty: recommendations === null ? "推荐歌单暂时无法加载，请手动刷新重试。" : "网易云本次没有返回推荐歌单。",
        morePage: profile ? "recommendations" : "discovery" },
    ],
  };
}

async function originalBrowse({ page }) {
  const context = scope();
  if (page === "discovery" || page === "recommendations") {
    const profile = page === "recommendations" ? await requireAccount() : await account();
    context.check();
    return { title: profile ? "个性化歌单" : "普通推荐（未登录）", sections: [{
      playlists: await recommendedPlaylists(context, !!profile), empty: "网易云本次没有返回推荐歌单",
    }] };
  }
  if (page === "radar") {
    await requireAccount();
    context.check();
    const radar = await playlist({ id: PRIVATE_RADAR });
    return { title: "私人雷达", subtitle: radar.name, imageUrl: radar.imageUrl, sections: [{ tracks: radar.tracks }] };
  }
  if (page === "daily") {
    await requireAccount();
    context.check();
    const tracks = await dailyTracks(context);
    const date = new Date(Date.now() + 8 * 3600000);
    const weekday = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"][date.getUTCDay()];
    return {
      title: "每日歌曲推荐", subtitle: `每日推荐 · ${date.getUTCMonth() + 1}月${date.getUTCDate()}日 ${weekday}`,
      description: `${tracks.length} 首 · 根据你的音乐口味生成`,
      sections: [{ tracks, empty: "网易云本次没有返回每日推荐歌曲" }],
    };
  }
  if (page !== "charts") throw fail("unsupported", "没有这个页面");
  const data = await request("/api/toplist/detail");
  return { title: "排行榜", sections: [{ playlists: (data.list || []).map(toPlaylist) }] };
}

async function playlists() {
  const context = scope();
  const profile = await account();
  context.check();
  if (!profile) return [];
  const result = new Map();
  for (let offset = 0; offset < 20000;) {
    const data = await request("/api/user/playlist", { uid: profile.id, limit: 200, offset }, context.options);
    if (!Array.isArray(data.playlist)) throw new Error("网易云未返回歌单列表，请刷新后重试");
    const items = data.playlist;
    const previousSize = result.size;
    for (const item of items) result.set(idOf(item.id), toPlaylist(item));
    if (!data.more) return [...result.values()];
    if (!items.length || result.size === previousSize) throw new Error("歌单分页未前进，无法确认完整同步，请稍后刷新");
    offset += items.length;
  }
  throw new Error("歌单超过 20000 个，未完成完整同步");
}

async function playlist({ id }) {
  const context = scope();
  id = idOf(id);
  const data = await request("/api/v6/playlist/detail", { id, n: PLAYLIST_LIMIT }, context.options);
  context.check();
  if (String(data.playlist?.id) !== id) throw fail("unavailable", "歌单不存在或当前账号无权访问");
  const source = data.playlist;
  if (!Array.isArray(source.trackIds) && !Array.isArray(source.tracks)) throw new Error("网易云未返回歌单曲目列表");
  const allIDs = (source.trackIds || source.tracks).map((track) => idOf(track.id));
  const ids = allIDs.slice(0, MAX_PLAYLIST_TRACKS);
  const result = toPlaylist(source);
  result.tracks = (await songDetails(ids, source.tracks || [], context.options)).map(toTrack);
  context.check();
  const total = Math.max(Number(source.trackCount) || 0, allIDs.length);
  result.trackCount = total;
  if (ids.length < total) {
    result.description += `\n未完整同步：已加载 ${ids.length}/${total} 首。${allIDs.length < total ? "服务端未返回完整曲目 ID。" : `超过单页 ${MAX_PLAYLIST_TRACKS} 首保护上限。`}请在官方客户端查看其余歌曲。`;
  }
  return result;
}

async function shows() {
  const context = scope();
  await requireAccount();
  context.check();
  const result = new Map();
  for (let offset = 0; offset < 2000;) {
    const data = await request("/api/djradio/get/subed", { limit: 100, offset, total: "true" }, context.options);
    const items = data.djRadios || [];
    const previousSize = result.size;
    for (const item of items) result.set(String(item.id), { ...toShow(item), subscribed: true });
    if (!data.hasMore) return [...result.values()];
    if (!items.length || result.size === previousSize) {
      throw new Error("网易云未返回完整的播客订阅列表，请稍后重试");
    }
    offset += items.length;
  }
  throw new Error("播客订阅超过本版本支持的 2000 个，暂时无法完整加载");
}

async function show({ id, offset = 0 }) {
  id = idOf(id);
  offset = pageOffset(offset);
  const [detail, programs] = await Promise.all([
    request("/api/djradio/v2/get", { id }, { keepSession: true }),
    request("/api/dj/program/byradio", { radioId: id, limit: PAGE_SIZE, offset, asc: "false" }, { keepSession: true }),
  ]);
  if (!detail.data || String(detail.data.id) !== id) throw fail("unavailable", "播客不存在或当前账号无权访问");
  return {
    show: toShow(detail.data),
    episodes: (programs.programs || []).map(program => toEpisode(program, detail.data)),
    more: !!programs.more,
  };
}

async function album({ id }) {
  const context = scope();
  const data = await request(`/api/v1/album/${idOf(id)}`, {}, context.options);
  context.check();
  if (!data.album) throw fail("unavailable", "专辑不可用");
  return { album: toAlbum(data.album), tracks: (await songDetails((data.songs || []).map((song) => song.id), data.songs || [], context.options)).map(toTrack) };
}

async function artistAlbums(id) {
  const context = scope();
  // The host has no artist-album pagination action. Collect every page here,
  // advancing by raw page length so overlapping albums do not shift offsets.
  const albums = new Map();
  for (let offset = 0; offset < 10000;) {
    const data = await request(`/api/artist/albums/${id}`, { limit: PAGE_SIZE, offset }, context.options);
    const items = data.hotAlbums || [];
    const previousSize = albums.size;
    for (const item of items) albums.set(String(item.id), toAlbum(item));
    if (!data.more) return [...albums.values()];
    if (!items.length || albums.size === previousSize) {
      throw new Error("网易云未返回完整的歌手专辑列表，请稍后重试");
    }
    offset += items.length;
  }
  throw new Error("歌手专辑过多，暂时无法完整加载");
}

async function artist({ id }) {
  const context = scope();
  id = idOf(id);
  const [detail, albums] = await Promise.all([
    request(`/api/v1/artist/${id}`, {}, context.options), artistAlbums(id),
  ]);
  context.check();
  if (!detail.artist) throw fail("unavailable", "歌手不可用");
  return {
    artist: toArtist(detail.artist), albums,
    tracks: (await songDetails((detail.hotSongs || []).map((song) => song.id), detail.hotSongs || [], context.options)).map(toTrack),
  };
}

async function likedIDs(fresh = false) {
  const context = scope();
  const revision = likedRevision;
  const profile = await requireAccount();
  context.check();
  if (!fresh && likedCache && likedCache.uid === profile.id && Date.now() - likedCache.at < 60000) return likedCache.ids;
  const data = await eapi("/api/song/like/get", { uid: profile.id }, context.options);
  context.check();
  if (!Array.isArray(data.ids)) throw new Error("网易云未返回喜欢列表，请刷新后重试");
  const ids = data.ids.map(idOf);
  if (revision === likedRevision) likedCache = { uid: profile.id, ids, at: Date.now() };
  return ids;
}

async function liked({ offset = 0 }) {
  const context = scope();
  offset = pageOffset(offset);
  const ids = await likedIDs(offset === 0);
  context.check();
  return { tracks: (await songDetails(ids.slice(offset, offset + PAGE_SIZE), [], context.options)).map(toTrack), more: offset + PAGE_SIZE < ids.length };
}

async function isLiked({ ids }) {
  const identities = ids.map(id => ({ id, ...trackIdentity(id) }));
  const songs = identities.filter(item => !item.program);
  const result = Object.fromEntries(ids.map(id => [id, false]));
  // The host also asks about episode IDs. This read-only podcast integration
  // does not export likeEpisode and must not query song likes for episodes.
  if (!songs.length) return result;
  currentSession();
  if (!session.cookies.MUSIC_U) return result;
  const liked = new Set(await likedIDs());
  for (const item of songs) result[item.id] = liked.has(item.audio);
  return result;
}

async function like({ id, on }) {
  const context = scope();
  const identity = trackIdentity(id);
  if (identity.program) throw fail("unsupported", "暂不支持喜欢或取消喜欢播客节目");
  await requireAccount();
  context.check();
  likedRevision++;
  likedCache = null;
  try {
    await eapi("/api/radio/like", { alg: "itembased", trackId: identity.audio, like: String(!!on), time: "3" }, context.options);
    context.check();
    const ids = await likedIDs(true);
    context.check();
    if (ids.includes(identity.audio) !== !!on) throw fail("unconfirmed", "喜欢状态尚未在云端确认，请刷新核对；未自动重试写入");
  } finally {
    // Invalidate even after a timeout: the server may have applied the write.
    if (context.options.generation === epoch) { likedRevision++; likedCache = null; }
  }
}

function checkPlaylistSession(activeSession, generation) {
  if (generation !== epoch || activeSession !== session) {
    throw new Error("账号状态已改变，请重试");
  }
}

async function submitPlaylistTracks(op, id, ids, activeSession, generation) {
  checkPlaylistSession(activeSession, generation);
  const form = new URLSearchParams({ op, pid: id, imme: "true", trackIds: JSON.stringify(ids.map(Number)) });
  if (activeSession.cookies.__csrf) form.set("csrf_token", activeSession.cookies.__csrf);
  try {
    const data = await request("/api/playlist/manipulate/tracks", {}, {
      session: activeSession, generation, form: form.toString(), keepSession: true, codes: [200, 502],
    });
    checkPlaylistSession(activeSession, generation);
    return data;
  } catch (error) {
    // Preserve signIn so the host can offer login; a content 401 keeps session.
    error.message = `${op === "add" ? "添加到歌单" : "移出歌单"}失败：${error.message}`;
    throw error;
  }
}

async function playlistTrackIDs(id, activeSession, generation) {
  checkPlaylistSession(activeSession, generation);
  const data = await request("/api/v6/playlist/detail", { id, n: PLAYLIST_LIMIT }, {
    session: activeSession, generation, keepSession: true,
  });
  checkPlaylistSession(activeSession, generation);
  const source = data.playlist;
  if (String(source?.id) !== id || !Array.isArray(source.trackIds) || source.trackIds.length < source.trackCount) {
    throw new Error("无法确认歌单的完整歌曲列表，请刷新后重试");
  }
  return new Set(source.trackIds.map(track => String(track.id)));
}

async function manipulatePlaylistTracks(op, id, trackIds) {
  const pid = String(Number(idOf(id)));
  if (trackIds == null) trackIds = [];
  if (!Array.isArray(trackIds)) throw new Error("无效的歌曲列表");
  const ids = [...new Set(trackIds.map(value => {
    const identity = trackIdentity(value);
    if (identity.program) throw fail("unsupported", "暂不支持将播客节目添加到歌曲歌单或从中移除");
    return String(Number(identity.audio));
  }))];
  if (!ids.length) return;
  const activeSession = currentSession();
  const generation = epoch;
  await requireAccount();
  checkPlaylistSession(activeSession, generation);
  const data = await submitPlaylistTracks(op, pid, ids, activeSession, generation);
  if (op === "add" && Number(data.code) === 502) {
    const present = await playlistTrackIDs(pid, activeSession, generation);
    const missing = ids.filter(trackID => !present.has(trackID));
    if (!missing.length) {
      throw fail("duplicate", ids.length === 1 ? "这首歌已经在这个歌单里了" : "这些歌曲已经在这个歌单里了");
    }
  }
  if (Number(data.code) !== 200) {
    throw new Error(`${op === "add" ? "添加到歌单" : "移出歌单"}未完成（${data.code}），请刷新歌单后重试`);
  }
  likedRevision++;
  likedCache = null;
  const present = await playlistTrackIDs(pid, activeSession, generation);
  if (!ids.every(trackID => present.has(trackID) === (op === "add"))) {
    throw fail("unconfirmed", "歌单修改尚未在云端确认，请刷新核对；未自动重试写入");
  }
}

async function addToPlaylist({ id, trackIds }) {
  await manipulatePlaylistTracks("add", id, trackIds);
}

async function removeFromPlaylist({ id, trackIds }) {
  await manipulatePlaylistTracks("del", id, trackIds);
}

async function comments({ trackId, offset = 0 }) {
  const identity = trackIdentity(trackId);
  const data = await request(`/api/v1/resource/comments/${identity.thread}`, {
    limit: PAGE_SIZE, offset: pageOffset(offset),
  }, { keepSession: true });
  // Hot comments overlap the chronological list. Adding them here would make
  // the host skip comments when it advances by the number already displayed.
  return { comments: (data.comments || []).map(toComment), total: data.total || 0, more: !!data.more };
}

async function lyrics({ id }) {
  const identity = trackIdentity(id);
  if (identity.program) return { lrc: "", translation: "" };
  const activeSession = currentSession();
  const generation = epoch;
  const data = await request("/api/song/lyric", { id: identity.audio, lv: 1, tv: -1 });
  const lrc = data.lrc?.lyric || "";
  const translation = data.tlyric?.lyric || "";
  if (lrc.trim()) return { lrc, translation };
  // Some songs have empty web lyrics while the desktop endpoint has LRC.
  // Do not treat that empty response as proof that the song is instrumental.
  if (activeSession !== session || generation !== epoch) throw new Error("账号状态已改变，请重试");
  const desktop = await eapi("/api/song/lyric/v1", {
    id: identity.audio, cp: false, tv: 0, lv: 0, rv: 0, kv: 0, yv: 0, ytv: 0, yrv: 0,
  }, { session: activeSession, keepSession: true });
  if (activeSession !== session || generation !== epoch) throw new Error("账号状态已改变，请重试");
  return { lrc: desktop.lrc?.lyric || "", translation: desktop.tlyric?.lyric || translation };
}

async function originalStream({ id, quality = "high" }) {
  id = trackIdentity(id).audio;
  if (!id) throw fail("unavailable", "该播客节目没有可播放的音频");
  const generation = epoch;
  if (!Object.prototype.hasOwnProperty.call(STREAM_LEVELS, quality)) throw fail("unavailable", "不支持的音质偏好，请更新播放器或重新选择音质");
  const key = `${generation}:${id}:${STREAM_LEVELS[quality]}`;
  if (pendingStreams.has(key)) return pendingStreams.get(key);
  const pending = loadStream(id, quality, generation);
  pendingStreams.set(key, pending);
  try { return await pending; }
  finally { if (pendingStreams.get(key) === pending) pendingStreams.delete(key); }
}

async function loadStream(id, quality, generation) {
  const level = STREAM_LEVELS[quality];
  const context = scope();
  if (generation !== epoch) throw fail("cancelled", "账号状态已改变，请重试");
  // Let the server return an entitled complete lower level. Do not interpret
  // empty URLs, risk controls or transport errors as permission to step down.
  const data = await eapi("/api/song/enhance/player/url/v1", {
    ids: JSON.stringify([Number(id)]), level,
    encodeType: ["lossless", "hires"].includes(level) ? "flac" : "mp3",
  }, context.options);
  context.check();
  const audio = (data.data || []).find((item) => String(item.id) === id);
  if (!audio || !audio.url || (audio.code !== undefined && audio.code !== 200) || audio.freeTrialInfo != null) {
    throw fail("unavailable", "当前账号无完整播放权限，或歌曲在当前地区不可用");
  }
  let url;
  try { url = new URL(secureURL(audio.url)); }
  catch { throw fail("unavailable", "网易云返回了无效的音频地址"); }
  if (url.protocol !== "https:" || url.username || url.password || url.port || !/^(?:[a-z0-9-]+\.)*music\.126\.net$/i.test(url.hostname)) {
    throw fail("unavailable", "网易云返回了不支持的音频地址");
  }
  const type = String(audio.type || "").toLowerCase();
  if (!["mp3", "flac", "ogg"].includes(type)) throw fail("unavailable", "该歌曲的音频格式暂不支持");
  const positive = value => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
  if (audio.expi !== undefined && !positive(audio.expi)) throw fail("unavailable", "音频地址已失效，请重新播放以获取新地址");
  const bitRate = positive(audio.br), size = positive(audio.size);
  const lossless = type === "flac";
  const reported = Object.values(STREAM_LEVELS).includes(audio.level) ? audio.level : "unknown";
  const consistent = lossless ? ["lossless", "hires"].includes(reported) : ["standard", "higher", "exhigh"].includes(reported);
  const actualLevel = consistent ? reported : "unknown";
  // Missing/contradictory level must never fall back to the requested level.
  // A FLAC container establishes lossless, but alone cannot establish Hi-Res.
  const actual = lossless ? "lossless" : actualLevel === "standard" ? "standard" :
    ["higher", "exhigh"].includes(actualLevel) || bitRate > 128000 ? "high" : "standard";
  const metadata = {
    requestedLevel: level, actualLevel, reportedLevel: reported,
    actual, type, bitRate, size,
  };
  for (const field of ["sampleRate", "bitDepth", "expi"]) {
    if (positive(audio[field])) metadata[field] = audio[field];
  }
  return { metadata, audio: {
    url: url.toString(), type, size, bitRate, quality: actual,
    gain: Number.isFinite(audio.gain) ? audio.gain : 0, peak: positive(audio.peak),
    headers: { "User-Agent": UA, Referer: `${SITE}/` },
  } };
}

// The host asks stationNext again as the queue runs out. These modes are
// NetEase's own recommendations, not a shuffle of the current local list.
function stationList() {
  return [
    { id: "DEFAULT", name: "私人漫游", description: "随心听，持续推荐你可能喜欢的歌曲" },
    { id: "FAMILIAR", name: "熟悉的歌", description: "回到熟悉的旋律" },
    { id: "EXPLORE", name: "新发现", description: "探索还没听过的音乐" },
  ].map((station, index) => ({ ...station, imageUrl: coverAsset(["roam", "familiar", "explore"][index]) }));
}

async function stations() {
  return stationList();
}

async function stationNext({ id }) {
  const context = scope();
  if (!["DEFAULT", "FAMILIAR", "EXPLORE"].includes(id)) throw fail("unsupported", "没有这个漫游模式");
  await requireAccount();
  context.check();
  let state = stationQueues.get(id);
  if (!state) {
    state = { seen: new Set(), tail: Promise.resolve(), exhausted: false };
    stationQueues.set(id, state);
  }
  // Serialize consumers so overlapping host requests never append the same batch.
  const result = state.tail.then(async () => {
    context.check();
    if (state.exhausted) return [];
    for (let attempt = 0; attempt < 3; attempt++) {
      const data = await eapi("/api/v1/radio/get", { mode: id, limit: 3 }, context.options);
      context.check();
      if (!Array.isArray(data.data)) throw new Error("网易云未返回漫游歌曲列表");
      const fresh = [...new Map(data.data.map(song => [idOf(song.id), song])).values()]
        .filter(song => !state.seen.has(String(song.id)));
      if (fresh.length) {
        const tracks = await recommendationTracks(fresh, context);
        context.check();
        for (const track of tracks) state.seen.add(track.id);
        // Bound memory while retaining the most recent 500 tracks per mode.
        while (state.seen.size > 500) state.seen.delete(state.seen.values().next().value);
        return tracks;
      }
      if (!data.data.length) break;
    }
    state.exhausted = true;
    return [];
  });
  state.tail = result.catch(() => {});
  return result;
}


// Read-only account snapshot. Refreshing this page always reads cloud state anew.
async function syncPage() {
  const context = scope();
  const profile = await account();
  context.check();
  if (!profile) return {
    title: "账号与同步", description: "请从账号入口扫码登录。关闭登录框后，点击下方入口可停止尚未完成的扫码。",
    sections: [{ links: [{ title: "取消扫码登录", page: `cancel-sign-in:${epoch}:${Date.now()}` }] }],
  };
  const lists = await playlists();
  context.check();
  const ids = await likedIDs(true);
  context.check();
  const first = await songDetails(ids.slice(0, PAGE_SIZE), [], context.options);
  context.check();
  const summary = {
    time: new Date().toISOString(), mine: lists.filter(p => p.mine).length,
    saved: lists.filter(p => !p.mine).length, liked: ids.length,
  };
  host.storage.set("syncSummary", summary);
  return {
    title: "账号与同步", subtitle: profile.name,
    description: `列表读取完成：自建 ${summary.mine} 个，收藏 ${summary.saved} 个，喜欢 ${summary.liked} 首。\n仅表示歌单目录及喜欢 ID 已读取；打开歌单时再加载曲目，超出上限或服务端缺少 ID 时会注明。\n本次已重新读取云端；再次同步请点「刷新云端列表」或播放器刷新按钮。侧栏目录使用播放器刷新按钮更新。`,
    sections: [
      { links: [
        { title: "刷新云端列表", page: `sync-refresh:${epoch}:${Date.now()}`, subtitle: "重新读取自建、收藏和喜欢列表" },
        { title: "播放诊断", page: "diagnostics", subtitle: "仅包含最近取流的脱敏摘要" },
        { title: "取消扫码登录", page: `cancel-sign-in:${epoch}:${Date.now()}`, subtitle: "停止尚未完成的登录，不退出当前账号" },
      ] },
      { title: "我喜欢的音乐（前 30 首；完整列表在侧栏）", tracks: first.map(toTrack) },
      { title: "自建歌单", playlists: lists.filter(p => p.mine) },
      { title: "收藏歌单", playlists: lists.filter(p => !p.mine) },
    ],
  };
}

async function home() {
  return personalizedHome();
}

async function browse({ page }) {
  if (page === "home-refresh" || page.startsWith("home-refresh:")) {
    refreshHome();
    const result = await home();
    result.description = "已重新读取首页推荐。此页列出本批歌曲；返回发现音乐后使用播放器刷新按钮，可更新首页大卡片。服务端可能仍返回同一批推荐。";
    return result;
  }
  if (page === "cancel-sign-in" || page.startsWith("cancel-sign-in:")) {
    cancelSignIn();
    return { title: "扫码登录已停止", description: "旧二维码返回的结果不会保存。当前已登录账号保持有效；需要登录时请重新点击账号入口。", sections: [] };
  }
  if (page === "sync" || page === "sync-refresh" || page.startsWith("sync-refresh:")) return syncPage();
  if (page === "diagnostics") {
    const audio = host.storage.get("streamSummary");
    return {
      title: "播放诊断",
      description: audio ? `最近成功取流：${audio.time}\n请求偏好 ${audio.requested}；请求档位 ${audio.requestedLevel || "未记录"}；实际档位 ${audio.actualLevel || "unknown"}；服务端档位 ${audio.reportedLevel || "未记录"}；宿主档位 ${audio.actual}。\n格式 ${audio.type}；码率 ${audio.bitRate} bps；大小 ${audio.size || 0} 字节；采样率 ${audio.sampleRate || "未提供"}；位深 ${audio.bitDepth || "未提供"}。\n此记录仅代表获取完整音源地址成功，不代表实际解码播放或 Hi-Res 验收通过。缓存播放可能不会调用插件，摘要不代表当前缓存音质。` : "暂无取流记录。播放歌曲后重新进入此页查看。",
      sections: [],
    };
  }
  return originalBrowse({ page });
}

async function stream(args) {
  const context = scope();
  const { audio, metadata } = await originalStream(args);
  context.check();
  host.storage.set("streamSummary", {
    ...metadata, requested: args.quality || "high", time: new Date().toISOString(),
  });
  return audio;
}

// An action may await several requests. Never publish an old account's result
// even if its last request finished before another action changed the account.
function guarded(action) {
  return async function(args) {
    const context = scope();
    const result = await action(args);
    context.check();
    return result;
  };
}

// Serialize explicit cloud writes, including their read-back verification.
// A queued write belongs to the account that queued it; it never moves to a new one.
function mutation(action) {
  return function(args) {
    const context = scope();
    const pending = mutationTail.catch(() => {}).then(async () => {
      context.check();
      try {
        const result = await action(args);
        context.check();
        return result;
      } finally {
        if (context.options.generation === epoch) {
          likedRevision++;
          likedCache = null;
          host.storage.remove("syncSummary");
        }
      }
    });
    mutationTail = pending;
    return pending;
  };
}

const public_search = guarded(search);
export { public_search as search };

const public_album = guarded(album);
export { public_album as album };

const public_artist = guarded(artist);
export { public_artist as artist };

const public_playlists = guarded(playlists);
export { public_playlists as playlists };

const public_playlist = guarded(playlist);
export { public_playlist as playlist };

const public_liked = guarded(liked);
export { public_liked as liked };

const public_isLiked = guarded(isLiked);
export { public_isLiked as isLiked };

const public_home = guarded(home);
export { public_home as home };

const public_browse = args => (args?.page === "cancel-sign-in" || args?.page?.startsWith("cancel-sign-in:")) ? browse(args) : guarded(browse)(args);
export { public_browse as browse };

const public_stations = guarded(stations);
export { public_stations as stations };

const public_stationNext = guarded(stationNext);
export { public_stationNext as stationNext };

const public_stream = guarded(stream);
export { public_stream as stream };

const public_lyrics = guarded(lyrics);
export { public_lyrics as lyrics };

const public_comments = guarded(comments);
export { public_comments as comments };

const public_shows = guarded(shows);
export { public_shows as shows };

const public_show = guarded(show);
export { public_show as show };

const public_like = mutation(like);
export { public_like as like };

const public_addToPlaylist = mutation(addToPlaylist);
export { public_addToPlaylist as addToPlaylist };

const public_removeFromPlaylist = mutation(removeFromPlaylist);
export { public_removeFromPlaylist as removeFromPlaylist };

// Settings writes reach the plugin directly, even when the host caches browse pages.
export function setSetting({key, value}) {
  if (key === "refreshHome" && String(value || "").trim()) refreshHome();
  if (key === "cancelLogin" && String(value || "").trim()) cancelSignIn();
}
