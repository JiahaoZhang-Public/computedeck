# Changelog

## 0.3.0 (unreleased)

- Verify Slurm QoS association access and separate unknown or unassociated planner choices.
- Distinguish optional capabilities from source failures; surface unavailable and degraded clusters.
- Count an SSH GPU as in use when it has compute processes; preserve unknown process visibility.
- Rotate service logs and restrict data-directory and log permissions at startup.
- Provide isolated plugin files, JSON state, SQLite transactions and strict SSH execution in the SDK.
- Add shared CLI and web connection diagnostics with repair guidance and credential redaction.
- Recognize the official plugin marketplace and show its copyable add command.
