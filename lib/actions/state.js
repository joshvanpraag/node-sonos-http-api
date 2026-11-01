'use strict';

module.exports = function (api) {
  api.registerAction('state', player => Promise.resolve(api.siriusNowPlaying.enrich(player.state)));
}
