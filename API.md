# API

Public API of `@marianmeres/send-email`. All message types are clean,
idiomatic **camelCase**. Errors are **thrown, never returned**.

## Functions

### `send(message, config)`

Sends a single message. Throws on failure; resolves with success data only.

**Parameters:**

- `message` ([SendOptions](#sendoptions)) — the message to send.
- `config` ([SendConfig](#sendconfig)) — provide **exactly one** of:
  - `config.transport` ([EmailTransport](#emailtransport)) — a pre-instantiated
    transport, to reuse a connection across sends.
  - `config.smtp` ([NodemailerTransportOptions](#nodemailertransportoptions)) —
    SMTP options; a nodemailer transport is built for this single call.

**Returns:** `Promise<` [SendResult](#sendresult) `>`

**Throws:** if both or neither of `transport`/`smtp` are given, or if the
underlying send fails.

**Example:**

```ts
import { send } from "@marianmeres/send-email";

await send(
	{ to: "to@example.com", from: "no-reply@example.com", subject: "Hi", text: "Hello" },
	{ smtp: { host: "smtp.example.com", port: 587, auth: { user: "u", pass: "p" } } },
);
```

---

### `createNodemailerTransport(options)`

Creates a nodemailer SMTP [EmailTransport](#emailtransport). The underlying
transporter is created **once** and reused, so prefer holding the returned
transport when sending many messages.

**Parameters:**

- `options` ([NodemailerTransportOptions](#nodemailertransportoptions)) — SMTP
  connection + behavior options.

**Returns:** [EmailTransport](#emailtransport) — with both `send()` and
`verify()` implemented.

**Example:**

```ts
import { createNodemailerTransport } from "@marianmeres/send-email";

const transport = createNodemailerTransport({
	host: "smtp.example.com",
	port: 587,
	auth: { user: "user@example.com", pass: "secret" },
	defaultReplyTo: "support@example.com",
});

await transport.verify(); // optional preflight
const { externalId } = await transport.send({
	to: "to@example.com",
	from: "no-reply@example.com",
	subject: "Hi",
	text: "Hello",
});
```

---

### `createMockTransport(options?)`

Creates an in-memory [MockEmailTransport](#mockemailtransport) for tests and dry
runs. Message ids are a deterministic per-instance counter (`"mock-1"`, `"mock-2"`, …).

**Parameters:**

- `options` ([MockEmailTransportOptions](#mockemailtransportoptions), optional) —
  simulated behavior (`failOnSend`, `failOnVerify`, `errorMessage`, `delay`).

**Returns:** [MockEmailTransport](#mockemailtransport)

**Example:**

```ts
import { createMockTransport } from "@marianmeres/send-email";

const transport = createMockTransport();
await transport.send({ to: "a@b.com", from: "c@d.com", subject: "Hi", text: "yo" });
transport.getLastEmail()?.subject; // "Hi"
transport.sentEmails.length; // 1
```

---

## Types

### `SendOptions`

```ts
interface SendOptions {
	to: string | string[];
	from: string;
	subject: string;
	html?: string;
	text?: string;
	replyTo?: string;
	cc?: string | string[];
	bcc?: string | string[];
	attachments?: EmailAttachment[];
	providerOptions?: Record<string, unknown>;
}
```

Provider-agnostic outgoing message. `providerOptions` is an opaque escape hatch;
the nodemailer transport forwards only a conservative whitelist of keys (see
[PROVIDER_OPTION_WHITELIST](#provider_option_whitelist)) and never lets them
override core fields.

### `EmailAttachment`

```ts
interface EmailAttachment {
	filename: string;
	content?: string | Uint8Array; // inline; mutually exclusive with `path`
	path?: string; // filesystem path; mutually exclusive with `content`
	contentType?: string; // sniffed from filename if omitted
	cid?: string; // Content-ID for inline `<img src="cid:...">`
}
```

### `SendResult`

```ts
interface SendResult {
	externalId: string; // provider message id (nodemailer: messageId)
}
```

### `EmailTransport`

```ts
interface EmailTransport {
	name: string;
	send(message: SendOptions): Promise<SendResult>;
	verify?(): Promise<void>;
}
```

The adapter seam. `verify()` is an optional preflight (SMTP: a real connect+auth
handshake, no message sent). Consumers must degrade gracefully when a transport
omits it.

### `SendConfig`

```ts
interface SendConfig {
	transport?: EmailTransport; // mutually exclusive with `smtp`
	smtp?: NodemailerTransportOptions; // mutually exclusive with `transport`
}
```

### `NodemailerTransportOptions`

```ts
interface NodemailerTransportOptions {
	host: string;
	port: number;
	secure?: boolean; // defaults to (port === 465)
	auth?: { user: string; pass: string };
	connectionTimeout?: number;
	socketTimeout?: number;
	defaultReplyTo?: string; // applied when a message has no `replyTo`
	tls?: {
		servername?: string; // SNI / cert hostname override
		rejectUnauthorized?: boolean; // false disables cert validation (insecure)
	};
}
```

**TLS notes:** set `tls.servername` when the connection `host` is a vanity name
but the server presents a cert for a different name — verification stays **on**.
`tls.rejectUnauthorized: false` disables certificate validation entirely
(insecure; last resort only).

### `MockEmailTransportOptions`

```ts
interface MockEmailTransportOptions {
	failOnSend?: boolean;
	failOnVerify?: boolean;
	errorMessage?: string;
	delay?: number; // ms
}
```

### `SentEmail`

```ts
interface SentEmail extends SendOptions {
	sentAt: Date;
}
```

### `MockEmailTransport`

```ts
interface MockEmailTransport extends EmailTransport {
	sentEmails: SentEmail[];
	verifyCount: number;
	clear(): void;
	getLastEmail(): SentEmail | undefined;
}
```

---

## Constants

### `PROVIDER_OPTION_WHITELIST`

`readonly string[]` — the keys the nodemailer transport forwards from
`SendOptions.providerOptions` to `sendMail()`:
`headers`, `priority`, `messageId`, `date`, `inReplyTo`, `references`,
`encoding`, `list`. Anything else is ignored, and these can never override the
core fields (`from`, `to`, `subject`, …).

---

## CLI

The bare module is also the CLI entrypoint:

```bash
deno run -A jsr:@marianmeres/send-email <command> [options]
```

### Commands

| Command   | Purpose                                                                                               |
| --------- | ----------------------------------------------------------------------------------------------------- |
| `send`    | Send one message (SMTP transport resolved from env).                                                  |
| `verify`  | Connect + auth handshake only; ✅ summary on success, `Error:` on stderr on failure. No message sent. |
| `help`    | Usage. Also `--help` / `-h`.                                                                          |
| `version` | Print the package version. Also `--version`.                                                          |

### `send` flags

| Flag                           | Maps to       | Notes                                                  |
| ------------------------------ | ------------- | ------------------------------------------------------ |
| `--to` (repeatable)            | `to`          | Repeat, or pass a comma-separated list.                |
| `--from`                       | `from`        | Defaults to env `SMTP_FROM`.                           |
| `--subject`, `-s`              | `subject`     |                                                        |
| `--text`                       | `text`        | Inline plain-text body.                                |
| `--html`                       | `html`        | Inline HTML body. Bare flag + piped stdin → HTML body. |
| `--text-file <path>`           | `text`        | Read the plain-text body from a file.                  |
| `--html-file <path>`           | `html`        | Read the HTML body from a file.                        |
| `--cc` (repeatable)            | `cc`          |                                                        |
| `--bcc` (repeatable)           | `bcc`         |                                                        |
| `--reply-to`                   | `replyTo`     | Defaults to env `SMTP_REPLY_TO`.                       |
| `--attach <path>` (repeatable) | `attachments` | Each becomes `{ path, filename: basename }`.           |
| `--dry-run`                    | —             | Use the mock transport; print what would be sent.      |
| `--json`                       | —             | Machine-readable output.                               |
| `--env-file <path>`            | —             | `.env` file to load (default `./.env`).                |

**Body resolution order:** body file flag → inline body flag → piped stdin
(when no body flag is given and stdin is not a TTY; plain text by default, or
HTML with a bare `--html`).

**Secrets:** there is no `--user`/`--pass` flag by design. Credentials come only
from the environment.

### Output & exit codes

- Success → human summary (or JSON with `--json`) on **stdout**, exit `0`.
  - `send` JSON: `{ "ok": true, "externalId": "...", "transport": "..." }`
  - `verify` JSON: `{ "ok": true, "transport": "..." }`
  - `verify` against a transport without `verify()` → text "verification not
    supported by …", or JSON `{ "ok": true, "transport": "...", "supported": false }`. Exit `0`.
- Failure → error on **stderr** (or `{ "ok": false, "error": "..." }` with
  `--json`), exit `1` (runtime) or `2` (usage/config).

### Environment

See the [Environment table in the README](README.md#environment).
