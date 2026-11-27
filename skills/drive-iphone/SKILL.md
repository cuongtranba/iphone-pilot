---
name: drive-iphone
description: How to operate a real iPhone through the iphone-pilot tools (doctor, snapshot, find, tap, type, key, swipe, scroll, home, screenshot) safely and without wasted calls. Use it whenever a task means doing something on the user's phone, such as opening an app, changing a setting, reading what is on screen, filling a field, or navigating iOS, and also when an iphone-pilot tool returned not_sent, unknown, stale_ref, ambiguous, mirror_* or a Lock Screen and you need to know what to do next.
---

# Driving an iPhone with iphone-pilot

The tools act on a real phone in someone's hand or on their desk, not a simulator. Every tap can
send a message, buy something or change a setting, and you only see the phone through text. So
the job is: **read the screen, act once, read again**, and stop as soon as reality does not match
what you expected.

## The loop

1. **`doctor` once at the start.** It reports both modes (`ocr` over iPhone Mirroring, `iph` over
   the iOS accessibility tree). For each failed check it gives a `user_action` (an exact fix).
   If neither mode is ready, pass that `user_action` to the user word for word and stop. Do not
   try to work around a missing permission.
2. **`snapshot`** to see the screen. You get `{mode, screen:{w,h}, elements:[{ref, role, label,
   value?, frame, source}]}`. Note `mode`: the server fixed it on its first command and keeps it
   for the whole session.
3. **Act with one tool call**, then judge the result by `outcome` (see below). Do not chain several
   blind actions. Each one changes the screen the next one depends on.
4. **Check that you got where you meant to go.** A tap returns `screen_changed`. `true` means
   something moved, not that it was the right thing. Take a new `snapshot` before you decide the
   next step.

`find {text}` is a cheaper snapshot when you only need one element. It returns the matching
elements and also replaces the stored refs.

## Choosing how to tap

Prefer, in this order:

1. **`tap {text: "Wi-Fi"}`**. It reads the screen first and taps only if there is exactly one
   match. No match gives `not_found` and several give `ambiguous` with `candidates`. Nothing is
   sent in either case.
2. **`tap {ref: "e7"}`** from the *latest* snapshot or find. This is the way to resolve an
   `ambiguous` result: pick the candidate whose frame or role fits and tap its ref.
3. **`tap {x, y}`** only when the control has no text (an icon-only button in ocr mode). Points are
   in the snapshot's `screen` coordinates. Derive them from element frames (a frame's centre is
   `x + w/2, y + h/2`), and use a `screenshot` only to see where the control sits relative to those
   frames (see [references/modes.md](references/modes.md)). A point tap is sent even if the screen
   changed underneath it, so snapshot right before it.

Refs live only until the next `snapshot`, `find` or text tap, because each of those replaces
them. A ref from two reads ago is gone and is refused as `stale_ref`. A `text` value shaped like a
ref (`e12`) is read as a ref, so to tap a label that really is "e12", find it and tap its ref.

## Reading outcomes: this decides whether you may retry

Every action returns `{ok, outcome, screen_changed?, error?: {code, message, hint?, user_action?,
candidates?}}`. Decide by `outcome` first and use `code` only to choose the fix:

| `outcome` | What it means | What you do |
|---|---|---|
| `done` | The action ran to the end | Snapshot and carry on |
| `not_sent` | Nothing reached the phone | Fix the cause (by `code`), then retrying is safe |
| `unknown` | Input **may** have reached the phone | **Never resend.** Snapshot and find out what actually happened |

Resending after `unknown` is how a message gets sent twice or a toggle ends up flipped back. After
`unknown`, read the screen and decide from what you see. If you cannot tell, ask the user.

A tool result marked `isError` is a usage mistake (for example `tap` with no `ref`, `text` or
`x,y`). Fix the arguments.

The full list of error codes, with the fix for each, is in
[references/errors.md](references/errors.md). Read it when you get a code that is not covered here.

## Typing, keys and moving around

- **`type {text, submit?}`** types into the *focused* field, so tap the field first. `submit: true`
  presses Return afterwards. In ocr mode, text is pasted and then looked for on screen. If it
  cannot be confirmed you get `type_not_verified` with `unknown`: snapshot and look at the field
  before you do anything else. Never retype on top of it.
- **`key {name}`** accepts only `return, escape, tab, delete, up, down, left, right, space`.
  `escape` does **not** go back in iOS apps. To go back, tap the back button (in iph its label is
  the previous page's title) or use `home`.
- **`scroll {direction: up|down}`** reveals more of a list. If a `not_found` element might be off
  screen, scroll and look again, but give up after a few pages rather than scrolling forever.
- **`swipe`** turns Home Screen pages and moves carousels. In ocr mode it is a wheel scroll (about
  100 points per step), so edge gestures such as swipe-back do not work.
- **`home`** goes to the Home Screen. It is the reliable way to get to a known state when you are lost.
- **`screenshot {path?}`** saves a PNG and returns its path. Use it when text is not enough (an
  icon-only screen, an image, a layout question). Read the image, then go back to text-based taps.

## The two modes differ in what they can see

| | ocr (iPhone Mirroring) | iph (accessibility tree) |
|---|---|---|
| Sees | Only written text. Icon-only controls are invisible | Labelled controls, including icons |
| Home Screen | App names come back as `app_icon` with the icon's frame | Normal elements |
| Speed | Snapshot takes about 0.5 s | Snapshot takes about 1.5 s |
| Needs | The Mirroring window visible and uncovered | The phone **unlocked**, USB trust, Developer Mode |

Details and recovery per mode: [references/modes.md](references/modes.md).

## A locked phone

In iph mode, a phone that auto-locked shows up as a snapshot of the **Lock Screen** (date, time,
notifications, Flashlight, Camera) instead of the app. When you see that, **stop and ask the user
to unlock the phone** (and suggest Auto-Lock: Never for the session). Text and ref taps fail
safely there, but `tap x,y`, `swipe`, `scroll`, `key` and `home` are *sent* and can wake the phone,
trigger Face ID or press a Lock Screen control.

In ocr mode the opposite happens: unlocking the phone in someone's hand ends Mirroring, and input
is refused with `mirror_disconnected`. The fix is for the user to lock the phone and click
**Connect** in the Mirroring window.

## Ask before anything you cannot take back

iphone-pilot itself does not ask for confirmation. It sends what you tell it to. You are the only
check, so before an action with real-world effect, confirm the exact action with the user unless
they already asked for that specific thing in this conversation. That covers sending a message or
email, posting, calling, paying or buying, deleting, signing out, resetting, and changing
security, privacy or account settings. Reading, navigating and opening apps need no confirmation.

When something unexpected is on screen (a permission prompt, a payment sheet, a "Delete?" alert, a
notification banner over your target), do not tap through it to get back on track. Describe it
and ask.

## Reporting back

Tell the user what you did and what the phone shows now, based on the last snapshot rather than
on what you assumed. If you stopped, say why and name the exact thing they need to do (quote the
`user_action` when there is one).
