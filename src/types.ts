/**
 * Core, provider-agnostic types for `@marianmeres/send-email`.
 *
 * These are intentionally the lowest common denominator of "an outgoing
 * email" — clean idiomatic camelCase, no DB/queue/template coupling. Each
 * concrete transport (see {@link EmailTransport}) maps these onto its own
 * provider shape.
 *
 * @module
 */

/**
 * A single email attachment. Maps directly onto nodemailer's attachment shape.
 *
 * Provide exactly one body source: either inline {@link EmailAttachment.content}
 * or a filesystem {@link EmailAttachment.path} (the transport reads the file).
 * Supplying both is ambiguous and transport-dependent — don't.
 */
export interface EmailAttachment {
	/** Display filename, e.g. `"invoice.pdf"`. */
	filename: string;
	/**
	 * Inline content as a string or bytes. Mutually exclusive with
	 * {@link EmailAttachment.path}.
	 */
	content?: string | Uint8Array;
	/**
	 * Filesystem path; the transport reads it at send time. Mutually exclusive
	 * with {@link EmailAttachment.content}.
	 */
	path?: string;
	/**
	 * MIME type, e.g. `"application/pdf"`. Optional; most transports sniff it
	 * from {@link EmailAttachment.filename} when omitted.
	 */
	contentType?: string;
	/**
	 * Content-ID for inline embedding, referenced from HTML as
	 * `<img src="cid:...">`.
	 */
	cid?: string;
}

/**
 * A provider-agnostic outgoing message. Only the lowest-common-denominator
 * fields are modeled as first-class properties; anything provider-specific
 * goes through {@link SendOptions.providerOptions}.
 */
export interface SendOptions {
	/** Recipient address, or a list of addresses. */
	to: string | string[];
	/** Sender address. */
	from: string;
	/** Subject line. */
	subject: string;
	/** HTML body. At least one of {@link SendOptions.html} / {@link SendOptions.text} should be set. */
	html?: string;
	/** Plain-text body. */
	text?: string;
	/** Reply-To address. */
	replyTo?: string;
	/** CC recipient, or a list of recipients. */
	cc?: string | string[];
	/** BCC recipient, or a list of recipients. */
	bcc?: string | string[];
	/** File attachments. */
	attachments?: EmailAttachment[];
	/**
	 * Opaque escape hatch for provider-specific options (tags, templates,
	 * idempotency keys, custom headers, ...). Deliberately NOT modeled in the
	 * core interface.
	 *
	 * A transport may pass a conservative whitelist of recognized keys through
	 * to its provider; unrecognized keys are ignored. Never relied upon to
	 * override core fields (`from`, `to`, `subject`, ...).
	 */
	providerOptions?: Record<string, unknown>;
}

/**
 * The result of a successful send. Failures are thrown, never returned, so
 * this only ever carries success data.
 */
export interface SendResult {
	/** Provider message id (nodemailer: `messageId`). */
	externalId: string;
}

/**
 * Provider-agnostic transport interface — the adapter seam of this package.
 *
 * Implement this to add a new provider. v1 ships a real SMTP transport
 * ({@link "./transport-nodemailer.ts".createNodemailerTransport}) and a
 * {@link "./transport-mock.ts".createMockTransport} for tests/dry runs.
 *
 * Contract: all methods **throw on failure** and only return success data.
 */
export interface EmailTransport {
	/** Stable transport name, e.g. `"nodemailer-smtp"` or `"mock"`. */
	name: string;
	/** Send one message. Resolves with a {@link SendResult}; throws on failure. */
	send(message: SendOptions): Promise<SendResult>;
	/**
	 * Optional preflight check. For SMTP this is a real connect+auth handshake
	 * with **no message sent**; HTTP-API providers may omit it or do a cheap
	 * auth probe. Throws on failure.
	 *
	 * Consumers (e.g. the CLI `verify` command) must degrade gracefully when a
	 * transport does not implement this.
	 */
	verify?(): Promise<void>;
}
