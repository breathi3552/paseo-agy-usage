# Changelog

## 0.1.3, 2026-11-17

### Fixed

- Connect to the Linux keyring on headless hosts. When Paseo runs without `DBUS_SESSION_BUS_ADDRESS`, `secret-tool` and `agy models` now read the session bus socket from `XDG_RUNTIME_DIR` or `/run/user/<uid>` (thanks @magicbear, #4).
- Read CLI token files such as `~/.gemini/antigravity-cli/antigravity-oauth-token` when the OS keyring is unavailable or holds an expired token, and extract the account email from `id_token_email` (thanks @magicbear, #4).

## 0.1.2, 2026-11-10

### Added

- Add the Gemini 4 Argon weekly window when the quota summary reports the `gemini-argon-wtu-weekly` bucket (thanks @gtoxlili, #3).
- Locate the `agy` binary across Windows, macOS, and Linux from `ANTIGRAVITY_CLI_PATH`, `AGY_PATH`, `~/.paseo/config.json`, and standard install directories (inspired by @LunabellaBetter, #1).

## 0.1.1, 2026-10-18

### Fixed

- Match Gemini quotas and reset times to `agy /usage` by sending the installed CLI version in the `User-Agent` header to `daily-cloudcode-pa.googleapis.com`.
- Renew logins once with `agy models` when a token expires, is missing, or returns HTTP 401 or 403. Bound each refresh to 18 seconds and strip command output from errors.
- Read Windows credentials with `powershell.exe` instead of `pwsh`, and run child processes with `execCommand()` from `@getpaseo/plugin/server`.

## 0.1.0

### Added

- Register the `antigravity` usage source for Paseo 0.11.0 and later.
- Report Gemini and Claude & GPT quotas for the 5-hour and weekly windows, with reset times and plan labels.
- Discover local `agy` logins and display the account email in the card footer.
- Read credentials from Windows Credential Manager, macOS Keychain, and Linux Secret Service without redeeming refresh tokens directly.
- Add unit tests, GitHub Actions CI, and the release workflow.
