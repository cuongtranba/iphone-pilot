# Probe results

Live runs of `bun run probe -- --mode <ocr|iph>` on a real iPhone. Each row is the latest run of that case.
Cases marked manual in `scripts/probe.ts` (quitting iPhone Mirroring, a locked phone) run only with `--only`.

Environment: MacBook Pro (Apple silicon), macOS 26.5.1, a 1x external display (the mirror window is
326x720 points, the phone screen inside it 310x674). iPhone 16 Pro (iPhone17,1) over USB, Vietnamese
Telex hardware-keyboard layout. The probes use only Settings and the Home Screen.

What the OCR runs taught (and what the code now does about it):

- The mirror ignores a click that arrives right after the pointer enters it, so the helper warps the
  pointer, posts a move and waits 200 ms before clicking.
- On the Home Screen only the icon takes a tap, not its name. Labels sitting under an icon-sized
  square become `app_icon` elements whose frame is the icon.
- Synthetic mouse drags do nothing in the mirror; wheel events scroll and page, so `swipe` uses them.
- Key events reach the phone through its hardware-keyboard layout (Telex turned "wifi" into "ưifi"),
  so all text is pasted. The clipboard is restored 8 s later: restoring it at once made the next paste
  insert the old contents.

<!-- probe:ocr:start -->
## ocr mode

| case | result | ms | detail | run (UTC) |
|---|---|---|---|---|
| doctor reports ready | PASS | 2967 | helper built: ok; accessibility permission: ok; screen recording permission: ok; iPhone Mirroring window: ok; window visible: ok; phone connected: ok | 2026-11-27 06:55 |
| snapshot of the Home Screen (size vs a PNG screenshot) | PASS | 2039 | 37 elements, 427 ms, 4036 B JSON vs 740837 B PNG (184x smaller) | 2026-11-27 06:55 |
| tap an app by its name (Settings) opens it | PASS | 3940 | {"ok":true,"outcome":"done","screen_changed":true,"front_restored":"Phone"} | 2026-11-27 06:55 |
| scroll down then up | PASS | 8876 | down {"ok":true,"outcome":"done","front_restored":"Phone"} moved=true; up {"ok":true,"outcome":"done","front_restored":"Phone"} moved=true | 2026-11-27 06:55 |
| tap Settings search, type ASCII + Vietnamese, submit | PASS | 17063 | tap {"ok":true,"outcome":"done","screen_changed":true,"front_restored":"Finder"}; "wifi" {"ok":true,"outcome":"done","front_restored":"Finder"}; " Tiếng Việt"+submit {"ok":true,"outcome":"done","front_restored":"Finder"}; on screen: true (No Results for "wifi Tiếng Việt" / Q wifi Tiếng Việt) | 2026-11-27 06:56 |
| key escape and return (on the Home Screen, where they change nothing) | PASS | 2715 | escape {"ok":true,"outcome":"done","front_restored":"Phone"}; return {"ok":true,"outcome":"done","front_restored":"Phone"} | 2026-11-27 06:55 |
| home | PASS | 1035 | {"ok":true,"outcome":"done","front_restored":"Phone"} | 2026-11-27 06:55 |
| tap a stale ref is refused (not_sent), nothing sent | PASS | 8318 | e20=General after going home: {"ok":false,"outcome":"not_sent","code":"stale_ref"} | 2026-11-27 06:55 |
| tap missing text is refused (not_sent) | PASS | 467 | {"ok":false,"outcome":"not_sent","code":"not_found"} | 2026-11-27 06:55 |
| screenshot fallback | PASS | 95 | {"ok":true,"outcome":"done"} 733124 B | 2026-11-27 06:55 |
| swipe left and right (Home Screen pages) | PASS | 5351 | left {"ok":true,"outcome":"done","front_restored":"Phone"} moved=true; right {"ok":true,"outcome":"done","front_restored":"Phone"} back=true | 2026-11-27 06:55 |
| mirror covered by the front app: input lands only in the mirror, front app restored | PASS | 5072 | front before=Finder after=Finder; {"ok":true,"outcome":"done","screen_changed":true,"front_restored":"Finder"} | 2026-11-27 06:55 |
| mirror under an always-on-top window: refused (not_sent), front app restored | PASS | 3626 | front before=Finder after=Finder; {"ok":false,"outcome":"not_sent","code":"mirror_covered","front_restored":"Finder"} | 2026-11-27 06:55 |
| mirror window minimized: refused with a clear message | PASS | 6900 | {"ok":false,"outcome":"not_sent","code":"mirror_hidden"} "un-minimize the iPhone Mirroring window"; doctor: minimized -> un-minimize the iPhone Mirroring window | 2026-11-27 06:55 |
| phone unlocked (mirror session ended): refused, doctor says how to reconnect | PASS | 376 | {"ok":false,"outcome":"not_sent","code":"mirror_disconnected"}; read refused: mirror_disconnected; doctor: iPhone in Use iPhone Mirroring ended due to iPhone use.  Lock your iPhone to connect. [Connect] -> lock the iPhone, then click Connect in the iPhone Mirroring window | 2026-11-27 06:26 |
| iPhone Mirroring not running: refused, doctor says how to fix | PASS | 2866 | {"ok":false,"outcome":"not_sent","code":"mirror_not_running"}; read refused: mirror_not_running; doctor: app not running -> open the iPhone Mirroring app on this Mac and connect your iPhone | 2026-11-27 05:46 |
<!-- probe:ocr:end -->

<!-- probe:iph:start -->
## iph mode

| case | result | ms | detail | run (UTC) |
|---|---|---|---|---|
| doctor reports ready | PASS | 7172 | pairing: ok; connection: ok; developer_mode: ok; developer_disk_image: ok; wifi: ok; screen_unlocked: ok; accessibility_tree: ok; touch_input: ok; auto_lock: ok | 2026-11-27 06:50 |
| snapshot of the Home Screen (size vs a PNG screenshot) | PASS | 7066 | 23 elements, 1452 ms, 2756 B JSON vs 5121771 B PNG (1858x smaller) | 2026-11-27 06:49 |
| tap an app by its name (Settings) opens it | PASS | 8858 | {"ok":true,"outcome":"done","screen_changed":true} | 2026-11-27 06:49 |
| scroll down then up | PASS | 26226 | down {"ok":true,"outcome":"done","screen_changed":true} moved=true; up {"ok":true,"outcome":"done","screen_changed":true} moved=true | 2026-11-27 06:49 |
| tap Settings search, type ASCII + Vietnamese, submit | PASS | 30861 | tap {"ok":true,"outcome":"done","screen_changed":true}; "wifi" {"ok":true,"outcome":"done","screen_changed":true}; " Tiếng Việt"+submit {"ok":true,"outcome":"done","screen_changed":true}; on screen: true | 2026-11-27 06:49 |
| key escape and return (on the Home Screen, where they change nothing) | PASS | 9415 | escape {"ok":true,"outcome":"done","screen_changed":false}; return {"ok":true,"outcome":"done","screen_changed":false} | 2026-11-27 06:49 |
| home | PASS | 3697 | {"ok":true,"outcome":"done","screen_changed":false} | 2026-11-27 06:49 |
| tap a stale ref is refused (not_sent), nothing sent | PASS | 16555 | e11=General after going home: {"ok":false,"outcome":"not_sent","code":"stale_ref"} | 2026-11-27 06:50 |
| tap missing text is refused (not_sent) | PASS | 1538 | {"ok":false,"outcome":"not_sent","code":"not_found"} | 2026-11-27 06:49 |
| screenshot fallback | PASS | 1184 | {"ok":true,"outcome":"done"} 5123664 B | 2026-11-27 06:49 |
| swipe left and right (Home Screen pages) | PASS | 14818 | left {"ok":true,"outcome":"done","screen_changed":true} moved=true; right {"ok":true,"outcome":"done","screen_changed":true} back=true | 2026-11-27 06:49 |
| iph absent from PATH: not_sent iph_missing with install action | PASS | 0 | {"ok":false,"outcome":"not_sent","code":"iph_missing"} "install iph: curl -fsSL https://raw.githubusercontent.com/HyunSeob/iphone-cli/main/install.sh \| sh, then run: iph setup (USB Trust, Developer Mode, developer disk image; check with: iph doctor)" | 2026-11-27 06:49 |
| phone locked: snapshot is the Lock Screen, app taps refused, doctor says unlock | PASS | 5105 | snapshot: Fri 27 Nov / 13:53 / GMAIL / Flashlight / Camera / Show Notifications; tap Settings {"ok":false,"outcome":"not_sent","code":"not_found"}; doctor screen_unlocked: fail: the phone reports that it is locked -> Unlock the phone. | 2026-11-27 06:53 |
<!-- probe:iph:end -->
