# elDrive: eDrive for fully electric cars

`apps/eldrive` is a copy of `apps/edrive` with a **fully electric (BEV)** mode added, built for the
**iX3 (G08)** on iDrive 7. Plug-in hybrids, 48 V mild hybrids and 12 V-only cars behave as in eDrive. The app
has its own id (`eldrive`), title, logging id (`OAA3`) and data folder, so it installs next to eDrive.

## What changes on a fully electric car

| eDrive (plug-in hybrid) | elDrive on a BEV |
|---|---|
| Charge from `DDBC`. The iX3 answers it with zero bytes, so eDrive shows **0 %** | Charge from `E5CE`. `DDBC` now needs at least 0.5 %, so a zero is never read as an empty battery |
| Range ends where the engine starts (at least 11 %); "HYBRID, battery held at 5-11 %" below that | Range counts down to 0 %, or to the new *Range counts down to* setting (5-20 %) |
| Learns only while the engine-speed signal is live | Ignores the engine-speed signal (shown raw on the Signals page) and checks the speed signal instead |
| % per km limits sized for a ~12 kWh pack (they reject normal driving on a 74 kWh pack) | Limits scale with the battery size |
| kWh per % = size setting x health | kWh per % from the pack's own usable kWh (`E5C7`). Health = usable kWh / *Usable battery when new* (74 kWh) |
| Range before learning: 50 km at 20 °C, by temperature | Usable kWh / typical use (17.5 kWh/100 km at 20 °C up to 27 at -10 °C) |
| Live power from `DD68` x `DD69` (the iX3 refuses both) | `E54D` (V) x `E561` (A). Without a voltage reading, an estimate from the charge, shown as `~` |
| — | Charges that add under 0.3 % per reading (AC, or ~50 kW DC with the screen on) are now logged |

On **Auto**, a battery unit that reports more than 45 kWh usable (`bevMinKwh`) is treated as fully electric, and the
app remembers it. You can also set **Drive system: Fully electric (BEV)** directly.

## What is confirmed

From the [OBDb iX3 captures](https://github.com/OBDb/BMW-iX3) (2021, 2022 and 2023 cars, battery unit `0x07`):
`E5CE` charge with the lowest and highest cell's charge after it, `E5C7` stored and usable kWh, `DDC0` cell
temperatures, `E561` current, `DDBC` zero bytes. `DD68`, `DD69`, `DDBF`, `DFA0` and `6335` are refused.

**Not yet confirmed on an iX3:**
- `E54D` pack voltage. It is confirmed on the iX (same battery-unit generation).
- The 12 V reading. The app tries `F442` on the battery unit, the BDC (`0x40`) and the EME (`0x1A`).
- Cell voltages: `E554` (every cell) and `E553` (lowest and highest), confirmed on the
  [iX1](https://github.com/OBDb/BMW-iX1), are tried first. Without them the Battery page's Cells panel shows the lowest
  and highest cell's charge from `E5CE`, and "Cell voltages: no reading".
- Coolant `DD6C`, current limits `DD7D`, and the climate unit probes.
- That the car's SOME/IP signals (speed, climate, seat heating) arrive as on the X5.

## First drive checklist

1. Settings: **Drive system → Fully electric (BEV)** (or leave Auto), **Usable battery when new → 74 kWh**, and
   **Diagnostics pages → on**.
2. **Diagnostic** page: `SOC *` should be on `E5CE` with status OK, and `ENERGY` OK (about 70-75 kWh usable).
3. **Battery unit** page: which `hvV` answers (`E54D`?), and `hvI` on `E561`. If the voltage shows `~`, it is the
   estimate. Accelerate and brake: power should be **+ while driving and - (green) under regen**. If it is the
   other way round, set `powerSign` to `1` in `app.json`.
4. **Signals** page, row `engine speed`: what the iX3 sends there (for information only, it is not used).
5. After ~10 km: the Range page should say "learned from … km". Compare with the car's own range.
6. Photograph anything that reads `n/a` or looks wrong. The identifiers are in `config.battery` in `app.json`.
   The **Scan** page (battery unit) now also covers `E500-E5FF`.
7. Home-screen widget: the HMI fades the picture towards its edges. **Home-screen widget: picture** (Settings) keeps
   it clear of the fade: *Medium* by default, *Small* if the edges still look faded, *Fill the widget* as in 1.0.

## Safety

The app only uses UDS **ReadDataByIdentifier (0x22)**: no writes, no coding, no routines. It uses the same
diagnostic transport and request pacing as eDrive. The live pages stop reading when parked, so the car can sleep.
Identifiers that keep failing are asked less often (from every 30 s up to every 5 min). On a BEV this adds one
read (`E5C7`) to each 15 s charge poll.

## Build, install, host

```sh
node kit/tools/test_eldrive.js          # all of eDrive's checks + the BEV ones
python3 kit/tools/build.py eldrive      # needs your oap-sdk (see the main README)
```

Install as described in the [repository README](../../README.md) (`kit/tools/make_kit.py`, then
`deploy/push-to-car.sh`). **Never publish `oap-sdk/` or built `.mgu` / `.tgz` files**: they contain BMW's SDK. To
rename the tile, change `title` and `startWidget.name` in `app.json`.
