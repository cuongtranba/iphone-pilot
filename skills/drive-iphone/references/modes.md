# The two modes in detail

The server is started with `--mode auto|ocr|iph`. With `auto` it uses iph when the `iph` CLI lists a
ready device and ocr otherwise. It decides on its first command and keeps that mode for the whole
session. To switch modes, the user restarts the server.

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
  `12:281` for a clock). Tap by a distinctive part of the label.
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
- **`iph doctor`'s touch self-test** can fail when Settings sits on a short page. Going back to the
  Settings root and running it again fixes that.
