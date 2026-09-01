---
name: skillstate-runtime
description: "Use the installed Skillstate runtime for long, multi-stage Codex work that benefits from fresh controller or worker contexts, bounded state, audit receipts, and explicit authority boundaries. Do not use for greetings, one-step answers, or ordinary small edits."
---

# Skillstate Runtime

For a long or interruption-prone task, use the external `skillstate` executable rather than trying to make the parent chat history into durable state. Start with `skillstate doctor --workspace <path>` and use the documented CLI commands. The plugin may select this Skill implicitly for multi-stage prompts; do not require the user to name it. Return only the verified outcome, current state, and blockers to the parent chat.

## Modes

- `hybrid` is the normal development mode. Controllers and bounded workers start fresh between stages, while a worker may use several tools within its stage.
- `strict` is for controlled experiments or when every controller step must have a fresh context and exactly one bounded runtime action. It is more restrictive and slower.

Neither mode removes or changes the parent chat history. The host keeps that history; the runtime limits what it passes to its fresh processes.

## Authority and safety

Treat the runtime as a control layer, not extra permission. Follow the task's existing authority, route, and workspace boundaries. Version 0.2.x always refuses external or irreversible effects, including push, pull-request creation or merge, deploy, publish, messages, payments, production changes, and credential changes. Even when the user authorizes one of those effects, perform it separately from Skillstate after reviewing its local result.

Do not replay an interrupted action automatically. Inspect the working tree and use `skillstate recover --workspace <path>` to review quarantine; use `--confirm` only after user confirmation. Do not place credentials, secrets, raw chat history, or unbounded logs in task state.

## Useful commands

```bash
skillstate run --workspace <path> --task-file <file> --mode hybrid --sandbox workspace-write
skillstate run --workspace <path> --resume
skillstate show --workspace <path>
skillstate audit-verify --workspace <path>
```

Use `--controller pinmind --pinmind-path <path>` only when a verified local Pinmind installation is intentionally in scope. A runtime audit receipt is local evidence, not proof that a host action occurred unless an authoritative receipt says so.
