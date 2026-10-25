# Versena downloads

Versena is a local-first writing app from Thorn & Reason. This repository contains release downloads and signed update information. The application source is maintained separately.

## Apple Silicon Mac beta

[Download the current beta](https://github.com/Thorn-and-Reason/Versena-releases/releases/tag/beta).

This beta has not been signed with an Apple Developer ID or notarised by Apple. macOS may require approval of its first launch in Privacy & Security. Update-package signatures verify the publisher separately from Apple platform signing.

Existing installations need one manual installation of the beta. Download the versioned `.app.tar.gz` file, extract it, quit the old app after saving your work, and move Versena.app to Applications. Later updates are available through **Help → Check for updates** or **Settings → About**.

The current beta is for Apple Silicon Macs. Intel Mac, Windows, and Linux downloads will be added after their installation and upgrade checks pass.

The app saves writing, section titles, and settings before an update, then restores the current project and section after restarting. Projects remain local files; the update channel does not upload project content.

Each release includes its SHA-256 checksums, updater signature, and public verification key. The update feed is [latest.json](https://github.com/Thorn-and-Reason/Versena-releases/releases/download/beta/latest.json).

Copyright © 2026 Thorn & Reason. All rights reserved. See LICENSE for the application licence.
