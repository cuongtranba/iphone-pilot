---
name: drive-iphone
description: How to operate a real iPhone through the iphone-pilot tools (doctor, snapshot, find, tap, type, key, swipe, scroll, home, screenshot) safely and without wasted calls. Use it whenever a task means doing something on the user's phone, such as opening or installing an app, playtesting an app, changing a setting, reading what is on screen, filling a field, or navigating iOS. Prefer it over screenshot-and-click desktop automation of the iPhone Mirroring window. Also use it when an iphone-pilot tool returned not_sent, unknown, stale_ref, not_found, ambiguous, mirror_* or a Lock Screen and you need to know what to do next.
---

# Driving an iPhone with iphone-pilot

These tools act on a real phone that belongs to the user. It holds their messages, accounts and
payment methods, and you only see it through text. Every tap can send, buy or change something
for real. The tools exist because screenshot-and-guess control was slow, costly (an image per
step, 0.7 to 5 MB, against about 3 KB of JSON) and sent clicks into the wrong window. So the job
is: **read the screen as text, act once, read again**, and stop as soon as the screen does not
match what you expected.

## Start: one `doctor`, before anything else

`doctor` reports both modes: `ocr` (text read from the iPhone Mirroring window) and `iph` (the
iOS accessibility tree over USB). Each failed check comes with a `user_action`, which is the
exact fix.

- If the mode you need is not ready, give the user its failed checks' `user_action` lines word for
  word and stop. Do not work around a missing permission or setting.
- Run it **at the start**, before the task. It is slower than a snapshot. In iph mode it opens
  Settings to test the phone and then reopens the app that was in front, so it leaves the phone
  where it was. Mid-task, work out the problem from the error code and a `snapshot` first.
- The two modes normally exclude each other. ocr needs the phone **locked** with Mirroring
  connected. iph needs it **unlocked** on USB, and unlocking the phone ends Mirroring. So usually
  only one mode is ready, and that is expected.
- With `--mode auto`, the mode is re-chosen on every command: ocr while Mirroring shows the phone,
  otherwise iph if a phone is ready on USB. It can therefore change mid-task when the phone is locked
  or unlocked. The `mode` field of each `snapshot` or `find` tells you which mode you are in, and
  doctor's `mode` is the same pick.

## The loop

1. **`snapshot`** to see the screen: `{mode, screen:{w,h}, elements:[{ref, role, label, value?,
   frame, source}]}`. Use `find {text}` instead when you only need one element. It is cheaper and
   returns only the matches.
2. **One action**, then judge it by `outcome` (see below). Do not chain several blind actions,
   because each one changes the screen the next one depends on.
3. **Read again** before deciding the next step. A tap returns `screen_changed`: `false` means it
   probably hit nothing, and `true` means something changed, which is not proof it was the right
   thing. If a read looks half-changed (a title moved but the content did not), the screen was
   mid-animation, so read once more.

Apps reopen where they were left: deep in a page, in search mode, or with a sheet open. After you
open an app, read the screen before you assume where you are. `home` is the reliable way back to a
known state.

## Refs: always from your latest read

Every `snapshot`, `find` and text `tap` (which reads the screen first) is a new read. In each read,
an element that is still there, with the same label and role in the same place, keeps its ref. Every
other element gets a new number, and numbers are never reused. So a ref from an earlier read either
still means the same element or is refused as `stale_ref`. It never silently taps something else.
Refs are not always `e1..eN` in order.

- Prefer the ref from the read you just made. If you get `stale_ref`, the element moved, changed or
  disappeared, or the mode changed since that read. Read again and use the new ref.
- The refs in an `ambiguous` result's `candidates` come from the read that tap just made, so they
  are current.

## Choosing how to tap

1. **`tap {text}`** taps only if there is exactly one match. A case-insensitive *exact* label wins.
   Otherwise any label or value that *contains* the text matches. So write the label exactly as
   the snapshot shows it (ocr may read a search field as `Q Search`). A short word like "Search" or
   "Get" also matches longer texts that contain it. No match gives `not_found`, and several give
   `ambiguous`. Nothing is sent in either case.
2. **`tap {ref}`** resolves `ambiguous`: pick the candidate whose role, value or frame fits (a
   `switch` rather than a `heading`, the field rather than the sentence) and tap its ref.
3. **`tap {x, y}`** only for controls with no text (icon-only buttons in ocr mode). Points are in
   the snapshot's `screen` coordinates. Derive them from nearby element frames (a frame's centre
   is `x + w/2, y + h/2`). Use `screenshot` only to see where the control sits relative to those
   frames, never as a pixel ruler ([references/modes.md](references/modes.md)). A point tap is sent
   even if the screen changed underneath it, so read right before it.

A `text` value shaped like a ref (`e12`) is read as a ref.

## Reading outcomes decides whether you may retry

Every action returns `{ok, outcome, screen_changed?, error?: {code, message, hint?, user_action?,
candidates?}}`. Decide by `outcome` first, then use `code` and `hint` to choose the fix:

| `outcome` | What it means | What you do |
|---|---|---|
| `done` | The action ran to the end | Read the screen and carry on |
| `not_sent` | Nothing reached the phone | Fix the cause, then a retry is safe |
| `unknown` | Input **may** have reached the phone | **Never resend.** Read the screen and find out what happened |

Resending after `unknown` is how a message gets sent twice or a switch gets flipped back. If the
screen does not settle the question, ask the user. A result marked `isError` is a usage mistake,
such as `tap` with no `ref`, `text` or `x,y`.

Every error code and its fix: [references/errors.md](references/errors.md).

## Typing and keys

- **Focus first, and only on a `done`.** `type {text, submit?}` goes into whatever field has focus.
  If the tap on the field came back `not_sent` (for example, `ambiguous`), the text goes nowhere,
  or into a field you did not mean. `submit: true` presses Return afterwards, which *sends* in
  chat apps.
- In ocr mode the text is pasted and then looked for on screen. `type_not_verified` (`unknown`)
  means: read the field before anything else, and only type again if it is clearly empty.
- **`key {name}`** accepts only `return, escape, tab, delete, up, down, left, right, space`, and
  they go to whatever has focus. `escape` does not go back in iOS apps. In search fields it clears
  and unfocuses but leaves search mode. To go back, tap the back button (in iph it is labelled with
  the previous page's title), tap Cancel or ✕, or use `home`.
- **Never type passwords, passcodes or verification codes**, even if the user offers them. Ask
  the user to enter those on the phone.

## Moving around

- **`scroll {direction: up|down}`** reveals more of a list. If an element is `not_found` and may be
  below the fold, scroll and look again. Give up after a few pages rather than scrolling forever.
- **`swipe`** turns Home Screen pages and moves carousels. In ocr mode it is a wheel scroll of about
  100 points per step, so edge gestures (swipe-back, Control Center) are impossible.
- To recognise the Home Screen, look for several app icons, not one label. "Settings" is also the
  title inside the Settings app.

## A locked phone

In iph mode an auto-locked phone shows up as a snapshot of the **Lock Screen**: date, time,
notifications, Flashlight and Camera. **Stop there and ask the user to unlock it**, and suggest
Auto-Lock: Never for the session (doctor's iph checks include `auto_lock`). Text and ref taps fail
safely on the Lock Screen, but `tap x,y`, `swipe`, `scroll`, `key` and `home` are *sent*. They wake
the phone, can trigger Face ID, or press Flashlight, Camera or a notification. `auto` picks iph for a
locked phone on USB unless Mirroring is connected, so being in iph mode does not mean the phone is
unlocked.

In ocr mode it is the other way round: unlocking ends Mirroring. With `--mode ocr`, input is then
refused with `mirror_disconnected`, and the user locks the phone and clicks **Connect** in the
Mirroring window. With `--mode auto`, the next command moves to iph if the phone is on USB, so check
the `mode` of your next read.

## Ask before anything you cannot take back

iphone-pilot sends whatever you tell it to and has no confirmation step of its own, so you are the
only check. Confirm the exact action with the user first, unless they asked for exactly that thing
in this conversation:

- sending, posting or calling;
- buying, subscribing, starting a trial, or tapping **Get** or **Install**;
- creating an account or signing in, which includes choosing an Apple ID or email to share;
- deleting, signing out or resetting;
- changing security, privacy or account settings.

Reading, navigating and opening apps need no confirmation.

- **Installing an app:** match the exact name *and* developer before you tap Get. Lookalikes are
  common: a search for "Chai" returned "Chai — Night Letters" and Character AI, but not the app
  that was wanted. If the right app is not in the results, it may not be sold in the user's App
  Store region. Stop and report what you found. Do not install the closest match.
- **Something unexpected on screen:** a permission prompt, payment sheet, sign-in sheet, "Delete?"
  alert, or notification banner over your target. Do not tap through it to get back on track.
  Describe it and ask.

## Privacy

The screen shows the user's notifications, messages and accounts. Repeat only what the task needs.
For example, if a notification is in the way, say so without reading it out. Screenshots capture
everything on screen. Leave them at the default temporary path. Never save them into a project or
share them, and offer to delete any you saved on purpose.

## Reporting back

Say what you did and what the phone shows now, based on your last read rather than on what you
expected. If you stopped, say why and name the exact thing the user needs to do, quoting the
`user_action` when there is one. For long sessions (playtests, multi-app tasks), keep notes as you
go and report progress at natural checkpoints. Do not save everything for the end.
