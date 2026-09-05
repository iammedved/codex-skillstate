# Codex Skillstate

Experimental bounded state layer for long Codex tasks. In the recommended setup, Pinmind remains the controller and asks Skillstate to record passive, hashed checkpoints. The older fresh-context controller remains available only for manual experiments.

It is not a claim that Codex App history is erased or that token use is reduced. Compatibility with a particular Codex App/CLI build must be smoke-tested locally.

## Install as a Codex plugin

After the public repository and tag exist:

```bash
codex plugin marketplace add iammedved/codex-skillstate --ref v0.2.2-experimental
```

In Codex, install **Codex Skillstate** together with Pinmind, restart Codex App, then start a new chat. Skillstate has no autonomous prompt hook and cannot implicitly become a second controller. Pinmind decides when a task needs durable state and calls `skillstate checkpoint` at clean phase boundaries.

## Install the local runtime globally (Linux)

From a complete checked-out release, with Node.js 20 or newer:

```bash
node scripts/install-personal.mjs --runtime-only
skillstate --help
```

For Codex App plugin users, `--runtime-only` is the correct global installation: it copies the release to `~/.local/share/codex-skillstate/0.2.2-experimental` and creates `~/.local/bin/skillstate`, without creating a second personal copy of the Skill. The installer recognizes any prior managed Skillstate marker, stages the new runtime before switching it in, and keeps replaced managed copies as timestamped backups.

Use `--with-skill` only when using the CLI without the Codex plugin:

```bash
node scripts/install-personal.mjs --with-skill
```

To remove only this managed version:

```bash
node scripts/uninstall-personal.mjs
```

To remove a legacy personal Skill installed with `--with-skill`, add `--with-skill` to the uninstall command.

## When to use it

Use `skillstate doctor --workspace <path> --pinmind-run <run-id>` before `skillstate checkpoint --workspace <path> --pinmind-run <run-id>` when Pinmind selects durable state. The default doctor checks the local Node runtime, workspace path and permissions, and the active Pinmind state; it does not probe Codex. Use `doctor --controller codex` or `doctor --controller pinmind --pinmind-path <path>` only for the separate legacy-controller diagnostics.

Repeating a verified unchanged checkpoint is idempotent. `checkpoint-verify` reports `missing`, `valid-current`, `valid-stale`, `foreign-run`, or `invalid`, and checks the checkpoint format, source binding, and journal linkage. A valid stale checkpoint remains historical evidence rather than corruption. If an interruption leaves `checkpoint.pending.json`, inspect `checkpoint-verify` and run `skillstate checkpoint-recover --workspace <path>` only when it reports the matching local transaction; recovery completes checkpoint metadata only and never repeats a user action. Checkpoint data stays under the workspace's ignored `.pinmind/skillstate/` directory, so ordinary workspace-write sandboxes need no home-directory permission. The legacy `hybrid` and `strict` controller modes are manual only and must not run beneath Pinmind.

Skillstate is not an authorization mechanism. Version 0.2.x always refuses push, PR creation or merge, deploy, publish, messages, payments, production changes, and credential changes. An authorized external effect must happen as a separate reviewed step. An interrupted action is quarantined; inspect the working tree and confirm recovery before proceeding.

## Scope and caveats

This `0.2.2-experimental` release uses only Node.js standard-library code. Its 51 automated tests exercise workspace-local passive Pinmind checkpoints, no-progress protection, the internal protocol, packaging metadata, installer upgrades, and fake-Codex integration. A strict read-only smoke test previously passed on Codex CLI `0.147.0`; other host builds should repeat that smoke test before relying on the legacy controller for operational work.

Paused `0.1` runs are not migrated to protocol `0.2`; finish or recover them with the preserved `0.1.0-experimental` runtime before starting a new `0.2` run.

## Кратко по-русски

В рекомендуемой схеме Pinmind управляет задачей, а Skillstate пассивно сохраняет хешированные контрольные точки. Он не запускается сам, не выбирает следующий шаг и не даёт новых полномочий. Старые controller/worker-режимы оставлены только для ручных экспериментов.

## License

[MIT](LICENSE)
