/**
 * Nodemailer SMTP transport — the first and only real adapter in v1.
 *
 * This is the single, tested "send an email over SMTP" path that the whole
 * ecosystem (and any throwaway script or the bundled CLI) shares. It wraps
 * `npm:nodemailer`, instantiating the underlying transporter **once** so the
 * connection is reused across many sends.
 *
 * @module
 */

import nodemailer from "nodemailer";
import type { EmailTransport, SendOptions, SendResult } from "./types.ts";

/**
 * Configuration for the nodemailer SMTP transport.
 */
export interface NodemailerTransportOptions {
	/** SMTP server hostname. */
	host: string;
	/** SMTP server port (commonly 587 for STARTTLS, 465 for implicit TLS). */
	port: number;
	/**
	 * Use implicit TLS. Defaults to `port === 465` when omitted (the
	 * conventional implicit-TLS port); other ports default to `false` and
	 * upgrade via STARTTLS.
	 */
	secure?: boolean;
	/** SMTP AUTH credentials. Omit for unauthenticated relays. */
	auth?: {
		/** Username (or API-key id, depending on provider). */
		user: string;
		/** Password / API key. Never logged; never accepted via CLI flags. */
		pass: string;
	};
	/** Connection timeout in milliseconds. */
	connectionTimeout?: number;
	/** Socket (data) timeout in milliseconds. */
	socketTimeout?: number;
	/**
	 * Default Reply-To applied when a message does not set its own `replyTo`.
	 * Useful when `from` is a no-reply sender but replies should route to a
	 * real inbox.
	 */
	defaultReplyTo?: string;
	/**
	 * TLS options forwarded to the underlying socket.
	 *
	 * - `servername`: hostname used for SNI and certificate verification.
	 *   Set this when the connection `host` is a vanity name (e.g.
	 *   `mail.example.com`) but the server presents a shared-hosting cert for
	 *   a different name (e.g. `*.provider.net`). Verification stays ON.
	 * - `rejectUnauthorized: false`: disables certificate validation entirely
	 *   (insecure — exposes SMTP AUTH credentials to MITM). Last resort only.
	 */
	tls?: {
		/** SNI / certificate hostname override. */
		servername?: string;
		/** Set `false` to disable cert validation (insecure — last resort only). */
		rejectUnauthorized?: boolean;
	};
}

/**
 * The config object passed to nodemailer's `createTransport()`.
 *
 * @internal Exported only so the mapping can be unit-tested without a live
 * SMTP connection.
 */
export interface NodemailerTransportConfig {
	/** SMTP server hostname. */
	host: string;
	/** SMTP server port. */
	port: number;
	/** Resolved implicit-TLS flag (`options.secure ?? port === 465`). */
	secure: boolean;
	/** SMTP AUTH credentials, if any. */
	auth?: { user: string; pass: string };
	/** Connection timeout in milliseconds, if set. */
	connectionTimeout?: number;
	/** Socket timeout in milliseconds, if set. */
	socketTimeout?: number;
	/** TLS options, if set. */
	tls?: { servername?: string; rejectUnauthorized?: boolean };
}

/**
 * A single attachment in nodemailer's shape.
 *
 * @internal Exported only for unit testing the attachment mapping.
 */
export interface NodemailerAttachment {
	/** Display filename. */
	filename: string;
	/** Inline content, if provided. */
	content?: string | Uint8Array;
	/** Filesystem path, if provided. */
	path?: string;
	/** MIME type, if provided. */
	contentType?: string;
	/** Content-ID for inline embedding, if provided. */
	cid?: string;
}

/**
 * The message object passed to nodemailer's `transporter.sendMail()`.
 *
 * Whitelisted {@link SendOptions.providerOptions} keys (see
 * {@link PROVIDER_OPTION_WHITELIST}) are added as additional properties at
 * runtime; they are intentionally not part of this static shape.
 *
 * @internal Exported only for unit testing the message mapping.
 */
export interface NodemailerMessage {
	/** Sender address. */
	from: string;
	/** Joined recipient list. */
	to: string;
	/** Joined CC list, if any. */
	cc?: string;
	/** Joined BCC list, if any. */
	bcc?: string;
	/** Resolved Reply-To (message `replyTo` ?? transport `defaultReplyTo`), if any. */
	replyTo?: string;
	/** Subject line. */
	subject: string;
	/** Plain-text body, if any. */
	text?: string;
	/** HTML body, if any. */
	html?: string;
	/** Mapped attachments, if any. */
	attachments?: NodemailerAttachment[];
}

/**
 * The conservative whitelist of {@link SendOptions.providerOptions} keys that
 * the nodemailer transport forwards to `sendMail()`. Anything not listed here
 * is ignored, and these can never override the core fields (`from`, `to`,
 * `subject`, ...) which are mapped first.
 */
export const PROVIDER_OPTION_WHITELIST: readonly string[] = [
	"headers",
	"priority",
	"messageId",
	"date",
	"inReplyTo",
	"references",
	"encoding",
	"list",
];

/** Joins a single address or an address list into a comma-separated string. */
function joinAddresses(
	value: string | string[] | undefined,
): string | undefined {
	if (value === undefined) return undefined;
	return Array.isArray(value) ? value.join(", ") : value;
}

/**
 * Builds the nodemailer `createTransport()` config from
 * {@link NodemailerTransportOptions}, resolving the `secure` default.
 *
 * @internal Exported for unit testing; not part of the supported public API.
 * @param options - The transport options.
 * @returns The config object for `nodemailer.createTransport()`.
 */
export function _toTransportConfig(
	options: NodemailerTransportOptions,
): NodemailerTransportConfig {
	const config: NodemailerTransportConfig = {
		host: options.host,
		port: options.port,
		secure: options.secure ?? options.port === 465,
	};
	if (options.auth !== undefined) config.auth = options.auth;
	if (options.connectionTimeout !== undefined) {
		config.connectionTimeout = options.connectionTimeout;
	}
	if (options.socketTimeout !== undefined) {
		config.socketTimeout = options.socketTimeout;
	}
	if (options.tls !== undefined) config.tls = options.tls;
	return config;
}

/**
 * Maps a provider-agnostic {@link SendOptions} onto the nodemailer
 * `sendMail()` message shape: camelCase fields, joined recipient lists,
 * attachment mapping, `replyTo` ?? `defaultReplyTo` fallback, and the
 * whitelisted {@link PROVIDER_OPTION_WHITELIST} pass-through.
 *
 * @internal Exported for unit testing; not part of the supported public API.
 * @param message - The message to send.
 * @param options - The transport options (for `defaultReplyTo`).
 * @returns The message object for `transporter.sendMail()`.
 */
export function _toNodemailerMessage(
	message: SendOptions,
	options: NodemailerTransportOptions,
): NodemailerMessage {
	const msg: NodemailerMessage = {
		from: message.from,
		to: joinAddresses(message.to) ?? "",
		subject: message.subject,
	};

	const cc = joinAddresses(message.cc);
	if (cc !== undefined) msg.cc = cc;
	const bcc = joinAddresses(message.bcc);
	if (bcc !== undefined) msg.bcc = bcc;

	const replyTo = message.replyTo ?? options.defaultReplyTo;
	if (replyTo !== undefined) msg.replyTo = replyTo;

	if (message.text !== undefined) msg.text = message.text;
	if (message.html !== undefined) msg.html = message.html;

	if (message.attachments && message.attachments.length > 0) {
		msg.attachments = message.attachments.map((a) => {
			const out: NodemailerAttachment = { filename: a.filename };
			if (a.content !== undefined) out.content = a.content;
			if (a.path !== undefined) out.path = a.path;
			if (a.contentType !== undefined) out.contentType = a.contentType;
			if (a.cid !== undefined) out.cid = a.cid;
			return out;
		});
	}

	// Conservative provider-specific pass-through. Mapped last but cannot clobber
	// core fields because the whitelist excludes them.
	if (message.providerOptions) {
		const po = message.providerOptions;
		const target = msg as unknown as Record<string, unknown>;
		for (const key of PROVIDER_OPTION_WHITELIST) {
			if (po[key] !== undefined) target[key] = po[key];
		}
	}

	return msg;
}

/**
 * The minimal transporter surface this package uses from nodemailer.
 *
 * @internal Exported only so {@link createNodemailerTransport}'s transporter
 * factory can be overridden in tests (the runtime `send()`/`verify()` wiring is
 * otherwise only reachable over a real SMTP connection).
 */
export interface NodemailerLikeTransporter {
	/** Sends a message; resolves with at least a `messageId`. */
	sendMail(message: NodemailerMessage): Promise<{ messageId: string }>;
	/** Connect + auth preflight; resolves on success, rejects on failure. */
	verify(): Promise<unknown>;
}

/**
 * Creates a nodemailer-based SMTP {@link EmailTransport}.
 *
 * The underlying transporter is created once and reused, so prefer holding on
 * to the returned transport when sending many messages. For a trivial one-shot
 * send, see {@link "./send-email.ts".send} with the `smtp` config.
 *
 * @param options - SMTP connection + behavior options.
 * @param createTransporter - Transporter factory; defaults to
 *   `nodemailer.createTransport`. **@internal** test seam — override it to
 *   exercise the `send()`/`verify()` wiring without a live SMTP connection.
 * @returns An {@link EmailTransport} with `send()` and `verify()` implemented.
 *
 * @example Reuse one transport across many sends
 * ```ts
 * import { createNodemailerTransport } from "@marianmeres/send-email";
 *
 * const transport = createNodemailerTransport({
 * 	host: "smtp.example.com",
 * 	port: 587,
 * 	auth: { user: "user@example.com", pass: "secret" },
 * 	defaultReplyTo: "support@example.com",
 * });
 *
 * await transport.verify(); // optional preflight: connect + auth, no message
 * const { externalId } = await transport.send({
 * 	to: "to@example.com",
 * 	from: "no-reply@example.com",
 * 	subject: "Hi",
 * 	text: "Hello",
 * });
 * ```
 */
export function createNodemailerTransport(
	options: NodemailerTransportOptions,
	createTransporter: (
		config: NodemailerTransportConfig,
	) => NodemailerLikeTransporter = nodemailer.createTransport,
): EmailTransport {
	const transporter = createTransporter(_toTransportConfig(options));

	return {
		name: "nodemailer-smtp",

		async send(message: SendOptions): Promise<SendResult> {
			const result = await transporter.sendMail(
				_toNodemailerMessage(message, options),
			);
			return { externalId: result.messageId };
		},

		async verify(): Promise<void> {
			await transporter.verify();
		},
	};
}
