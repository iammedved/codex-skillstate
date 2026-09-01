# Security policy

Codex Skillstate is experimental. Do not report vulnerabilities in public issues if they could expose credentials, local paths, task data, or a bypass of authority controls.

Use GitHub's private vulnerability-reporting feature for `iammedved/codex-skillstate` when it is enabled. Otherwise, open a minimal public issue requesting a private contact channel; include no exploit details or sensitive data.

The runtime is a local control layer. It does not grant permission for external or irreversible actions, and it must not be used to store secrets in state or audit files.
