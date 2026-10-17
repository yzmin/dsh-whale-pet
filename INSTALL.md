# Install the whale pet on another machine

Artifacts are in `dist/`. Verified against DeepSeek Harness **0.2.0-rc.2**.

## 1. Get the files there

| Artifact | Use |
|---|---|
| `dsh-whale-pet.tgz` | An npm/pnpm tarball. Install by path or by URL. |
| `dsh-whale-pet.zip` | Hand-copy or download; extract it anywhere. |
| `dsh-whale-pet/` | A plain folder, already unpacked. |
| `tones/*.wav` | Offline previews of the five completion tones, so the sound can be chosen before installing. |

Both archives nest the plugin under `dsh-whale-pet/package/`, matching
`npm pack`, so the tarball installs dsh-side and the zip extracts to one tidy
folder with the guide and the previews beside it.

## 2. Install it

Through the Plugin Manager (agent tool `plugin_manager`), with an **absolute**
path — a relative path is refused on purpose, because the Host's working
directory means nothing to the person typing:

```
install_bundle  target: <absolute path to .../dsh-whale-pet/package>
```

A tarball works instead of a directory, on disk or over HTTP:

```
install_bundle  target: C:\path\to\dsh-whale-pet.tgz
install_bundle  target: https://example.com/dsh-whale-pet.tgz
```

A git repository works too, if `dsh-whale-pet/package/` is pushed as the repo
root:

```
install_bundle  target: https://github.com/<you>/dsh-whale-pet
```

`install_bundle` performs the profile's package install and bundle selection
itself. Do not hand-edit the profile's `package.json` or `cordis.patch.yml`, and
do not run pnpm in the profile directory.

## 3. Confirm it

- `Config.listConfigs name=dsh-whale-pet` → one entry `include:pet-whale`.
- `Slots.listSubTree root=shell.overlay` → occupant `pet-whale`, `active: true`.
- `GET /pet-whale/state` → `{"ok":true,"version":3,...}`.
- `GET /pet-whale/assets/tone.wav` → `200`, `content-type: audio/wav`.

## 4. Reloading after a change

| Changed | What it needs |
|---|---|
| `client.js` (the panel) | a page refresh |
| `index.js` (the Host half) | a DSH **restart** |
| `assets/tone.wav` | a DSH **restart** (read once, then served from memory) |

The Host half is an ES module and the Loader imports a specifier once per process
generation, so toggling the bundle or reinstalling does **not** re-evaluate
`index.js`.

## Completion tone

The pet plays a chime when a turn finishes, and **which one is the user's
choice**: the panel's footer has a tone dropdown. Selecting a tone plays it
immediately, so the decision is made by ear; the choice persists in
`localStorage`.

| Tone | Completion sound |
|---|---|
| **明亮铃音 Bright（音频文件）** — default | the file `assets/tone.wav` |
| 柔和木琴 Soft | synthesized, two pure sines |
| 木质马林巴 Marimba | synthesized, square wave, short |
| 轻点提示 Click | synthesized, two high notes |
| 长尾钟声 Bell | synthesized, slow attack, long tail |

Each tone declares a `source` of `'asset'` or `'synth'`, which is what decides
its completion cue. The failure and start cues are always synthesized from the
chosen tone, because the asset carries only the success sound.

### Replacing the completion sound

Replace `assets/tone.wav` with your own file, then restart DSH. Any of
`.wav` / `.mp3` / `.ogg` / `.m4a` / `.aac` / `.flac` / `.webm` works — for a
different extension, update `TONE_URL` in `plugin/client.js` to match. Aim for
**0.3–1.5 s** with a peak near but not above 1.0. If the file is missing or fails
to decode, the cue falls back to synthesized notes rather than going silent.

`tones/*.wav` approximate the live path — same note data, envelope, partials and
trim — but skip the browser's compressor, so they convey character rather than the
exact output. Regenerate with `node tools/render-tones.mjs`.

To add your own synthesized tone instead, add an entry to `TONES` in
`plugin/client.js` (note data plus an optional voicing) and it appears in the
picker automatically.

## Notes for the receiving machine

- The plugin declares **no runtime imports and no dependencies**. It does not need
  `node_modules`, a build step, or a bundler: the browser half is hand-written in
  the `window.__ModuleLoader__.load` format the Web shell already consumes.
- Installing from a **directory** creates a `link:` — the profile points at your
  folder, so later edits take effect. Installing from a **tarball** copies it, so
  the installed version is frozen. Use the tarball to distribute.
- The profile must expose `webServer` (it is part of the shipped Web
  composition) and should expose `deepseekAccount` for the balance row; without
  it the accounting still works and the balance row is simply absent.
