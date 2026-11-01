'use strict';
// Fills in the song for SiriusXM channels when Sonos only reports the channel.
//
// Since late 2026 SiriusXM stopped sending song metadata to Sonos: currentTrack.title is just
// the stream URI ("x-sonosapi-hls:channel-linear:<uuid>?sid=37...") and artist is the channel
// name. We look the song up by channel UUID and patch it into the state that /state and the
// webhook hand out, so every consumer gets it without changes.
//
// Sources, tried in order until one has a current song:
//   xmplaylist - public site, no login
//   siriusxm   - SiriusXM's own web-player API; only used if siriusxm-login.json exists
//                ({"username": "...", "password": "..."} next to settings.json, gitignored)
//
// Mode (settings.json "siriusNowPlaying.mode", or GET /sxmnowplaying/<mode> at runtime):
//   auto - look up only when Sonos has no song of its own (default; switches back by itself
//          if SiriusXM starts sending song data again)
//   on   - always use the lookup for SiriusXM channels
//   off  - never look up; Sonos data passes through untouched
const fs = require('fs');
const path = require('path');
const logger = require('sonos-discovery/lib/helpers/logger');

const MODES = ['auto', 'on', 'off'];
const XMPLAYLIST = 'https://xmplaylist.com/api/station';
const USER_AGENT = 'node-sonos-http-api (github.com/joshvanpraag/node-sonos-http-api)';
const STATION_LIST_TTL = 24 * 60 * 60 * 1000;
// A channel stops being polled once nobody has asked about it for this long.
const CHANNEL_IDLE = 2 * 60 * 1000;
// A song with a known length stays up this long past its end, to cover clock drift.
const END_GRACE = 30 * 1000;

const SXM_API = 'https://api.edge-gateway.siriusxm.com/';
const SXM_IMAGES = 'https://imgsrv-sxm-prod-device.streaming.siriusxm.com/';
const SXM_ORIGIN = 'https://www.siriusxm.com';
const BROWSER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) '
  + 'Chrome/130.0.0.0 Safari/537.36';
// Refresh tokens this long before they expire.
const TOKEN_MARGIN = 10 * 60 * 1000;
// Re-fetch a channel's song list at least this often, even mid-song.
const SXM_LIST_MAX_AGE = 3 * 60 * 1000;

function channelIdOf(state) {
  const track = state && state.currentTrack;
  if (!track || !track.uri || !/[?&]sid=37(&|$)/.test(track.uri)) return null;
  let uri = track.uri;
  try { uri = decodeURIComponent(uri); } catch (e) { /* keep raw */ }
  const match = uri.match(/channel-linear:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  return match ? match[1].toLowerCase() : null;
}

// True when Sonos itself still carries a real song for this channel.
function sonosHasSong(track) {
  const title = track.title || '';
  if (!title || title.startsWith('x-sonosapi-')) return false;
  if (title === track.stationName) return false;
  // Empty SiriusXM placeholder, e.g. "TYPE=SNG|TITLE |ARTIST |ALBUM"
  if (/TITLE \|ARTIST \|ALBUM$/.test(title)) return false;
  return true;
}

async function getJson(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    signal: AbortSignal.timeout(10000)
  });
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  return res.json();
}

// Public, no-login source: https://xmplaylist.com
function XmPlaylistProvider() {
  let deeplinks = {};
  let stationsFetched = 0;

  this.name = 'xmplaylist';

  this.lookup = async function lookup(channelId) {
    if (!deeplinks[channelId] || Date.now() - stationsFetched > STATION_LIST_TTL) {
      const list = await getJson(XMPLAYLIST);
      deeplinks = {};
      list.results.forEach((station) => { deeplinks[station.id.toLowerCase()] = station.deeplink; });
      stationsFetched = Date.now();
    }
    const deeplink = deeplinks[channelId];
    if (!deeplink) return null;

    const latest = (await getJson(`${XMPLAYLIST}/${deeplink}`)).results[0];
    if (!latest || !latest.track) return null;
    return {
      title: latest.track.title,
      artist: (latest.track.artists || []).join(' & '),
      album: '',
      art: latest.spotify && latest.spotify.albumImageLarge,
      startedAt: Date.parse(latest.timestamp)
    };
  };
}

// SiriusXM's own web-player API (same flow as www.siriusxm.com/player). Needs a subscription login.
// Login: device grant -> anonymous session -> password -> authenticated session. The tokens are
// cached in sessionFile so the half-hourly pm2 restarts don't log in again each time.
function SiriusXmProvider(login, sessionFile) {
  let session = {};
  let clock = 0;
  let loggingIn = null;
  const songLists = {}; // channelId -> { items, fetched }

  try { session = JSON.parse(fs.readFileSync(sessionFile)); } catch (e) { /* first run */ }

  this.name = 'siriusxm';

  function valid(token, expires) {
    return Boolean(session[token]) && session[expires] - Date.now() > TOKEN_MARGIN;
  }

  function save() {
    fs.writeFileSync(sessionFile, JSON.stringify(session), { mode: 0o600 });
  }

  async function request(method, apiPath, payload, bearer) {
    clock += 1;
    const headers = {
      Accept: 'application/json',
      'User-Agent': BROWSER_AGENT,
      Origin: SXM_ORIGIN,
      Referer: `${SXM_ORIGIN}/`,
      'x-sxm-clock': `[0,${clock}]`,
      'x-sxm-platform': 'browser',
      'x-sxm-tenant': 'sxm'
    };
    if (bearer) headers.Authorization = `Bearer ${bearer}`;
    let body;
    if (payload !== undefined) {
      headers['Content-Type'] = 'application/json; charset=UTF-8';
      body = JSON.stringify(payload);
    }
    const res = await fetch(SXM_API + apiPath, { method, headers, body, signal: AbortSignal.timeout(15000) });
    const text = await res.text();
    if (!res.ok) {
      const err = new Error(`${apiPath} returned ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return text ? JSON.parse(text) : {};
  }

  async function logIn() {
    if (!session.deviceGrant) {
      const device = await request('POST', 'device/v1/devices', {
        devicePlatform: 'web-desktop',
        deviceAttributes: {
          browser: {
            browserVersion: '130.0.0.0',
            browser: 'Chrome',
            userAgent: BROWSER_AGENT,
            sdk: 'web',
            app: 'web',
            sdkVersion: '130.0.0.0',
            appVersion: '130.0.0.0'
          }
        }
      });
      if (!device.grant) throw new Error('SiriusXM did not issue a device grant');
      session = { deviceGrant: device.grant };
    }

    if (!(session.identityGrant && valid('anonToken', 'anonExpires'))) {
      const anon = await request('POST', 'session/v1/sessions/anonymous', '', session.deviceGrant);
      session.anonToken = anon.accessToken;
      session.anonExpires = Date.parse(anon.accessTokenExpiresAt) || Date.now() + 3600 * 1000;
      let identity;
      try {
        identity = await request('POST', 'identity/v1/identities/authenticate/password',
          { handle: login.username, password: login.password }, session.anonToken);
      } catch (err) {
        if ([400, 401, 403, 404, 422].includes(err.status)) {
          throw new Error('SiriusXM rejected the username or password in siriusxm-login.json');
        }
        throw err;
      }
      if (!identity.grant) throw new Error('SiriusXM did not accept the login');
      session.identityGrant = identity.grant;
    }

    const authed = await request('POST', 'session/v1/sessions/authenticated', '', session.identityGrant);
    if (!authed.accessToken) throw new Error('SiriusXM did not open an authenticated session');
    session.accessToken = authed.accessToken;
    session.accessExpires = Date.parse(authed.accessTokenExpiresAt) || Date.now() + 3600 * 1000;
    save();
    logger.info('Logged in to SiriusXM');
  }

  async function call(method, apiPath, payload) {
    if (!valid('accessToken', 'accessExpires')) {
      if (!loggingIn) loggingIn = logIn().finally(() => { loggingIn = null; });
      await loggingIn;
    }
    try {
      return await request(method, apiPath, payload, session.accessToken);
    } catch (err) {
      if (err.status !== 401 && err.status !== 403) throw err;
      // Token revoked early: start over, keeping the device registration.
      session = { deviceGrant: session.deviceGrant };
      await logIn();
      return request(method, apiPath, payload, session.accessToken);
    }
  }

  function imageUrl(images) {
    for (const kind of ['tile', 'logo']) {
      for (const aspect of ['aspect_1x1', 'aspect_16x9']) {
        const image = images && images[kind] && images[kind][aspect];
        const key = image && ['preferred', 'preferredImage', 'default', 'defaultImage']
          .map(variant => image[variant] && image[variant].url).find(Boolean);
        if (key) {
          if (/^https?:\/\//.test(key)) return key;
          const edits = { key, edits: [{ format: { type: 'jpeg' } }, { resize: { width: 720, height: 720 } }] };
          return SXM_IMAGES + Buffer.from(JSON.stringify(edits)).toString('base64');
        }
      }
    }
    return null;
  }

  function currentItem(items, now) {
    let current = null;
    items.forEach((item) => {
      const start = Date.parse(item.timestamp || item.startTime);
      if (start <= now && (!current || start >= current.start)) current = { start, item };
    });
    return current;
  }

  this.lookup = async function lookup(channelId) {
    const now = Date.now();
    let list = songLists[channelId];
    let current = list && currentItem(list.items, now);
    const ended = current && current.item.duration && now > current.start + Number(current.item.duration);
    if (!list || ended || now - list.fetched > SXM_LIST_MAX_AGE) {
      const data = await call('POST', 'playback/play/v1/liveUpdate', {
        channelId,
        startTimestamp: new Date(now - 3 * 3600 * 1000).toISOString(),
        endTimestamp: new Date(now + 60 * 1000).toISOString()
      });
      list = { items: data.items || [], fetched: now };
      songLists[channelId] = list;
      current = currentItem(list.items, now);
    }
    if (!current) return null;
    const { item, start } = current;
    // DJ talk, ads and promos: show the channel instead.
    if (item.isInterstitial || !item.name) return null;
    return {
      title: item.name,
      artist: item.artistName || '',
      album: item.albumName || '',
      art: imageUrl(item.images) || imageUrl(item.artistImages),
      startedAt: start,
      endsAt: item.duration ? start + Number(item.duration) : undefined
    };
  };
}

function loadLogin(file) {
  try {
    const login = JSON.parse(fs.readFileSync(file));
    if (login.username && login.password) return login;
    logger.warn(`${file} needs both "username" and "password"; SiriusXM fallback disabled`);
  } catch (e) {
    if (e.code !== 'ENOENT') logger.warn(`Could not read ${file}; SiriusXM fallback disabled:`, e.message);
  }
  return null;
}

function SiriusNowPlaying(settings, onSongChange) {
  const options = Object.assign({
    mode: 'auto',
    pollSeconds: 15,
    // xmplaylist has no song length, so a song older than this is treated as over
    // (DJ talk, ads) and the display falls back to the channel name and logo.
    maxSongMinutes: 10,
    loginFile: path.resolve(__dirname, '../../siriusxm-login.json')
  }, settings.siriusNowPlaying);
  const modeFile = path.join(settings.cacheDir, 'sirius-now-playing-mode.json');
  const providers = [new XmPlaylistProvider()];
  const login = loadLogin(options.loginFile);
  if (login) providers.push(new SiriusXmProvider(login, path.join(settings.cacheDir, 'siriusxm-session.json')));
  const channels = {}; // channelId -> { song, source, lastAsked, errors }
  let timer = null;

  let mode = options.mode;
  try {
    mode = JSON.parse(fs.readFileSync(modeFile)).mode || mode;
  } catch (e) { /* no runtime override saved */ }
  if (!MODES.includes(mode)) mode = 'auto';

  function isCurrent(song) {
    if (!song) return false;
    if (song.endsAt) return Date.now() <= song.endsAt + END_GRACE;
    return Date.now() - song.startedAt <= options.maxSongMinutes * 60 * 1000;
  }

  async function poll(channelId) {
    const channel = channels[channelId];
    const errors = {};
    let found = null;
    let source = null;
    for (const provider of providers) {
      try {
        const song = await provider.lookup(channelId);
        if (isCurrent(song)) {
          found = song;
          source = provider.name;
          break;
        }
      } catch (err) {
        errors[provider.name] = err.message;
        logger.warn(`SiriusXM lookup via ${provider.name} failed:`, err.message);
      }
    }
    const previous = channel.song;
    channel.song = found;
    channel.source = source;
    channel.errors = errors;
    const changed = found
      ? !previous || previous.title !== found.title || previous.artist !== found.artist
      : Boolean(previous);
    if (changed) {
      logger.info(`SiriusXM ${channelId}: ${found ? `${found.artist} - ${found.title} (${source})` : 'no current song'}`);
      onSongChange(channelId);
    }
  }

  function pollAll() {
    Object.keys(channels).forEach((channelId) => {
      if (Date.now() - channels[channelId].lastAsked > CHANNEL_IDLE) {
        delete channels[channelId];
      } else {
        poll(channelId);
      }
    });
    if (Object.keys(channels).length === 0) {
      clearInterval(timer);
      timer = null;
    }
  }

  function watch(channelId) {
    if (!channels[channelId]) {
      channels[channelId] = { song: null, source: null, lastAsked: Date.now(), errors: {} };
      poll(channelId);
    }
    channels[channelId].lastAsked = Date.now();
    if (!timer) timer = setInterval(pollAll, options.pollSeconds * 1000);
  }

  this.channelIdOf = channelIdOf;

  // Returns the state with the looked-up song filled in, or the original state unchanged.
  this.enrich = function enrich(state) {
    const channelId = channelIdOf(state);
    if (!channelId || mode === 'off') return state;
    if (mode === 'auto' && sonosHasSong(state.currentTrack)) return state;
    if (state.playbackState !== 'PLAYING') return state;

    watch(channelId);
    const { song, source } = channels[channelId];
    if (!isCurrent(song)) return state;

    const currentTrack = Object.assign({}, state.currentTrack, {
      title: song.title,
      artist: song.artist,
      album: song.album,
      siriusNowPlaying: { source, startedAt: new Date(song.startedAt).toISOString() }
    });
    if (song.art) {
      currentTrack.albumArtUri = song.art;
      currentTrack.absoluteAlbumArtUri = song.art;
    }
    return Object.assign({}, state, { currentTrack });
  };

  this.setMode = function setMode(newMode) {
    if (!MODES.includes(newMode)) throw new Error(`mode must be one of: ${MODES.join(', ')}`);
    mode = newMode;
    fs.writeFileSync(modeFile, JSON.stringify({ mode }));
    logger.info(`SiriusXM now-playing lookup mode set to ${mode}`);
  };

  this.status = function status() {
    return { mode, providers: providers.map(p => p.name), channels };
  };
}

module.exports = SiriusNowPlaying;
module.exports.SiriusXmProvider = SiriusXmProvider;
