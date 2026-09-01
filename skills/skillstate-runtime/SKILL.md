---
name: skillstate-runtime
description: "Record passive, bounded checkpoints for a Pinmind-controlled long task. Invoke only when Pinmind selects durable state; Skillstate must not become a second workflow controller."
---

# Skillstate Runtime

Pinmind is the sole workflow controller. When Pinmind selects durable state, start with `skillstate doctor --workspace <path>`, then record the already-validated Pinmind state with `skillstate checkpoint --workspace <path> --pinmind-run <run-id>` at clean phase boundaries. Skillstate stores hashes and bounded metadata; it does not route the task, decide the next action, or spawn a second controller.

## Modes

- `hybrid` is the normal development mode. Controllers and bounded workers start fresh between stages, while a worker may use several tools within its stage.
- `strict` is for controlled experiments or when every controller step must have a fresh context and exactly one bounded runtime action. It is more restrictive and slower.

Neither mode removes or changes the parent chat history. The host keeps that history; the runtime limits what it passes to its fresh processes.

## Authority and safety

Treat the runtime as a control layer, not extra permission. Follow the task's existing authority, route, and workspace boundaries. Version 0.2.x always refuses external or irreversible effects, including push, pull-request creation or merge, deploy, publish, messages, payments, production changes, and credential changes. Even when the user authorizes one of those effects, perform it separately from Skillstate after reviewing its local result.

Do not replay an interrupted action automatically. Inspect the working tree and use `skillstate recover --workspace <path>` to review quarantine; use `--confirm` only after user confirmation. Do not place credentials, secrets, raw chat history, or unbounded logs in task state.

## Useful commands

```bash
skillstate checkpoint --workspace <path> --pinmind-run <run-id>
skillstate checkpoint-show --workspace <path>
skillstate audit-verify --workspace <path>
```

The legacy `skillstate run` controller remains experimental and manual; never use it inside a Pinmind-controlled task. A checkpoint is local evidence, not proof that a host action occurred unless an authoritative receipt says so.
