/**
 * One-shot convenience `send()` — the trivial "just send this" entry point.
 *
 * @module
 */

import {
	createNodemailerTransport,
	type NodemailerTransportOptions,
} from "./transport-nodemailer.ts";
import type { EmailTransport, SendOptions, SendResult } from "./types.ts";

/**
 * Configuration for {@link send}. Provide **exactly one** of:
 *
 * - `transport`: a pre-instantiated {@link EmailTransport}. Use this when you
 *   already hold a transport and want to reuse its connection across sends.
 * - `smtp`: {@link NodemailerTransportOptions}. A nodemailer transport is built
 *   for this single call — the true one-shot path, no manual instantiation.
 *
 * Per this package's hard invariant, neither path ever reads the environment;
 * all configuration is explicit. Environment resolution lives only in the CLI.
 */
export interface SendConfig {
	/** A pre-instantiated transport. Mutually exclusive with {@link SendConfig.smtp}. */
	transport?: EmailTransport;
	/**
	 * SMTP options; a nodemailer transport is created for this single send.
	 * Mutually exclusive with {@link SendConfig.transport}.
	 */
	smtp?: NodemailerTransportOptions;
}

/** Resolves a {@link SendConfig} to a concrete transport, validating exclusivity. */
function resolveTransport(config: SendConfig): EmailTransport {
	const hasTransport = config.transport !== undefined;
	const hasSmtp = config.smtp !== undefined;
	if (hasTransport && hasSmtp) {
		throw new Error(
			"send(): provide either `transport` or `smtp`, not both.",
		);
	}
	if (config.transport) return config.transport;
	if (config.smtp) return createNodemailerTransport(config.smtp);
	throw new Error("send(): a `transport` or `smtp` config is required.");
}

/**
 * Sends a single message. Throws on failure; returns only success data.
 *
 * @param message - The message to send.
 * @param config - Either a pre-built `transport` or one-shot `smtp` options.
 * @returns The {@link SendResult} carrying the provider message id.
 *
 * @example One-shot with SMTP options (builds the transport for you)
 * ```ts
 * import { send } from "@marianmeres/send-email";
 *
 * const { externalId } = await send(
 * 	{ to: "to@example.com", from: "no-reply@example.com", subject: "Hi", text: "Hello" },
 * 	{ smtp: { host: "smtp.example.com", port: 587, auth: { user: "u", pass: "p" } } },
 * );
 * ```
 *
 * @example Reusing a transport across many sends
 * ```ts
 * import { createNodemailerTransport, send } from "@marianmeres/send-email";
 *
 * const transport = createNodemailerTransport({ host: "smtp.example.com", port: 587 });
 * await send(msg1, { transport });
 * await send(msg2, { transport });
 * ```
 */
export async function send(
	message: SendOptions,
	config: SendConfig,
): Promise<SendResult> {
	return await resolveTransport(config).send(message);
}
