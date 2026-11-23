# Deployment

The gateway speaks plain HTTP and expects a reverse proxy in front of it to provide HTTPS. Bearer
tokens and provider traffic must never cross an untrusted network unencrypted. This is built for one
owner's private use, not as a multi-tenant public service.

What CI verifies about deployment: the gateway bundle builds, starts and answers `/health`. The steps
below, and the proxy configurations, are not exercised by any automated test.

## 1. Build and install

The `Build gateway` job uploads the bundle as the `gateway-dist` artifact. To build it yourself on a
machine with Node 20.19 or newer:

```sh
npm ci
npm run build:gateway          # writes backend/gateway/dist/server.js
```

The bundle contains the workspace code. `fastify`, `@modelcontextprotocol/sdk` and `zod` are not
inlined, so they must be installed on the host from the committed lockfile (`npm ci --omit=dev` in a
checkout of this repository).

## 2. Configure

Set the variables from `.env.example` in the host's environment or secret manager. For a deployment
behind a proxy:

| Variable | Value |
| --- | --- |
| `NODE_ENV` | `production` |
| `HOST` | `127.0.0.1`, so only the proxy can reach the gateway |
| `TRUST_PROXY` | `true`, so rate limits and lockouts see the real client address. Requires the proxy on the same host |
| `GATEWAY_ADMIN_TOKEN`, `GATEWAY_TOKEN_*` | Long random values (`openssl rand -hex 32`), all different |
| `*_API_KEY`, `*_MODEL` | See [PROVIDERS.md](PROVIDERS.md) |
| `DASHBOARD_ORIGIN` | The dashboard's origin, only if it is served from another host |

Set `TRUST_PROXY=true` **only** when the gateway is reachable exclusively through a proxy running on the
same host. The gateway then reads `X-Forwarded-For` only from connections that come from loopback and
uses the rightmost address that is not loopback. If the proxy is on another machine, every client will
look like that machine and share one limit, so this setup is not supported yet.

## 3. Run

```sh
node backend/gateway/dist/server.js
```

Run it under a process manager that restarts it and keeps its environment private (for example a
systemd unit with `EnvironmentFile` readable only by the service user). A restart ends all sessions and
resets provider state, usage counters, audit events and rate-limit windows.

## 4. Put HTTPS in front

### Caddy

`deploy/Caddyfile` is a complete example. Caddy obtains and renews the certificate automatically, adds
`X-Forwarded-For`, and caps the request body.

### nginx

```nginx
server {
    listen 443 ssl;
    http2 on;
    server_name gateway.example.com;

    ssl_certificate     /etc/letsencrypt/live/gateway.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/gateway.example.com/privkey.pem;

    client_max_body_size 256k;
    add_header Strict-Transport-Security "max-age=31536000" always;

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_read_timeout 60s;
    }
}

server {
    listen 80;
    server_name gateway.example.com;
    return 301 https://$host$request_uri;
}
```

Set `X-Forwarded-For` to `$remote_addr` rather than appending to the incoming header, so a client cannot
prepend a forged address.

## 5. Check

```sh
curl https://gateway.example.com/health
curl -X POST -H "Authorization: Bearer $GATEWAY_ADMIN_TOKEN" \
  https://gateway.example.com/api/providers/anthropic/verify
```

The dashboard (static files from `npm run build:dashboard`) can be served by the same proxy or any
static host. A dashboard served over HTTPS cannot call a gateway over plain HTTP.

## Not provided

No container image, no firewall rules, no log shipping, no backups (there is nothing persistent to back
up yet), and no multi-instance setup: sessions, audit events and rate limits are per process.
