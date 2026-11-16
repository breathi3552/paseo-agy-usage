# Paseo Antigravity Usage

View Antigravity CLI (`agy`) quota remaining and reset times in Paseo.

![Antigravity usage card](./assets/marketplace/usage-dark.png)

## Install

```bash
paseo plugin add git:breathi3552/paseo-agy-usage
```

Requires Paseo >= 0.11.0 and a local `agy` login; Linux also requires `secret-tool` and an unlocked system keyring.

## Headless Linux

`agy` keeps its login in the Secret Service, so the plugin reads it with `secret-tool`. A daemon that
was not started from a login session (systemd service, container, `nohup`) has no session bus; the
plugin then derives `DBUS_SESSION_BUS_ADDRESS` from `XDG_RUNTIME_DIR`, falling back to
`/run/user/<uid>`. That socket only exists while your user session is running, so enable lingering:

```bash
loginctl enable-linger "$USER"
```

Keep the file fallback as a last resort: write the CLI token to
`~/.gemini/antigravity-cli/antigravity-oauth-token`.

## Development

```bash
npm ci
npm test
paseo plugin install .
```

## License

[MIT](./LICENSE)
