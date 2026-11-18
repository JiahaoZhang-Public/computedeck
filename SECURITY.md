# Security policy

## Supported versions

ComputeDeck is in beta. Security fixes go into the latest minor release and the `main`
branch; older versions are not patched. Upgrade to the latest release (or `main` when
running from source) before reporting.

| Version | Supported |
|---|---|
| Latest minor release, and `main` | Yes |
| Anything older | No |

## Report a vulnerability privately

Use GitHub private vulnerability reporting: open the repository's **Security** tab and
choose **Report a vulnerability**
([direct link](https://github.com/JiahaoZhang-Public/computedeck/security/advisories/new)).
If that option is not shown, open a public issue that asks for a private contact and
contains no details of the problem.

Never put real credentials, configuration files, host names or collected data in a
report; describe the problem with fictional values. Include the ComputeDeck version, the
operating system, how ComputeDeck runs (on your computer, with routes, or on a server)
and the steps that show the problem. The discussion stays in the private advisory until a
fix is released; fixes are announced in the [changelog](CHANGELOG.md) and the advisory.

Problems in the [official plugins](https://github.com/JiahaoZhang-Public/computedeck-plugins)
go to that repository in the same way.

## In scope

- The service (`src/computedeck`): its HTTP API, access token and session handling,
  origin and host checks, file permissions in the data directory, and the commands it
  runs over SSH.
- The web app bundled in the package.
- Credential references and how they are resolved.
- Routes: what is sent to a jump host or a collection machine, and how `computedeck
  collect` handles a request.
- The plugin installer and marketplace handling, as far as ComputeDeck enforces them
  (pinned sources, policy, compatibility checks).
- The release packages and the workflows that build them.

Out of scope: weaknesses of a cluster, cloud provider or SSH server ComputeDeck connects
to; what an installed plugin does with the permissions it is given; anyone who can already
run commands as the user who runs ComputeDeck; and denial of service from the local machine.

## How ComputeDeck protects you

[Running ComputeDeck](docs/deployment.md#access-token) describes this in full.

- **Read-only.** The core only reads. It never submits or cancels jobs, starts or stops
  instances, or changes a cluster. SSH runs non-interactively with strict host-key
  checking, no forwarding and no terminal.
- **Loopback only.** The service listens on `127.0.0.1` and accepts only the host names
  `127.0.0.1` and `localhost`, which keeps other machines and DNS rebinding out.
- **Origin checks.** Changes are accepted only from ComputeDeck's own page (its Origin and
  an `X-ComputeDeck` header), which keeps other websites out.
- **Optional access token.** Loopback does not keep out other users of the same machine.
  With `COMPUTEDECK_AUTH=token`, every API request needs the token from
  `<data dir>/api-token` (mode 600). It never appears in a URL or on a command line, and
  cookies are not used.
- **Credentials by reference.** Sources store `env:`, `keychain:` or `file:` references.
  Secrets are resolved when needed and are not stored in the database, backups or exports;
  diagnostics redact them. The data directory is mode 700 and its logs mode 600.
- **Plugins are trusted code.** A plugin runs inside the service with the permissions of
  the user who runs ComputeDeck. Install only plugins you trust; an administrator can
  limit marketplaces and block plugins with `policy.toml`.

## What routes change

- **Jump host.** Collection still runs on your computer with your keys. The jump host
  forwards an SSH connection that stays encrypted from your computer to the target, so it
  sees only which host and port you connect to, when, and how much encrypted traffic
  passes. It never receives your keys or credentials. Host keys of both the jump host and
  the target are checked against your computer's `known_hosts`.
- **Collection machine.** ComputeDeck on that machine receives the source's connection
  settings (alias, username, options and credential reference, never a secret) on
  standard input, resolves the credential there with that machine's stores, collects, and
  returns the result. Anyone who controls that machine or its user account can see what it
  collects and can use the credentials stored there. Use a machine and account you trust.
- **Server with `computedeck connect`.** The browser reaches the server only through an
  SSH tunnel to its loopback port. Turn on the access token on a server other people can
  log in to.
