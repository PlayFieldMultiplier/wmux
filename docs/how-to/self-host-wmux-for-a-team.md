# How to self-host wmux for a team

> **Goal:** run one isolated wmux per person on a shared Linux server, so each
> person opens their own terminals and agents from a browser and installs
> nothing on their own machine. People sign in with the company's OIDC
> provider, and each can reach only their own instance.

The files are in [`deploy/docker/`](../../deploy/docker/):

- `Dockerfile`: one user's headless wmux (daemon and `wmux web`) on Debian 12,
  built from a released `wmux-server` tarball. The download is checked against
  the release's `.sha256` file and, when you pass `WMUX_SHA256`, against a hash
  you pinned yourself.
- `compose.example.yaml`: Traefik, oauth2-proxy and one container per person.

## What you get

- **One container per person.** Each has its own home volume (terminals,
  `~/.wmux`, the `~/.claude` login, repositories), its own network and its own
  wmux token. Containers cannot reach each other: only Traefik joins every
  user network.
- **Limits.** Each container runs as an unprivileged user with every Linux
  capability dropped, `no-new-privileges`, and CPU, memory and process caps.
  No user container gets the Docker socket, and Traefik reaches Docker only
  through a filtering proxy that allows read-only container listing.
- **Sign-in.** Every request first needs a company sign-in through
  oauth2-proxy. A per-user rule then admits only that person's address, so a
  signed-in colleague who opens someone else's address gets `403`.
- **Agents.** Claude Code is installed into the home volume on first start,
  and wmux's Claude Code hooks are installed with it, so tool approvals reach
  the browser. Each person signs in to their own Claude account in their own
  terminal. Never share one account between containers.

## Prerequisites

- A Linux server with Docker and Docker Compose.
- A DNS name per person under one domain, for example
  `alice.wmux.example.com`, pointing at the server. For a server reachable only
  over a VPN, the names can resolve to a private address. Use a DNS-challenge
  certificate so the certificate stays publicly trusted.
- An OIDC client at your identity provider, with the redirect URI
  `https://<person>.<domain>/oauth2/callback` for each person.

## Steps

1. **Copy the user blocks.** In `compose.example.yaml`, keep one service per
   person (`alice` and `bob` are examples). For each person, set:
   - their host name;
   - the `allowed_emails` address in their `-only` middleware;
   - their own network and volume.

   Add each new network to Traefik's `networks`.

2. **Configure TLS.** Uncomment the `certresolver` lines and set Traefik's
   ACME DNS-challenge provider, or point Traefik at certificates you already
   have.

3. **Start it.**

   ```bash
   cd deploy/docker
   export WMUX_DOMAIN=wmux.example.com
   export OIDC_ISSUER_URL=https://login.example.com
   export OIDC_CLIENT_ID=... OIDC_CLIENT_SECRET=...
   export OAUTH2_PROXY_COOKIE_SECRET=$(openssl rand -hex 16)
   docker compose -f compose.example.yaml up -d --build
   ```

   Both oauth2-proxy secrets reach it as compose secret files, not as flags
   or container environment. To build another wmux release, or to pin the
   tarball's hash, also export `WMUX_VERSION` and `WMUX_SHA256` before
   `up`; the compose file passes them to the build.

4. **Hand out each person's address.** On its first start, each container
   creates one terminal and logs the address to open:

   ```bash
   docker compose -f compose.example.yaml logs alice | grep 'wmux is ready'
   ```

   Send each person their own line privately. The token in it is that
   person's wmux secret.

5. **First visit.** The person first opens their address without the token
   (`https://alice.wmux.example.com/`) and signs in with the company account.
   Then they open the token address from step 4 and land in their terminal.
   Signing in first matters: a token in the address during sign-in travels to
   the identity provider inside the return address. Sign-ins expire (after a
   week by default), so whenever the sign-in page appears, open the address
   without the token first. To use Claude Code, they run
   `claude` and finish the sign-in once. The login is kept in their volume.

## Things to know

- **Two secrets.** The company sign-in decides who may reach an address. The
  wmux token is still needed behind it, which is why step 4 exists.
- **No device pairing.** Inside the container `wmux web` serves plain HTTP on
  that person's private network, behind Traefik's TLS. wmux refuses to mint
  long-lived device credentials over plain HTTP, so phones and browsers use
  the token address instead of a pairing code.
- **The host administrator can see everything.** Anyone with root on the
  server can read every volume, including each `~/.claude` login. Tell users,
  and keep administrator access small.
- **Cloud metadata.** User containers can reach the host's network,
  including a cloud provider's metadata address (`169.254.169.254`). On a
  cloud VM, block it for the user networks with a host firewall rule, or any
  user can read the VM's cloud credentials.
- **Restarts.** Restarting a container keeps the token, the terminal list and
  the Claude Code install. Processes that were running in its terminals end.
- **Adding people.** Each new person means another service block, plus
  their network in Traefik's list, which recreates Traefik. Containers share
  the host kernel, so the server assumes nobody on it will try to break out of
  a container. Give people you do not trust separate virtual machines.
