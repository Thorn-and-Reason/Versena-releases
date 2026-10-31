# Versena downloads

Versena is a local-first writing app from Thorn & Reason. This repository contains installers and signed update information; the application source is private.

## Current beta: 0.1.3-beta.6

This release fixes Linux links and “show in folder” actions by restoring the host environment for desktop helpers. All five platform packages use the same signed update version.

- [Apple Silicon Mac installer](https://github.com/Thorn-and-Reason/Versena-releases/releases/download/v0.1.3-beta.6/Versena_0.1.3-beta.6_darwin-aarch64.dmg)
- [Intel Mac installer](https://github.com/Thorn-and-Reason/Versena-releases/releases/download/v0.1.3-beta.6/Versena_0.1.3-beta.6_darwin-x86_64.dmg)
- [Windows ARM64 installer](https://github.com/Thorn-and-Reason/Versena-releases/releases/download/v0.1.3-beta.6/Versena_0.1.3-beta.6_windows-aarch64-setup.exe)
- [Windows x64 installer](https://github.com/Thorn-and-Reason/Versena-releases/releases/download/v0.1.3-beta.6/Versena_0.1.3-beta.6_windows-x86_64-setup.exe)
- [Linux x64 AppImage](https://github.com/Thorn-and-Reason/Versena-releases/releases/download/v0.1.3-beta.6/Versena_0.1.3-beta.6_linux-x86_64.AppImage)

The desktop helper regression passed on Fedora 44 x64, and the packaged Linux PDF engine was checked. Physical Fedora hardware and SELinux acceptance remain unverified.

Existing users can update through the Thorn & Reason Launcher or choose **Check for updates** in Versena. Builds without the updater need one manual installation. Save your work and quit Versena before replacing it manually. Projects remain local files.

On Windows ARM, choose the ARM64 installer. Existing x64 installations continue to receive x64 updates; save your work, quit Versena, and install the ARM64 package manually to switch architecture. Native Windows ARM installation, PDF export, and updates remain untested on hardware.

Mac packages are ad-hoc signed and have not been notarised by Apple. Windows packages have no Authenticode signature. Package signatures verify the update separately from operating-system publisher trust. Full desktop and accessibility acceptance has not been repeated on every platform.

[Checksums](https://github.com/Thorn-and-Reason/Versena-releases/releases/download/v0.1.3-beta.6/SHA256SUMS.txt) · [Update feed](https://github.com/Thorn-and-Reason/Versena-releases/releases/download/beta/latest.json) · [Release downloads](https://github.com/Thorn-and-Reason/Versena-releases/releases/tag/v0.1.3-beta.6)

Copyright © 2026 Thorn & Reason. All rights reserved. See LICENSE for the application licence.

