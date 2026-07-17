# Manual Application Update Implementation Plan

> **For Codex:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a beginner-friendly, explicitly initiated Windows update flow that checks GitHub Releases, downloads an installer update with visible progress, and restarts safely without losing profiles, settings, or credentials.

**Architecture:** Keep update orchestration in the Electron main process and expose a narrow typed IPC bridge to the React renderer. Wrap `electron-updater` behind a testable adapter, keep automatic startup checks/downloads/quit installs disabled, and re-check OBS/platform activity immediately before installation. Publish metadata will target the fixed `akina910/obs-stream-manager` GitHub repository; release automation will remain dormant until an authorized version tag is pushed.

**Tech Stack:** Electron 39, electron-updater 6.8.9, React 19, TypeScript, Vitest, electron-builder 26, GitHub Actions, PowerShell distribution verification.

---

### Task 1: Define and test the manual updater state machine

**Files:**
- Create: `shared/update-contracts.ts`
- Create: `desktop/updater.ts`
- Test: `desktop/updater.test.ts`

**Step 1: Write failing tests**

Cover these observable requirements with a fake updater adapter:

- construction disables automatic download and automatic install-on-quit but performs no network check;
- `check()` transitions through `checking` to `available` or `up-to-date`;
- release notes are normalized from string/array values;
- `download()` exposes progress and reaches `downloaded`;
- `install()` calls `quitAndInstall(true, true)` only after a second runtime-safety check;
- streaming, recording, replay buffer, busy platform mutation, and live/transitioning YouTube or Twitch each block installation;
- unpackaged development builds report unsupported;
- Portable builds may check for a version but never self-overwrite.

**Step 2: Run the focused test and confirm RED**

Run: `npx vitest run desktop/updater.test.ts`

Expected: FAIL because the updater contract and service do not exist yet.

**Step 3: Add the dependency and implement the smallest state machine**

Run: `npm install electron-updater@6.8.9 --save`

Implement typed phases (`idle`, `checking`, `up-to-date`, `available`, `downloading`, `downloaded`, `installing`, `error`, `unsupported`), immutable snapshots, adapter event handling, operation serialization, safe release-note normalization, and a pure runtime blocker helper. Do not call `checkForUpdates()` from a constructor or startup path.

**Step 4: Run the focused test and confirm GREEN**

Run: `npx vitest run desktop/updater.test.ts`

Expected: PASS.

**Step 5: Commit**

```powershell
git add shared/update-contracts.ts desktop/updater.ts desktop/updater.test.ts package.json package-lock.json
git commit -m "feat: add manual updater state machine"
```

### Task 2: Add the secure desktop IPC bridge and main-process integration

**Files:**
- Modify: `desktop/main.ts`
- Modify: `desktop/preload.cts`
- Modify: `src/desktop.d.ts`
- Test: `desktop/updater.test.ts`

**Step 1: Extend failing tests for the Electron adapter**

Add tests that verify Electron updater flags, event subscription cleanup, error redaction/normalization, and exact silent relaunch arguments.

**Step 2: Run the focused test and confirm RED**

Run: `npx vitest run desktop/updater.test.ts`

Expected: FAIL on the new adapter expectations.

**Step 3: Implement the main-process wiring**

- Wrap `electron-updater` without exposing it to the renderer.
- Register IPC handlers for state, check, download, install, and opening the fixed Releases page.
- Broadcast state changes to the main window.
- Query `http://127.0.0.1:<bound-port>/api/status` immediately before install and apply the pure runtime blocker.
- Never accept a renderer-provided download URL or executable path.
- Add a localized tray action that opens the desktop window and initiates a check only when clicked.
- Do not check on app startup.

**Step 4: Expose a narrow preload API**

Expose only the updater commands and a state-change subscription with cleanup. Keep the TypeScript declaration synchronized.

**Step 5: Run updater and desktop tests**

Run: `npx vitest run desktop/updater.test.ts desktop/integration.test.ts desktop/startup.test.ts`

Expected: PASS.

**Step 6: Commit**

```powershell
git add desktop/main.ts desktop/preload.cts src/desktop.d.ts desktop/updater.ts desktop/updater.test.ts
git commit -m "feat: connect manual updater to desktop runtime"
```

### Task 3: Build the Japanese/English beginner UI

**Files:**
- Create: `src/DesktopUpdateControl.tsx`
- Create: `src/update-ui.ts`
- Create: `src/update-ui.test.ts`
- Modify: `src/App.tsx`
- Modify: `src/i18n.tsx`
- Modify: `src/i18n.test.ts`

**Step 1: Write failing state-to-action tests**

Test the primary action and explanation for every phase, including disabled installation during OBS/platform activity and the Portable "open download page" path.

**Step 2: Run the focused tests and confirm RED**

Run: `npx vitest run src/update-ui.test.ts src/i18n.test.ts`

Expected: FAIL because UI mapping and translation keys are missing.

**Step 3: Implement the settings control**

Add a desktop-only settings card showing current/latest versions, release notes, download progress, a single obvious next action, and a plain-language safety reason when installation is blocked. Subscribe/unsubscribe to main-process state through the preload bridge. Use the existing layout and visual system; do not redesign unrelated UI.

**Step 4: Add complete Japanese and English copy**

Translate every visible updater state/action/error. Avoid developer terms such as `latest.yml`, provider, IPC, or semver in end-user copy.

**Step 5: Run focused tests and type checks**

Run: `npx vitest run src/update-ui.test.ts src/i18n.test.ts`

Run: `npm run typecheck`

Expected: PASS.

**Step 6: Commit**

```powershell
git add src/DesktopUpdateControl.tsx src/update-ui.ts src/update-ui.test.ts src/App.tsx src/i18n.tsx src/i18n.test.ts
git commit -m "feat: add manual update controls"
```

### Task 4: Make release artifacts updater-compatible and reproducible

**Files:**
- Modify: `electron-builder.yml`
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `scripts/write-release-checksums.mjs`
- Create: `scripts/write-release-checksums.test.ts`
- Create: `.github/workflows/windows-release.yml`
- Modify: `scripts/verify-windows-package.ps1`

**Step 1: Write failing checksum tests**

Verify deterministic sorting, SHA-256 formatting, exclusion of the checksum file itself, and rejection of an empty artifact set.

**Step 2: Run the focused test and confirm RED**

Run: `npx vitest run scripts/write-release-checksums.test.ts`

Expected: FAIL because the script does not exist.

**Step 3: Add fixed publish metadata and release automation**

- Configure electron-builder for GitHub owner `akina910`, repo `obs-stream-manager`, draft releases.
- Add a tag-triggered workflow that checks `v<package.version>`, creates/uses a draft, builds NSIS/Portable/ZIP, uploads updater metadata/blockmaps, writes checksums, verifies the unpacked ZIP, and publishes only after all steps pass.
- Do not create or push a tag in this implementation task.
- Bump the application version to `0.2.4` so the first updater-capable installer is distinguishable.

**Step 4: Harden packaged-output verification**

Require packaged `resources/app-update.yml` to point only at the fixed GitHub provider/owner/repo and reject embedded authentication material.

**Step 5: Run focused tests**

Run: `npx vitest run scripts/write-release-checksums.test.ts`

Expected: PASS.

**Step 6: Commit**

```powershell
git add electron-builder.yml package.json package-lock.json scripts/write-release-checksums.mjs scripts/write-release-checksums.test.ts scripts/verify-windows-package.ps1 .github/workflows/windows-release.yml
git commit -m "build: prepare signed manual update releases"
```

### Task 5: Update user and maintainer documentation

**Files:**
- Modify: `README.md`
- Modify: `README.en.md`
- Modify: `docs/DISTRIBUTION.md`

**Step 1: Add matching Japanese and English user instructions**

Document the manual settings/tray flow, installer behavior, Portable limitation, data preservation, safe activity blocking, and that no update is checked without a click.

**Step 2: Document the maintainer-only release process**

Separate tag/version/publish steps from end-user instructions. Explicitly state that provider credentials remain repository secrets and that ordinary users do not configure OAuth or update URLs.

**Step 3: Check all referenced commands and paths**

Run: `rg -n "更新|update|windows-release|SHA256|Portable" README.md README.en.md docs/DISTRIBUTION.md`

Expected: both languages and maintainer steps are present and consistent.

**Step 4: Commit**

```powershell
git add README.md README.en.md docs/DISTRIBUTION.md
git commit -m "docs: explain manual application updates"
```

### Task 6: Full validation, distribution build, and current-PC deployment

**Files:**
- Verify all modified files and generated artifacts under `release/` or the configured output directory.

**Step 1: Run the complete quality gate**

Run: `npm run check`

Expected: typecheck, lint, automated tests, production build, and secret contract checks all PASS.

**Step 2: Build Windows distributions**

Run: `npm run dist:win`

Expected: NSIS installer, Portable EXE, ZIP, and embedded fixed update configuration are generated without requiring a system Node.js runtime.

**Step 3: Validate packaged output**

Run the repository package verifier against the generated ZIP. Confirm loopback-only binding, single instance, clean shutdown, persistence, no secret backup leakage, OBS plugin compatibility, and fixed update provider metadata. If provider OAuth resources require repository-only credentials, run the existing `windows-distribution` GitHub workflow on this branch and validate its artifact instead of copying secrets locally.

**Step 4: Install the updater-capable build on this PC**

- Snapshot the running app's profile/settings/connection status without logging secrets.
- Gracefully stop only OBS Stream Manager when installation requires it; keep OBS/user work unaffected where possible.
- Install the verified `0.2.4` NSIS artifact.
- Start it and confirm the same settings/profiles/connection status are restored.
- Confirm manual update checking produces a friendly result when no public Release exists.

**Step 5: Re-run repository and history secret scans**

Run the existing secret checks plus the repository's history scan procedure. Treat unavailable live OAuth/provider checks as BLOCKED, never PASS.

**Step 6: Review, publish the branch, and integrate after checks**

Review the diff, commit any verification fixes, push the feature branch, run CI/distribution workflows, and merge to `main` only after required checks pass. Do not create a version tag or GitHub Release without a new explicit authorization.

**Step 7: Final evidence**

Report commits, changed files, generated artifact paths and hashes, checks run/results, installed version, preservation evidence, unverified live update path, and the exact remaining blocker (an authorized published Release newer than the installed version).
