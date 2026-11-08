# Third-party notices

This plugin is licensed under AGPL-3.0-only. The complete license is in `LICENSE`.

The NetEase API protocol and data mappings are adapted from:

- Repository: https://github.com/sogud/mygo-cloudmusic
- Original project: https://github.com/egoist/mygo-cloudmusic
- Upstream author: egoist and contributors; preserved fork: sogud.
- Reference commit: `b13f52a2a2ff0746502b85b9c4c7fa1e86a1c385`.
- Files consulted: `internal/netease/eapi.go`, `auth.go`, `netease.go`, `catalog.go`, `podcast.go`, `subscriptions.go`.
- Upstream license: GNU Affero General Public License version 3.

Modifications made on 2026-11-06: ported Go requests to MyGo Music's JavaScript
plugin API; replaced the HTTP cookie jar and keychain integration with explicit
cookie handling and the host's private storage; added host data conversion,
quality mapping, bounded playlist loading, session invalidation, domain
validation, and tests. No Go code or upstream binaries are included in the plugin.

Host API reference: https://github.com/egoist/mygo-music at
`9c7f629ef202d66ee064ee9128c34b169b5e7215` (MyGo Music 0.1.6), especially its
README, `examples/demo-plugin`, `internal/music/music.go`, and `internal/plugin`.
The host itself is licensed under AGPL-3.0 and is distributed separately.

NetEase Cloud Music names and content belong to their respective owners. This
project is not an official NetEase or MyGo Music release. The license covers
this plugin's source, not music content or service access rights.

Recommendation endpoint shapes and FM modes were also checked against
AkinoKaede/mygo-music-netease-cloud-music, commit
`c988df7f4d787c1a133ba66e1f4f9dd71a2650cf` (`index.js`, AGPL-3.0),
and the public playlist metadata returned by NetEase for private radar.

Modifications made on 2026-11-07: added read-only comment pages, subscribed
podcasts and episode browsing, and kept program identity separate from its
audio ID for playback and comments; retained server cookie updates on
transient playback refusals for the existing bounded retry.

Playlist track editing is adapted from jieye666's contribution in
https://github.com/sogud/mygo-music-netease/pull/6, commit
`29c6cffd6990d527a3d9e46757824dc0f6903881` (AGPL-3.0-only), with
current-session checks, podcast ID rejection, and conservative duplicate retry.

The unexposed heart-mode candidate is adapted from `HeartMode` in
`internal/netease/radio.go` at the same preserved upstream commit. Its request
uses NetEase's intelligence endpoint; live continuation and account validation
remain pending, so the candidate is not listed in the plugin's navigation.


Stage-one standalone edition, 2026-11-08:

- Direct JavaScript baseline: https://github.com/sogud/mygo-music-netease
  commit `16e4f47b26f157eeb7c0796403a74c1c9f3b8ab9`, `index.js`
  Git blob `87e5ee9e4f996ad07fb94084187dc2a97ee4c689`.
  The installed 0.1.6 plugin's index.js matches this blob exactly.
- Host protocol and sign-in cancellation behavior checked against
  https://github.com/egoist/mygo-music commit
  `1af0d8efd77fdf630c27cfc635f12e9cb089ce10` (0.1.22), README,
  internal/plugin/{host,plugin,source}.go and internal/app/ui_account.go.
- Local starting point: this project's read-only validation-plugin 0.0.1.
- Changes: independent netease-all identity, QR lifecycle and stale-result
  protection, explicit cancellation page and setting, complete playlist-ID
  loading up to a disclosed safety limit, bounded detail concurrency,
  pagination progress detection, fixed liked playlist metadata, serialized
  cloud writes with read-back verification, refreshed likes, sync/status pages,
  safe stream diagnostics, mock tests and reproducible packaging.
- Removed the unexposed heart-mode candidate from this edition. The published
  three radio modes remain. No host code or binaries are shipped here.

The original historical notes above describe upstream adaptations. References
there to private storage mean host plugin storage, not a keychain guarantee.
The complete corresponding runtime source is the unminified index.js in this
package. Development tests and packaging scripts are in the project workspace.
