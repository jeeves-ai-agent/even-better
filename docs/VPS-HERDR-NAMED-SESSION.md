# VPS deployment with a named Herdr session

This recipe runs even-better as a hardened systemd service, mirrors agents from
a named Herdr session, and exposes the even-terminal API through an existing
HTTPS reverse proxy. It uses Bun; npm is not required.

## 1. Install and verify

```bash
bun install
bun run check
bun run test
```

## 2. Named Herdr socket

Start or verify the named Herdr server:

```bash
herdr --session jeeves server
herdr --session jeeves status server
```

Set `HERDR_SOCKET` to that session's socket. Without it, even-better uses the
default unnamed Herdr socket.

## 3. Install transcript hooks

The hooks report the Claude/Codex session id and transcript path. Without them,
prompts can reach the pane, but assistant text may not stream to the glasses.

```bash
mkdir -p ~/.config/even-better/backups
cp -a ~/.claude/settings.json ~/.config/even-better/backups/ 2>/dev/null || true
bun src/index.ts hook-install
```

Restart already-running agent panes after installing hooks.

## 4. Environment file

Create `~/.config/even-better/env` with mode `0600`:

```dotenv
HOME=/home/ubuntu
PATH=/home/ubuntu/.local/bin:/home/ubuntu/.bun/bin:/usr/local/bin:/usr/bin:/bin
MUX=herdr
HERDR_SOCKET=/home/ubuntu/.config/herdr/sessions/jeeves/herdr.sock
SELF_HOOK=1
PORT=3456
BIND_HOST=local
PUBLIC_BASE_URL=https://example.com/terminal
BRIDGE_TOKEN=REPLACE_WITH_A_RANDOM_64_HEX_TOKEN
QR=1
LOG=normal
LOG_FILE=/home/ubuntu/.local/state/even-better/events.log
```

Generate a token with `openssl rand -hex 32`. Never commit the real env file or
its QR code; the token can drive a coding agent and should be treated like shell
access.

## 5. systemd service

Copy `deploy/even-better.service.example` to
`/etc/systemd/system/even-better.service`, adjust paths if needed, then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now even-better
systemctl is-active even-better
```

The unit grants write access to `~/.even-better` because the self-hook endpoint
creates `~/.even-better/hook.sock`. Omitting it while `ProtectHome=read-only` is
set causes `EROFS`. If a manual test process crashed, a stale socket can cause
`EADDRINUSE`; stop the service, remove the stale socket, then start it again.

## 6. Caddy reverse proxy

```caddyfile
handle_path /terminal/* {
    reverse_proxy 127.0.0.1:3456 {
        transport http {
            dial_timeout 10s
            read_timeout 24h
            write_timeout 24h
        }
    }
}
redir /terminal /terminal/ 308
```

The long timeouts keep the Server-Sent Events stream alive. Validate and reload:

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

## 7. Smoke test

```bash
source ~/.config/even-better/env
curl -H "Authorization: Bearer $BRIDGE_TOKEN" \
  "$PUBLIC_BASE_URL/api/sessions"

curl -N -H "Authorization: Bearer $BRIDGE_TOKEN" \
  "$PUBLIC_BASE_URL/api/events?sessionId=<pane-id>"
```

In another shell, POST a prompt. A complete stream should include
`user_prompt`, `status:busy`, `text_delta`, `result`, then `status:idle`.

## Bun test command pitfall

Use `bun run test`. Running `bun test scripts/test-*.ts` treats the expanded file
names as test-name filters and may report that no files matched.

## Security

- Bind even-better to loopback and terminate TLS at the reverse proxy.
- Keep `BRIDGE_TOKEN` and generated QR codes out of Git.
- Set service stdout to null (or another protected sink) so the QR carrying the
  token is not persisted in journald.
- Consider a second authentication layer, such as Cloudflare Access, for
  long-lived public exposure.

Related documents: [MULTIPLEXERS.md](MULTIPLEXERS.md),
[TROUBLESHOOTING.md](TROUBLESHOOTING.md), and [PROTOCOL.md](PROTOCOL.md).
