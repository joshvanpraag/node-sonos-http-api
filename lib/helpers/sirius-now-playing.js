'use strict';
// Fills in the song for SiriusXM channels when Sonos only reports the channel.
//
// Since late 2026 SiriusXM stopped sending song metadata to Sonos: currentTrack.title is just
// the stream URI ("x-sonosapi-hls:channel-linear:<uuid>?sid=37...") and artist is the channel
// name. We look the song up by channel UUID and patch it into the state that /state and the
// webhook hand out, so every consumer gets it without changes.
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

function SiriusNowPlaying(settings, onSongChange) {
  const options = Object.assign({
    mode: 'auto',
    pollSeconds: 15,
    // xmplaylist has no song length, so a song older than this is treated as over
    // (DJ talk, ads) and the display falls back to the channel name and logo.
    maxSongMinutes: 10
  }, settings.siriusNowPlaying);
  const modeFile = path.join(settings.cacheDir, 'sirius-now-playing-mode.json');
  const providers = [new XmPlaylistProvider()];
  const channels = {}; // channelId -> { song, source, lastAsked, lastError }
  let timer = null;

  let mode = options.mode;
  try {
    mode = JSON.parse(fs.readFileSync(modeFile)).mode || mode;
  } catch (e) { /* no runtime override saved */ }
  if (!MODES.includes(mode)) mode = 'auto';

  async function poll(channelId) {
    const channel = channels[channelId];
    for (const provider of providers) {
      try {
        const song = await provider.lookup(channelId);
        if (!song) continue;
        const previous = channel.song;
        channel.song = song;
        channel.source = provider.name;
        channel.lastError = null;
        if (!previous || previous.title !== song.title || previous.artist !== song.artist) {
          logger.info(`SiriusXM ${channelId}: ${song.artist} - ${song.title} (${provider.name})`);
          onSongChange(channelId);
        }
        return;
      } catch (err) {
        channel.lastError = `${provider.name}: ${err.message}`;
        logger.warn(`SiriusXM lookup via ${provider.name} failed:`, err.message);
      }
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
      channels[channelId] = { song: null, source: null, lastAsked: Date.now(), lastError: null };
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
    if (!song || Date.now() - song.startedAt > options.maxSongMinutes * 60 * 1000) return state;

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
