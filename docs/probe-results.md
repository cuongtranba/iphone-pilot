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
| doctor reports ready | PASS | 51 | helper built: ok; accessibility permission: ok; screen recording permission: ok; iPhone Mirroring window: ok; window visible: ok | 2026-11-27 05:46 |
| snapshot of the Home Screen (size vs a PNG screenshot) | PASS | 1744 | 38 elements, 488 ms, 4047 B JSON vs 228472 B PNG (56x smaller) | 2026-11-27 05:46 |
| tap an app by its name (Settings) opens it | PASS | 3764 | {"ok":true,"outcome":"done","screen_changed":true,"front_restored":"Finder"} | 2026-11-27 05:46 |
| scroll down then up | PASS | 7671 | down {"ok":true,"outcome":"done","front_restored":"Finder"} moved=true; up {"ok":true,"outcome":"done","front_restored":"Finder"} moved=true | 2026-11-27 05:46 |
| tap Settings search, type ASCII + Vietnamese, submit | PASS | 14805 | tap {"ok":true,"outcome":"done","screen_changed":true,"front_restored":"Finder"}; "wifi" {"ok":true,"outcome":"done","front_restored":"Finder"}; " Tiếng Việt"+submit {"ok":true,"outcome":"done","front_restored":"Finder"}; on screen: true | 2026-11-27 05:46 |
| key escape and return (on the Home Screen, where they change nothing) | PASS | 2777 | escape {"ok":true,"outcome":"done","front_restored":"Finder"}; return {"ok":true,"outcome":"done","front_restored":"Finder"} | 2026-11-27 05:46 |
| home | PASS | 1050 | {"ok":true,"outcome":"done","front_restored":"Finder"} | 2026-11-27 05:46 |
| tap a stale ref is refused (not_sent), nothing sent | PASS | 6561 | e12=General after going home: {"ok":false,"outcome":"not_sent","code":"stale_ref"} | 2026-11-27 05:46 |
| tap missing text is refused (not_sent) | PASS | 537 | {"ok":false,"outcome":"not_sent","code":"not_found"} | 2026-11-27 05:46 |
| screenshot fallback | PASS | 164 | {"ok":true,"outcome":"done"} 228766 B | 2026-11-27 05:46 |
| swipe left and right (Home Screen pages) | PASS | 5296 | left {"ok":true,"outcome":"done","front_restored":"Finder"} moved=true; right {"ok":true,"outcome":"done","front_restored":"Finder"} back=true | 2026-11-27 05:46 |
| mirror covered by the front app: input lands only in the mirror, front app restored | PASS | 4960 | front before=Finder after=Finder; {"ok":true,"outcome":"done","screen_changed":true,"front_restored":"Finder"} | 2026-11-27 05:46 |
| mirror under an always-on-top window: refused (not_sent), front app restored | PASS | 3715 | front before=Finder after=Finder; {"ok":false,"outcome":"not_sent","code":"mirror_covered","front_restored":"Finder"} | 2026-11-27 05:46 |
| mirror window minimized: refused with a clear message | PASS | 3138 | {"ok":false,"outcome":"not_sent","code":"mirror_hidden"} "un-minimize the iPhone Mirroring window"; doctor: minimized -> un-minimize the iPhone Mirroring window | 2026-11-27 05:46 |
| phone unlocked (mirror session ended): refused, doctor says how to reconnect | PASS | 376 | {"ok":false,"outcome":"not_sent","code":"mirror_disconnected"}; read refused: mirror_disconnected; doctor: iPhone in Use iPhone Mirroring ended due to iPhone use.  Lock your iPhone to connect. [Connect] -> lock the iPhone, then click Connect in the iPhone Mirroring window | 2026-11-27 06:26 |
| iPhone Mirroring not running: refused, doctor says how to fix | PASS | 2866 | {"ok":false,"outcome":"not_sent","code":"mirror_not_running"}; read refused: mirror_not_running; doctor: app not running -> open the iPhone Mirroring app on this Mac and connect your iPhone | 2026-11-27 05:46 |
<!-- probe:ocr:end -->
