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


## Diagnose and repair a connection

Open a source diagnosis and choose **Test connection**. Steps update as they run; a failed
step explains what to check next. A suggested SSH command runs `true` only. Confirm a changed
host key with its administrator before updating `known_hosts`; do not disable host checks.
Closing the diagnosis cancels the active request. Opening the diagnosis alone runs no checks.

Use **Edit connection or credential reference** to change the source. Update the secret in
its configured credential store; the dashboard only stores the reference. A successful
reference lookup proves that the service can read it, not that the provider accepts it.
After saving, the form waits for a new collection and reports that result separately.
**Collect now** can confirm recovery after a network or credential repair.

中文：连接检查逐步显示结果，失败步骤提供对应建议。密码或密钥在其原有存储中更新，
来源只保存引用。保存配置、读取凭据、认证成功与采集恢复是不同结果；修改后以新一轮采集
为准。关闭诊断会取消当前检查，打开诊断本身不会发起连接。
