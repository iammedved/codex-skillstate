# Codex Skillstate

Experimental fresh-context runtime for long Codex tasks. It keeps a bounded current state outside the parent chat, starts new controller or worker processes for bounded stages, validates state transitions, and writes local audit receipts.

It is not a claim that Codex App history is erased or that token use is reduced. Compatibility with a particular Codex App/CLI build must be smoke-tested locally.

## Install as a Codex plugin

After the public repository and tag exist:

```bash
codex plugin marketplace add iammedved/codex-skillstate --ref v0.1.0-experimental
```

In Codex, install **Codex Skillstate**, start a new chat, then confirm that `skillstate-runtime` appears in the skills list. Explicitly invoke it for critical work; host-side implicit selection is not guaranteed.

## Install the local runtime globally (Linux)

From a complete checked-out release, with Node.js 20 or newer:

```bash
node scripts/install-personal.mjs
skillstate --help
```

The installer copies the release to `~/.local/share/codex-skillstate/0.1.0-experimental`, creates `~/.local/bin/skillstate`, and installs the Agent Skill at `~/.agents/skills/skillstate-runtime`. It refuses to replace paths it does not manage and keeps prior managed copies as timestamped backups.

To remove only this managed version:

```bash
node scripts/uninstall-personal.mjs
```

## When to use it

Use `hybrid` mode for normal multi-step development: each controller and each bounded worker stage starts fresh, while a worker may use several tools during its stage. Use `strict` mode for controlled experiments or maximum step-by-step context separation. The exact commands are available via `skillstate --help`.

Skillstate is not an authorization mechanism. Version 0.1.x always refuses push, PR creation or merge, deploy, publish, messages, payments, production changes, and credential changes. An authorized external effect must happen as a separate reviewed step. An interrupted action is quarantined; inspect the working tree and confirm recovery before proceeding.

## Scope and caveats

This `0.1.0-experimental` release uses only Node.js standard-library code. Its 22 automated tests exercise the internal protocol, including fake-Codex integration. A strict read-only smoke test also passed on Codex CLI `0.147.0`: two fresh ephemeral controller processes read a disposable repository, recorded real token usage and a valid audit chain, and left the Git tree unchanged. Other host builds should repeat that smoke test.

## Кратко по-русски

Skillstate переносит длинную работу во внешний локальный runtime с ограниченным `state.json`, свежими controller/worker-вызовами и audit receipts. Для обычной разработки выбирайте `hybrid`, для строгого эксперимента — `strict`. Он не стирает историю текущего чата и не даёт новых полномочий: публикация, push, deploy и другие внешние действия остаются отдельным подтверждаемым шагом.

## License

[MIT](LICENSE)
