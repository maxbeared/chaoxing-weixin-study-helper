# Packaging

Use the root `package.cmd` for one-click packaging on Windows:

```cmd
package.cmd
```

The default package is written to `release/chaoxing-weixin-study-helper-test-<timestamp>.zip`.

By default this is a source install package. It includes the extension, install scripts, docs, and native host source files, but excludes `node_modules`, `.state`, generated native messaging manifests, and Git metadata. The target machine needs Node.js 22+ and npm; `install.cmd` will run `npm install` during setup.

Packaged zips include a generated root `manifest.json`, so Chrome/Edge can load either the extracted package root or the `extension/` subfolder as the unpacked extension.

Advanced options:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\package.ps1 -PackageName my-test-build
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\package.ps1 -IncludeExistingDist
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\package.ps1 -BuildWinX64
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\package.ps1 -BuildWinX64 -PkgFetchMirror https://ghfast.top/
```

- `-PackageName`: sets the zip/staging name.
- `-IncludeExistingDist`: includes `native-host/dist/` when it already exists.
- `-BuildWinX64`: runs `npm run build:win:x64` first and includes the resulting `native-host/dist/`.
- `-PkgFetchMirror`: overrides the mirror used to pre-download pkg's patched Node base binary. The downloaded binary is always verified with SHA256 before pkg uses it.

When building `-BuildWinX64`, the script pre-downloads pkg's base binary from mirrors before running `pkg`. This avoids relying on GitHub Releases directly, which is often slow or unavailable in China. The current default mirror order starts with `https://ghfast.top/`, then falls back to other GitHub release proxies and finally the official GitHub URL.
