# Changelog

## Unreleased

### Added

- Support dedicated Gemini 4 Argon weekly quota window (`gemini-argon-wtu-weekly`) when reported by Antigravity.

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
