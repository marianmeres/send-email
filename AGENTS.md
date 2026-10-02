# @marianmeres/send-email — Agent Guide

Lowest-layer, dependency-light "send an email" path: a provider-agnostic
transport interface + a nodemailer SMTP transport + a mock transport + a
one-shot `send()` + a first-class CLI. **Not** an email system (no queue,
persistence, templating, retries, DB).

## Quick Reference

- **Runtime:** Deno. **JSR:** full package (library + CLI). **npm:** library
  only (built from `mod.ts`; the Deno-only CLI is excluded).
- **JSR `exports` / CLI entry:** `src/main.ts` — re-exports `mod.ts` + the
  `import.meta.main` guard (bare `deno run` runs the CLI).
- **Library entry (npm `.`):** `src/mod.ts` — pure re-exports, no Deno globals
  (so it compiles under `tsc`).
- **CLI logic:** `src/cli.ts` → `runCli(args): Promise<number>` (returns exit
  code; never calls `Deno.exit`).
- **Test:** `deno task test` (`deno test -A`) — green offline. **Format:** `deno fmt`.
- **Check:** `deno check src/*.ts tests/*.ts` | **Lint:** `deno lint` |
  **Publish dry-run:** `deno publish --dry-run --allow-dirty`.

## Architecture & layering

```
@marianmeres/send-email   ← THIS PACKAGE (bottom layer): transport interface +
        ▲                   nodemailer transport + mock + send() + CLI. No app deps.
        │ (future) consumed by
higher-level email systems ← the email SYSTEM layer (service/queue/DB/templating).
                            A consumer's SMTP transport shrinks to a thin adapter onto
                            this package's send(); npm:nodemailer moves down here.
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
  mod.ts                   pure library re-exports (npm "." entry; tsc-safe)
  main.ts                  JSR exports/CLI entry: re-exports mod.ts + import.meta.main guard
tests/
  send-email.test.ts            unit: send() + mock transport
  transport-nodemailer.test.ts  pure mapping seams (no network)
  env.test.ts                   resolveSmtpOptions() mapping + SmtpEnvError cases
  cli.test.ts                   runCli() with injected I/O (no network)
  ethereal.test.ts              opt-in real SMTP (ignore: true)
```

## Critical Conventions (hard invariants — enforce in review)

1. **The library NEVER reads `.env` or `Deno.env`.** Only `cli.ts` touches the
   ambient environment / `.env` file. Any symbol exported from `mod.ts` must have
   zero ambient behavior — `resolveSmtpOptions()` qualifies because it is a pure
   function over a caller-supplied getter; keep it that way (no `Deno.env`
   fallback, ever).
2. **Secrets are never logged.** Never print `auth.pass`. No `--user`/`--pass`
   CLI flags — credentials come only from env.
3. **Throw on failure; return only success data** (`SendResult` is just `{ externalId }`).
4. Core `SendOptions` stays minimal; provider quirks go through `providerOptions`
   (a conservative whitelist, never able to clobber `from`/`to`/`subject`).
5. **Explicit return types + thorough JSDoc on every exported symbol** (this
   package must pass `deno publish` slow-type checks).
6. `nodemailer` (v10+) ships its own types, but they admit only `Buffer`
   attachment content while the public `Attachment` takes `Uint8Array` (which
   nodemailer handles identically at runtime). The default transporter factory
   in `createNodemailerTransport` narrows the result type for this — keep that
   cast confined there, and keep exported signatures on this package's own
   types, never nodemailer's.
7. The nodemailer transporter is created **once** (connection reuse).

## CLI

```
send    --to <addr>(repeatable|comma) --from --subject/-s --text --html
        --text-file --html-file --cc --bcc --reply-to --attach(repeatable)
        --dry-run --json --env-file
verify  (connect + auth handshake only; no message sent)
help | version
```

- Body resolution: body-file flag → inline flag → piped stdin (text by default;
  bare `--html` marks piped stdin as HTML).
- Exit codes: `0` ok, `1` runtime failure, `2` usage/config error.
- `verify` on a transport without `verify()` → "not supported", exit `0`.

## Env vars (vocabulary defined in `env.ts`, read only by the CLI)

`SMTP_HOST` (required), `SMTP_PORT` (587), `SMTP_SECURE`, `SMTP_USER`,
`SMTP_PASS`, `SMTP_FROM`, `SMTP_REPLY_TO`, `SMTP_SERVERNAME`,
`SMTP_TLS_REJECT_UNAUTHORIZED`, `SMTP_CONNECTION_TIMEOUT_MS`,
`SMTP_SOCKET_TIMEOUT_MS`. Process env wins over the `.env` file.

## Before Making Changes

- [ ] Keep the library env-free; `.env` loading and `Deno.env` stay in `cli.ts`
      only. `env.ts` maps a getter → options and must stay pure.
- [ ] Changing what an `SMTP_*` key means? Change it in `env.ts` (the CLI and
      every downstream tool inherit it) and update the README env table + API.md.
- [ ] New `SendOptions` field? Justify it vs. `providerOptions` first.
- [ ] Run `deno fmt`, `deno lint`, `deno check`, `deno task test`, and
      `deno publish --dry-run --allow-dirty`.
- [ ] Update [README.md](README.md) / [API.md](API.md) if the public API changed.

## Documentation

- [README.md](README.md) — human overview, install, usage, env table.
- [API.md](API.md) — full library + CLI reference.
