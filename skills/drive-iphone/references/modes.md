# The two modes in detail

The server is started with `--mode auto|ocr|iph`. With `auto` the mode is chosen on every command:
ocr while iPhone Mirroring shows the phone, otherwise iph when `iph devices` lists a ready (paired,
connected) phone, otherwise ocr. `iph devices` does not report the lock, so a locked phone on USB with
Mirroring not connected still gets iph. Refs from a read in the other mode are refused after a
switch. `--mode ocr` or `--mode iph` fixes the mode.

The two modes exclude each other through the lock state. ocr needs the phone **locked** and near
the Mac with Mirroring connected. iph needs it **unlocked** on USB, and unlocking ends Mirroring
("iPhone in Use"). So `doctor` normally shows one mode ready and the other not, and that is not
something to fix.

## ocr: OCR over iPhone Mirroring (macOS)

- **What it sees:** only text, read with Vision OCR from the Mirroring window. Coordinates are points
  of the phone picture inside the window.
- **Blind spots:** icon-only controls (back chevron, close ✕, toolbar icons) have no element. Use
  `screenshot` to see where the control sits relative to text that *is* in the snapshot. Then take
  `x, y` from those text frames, for example a back chevron at the far left on the same row as the
  page title. Do not convert screenshot pixels directly. The PNG is the whole Mirroring window at
  display scale, including its border, so its pixels do not map 1:1 onto snapshot coordinates.
  iph mode, where these controls are labelled, is the better choice if it is available.
- **Misreads:** small or decorated text can come back slightly wrong (`Q Search` for a search field,
  `12:281` for a clock). Tap by the label exactly as it was read, since an exact match wins over
  partial ones, or by a distinctive part of it.
- **No state:** roles are only `text` and `app_icon`, with no switch values. To check whether a
  toggle is on, look at a `screenshot`, or use iph, which reports `value`.
- **Home Screen:** app names come back as `app_icon` with the icon's frame, because the mirror only
  takes taps on the icon, so `tap {text: "Settings"}` works.
- **Input safety:** before any input, the helper checks that the mirror is frontmost and on top at
  the exact target point, and refuses with `not_sent` otherwise. Afterwards it gives focus back to
  the user's app.
- **Typing:** text is pasted, not keyed, so any language and emoji work. About one paste in ten,
  Universal Clipboard hands over the phone's previous clipboard item. The tool repairs that itself,
  and when it cannot be sure it answers `unknown`. The user's Mac clipboard is restored 8 s later.
- **Gestures:** drags are ignored by the mirror. `swipe` and `scroll` are wheel steps of about 100
  points, so edge gestures (swipe-back, Control Center, Notification Center) are impossible.
- **Locking:** unlocking the phone ends Mirroring (`mirror_disconnected`). The user locks it again
  and clicks Connect.
- **Cutting your own connection:** Mirroring needs Wi-Fi and Bluetooth on the phone. Turning either
  off, or enabling Airplane Mode, can end the session right after the tap that did it. Warn the
  user before you do it, and if the next read fails with `mirror_disconnected`, report that you
  could not confirm the change instead of claiming success.

## iph: iOS accessibility tree over USB (iOS 27 or later)

- **What it sees:** the app's accessibility tree, so icon-only controls are labelled (a back button
  carries the previous page's title). Coordinates are iOS points.
- **Speed:** a snapshot takes about 1.5 s. Use `find` when you only need one element.
- **Needs:** USB trust, Developer Mode, the `iph` CLI, and an unlocked phone.
- **Locked phone:** snapshots show the Lock Screen. Text and ref taps fail safely (`not_found`,
  `stale_ref`), but point taps, swipes, scrolls, keys and `home` are sent and can wake the phone or
  press Lock Screen controls. Stop and ask the user to unlock. For long sessions, suggest
  **Settings → Display & Brightness → Auto-Lock → Never** (and restoring it afterwards).
- **Notification banners** are not in the app's tree but take taps near the top of the screen. For
  unattended runs the user can turn on `iph dnd on` (and `iph dnd off` afterwards).
- **Switches and fields carry `value`** (a switch reads `"1"` or `"0"`, or `On` or `Off`). Check it
  after a toggle instead of trusting `screen_changed`.
- **`doctor` in this mode** runs `iph doctor --no-touch-test`. That briefly brings Settings to the
  front, then reopens the app that was in front (iOS resumes it where it was) or goes to the Home
  Screen. Its `screen restored` check says which. Touch input is not tested, so as not to scroll
  Settings. If taps fail for no visible reason, the user can run `iph doctor` by hand, which does
  test touch. That test can fail when Settings sits on a short page (for example Auto-Lock); going
  back to the Settings root and running it again fixes that. While Mirroring is streaming, iph's
  checks fail because the phone is locked for Mirroring, which is expected.
- **`developer_disk_image` or `screen_unlocked` failing** right after the phone restarted or
  auto-locked usually just means it is locked. Ask the user to unlock it and run `doctor` again.
