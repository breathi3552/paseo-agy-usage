# Changelog

## Unreleased

### Fixed

- Read the Linux keyring from headless hosts: when the Paseo daemon runs as a system service, container, or any process without `DBUS_SESSION_BUS_ADDRESS`, `secret-tool` used to fail with “Cannot autolaunch D-Bus without X11 $DISPLAY”, so the usage account silently disappeared from the native Usage settings. Both the credential reader and the `agy models` renewal now derive the session bus from `XDG_RUNTIME_DIR`, falling back to `/run/user/<uid>`, and only when that socket exists.
- Fall back to CLI-written token files when the OS keyring is unavailable, and read the account email from `id_token_email`.

## 0.1.2 — 2026-11-10

### Added

- Gemini 4 Argon weekly window for logins whose quota summary reports the separate Argon pool (thanks @gtoxlili, #3).
- Robust multi-platform Antigravity CLI binary resolution across Windows, macOS, and Linux, supporting custom environment variables, Paseo host configuration, and standard installation paths (inspired by @LunabellaBetter, #1).

## 0.1.1 — 2026-10-18

### Fixed

- Match Gemini quotas and reset times to `agy /usage` using the CLI service endpoint and installed CLI version.
- Attempt login renewal once via `agy models` for expired credentials, missing access tokens, or HTTP 401/403, then reload credentials and quotas. Requests have an 18-second deadline and sanitized errors; opening the popover remains subject to host caching.
- Use built-in Windows PowerShell 5.1 instead of requiring PowerShell 7, and reuse the public Paseo SDK's `execCommand()`. macOS/Linux readers are unchanged; no new runtime dependencies.

## 0.1.0

### Added

- Native Antigravity usage source for Paseo 0.11+.
- Gemini and Claude & GPT quotas with 5-hour and weekly windows, reset times, and subscription labels.
- Automatic CLI and OS-login discovery with an account-email footer.
- Read-only credential access, CLI-managed login renewal, and sanitized error diagnostics.
- Windows Credential Manager, macOS Keychain, and Linux Secret Service adapters. Windows has live-host verification.
- Behavior-focused tests, CI, and a GitHub-only release workflow.
- An Antigravity mark above an outlined progress bar, with monochrome and flat terracotta listing icons.
- A redacted screenshot of the native Usage card, included in the README and plugin listing media.
