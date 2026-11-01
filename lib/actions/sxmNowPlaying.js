'use strict';

// GET /sxmnowplaying              -> current mode and what each SiriusXM channel is playing
// GET /sxmnowplaying/auto|on|off  -> change the mode (survives restarts)
function sxmNowPlaying(api, values) {
  if (values[0]) api.siriusNowPlaying.setMode(values[0].toLowerCase());
  return Promise.resolve(api.siriusNowPlaying.status());
}

module.exports = function (api) {
  api.registerAction('sxmnowplaying', (player, values) => sxmNowPlaying(api, values));
};
