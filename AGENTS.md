# @marianmeres/send-email — Agent Guide

Lowest-layer, dependency-light "send an email" path: a provider-agnostic
transport interface + a nodemailer SMTP transport + a mock transport + a
one-shot `send()` + a first-class CLI. **Not** an email system (no queue,
persistence, templating, retries, DB).

## Quick Reference

- **Stack**: TypeScript (erasable-only), Node LTS (`.node-version`), pnpm, `node:test`,
  Biome. One runtime dependency: `nodemailer`.
- **Install**: `pnpm install` | **Test**: `pnpm test` | **Check all**: `pnpm run ci` |
  **Build**: `pnpm run build`
- **Distribution**: one source, two registries. npm gets `dist/` (ESM + `.d.ts`): the
  library (`.` → `mod.ts`) and the `send-email` bin (`bin.ts`). JSR (`jsr.json`) gets
  the `.ts` source with `main.ts` as its export (library + CLI via `import.meta.main`),
  for the Deno consumers that import it via `jsr:`.
- **Deno lane** (JSR only): `pnpm run test:deno` (suite on Deno, CLI e2e through
  `main.ts`), `pnpm run jsr:check` (publish dry run). Not in CI; `publish:jsr` runs
  `test:deno` first.

## Architecture & layering

```
@marianmeres/send-email   ← THIS PACKAGE (bottom layer): transport interface +
        ▲                   nodemailer transport + mock + send() + CLI. No app deps.
        │ consumed by
higher-level email systems ← the email SYSTEM layer (service/queue/DB/templating).
                            A consumer's SMTP transport shrinks to a thin adapter onto
                            this package's send(); nodemailer moves down here.
```

This repo's deliverable is ONLY send-email. Do **not** edit downstream consumers
from here. Do **not** merge message types with a consumer (this package is clean
camelCase; a consumer's payload may be snake_case / DB-coupled).
Vocabulary: the adapter is a **"transport"**, never "adapter".

## Project Structure

```
src/
  types.ts                 SendOptions, EmailAttachment, SendResult, EmailTransport
  transport-nodemailer.ts  createNodemailerTransport, NodemailerTransportOptions,
                           PROVIDER_OPTION_WHITELIST, internal _toTransportConfig /
                           _toNodemailerMessage (pure mappers, exported for tests)
  transport-mock.ts        createMockTransport (records sends; deterministic ids)
  send-email.ts            send(message, { transport } | { smtp })
  env.ts                   resolveSmtpOptions(env), SmtpEnvError, EnvGetter — PURE
                           SMTP_* env-shape → NodemailerTransportOptions mapping
  cli.ts                   runCli(); subcommands, flags, stdin, .env loading, exit codes
  version.ts               VERSION constant (written by scripts/sync-version.ts)
  mod.ts                   pure library re-exports (npm "." entry)
  bin.ts                   npm `bin` entry; shebang; runs the CLI unconditionally
  main.ts                  JSR export: re-exports mod.ts + import.meta.main CLI guard
                           (excluded from the npm build)
tests/
  send-email.test.ts            unit: send() + mock transport
  transport-nodemailer.test.ts  pure mapping seams (no network)
  env.test.ts                   resolveSmtpOptions() mapping + SmtpEnvError cases
  cli.test.ts                   runCli() with injected I/O (no network)
  cli.e2e.test.ts               spawns the CLI: real process.env, ./.env, stdin;
                                CLI_RUNTIME=deno runs main.ts on Deno instead
  version.test.ts               src/version.ts === package.json version
  ethereal.test.ts              opt-in real SMTP (skip: true)
scripts/
  sync-version.ts          release --before-commit hook: package.json → src/version.ts
  smoke-npm.ts             packs + installs the npm tarball, runs the bin and library
```

## Critical Conventions (hard invariants — enforce in review)

1. **Runtime policy**: Node at the keyboard and in production, npm as the registry.
   No `Deno.*`, `Bun.*`, `jsr:` / `npm:` specifiers or `@std/*` in source (`jsr.json`
   `imports` maps `nodemailer` for JSR). `node:*` only where web standards don't
   reach, imported explicitly — Deno runs them too, which keeps the JSR CLI working.
   Deno is a _consumer_ runtime (JSR), not a dev runtime.
2. **The library NEVER reads `.env` or `process.env`.** Only `cli.ts` touches the
   ambient environment / `.env` file. Any symbol exported from `mod.ts` must have
   zero ambient behavior — `resolveSmtpOptions()` qualifies because it is a pure
   function over a caller-supplied getter; keep it that way (no `process.env`
   fallback, ever).
3. **Secrets are never logged.** Never print `auth.pass`. No `--user`/`--pass`
   CLI flags — credentials come only from env.
4. **Throw on failure; return only success data** (`SendResult` is just `{ externalId }`).
5. Core `SendOptions` stays minimal; provider quirks go through `providerOptions`
   (a conservative whitelist, never able to clobber `from`/`to`/`subject`).
6. **Explicit return types + thorough JSDoc on every exported symbol** (JSR
   slow-types check, `pnpm run jsr:check`).
7. `nodemailer` (v10+) ships its own types, but they admit only `Buffer`
   attachment content while the public `Attachment` takes `Uint8Array` (which
   nodemailer handles identically at runtime). The default transporter factory
   in `createNodemailerTransport` narrows the result type for this — keep that
   cast confined there, and keep exported signatures on this package's own
   types, never nodemailer's.
8. The nodemailer transporter is created **once** (connection reuse).
9. **Erasable TypeScript**: no `enum`, `namespace`, constructor parameter
   properties; `import type` for types; explicit `.ts` import extensions.
   `pnpm run typecheck` is the only type gate (Node strips types, never checks).
10. **Version**: `package.json` is the manifest of record; `jsr.json` has no
    `version` (`--set-version` at publish). `src/version.ts` follows it via the
    release hook — never hand-edit one without the other.

## CLI

```
send    --to <addr>(repeatable|comma) --from --subject/-s --text --html
        --text-file --html-file --cc --bcc --reply-to --attach(repeatable)
        --dry-run --json --env-file
verify  (connect + auth handshake only; no message sent)
help | version
```

- Parsing: `node:util` `parseArgs`, `strict` — unknown flag / missing value → exit
  `2`. `bareHtmlAsEmpty()` keeps a bare `--html` (last, or before another flag)
  meaning `""`.
- Body resolution: body-file flag → inline flag → piped stdin (text by default;
  bare `--html` marks piped stdin as HTML).
- `.env`: `util.parseEnv` (no `${VAR}` expansion), BOM dropped; process env wins.
- Exit codes: `0` ok, `1` runtime failure, `2` usage/config error. `runCli()` returns
  the code; `bin.ts` / `main.ts` set `process.exitCode`, never `process.exit`.
- `verify` on a transport without `verify()` → "not supported", exit `0`.

## Env vars (vocabulary defined in `env.ts`, read only by the CLI)

`SMTP_HOST` (required), `SMTP_PORT` (587), `SMTP_SECURE`, `SMTP_USER`,
`SMTP_PASS`, `SMTP_FROM`, `SMTP_REPLY_TO`, `SMTP_SERVERNAME`,
`SMTP_TLS_REJECT_UNAUTHORIZED`, `SMTP_CONNECTION_TIMEOUT_MS`,
`SMTP_SOCKET_TIMEOUT_MS`. Process env wins over the `.env` file.

## Before Making Changes

- [ ] Keep the library env-free; `.env` loading and `process.env` stay in `cli.ts`
  only. `env.ts` maps a getter → options and must stay pure.
- [ ] Changing what an `SMTP_*` key means? Change it in `env.ts` (the CLI and
  every downstream tool inherit it) and update the README env table + API.md.
- [ ] New `SendOptions` field? Justify it vs. `providerOptions` first.
- [ ] CLI change: `HELP` in `src/cli.ts`, README "CLI usage", API.md "CLI", a unit
  and/or e2e test.
- [ ] `pnpm run format`, then `pnpm run ci`. Touching the CLI or the JSR surface:
  also `pnpm run test:deno` and `pnpm run jsr:check`.
- [ ] Update [README.md](README.md) / [API.md](API.md) if the public API changed.

## Documentation

- [README.md](README.md) — human overview, install, usage, env table, development.
- [API.md](API.md) — full library + CLI reference.
