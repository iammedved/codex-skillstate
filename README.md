# Codex Skillstate

Experimental fresh-context runtime for long Codex tasks. It keeps a bounded current state outside the parent chat, starts new controller or worker processes for bounded stages, validates state transitions, and writes local audit receipts.

It is not a claim that Codex App history is erased or that token use is reduced. Compatibility with a particular Codex App/CLI build must be smoke-tested locally.

## Install as a Codex plugin

After the public repository and tag exist:

```bash
codex plugin marketplace add iammedved/codex-skillstate --ref v0.2.0-experimental
```

In Codex, install **Codex Skillstate**, restart Codex App, then start a new chat. The bundled `UserPromptSubmit` hook automatically routes long, multi-stage prompts to `$skillstate-runtime`, and the Skill permits implicit invocation. Short or one-step requests receive no hook context.

The routing stays inside Codex: the hook never starts a process, edits a file, grants authority, or blocks a chat. For a critical task, explicitly invoking `skillstate-runtime` remains the clearest choice.

## Install the local runtime globally (Linux)

From a complete checked-out release, with Node.js 20 or newer:

```bash
node scripts/install-personal.mjs --runtime-only
skillstate --help
```

For Codex App plugin users, `--runtime-only` is the correct global installation: it copies the release to `~/.local/share/codex-skillstate/0.2.0-experimental` and creates `~/.local/bin/skillstate`, without creating a second personal copy of the Skill. The installer recognizes any prior managed Skillstate marker, stages the new runtime before switching it in, and keeps replaced managed copies as timestamped backups.

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

Use `hybrid` mode for normal multi-step development: each controller and each bounded worker stage starts fresh, while a worker may use several tools during its stage. Use `strict` mode for controlled experiments or maximum step-by-step context separation. The exact commands are available via `skillstate --help`.

Skillstate is not an authorization mechanism. Version 0.2.x always refuses push, PR creation or merge, deploy, publish, messages, payments, production changes, and credential changes. An authorized external effect must happen as a separate reviewed step. An interrupted action is quarantined; inspect the working tree and confirm recovery before proceeding.

## Scope and caveats

This `0.2.0-experimental` release uses only Node.js standard-library code. Its 49 automated tests exercise the internal protocol, packaging metadata, hook routing, installer upgrades, and fake-Codex integration. A strict read-only smoke test also passed on Codex CLI `0.147.0`: two fresh controller processes completed the task, the audit chain verified, and tracked workspace content stayed unchanged. Other host builds should repeat that smoke test before relying on it for operational work.

Paused `0.1` runs are not migrated to protocol `0.2`; finish or recover them with the preserved `0.1.0-experimental` runtime before starting a new `0.2` run.

## Кратко по-русски

Skillstate переносит длинную работу во внешний локальный runtime с ограниченным `state.json`, свежими controller/worker-вызовами и audit receipts. Для обычной разработки выбирайте `hybrid`, для строгого эксперимента — `strict`. Он не стирает историю текущего чата и не даёт новых полномочий: публикация, push, deploy и другие внешние действия остаются отдельным подтверждаемым шагом.

## License

[MIT](LICENSE)
