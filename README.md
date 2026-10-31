# @marianmeres/send-email

[![NPM](https://img.shields.io/npm/v/@marianmeres/send-email)](https://www.npmjs.com/package/@marianmeres/send-email)
[![JSR](https://jsr.io/badges/@marianmeres/send-email)](https://jsr.io/@marianmeres/send-email)
[![License](https://img.shields.io/npm/l/@marianmeres/send-email)](LICENSE)

A single, tested, dependency-light **"send an email"** path — usable as a
**library** and as a **CLI**. One source of truth for the low-level SMTP send,
so apps, one-off scripts, cron jobs, and the shell all share the same engine.

This package is intentionally low-level. It is **not** an email _system_: no
queueing, persistence, templating, retries, or DB. Those belong a layer up (see
[Consumers](#consumers)).

- **Provider-agnostic transport interface** (the adapter seam).
- **Nodemailer SMTP transport** (the one real adapter in v1) — with attachments
  and a real connect+auth `verify()`.
- **Mock transport** for tests and dry runs.
- **One-shot `send()`** convenience.
- **`resolveSmtpOptions()`** — the `SMTP_*` env-shape → transport-options mapping,
  exported as a pure function so other tools share the CLI's vocabulary.
- **First-class CLI** with `send` and `verify`, `.env` support, and stdin bodies.

## Installation

```bash
# npm
npm install @marianmeres/send-email

# Deno (JSR)
deno add jsr:@marianmeres/send-email
```

Or run the CLI with no install at all:

```bash
npx @marianmeres/send-email --help
```

> Both registries ship the library and the CLI. The npm package needs Node >= 24.12;
> on Deno the CLI runs as `deno run -A jsr:@marianmeres/send-email …`.

## Library usage

The library **never reads the environment** — all configuration is explicit.

```ts
import { send } from "@marianmeres/send-email";

// One-shot: pass SMTP options and a transport is built for this single send.
const { externalId } = await send(
	{
		to: "to@example.com",
		from: "no-reply@example.com",
		subject: "Hello",
		text: "Hi there",
		html: "<p>Hi there</p>",
	},
	{ smtp: { host: "smtp.example.com", port: 587, auth: { user: "u", pass: "p" } } },
);
```

Reuse one transport (and its connection) across many sends:

```ts
import { createNodemailerTransport, send } from "@marianmeres/send-email";

const transport = createNodemailerTransport({
	host: "smtp.example.com",
	port: 587,
	auth: { user: "u", pass: "p" },
	defaultReplyTo: "support@example.com",
});

await transport.verify(); // optional preflight: connect + auth, no message sent

await send(msg1, { transport });
await send(msg2, { transport });
```

Tests and dry runs use the mock transport:

```ts
import { createMockTransport, send } from "@marianmeres/send-email";

const transport = createMockTransport();
await send(msg, { transport });
transport.getLastEmail()?.subject;
```

> Errors are **thrown, never returned**. A successful result only carries
> `{ externalId }`.

Building a tool that, like the CLI, wants `SMTP_HOST` / `SMTP_PORT` / … to mean
the same thing? `resolveSmtpOptions()` is that mapping, exported. It is a pure
function over a `key → value` lookup **you** supply — the library still never
reads the environment itself:

```ts
import { createNodemailerTransport, resolveSmtpOptions } from "@marianmeres/send-email";

const transport = createNodemailerTransport(
	resolveSmtpOptions((key) => process.env[key]),
);
```

It throws `SmtpEnvError` on a missing `SMTP_HOST` or a malformed value, and it
does not consume `SMTP_FROM` (a message concern, not a transport one).

## CLI usage

The package ships a `send-email` command. Run it with
`npx @marianmeres/send-email …`, or install it globally to get `send-email` on your
`PATH`:

```bash
npm install -g @marianmeres/send-email
```

Credentials come **only** from the environment — never from flags (flags leak into the
process table and shell history).

```bash
# Send
send-email send --to a@b.com --subject "Hi" --text "Hello"

# Verify SMTP config without sending (connect + auth handshake only)
send-email verify

# Pipe a body in
report | send-email send --to me@x.com -s Report

# Machine-readable, and a dry run that sends nothing
send-email send --to a@b.com --text hi --dry-run --json
```

On Deno, `deno run -A jsr:@marianmeres/send-email` takes the same arguments.

### Commands

| Command   | Purpose                                                                                               |
| --------- | ----------------------------------------------------------------------------------------------------- |
| `send`    | Send one message (SMTP transport resolved from env).                                                  |
| `verify`  | Connect + auth handshake only; ✅ summary on success, `Error:` on stderr on failure. No message sent. |
| `help`    | Usage. Also `--help` / `-h`.                                                                          |
| `version` | Print the package version. Also `--version`.                                                          |

Exit codes: `0` success, `1` runtime failure, `2` usage error (including an unknown
flag, or a flag missing its value).

See [API.md](API.md#cli) for the full flag reference.

## Environment

The CLI builds the SMTP transport from these variables (loaded from `./.env`,
or `--env-file <path>`). Process env takes precedence over the `.env` file. The
file is parsed by Node's `util.parseEnv`, the rules of `node --env-file`: quotes and
`#` comments are understood, `${VAR}` references are not expanded.

| Variable                       | Required | Notes                                          |
| ------------------------------ | -------- | ---------------------------------------------- |
| `SMTP_HOST`                    | yes      | SMTP server hostname.                          |
| `SMTP_PORT`                    | no       | Default `587`.                                 |
| `SMTP_SECURE`                  | no       | Implicit TLS; defaults to `port === 465`.      |
| `SMTP_USER` / `SMTP_PASS`      | no       | SMTP AUTH credentials. Never via CLI flags.    |
| `SMTP_FROM`                    | no       | Default sender when `--from` is omitted.       |
| `SMTP_REPLY_TO`                | no       | Default Reply-To when `--reply-to` is omitted. |
| `SMTP_SERVERNAME`              | no       | TLS SNI / cert hostname override.              |
| `SMTP_TLS_REJECT_UNAUTHORIZED` | no       | Set `false` only as an insecure last resort.   |
| `SMTP_CONNECTION_TIMEOUT_MS`   | no       | Connection timeout (ms).                       |
| `SMTP_SOCKET_TIMEOUT_MS`       | no       | Socket timeout (ms).                           |

See [.env.example](.env.example).

## Consumers

This package is the bottom layer. Higher-level email **systems** (service,
queue, DB-backed collections, templating) are intended to **consume** it: such a
consumer's SMTP transport shrinks to a thin adapter that maps its own (often
DB-shaped, snake_case) payload onto this package's `send()`, dropping its direct
`nodemailer` dependency in favor of this one. Message types stay parallel on
purpose — this package is clean camelCase; a consumer's payload can be whatever
its storage needs.

## API

See [API.md](API.md) for the complete library and CLI reference.

## Development

Node LTS (`.node-version`), pnpm, Biome, `node:test`. The source is erasable-only
TypeScript that Node runs directly; `dist/` is built only for publishing to npm. JSR is
served the `.ts` source (`jsr.json`).

| Command                             | Does                                                          |
| ----------------------------------- | ------------------------------------------------------------- |
| `pnpm install`                      | installs the dev tooling                                      |
| `pnpm test` / `pnpm run test:watch` | `node --test` over `tests/**/*.test.ts`                       |
| `pnpm run test:deno`                | the same suite on Deno, the CLI e2e run through the JSR entry |
| `pnpm run typecheck`                | `tsc --noEmit` over `src`, `tests` and `scripts`              |
| `pnpm run lint` / `pnpm run format` | `biome check .` read-only / with `--write`                    |
| `pnpm run ci`                       | typecheck + lint + test + smoke, what CI runs                 |
| `pnpm run build`                    | `tsc -p tsconfig.build.json` → `dist/`                        |
| `pnpm run smoke`                    | builds, packs and runs the npm tarball in a temp project      |
| `pnpm run jsr:check`                | `deno publish --dry-run` with the `package.json` version      |
| `pnpm run rp` / `pnpm run rpm`      | patch / minor release, then publish to npm and JSR            |

## License

[MIT](LICENSE)
