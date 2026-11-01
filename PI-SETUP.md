# Our Sonos display Pi

This fork runs on the kitchen album-art display Pi (`sonos-display.local`, port 5005),
alongside [joshvanpraag/music-screen-api](https://github.com/joshvanpraag/music-screen-api).

**Full rebuild guide and setup script:**
[music-screen-api/pi-setup](https://github.com/joshvanpraag/music-screen-api/tree/master/pi-setup)

Don't hand-write `settings.json` (gitignored). The setup script generates it:

```json
{
  "webhook": "http://localhost:8080/",
  "household": "Sonos_Azfow5K3VwydSf8ywhWNZSsDFM"
}
```

`household` is required. Without it, discovery can lock onto the Sonos Roam SL (a separate
S2 system on the same Wi-Fi), and Kitchen disappears. Use the short ID from SSDP
(`pi-setup/find-household.js`), not the longer `HouseholdControlID` from `:1400/status/zp`.

## SiriusXM song data (fork-only feature)

SiriusXM stopped sending song data to Sonos in late 2026. `lib/helpers/sirius-now-playing.js`
looks the song up (xmplaylist.com first, then SiriusXM's own API) and fills it into `/state` and
the webhook. `GET /sxmnowplaying` shows its status, and `/sxmnowplaying/auto|on|off` switches it.
The optional SiriusXM login lives in `siriusxm-login.json` here (gitignored, never commit it).

How it works, switching back, and troubleshooting:
[music-screen-api/pi-setup/README.md#siriusxm-song-data](https://github.com/joshvanpraag/music-screen-api/blob/master/pi-setup/README.md#siriusxm-song-data)
