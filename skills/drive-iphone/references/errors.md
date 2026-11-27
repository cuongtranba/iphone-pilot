# Error codes

An action that did not finish returns `error: {code, message, hint?, user_action?, candidates?}`.
The **outcome** (`not_sent` or `unknown`) decides whether you may retry. The code tells you what to
fix. The same code can come with either outcome. For example, `mirror_not_front` before input is
`not_sent`, but if focus was lost *while* input was going out it is `unknown`.

When `user_action` is present, it is the exact fix to give the user. Quote it rather than
paraphrasing.

## Screen and targeting (both modes)

| Code | Meaning | Do this |
|---|---|---|
| `stale_ref` | The ref is not from the latest read, or its element moved or disappeared | `snapshot` (or `find`), then tap the new ref or tap by text |
| `not_found` | No element's label or value contains that text | Snapshot and use the label as written. Try a shorter part of it. Scroll if it may be off screen. In ocr mode, the text may be misread or the control may be icon-only |
| `ambiguous` | Several elements match. `candidates` lists them with refs | Choose by role, frame or value, then `tap {ref}`. Never guess when the candidates mean different actions |
| `unknown_key` | `key` name is not supported | Use `return, escape, tab, delete, up, down, left, right, space` |

## ocr mode (iPhone Mirroring)

| Code | Meaning | Do this |
|---|---|---|
| `mirror_not_running` | iPhone Mirroring is not open | Ask the user to open iPhone Mirroring and connect the phone |
| `mirror_hidden` | The window is minimized or shows no phone | Ask the user to restore the Mirroring window |
| `mirror_disconnected` | Mirroring shows "iPhone in Use … Connect", usually because the phone was unlocked | Ask the user to lock the phone and click **Connect** in the Mirroring window |
| `mirror_not_front` | Mirroring could not be brought to the front, or lost focus mid-input | If `not_sent`, retry once. If it repeats, ask the user what is stealing focus. If `unknown`, snapshot first |
| `mirror_covered` | Another window (often an always-on-top one) covers the target point | Ask the user to move that window off the mirror, then retry |
| `capture_failed` | The window could not be captured | Usually the Screen Recording permission is missing for the host app, or the window is minimized. Run `doctor` |
| `type_not_verified` | The pasted text could not be confirmed on screen (`unknown`) | Snapshot and look at the field. Only type again if it is clearly empty or unchanged |
| `menu_item_missing`, `menu_press_failed` | Home or other menu-driven actions failed | Snapshot to see the state, then retry once |
| `read_only_image` | The server was started with `--image`, a saved capture | Input is impossible in that session. Tell the user |
| `helper_missing` | `bin/mirror-helper` was not built | The user runs `bun run build:helper` in the iphone-pilot checkout |
| `helper_usage`, `helper_crashed`, `input_failed`, `ocr_failed`, `bad_image` | Internal failure | Report the `message`. Treat `helper_crashed` and `input_failed` as `unknown` (snapshot before anything else) |

## iph mode (accessibility tree)

| Code | Meaning | Do this |
|---|---|---|
| `iph_missing` | The `iph` CLI is not installed or not on PATH | Run `doctor` and pass on its `user_action` |
| `iph_bad_output` | `iph` exited without JSON | Run `doctor`. The phone may be disconnected, locked or untrusted |
| other codes | Passed through from `iph` itself | Follow `user_action` or `hint`. Run `doctor` if the cause is unclear |

## Readiness checks

`doctor` returns `{mode, ready, modes: {ocr: {ready, checks}, iph: {ready, checks}}}`, where each
check is `{check, ok, detail?, user_action?}`. In iph mode, `screen_unlocked` failing means "Unlock
the phone". This is the one check you will hit mid-session. `doctor`'s `mode` is a fresh pick,
while the MCP server keeps the mode it picked on its first command, so the two can differ. The
`mode` of a `snapshot` is the one your actions use.
