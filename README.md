# elDrive (electric drive): eDrive for fully electric BMWs

A custom app for the BMW **MGU head unit (iDrive 7)** that shows what the high-voltage battery really gives you. It
shows real range learned from your own driving, live battery power, battery health and kWh, a charge log with cost,
and a home-screen widget. It is the [eDrive](https://github.com/cauliflowermossgrape/idrive7-apps) app with a
**fully electric (BEV)** mode added, made for the **iX3 (G08)**. Plug-in hybrids and 48 V mild hybrids work as in
eDrive.

What changes on a BEV, what is confirmed on an iX3 and a first-drive checklist: [apps/eldrive/README.md](apps/eldrive/README.md).

> **Disclaimer.** This is an unofficial hobby project. It is not affiliated with, endorsed by or supported by BMW AG.
> BMW, iDrive, eDrive and iX3 are trademarks of BMW AG, used here only to describe the cars this works with. Modifying
> your head unit is at your own risk.

This repository holds only elDrive and the kit it needs (runtime, build, GPU renderer, installer), taken from
[cauliflowermossgrape/idrive7-apps](https://github.com/cauliflowermossgrape/idrive7-apps). Its README explains the
platform, the renderer and every install option in depth.

## You need

- A BMW with the **MGU head unit** (iDrive 7) and **root SSH access** to it. This repository doesn't provide that.
- **BMW's app SDK (`oap-sdk`)**, extracted from your own unit (below). It is BMW's code: never commit it.
- **Python 3** and **Node.js 14+** on your computer.

## Build and install

```sh
# 1. the SDK, from the x_call app in your unit's firmware (unpacked outside the repository: it is BMW's code)
mkdir -p /tmp/x_call && scp root@<unit>:'/usr/lib/oap-mainapp/preinstalled_apps/x_call@*.tgz' /tmp/x_call/
tar xzf /tmp/x_call/x_call@*.tgz -C /tmp/x_call
node kit/tools/extract_sdk.js /tmp/x_call/javascript/app.js   # writes ./oap-sdk/ (git-ignored)

# 2. check and pack: the app, the installer and the prebuilt GPU renderer -> dist/mgu-custom-apps.tar.gz
node kit/tools/test_eldrive.js
python3 kit/tools/make_kit.py eldrive

# 3. install over SSH (car parked, ignition on)
HU=root@<unit-ip> PORT=22 KEY=~/.ssh/id_mgu deploy/push-to-car.sh check     # read-only dry run
HU=root@<unit-ip> PORT=22 KEY=~/.ssh/id_mgu deploy/push-to-car.sh install   # backup, install, restart the app platform
```

On Windows, use `deploy\push-to-car.ps1` (same `check` / `install` / `restore`, see the upstream README). The tile
appears under **Apps** after 1-2 minutes.

**Notes**
- `install` adds or updates only the apps in this kit, so apps already installed from the upstream kit (e.g.
  eDrive) stay. elDrive has its own id and data, so it runs next to eDrive.
- `deploy/push-to-car.sh restore` puts the unit back to stock, **removing every custom app**.

`mgu-repo.json` is the manifest the [MGU Store](https://github.com/robertnisipeanu/mgu-store) reads to build and
install the apps of a repository, so you can also install from this repository through the Store.

## Develop

```sh
node kit/tools/test_eldrive.js                       # synthetic checks: no car, SDK or renderer
python3 kit/tools/build.py --preview-only eldrive    # offline preview build (not installable)
node kit/tools/preview.js dist/eldrive preview --set hybrid=bev BTN_PAGE   # screens as PNGs, demo data
node kit/tools/emu.js eldrive                        # live emulator at http://localhost:8077 (needs oap-sdk: it builds the app)
```

The app runs on the head unit's **Node.js 8**: no `?.`, `??` or other newer syntax. Battery identifiers and their
scaling are in `config.battery` in [apps/eldrive/app.json](apps/eldrive/app.json).

## Never publish

`oap-sdk/`, the `x_call` app it comes from, `dist/`, `*.mgu` and `*.tgz` contain BMW's code. They are in
`.gitignore`: keep it that way, and check `git status` before committing.

## License

MIT, as the upstream project ([LICENSE](LICENSE)), with these exceptions:
- **GPU renderer** (`kit/renderd`): [mgu-render](https://github.com/robertnisipeanu/mgu-store) by Robert Nisipeanu
  and IterioDev, GPL-3.0-or-later (`kit/renderd/LICENSE`). The parts from the upstream's first renderer and the
  controller gate (`kit/renderd/inputgate`) are MIT (`kit/renderd/LICENSE.mgu-renderd`).
- **Emulator's draw engine** (`kit/emu/wasm`, `kit/emu/web/gfx`): GPL-3.0-or-later. The rest of the emulator is MIT.
- **Fonts**: their own licences. The UI glyphs in `kit/runtime/fonts` are baked from the Ubuntu font
  (`UFL-Ubuntu.txt`, Ubuntu Font Licence 1.0); the Chinese and Korean ones from Noto Sans (`OFL-*.txt`, SIL OFL 1.1).

The app talks to the renderer over a socket, so it stays MIT.

The iX3 battery identifiers and their scaling, and the iX3 replies the tests use, come from the
[OBDb](https://github.com/OBDb) captures of the [iX3](https://github.com/OBDb/BMW-iX3) and
[iX](https://github.com/OBDb/BMW-iX) (CC BY-SA 4.0).
