# Diagnose a connection

```bash
computedeck doctor
computedeck doctor --source cluster-a-alice
computedeck doctor --language zh-CN
computedeck --data-dir ./example-data doctor --port 8710 --json
```

`doctor` checks the service data-directory permissions, port, installed plugin compatibility
and enabled sources. `--source` also permits checking a configured source that is disabled.
The command returns 1 if a required check fails and 0 otherwise; optional unavailable
commands are marked MISSING rather than treated as a failed connection.

For SSH sources it checks that OpenSSH exists, the alias can be resolved from SSH configuration,
BatchMode login works, and the scheduler's commands are on the non-interactive PATH. Host-key
checking stays strict. A ProxyJump or ProxyCommand may resolve its destination on a jump host;
those destinations are tested by the SSH connection rather than by local DNS.

Credential references are resolved without printing their values or resolver exceptions.
Check environment references in the service's environment, not only in your interactive shell.
Sources assigned to collection nodes are checked on those nodes through the existing read-only
collection protocol. If that fails, run doctor on the collection node to inspect its local setup.

The Sources page's **Test connection** button and the initial connection dialog use the same
diagnostic labels and repair messages as this command, in English or Chinese. A successful
command-presence check does not guarantee scheduler permissions; the first collection reports
which data can actually be read. Missing optional history or inventories remain informational.

Existing databases are opened read-only. Doctor does not install an SSH key, accept a host key,
change a source, repair permissions or restart a service. Installed plugins are trusted Python
code and may be imported to register their credential resolvers. A port is considered usable
if it is free or already answers as ComputeDeck; no credential is sent to identify a listener.
