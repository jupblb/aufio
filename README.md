# aufio

Local, agent-friendly control of a **FiiO KA17's onboard EQ** on Apple Silicon
macOS. No browser, FiiO account, audio-routing driver, cloud service or MCP server
is required. Audio continues through the KA17; this program only sends control
messages. The headphones are **HiFiMan Arya Unveiled** (a passive analog device,
not a separately controllable USB device).

## Run

```sh
nix develop
npm ci
npm run -s aufio -- inspect
npm run -s aufio -- read
npm run -s aufio -- save before-tuning
```

`flake.nix`/`flake.lock` provide Node 24 (including npm), TypeScript, Git, curl,
and the Python/pkg-config/Clang/Make native-addon build tools. npm dependencies
are pinned in `package-lock.json`. The macOS `node-hid` prebuilt binary is bundled
with the package. `npm ci` may warn about an unapproved native install script;
the bundled binary works without running that script on the tested Mac.

From an agent's shell tool, use this in the repository working directory:

```sh
nix develop --command node bin/aufio.mjs inspect
```

All command results are JSON on stdout, except help/version. Errors and recovery
paths are JSON on stderr. Failures return exit status 1. `verify` also returns 1
for a mismatch; `diff` reports differences without failing. `validate` returns 1
if the model estimates clipping. Do not interpret exit status 0 as proof of
nonvolatile device storage.

## Tune and save

**Close FiiO Control and other EQ controllers before using aufio.** Keep listening
volume low. `--yes` explicitly permits changing the device; without it, `apply`,
`restore` and `select` refuse to write. `--dry-run` never changes the device.

| Command | Effect |
| --- | --- |
| `inspect` | Enumerate KA17 interfaces, USB revision, slot IDs and data directory |
| `read` | Read the current slot, preamp, all bands and raw response bytes |
| `save <name>` | Save current EQ as a local preset **and** a raw backup; no DAC write |
| `list` / `show <preset>` | List or inspect local presets |
| `validate <preset>` | Check limits, compile Q values and estimate headroom without USB access |
| `diff <preset-or-snapshot>` | Compare with live EQ without selecting another slot |
| `apply <preset> --dry-run` | Preview encoded values and differences |
| `apply <preset> --yes` | Back up and update the active USER slot, verify, save to DAC, verify again |
| `verify <preset-or-snapshot>` | Compare live values; fail on mismatch |
| `restore <snapshot.json> --yes` | Restore raw values to the snapshot's already-active USER slot |
| `select USER1 --yes` | Select USER1, USER2, USER3 or BYPASS, with a before-change backup |

`<preset>` accepts a saved name or an explicit JSON path. Names use lowercase
letters, digits, hyphens and underscores. Files are stored under:

```text
~/Library/Application Support/aufio/
  presets/<name>.json
  backups/<timestamp>-<uuid>.json
```

Use global `--data-dir <path>` or `AUFIO_DATA_DIR` to relocate storage; global
`--device <HID-path>` selects among multiple KA17s. Paths can change after USB
reconnection. Preset saves **never overwrite existing names**. Create a new
version when tuning. Backups are flushed, atomically published, and retained.
Back up this directory like any other personal data: files are independent of
the browser and DAC, but are not a substitute for an off-machine backup.

### Agent workflow

1. `read` and `save` the current EQ before the first tuning session.
2. Copy a saved preset to a new JSON file; edit its name, notes and requested
   bands. Do not overwrite the original reference profile.
3. Run `validate` and `apply --dry-run`. Explain the frequency/gain/Q changes.
4. Apply with `--yes` when the user has requested that tuning, then verify.
5. If the user dislikes it, restore the raw before-write snapshot printed by
   `apply`. If disconnected mid-write, read first; do not blindly retry a write.

An example preset (a format example, **not** an Arya correction recommendation):

```json
{
  "schemaVersion": 1,
  "kind": "ka17-preset",
  "name": "gentle-bass",
  "headphone": "HiFiMan Arya Unveiled",
  "notes": "Example only",
  "qMode": "device",
  "preampDb": -4,
  "bands": [
    { "type": "LS", "frequencyHz": 100, "gainDb": 2, "q": 0.7 }
  ]
}
```

Supported tuning filters: `PK` (peak), `LS` (low shelf), `HS` (high shelf).
Limits: 1–10 bands; integer 20–20,000 Hz; gain/preamp −12…+12 dB in 0.1 dB steps;
device Q 0.1…10 in 0.01 steps. Unknown fields/types are rejected.

`qMode: "device"` preserves FiiO's stored Q exactly. This is the mode used by
`save`. `qMode: "rbj-peak"` compensates **peaking filters only** for FiiO's measured
gain-dependent bandwidth convention, rounding to device precision. Shelves
remain in device Q units. Compensation outside the hardware range is rejected,
not clamped. Do not change the mode of an existing raw profile without converting
its Q values. See [protocol notes](docs/ka17.md).

Headroom is a response-model estimate, not an acoustic measurement. Overlapping
filters are combined and shelf resonance is included, but KA17 shelf behavior
is not independently verified. `validate` recommends an extra 1 dB margin;
`apply` rejects estimated positive peaks. `restore` deliberately restores exact
old values, without changing their headroom. Neither operation changes playback
volume or amplifier gain. **BYPASS is not hardware EQ OFF** and may be louder.

## Persistence and recovery

The CLI distinguishes local storage, device readback, and power-loss persistence.
After an apply, `deviceSave: "command sent"` and `readback: "matched"` do **not**
prove that flash storage survives power loss. No auto-reapply daemon runs.

To check persistence, pause playback, disconnect **both** USB cables if external
power is attached, reconnect, and run `verify <saved-preset>` **before applying
anything**. If it differs, run `read` and `save after-reconnect` to preserve the
evidence. Check the active slot separately. Then select the desired USER slot
and restore if needed. Switching slots can change loudness, so pause first.

Every device operation holds a per-user lock shared across CLI invocations.
Other applications do not honor this lock. After a crash, the error identifies
the lock file and its PID. Remove it only after confirming the previous process
has exited. Writes are not atomic: an interruption can leave partial settings
or the temporary −12 dB preamp. A durable before-write snapshot is printed to
stderr before the first hardware change. No firmware flashing or device reset
commands are implemented.

## Development and verification

```sh
nix develop --command npm run check
nix develop --command npm test
```

Tests never access real USB hardware. They cover golden packets, incomplete and
unrelated responses, failed writes, readback-before-save, post-save corruption,
Q compensation, headroom, validation, exclusive operations and durable storage.

Hardware verification on 2026-09-17: native reads, local backups, a small USER1
write/save, fresh-process readback, exact restoration and a final comparison all
succeeded. Original settings remain selected; baseline preset: `arya-original`.
Physical power-cycle persistence and switching to other slots have **not** been
tested. See [device notes](docs/ka17.md) and [third-party attribution](THIRD_PARTY_NOTICES.md).
