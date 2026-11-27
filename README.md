# iphone-pilot

Drive a real iPhone from a Mac by **text, not screenshots**.

An agent asks for the screen and gets a few kilobytes of JSON: what is written where, each item
with a ref it can tap. On the Home Screen that is about 4 KB against a 228 KB PNG (56x smaller), and
no guessing of coordinates from a picture.

```console
$ iphone-pilot snapshot
{"mode":"ocr","screen":{"w":310,"h":674},"elements":[
  {"ref":"e15","role":"app_icon","label":"FaceTime","frame":{"x":23.3,"y":223.5,"w":50.6,"h":49.2},"source":"ocr"},
  {"ref":"e33","role":"app_icon","label":"Settings","frame":{"x":164.6,"y":454.2,"w":52.5,"h":52.3},"source":"ocr"},
  …]}
$ iphone-pilot tap Settings
{"ok":true,"outcome":"done","screen_changed":true,"restored_front_app":"Dia"}
```

The same commands and the same element model work in two modes:

| | **ocr** | **iph** |
|---|---|---|
| Reads | Apple Vision text recognition on the macOS **iPhone Mirroring** window | The real iOS accessibility tree through [`iphone-cli`](https://github.com/HyunSeob/iphone-cli) (`iph`) |
| Phone setup | None (iPhone Mirroring set up once) | USB pairing (Trust), Developer Mode, **iOS 27 or later** |
| Sees | Text on screen, app icons on the Home Screen | Every accessible element: buttons, switches, fields, icon-only controls |
| Phone state | **Locked** (Mirroring ends when the phone is unlocked) | **Unlocked** |
| Input | Mouse, wheel and paste into the mirror window | Apple's input service on the phone |

Because Mirroring needs the phone locked and `iph` needs it unlocked, only one mode works at a time.
`--mode auto` (the default) picks one for you; see [How `auto` picks a mode](#how-auto-picks-a-mode).

It ships as a CLI and as an MCP server.

## Which mode to use

**ocr is faster, iph is more accurate.** These timings are from the same iPhone 16 Pro (iOS 27.2.1, USB):

| Speed | ocr | iph |
|---|---|---|
| `snapshot` of the Home Screen | **0.46 s** | 1.3–1.5 s |
| `tap` (MCP, including the check that the screen changed) | **2.0 s** | 3.6 s |
| Settings search: tap the field, type twice, Return | **16 s** | 31 s |

Most of iph's time is the phone itself: after each request it waits about 1.1 s before sending the
screen.

| Accuracy | ocr | iph |
|---|---|---|
| Source | Text recognised in a picture; small or decorated text can be misread (`Q Search`, a clock as `12:281`) | The phone's own accessibility tree; labels are exact |
| Icon-only controls (back, close ✕) | Not seen; use `screenshot` and `tap x,y` | Seen, with labels (a back button carries the previous page's title) |
| State of a switch, value of a field | Not available | `value` (`"1"` / `"0"`, field text) |
| Roles | `text`, `app_icon` | `button`, `switch`, `search_field`, `text_field`, `header`, … |
| Typing | Pasted through Universal Clipboard; about 1 paste in 10 needs a repair (adds ~2 s) | Pasted by `iph` on the phone; it checks the field afterwards |

Use **iph** when the phone can stay unlocked on USB and you need exact controls: icon-only buttons,
switch states, a lot of typing. Use **ocr** when you want speed, cannot set the phone up (no USB, no
Developer Mode, iOS older than 27), or the phone must stay locked; it is good for reading text and
opening apps.

## How `auto` picks a mode

- `auto` uses **iph** when the `iph` command is installed and `iph devices` lists a phone with
  `ready: true`; otherwise it uses **ocr**.
- `ready` in `iph devices` means paired and reachable over USB or Wi-Fi. It **does not check whether
  the phone is locked**, and `auto` does not look at the mirror. So a phone that auto-locked while
  plugged in still gets iph, even when iPhone Mirroring has reconnected and ocr would work.
- The **CLI** decides on every command. The **MCP server** decides on its first tool call and keeps
  that mode until it is restarted.
- `iphone-pilot doctor` shows both modes' readiness in `modes.ocr` and `modes.iph`; the iph checks
  include `screen_unlocked`. Its `"mode"` field uses this full check, so it can differ from what a
  command picks: with a locked phone on USB, `doctor` says `ocr` while commands still pick iph.
- To be sure of the mode, pass it: `--mode iph` or `--mode ocr` (for MCP:
  `… src/cli.ts --mode iph mcp`).

## Install

Needs macOS 15 or later on a Mac that runs iPhone Mirroring, [Bun](https://bun.sh), and the Xcode
Command Line Tools (`xcode-select --install`, for `swiftc`; Xcode itself is not needed).

```sh
git clone https://github.com/cuongtranba/iphone-pilot
cd iphone-pilot
bun install
bun run build:helper      # builds bin/mirror-helper (Swift: capture, Vision OCR, input)
bun link                  # optional: puts `iphone-pilot` on your PATH
iphone-pilot doctor
```

### Permissions (ocr mode)

In **System Settings → Privacy & Security**, allow the app that runs `iphone-pilot` (your terminal,
or the agent host) under:

- **Accessibility**: to send clicks and keys and to press the Mirroring menu items.
- **Screen & System Audio Recording**: to capture the Mirroring window.

Restart that app after granting. `iphone-pilot doctor` says which one is missing.

### iph mode

```sh
curl -fsSL https://raw.githubusercontent.com/HyunSeob/iphone-cli/main/install.sh | sh   # checksum-verified
iph setup
```

Plug the phone in by USB, unlock it, tap **Trust**, then turn on **Settings → Privacy & Security →
Developer Mode** (the phone restarts). `iph doctor` installs the developer disk image and checks the
rest. Touch and typing need **iOS 27 or later**; `iphone-pilot doctor` lists each failing `iph` check
with the action to take.

## Commands

```text
iphone-pilot [--mode auto|ocr|iph] [--image file.png] <command>
  doctor                      readiness of both modes, with the exact fix for each failed check
  snapshot                    elements on screen as JSON (refs e1..eN)
  find <text>                 elements whose label or value contains the text
  tap <ref|text|x,y>          tap by ref from the last snapshot, by text, or at a point
  type <text> [--submit]      type text into the focused field (Return after it with --submit)
  key <name>                  return, escape, tab, delete, up, down, left, right, space
  swipe <up|down|left|right>
  scroll <up|down>
  home                        go to the Home Screen
  screenshot <file.png>       PNG fallback for screens text cannot describe
  mcp                         stdio MCP server (mode fixed at start)
```

`--image capture.png` (ocr) reads a saved capture instead of the live window; input is then refused.

### Elements

```ts
{ ref: "e12", role: "button" | "text" | "app_icon" | …, label: string, value?: string,
  frame: { x, y, w, h }, source: "ax" | "ocr" }
```

- `frame` and tap points are in the coordinate space of that mode's `snapshot().screen` (ocr: points
  of the phone picture inside the mirror window; iph: iOS points).
- A ref is valid only for the latest snapshot. Every snapshot (and every tap or find by text, which
  reads the screen) replaces the stored refs. They are kept in `~/Library/Caches/iphone-pilot`
  (override with `IPHONE_PILOT_STATE_DIR`), so refs survive between CLI calls.
- Before tapping a ref, the screen is read again: if that element is no longer where the snapshot saw
  it, nothing is sent (`stale_ref`).
- `tap <text>` taps a single match. No match is `not_found`, several are `ambiguous` with the
  candidates; it never picks one for you.

### Outcomes

Every action returns `{ok, outcome, …}` with the same contract as `iph`:

| `outcome` | Meaning | Exit code |
|---|---|---|
| `done` | Ran to the end (taps add `screen_changed`) | 0 |
| `not_sent` | Nothing reached the phone. Safe to retry | 1 |
| `unknown` | Input may have reached the phone. **Do not resend**; read the screen | 2 |

A refused action has `error: {code, message, user_action?}`.

## MCP

```sh
claude mcp add iphone-pilot -- bun /path/to/iphone-pilot/src/cli.ts --mode auto mcp
```

or in an MCP client config:

```json
{
  "mcpServers": {
    "iphone-pilot": {
      "command": "bun",
      "args": ["/path/to/iphone-pilot/src/cli.ts", "--mode", "auto", "mcp"]
    }
  }
}
```

Tools: `doctor`, `snapshot`, `find`, `tap` (`ref` | `text` | `x`,`y`), `type` (`text`, `submit`),
`key` (`name`), `swipe` (`direction`), `scroll` (`direction`), `home`, `screenshot` (`path`). Each returns
the same JSON as the CLI.

## How ocr mode stays safe

The previous approach (screenshots plus clicks) sent taps and typing into whatever window covered
the mirror. Here, before **any** input the helper:

1. refuses if Mirroring is not running, its window is minimized, or it is not showing the phone
   (after the phone is unlocked, the window shows Mirroring's own "iPhone in Use … Connect" screen);
2. brings iPhone Mirroring to the front and waits until it is frontmost **and** the topmost window at
   the exact target point is the mirror; if not (an always-on-top window covers it), it sends nothing
   and returns `not_sent` (`mirror_covered`);
3. sends the input, then gives the front back to the app that had it and puts the pointer back.

Text is never typed key by key: the phone reads key events through its own hardware-keyboard layout
(a Vietnamese Telex layout turned `wifi` into `ưifi`). It is pasted instead (any language, emoji), and
then looked for on screen. Universal Clipboard sometimes hands the phone its previous item (about one
paste in ten). When nothing was inserted, the paste is repeated. When something else was inserted, it
is undone with ⌘Z, and the paste is repeated only if the screen is back exactly as before. In every
other case the result is `unknown`, never a blind retype. Your clipboard is put back 8 seconds later,
or left alone if you copied something in between.

## Limits of ocr mode

- Only what is written is seen. Icon-only controls (a back chevron, a close ✕) have no text: use
  `screenshot` and `tap x,y`, or iph mode. Home Screen app names are matched to the icon above them and
  come back as `app_icon`, because the mirror takes a tap only on the icon.
- The mirror ignores mouse drags. `swipe` and `scroll` use wheel events (about 100 points per step),
  which scroll lists and turn Home Screen pages but cannot do edge gestures such as swipe-back.
- OCR can misread small or decorated text (`Q Search` for the search field, a clock read as `12:281`).
- `escape` on a hardware keyboard does not go back in iOS apps.

## iph mode, Auto-Lock and a locked phone

iph works only while the phone is unlocked. With Auto-Lock on, the phone locks itself after its
timeout (30 s to 5 min), often in the middle of an agent's work. This was measured with the phone
locked and face down (so Face ID could not unlock it):

| Command on a locked phone | What happens |
|---|---|
| `snapshot` | Returns the **Lock Screen** (date, time, notifications, Flashlight, Camera), not the app that was open |
| `tap <text>` / `tap <ref>` for something in the app | Refused, `not_sent` (`not_found` / `stale_ref`); nothing is sent |
| `tap x,y`, `swipe`, `scroll`, `key`, `home` | **Sent**: iph does not refuse input on a locked phone. It lands on the Lock Screen and wakes the phone; if someone is facing the phone, Face ID may unlock it. A tap on a Lock Screen control (Flashlight, Camera, a notification) triggers it |
| `doctor` | `screen_unlocked` fails with "Unlock the phone." |

Nothing is lost when the phone locks: pairing, Developer Mode and the developer disk image stay. After
it is unlocked, commands work again.

Recommendations for agent sessions:

1. Before a session, set **Settings → Display & Brightness → Auto-Lock → Never**; set it back afterwards.
2. Start with `iphone-pilot doctor` and continue only when `modes.iph.ready` is `true`.
3. Prefer taps by text or ref over `tap x,y`: they read the screen first, so a Lock Screen makes them
   fail safely instead of pressing something.
4. If a snapshot unexpectedly shows the Lock Screen, stop and ask a person to unlock the phone. Do not
   tap your way through it.
5. Notification banners are not in the app's tree and take taps near the top of the screen. For long
   unattended runs, `iph dnd on` (and `iph dnd off` afterwards) keeps most of them away.

Unlocking the phone also ends iPhone Mirroring ("iPhone in Use"), so ocr stops working (its
commands are refused with `mirror_disconnected`). Locking it again and clicking **Connect** in the
Mirroring window brings ocr back.

Other notes:

- Icon-only controls have labels in iph (a back button is labelled with the previous page's title).
- `iph doctor`'s own touch self-test scrolls Settings. It can fail when Settings is on a short page
  (for example Auto-Lock); go back to the Settings root and run it again.

## Probe results

`bun run probe -- --mode ocr|iph` runs a live matrix on the phone (Settings and the Home Screen only)
and records it in [docs/probe-results.md](docs/probe-results.md). On an iPhone 16 Pro with iOS 27.2.1, all
16 ocr cases and all 13 iph cases pass, including the refusals: covered, minimized, disconnected or
closed mirror, stale refs, missing text, `iph` not installed, and a locked phone.

| Home Screen snapshot | elements | read time | JSON | PNG screenshot |
|---|---|---|---|---|
| ocr | 39 | 0.46 s | 4.2 KB | 746 KB (2x display) |
| iph | 23 | 1.5 s | 2.8 KB | 5.1 MB |

## Development

```sh
bun test                 # behaviour through the public API: real Swift helper on PNG fixtures, a fake iph on PATH
bunx tsc --noEmit
bun run build:helper
bun run probe -- --mode ocr
```

`MIRROR_HELPER_PASTE_BEFORE_MS`, `MIRROR_HELPER_PASTE_MS` and `MIRROR_HELPER_RESTORE_MS` tune the paste
timings; `MIRROR_HELPER_UPSCALE` the OCR upscaling (2 by default); `IPHONE_PILOT_HELPER` points at another
helper binary.

## Credits

- [`iphone-cli`](https://github.com/HyunSeob/iphone-cli) (MIT) does the iph mode; this project only calls it.
- The iPhone Mirroring pitfalls documented by [mirroir-mcp](https://github.com/jfarcand/mirroir-mcp)
  (Apache-2.0) saved time; no code was taken from it.

## License

MIT
