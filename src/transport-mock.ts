/**
 * Mock email transport for tests and CLI dry runs.
 *
 * Captures every "sent" message in memory instead of touching the network, so
 * unit tests can assert on what *would* have been sent.
 *
 * @module
 */

import type { EmailTransport, SendOptions, SendResult } from "./types.ts";

/**
 * Options controlling the mock transport's simulated behavior.
 */
export interface MockEmailTransportOptions {
	/** When `true`, {@link MockEmailTransport.send} rejects instead of recording. */
	failOnSend?: boolean;
	/** When `true`, {@link MockEmailTransport.verify} rejects instead of recording. */
	failOnVerify?: boolean;
	/** Error message used for simulated failures. */
	errorMessage?: string;
	/** Delay in milliseconds before resolving (simulates network latency). */
	delay?: number;
}

/**
 * A captured message, i.e. the {@link SendOptions} plus the timestamp at which
 * the mock "sent" it.
 */
export interface SentEmail extends SendOptions {
	/** When the message was captured. */
	sentAt: Date;
}

/**
 * An {@link EmailTransport} that records messages in memory, plus test
 * inspection helpers.
 */
export interface MockEmailTransport extends EmailTransport {
	/** All captured messages, in send order. */
	sentEmails: SentEmail[];
	/** Number of times {@link MockEmailTransport.verify} has been called. */
	verifyCount: number;
	/** Empties {@link MockEmailTransport.sentEmails} and resets {@link MockEmailTransport.verifyCount}. */
	clear(): void;
	/** Returns the most recently captured message, or `undefined` if none. */
	getLastEmail(): SentEmail | undefined;
}

/**
 * Creates a {@link MockEmailTransport}.
 *
 * Message ids are a simple per-instance incrementing counter (`"mock-1"`,
 * `"mock-2"`, ...) rather than timestamp-based, so assertions stay
 * deterministic.
 *
 * @param options - Simulated behavior options.
 * @returns A mock transport that records sends in memory.
 *
 * @example
 * ```ts
 * import { createMockTransport } from "@marianmeres/send-email";
 *
 * const transport = createMockTransport();
 * await transport.send({ to: "a@b.com", from: "c@d.com", subject: "Hi", text: "yo" });
 * transport.getLastEmail()?.subject; // "Hi"
 * ```
 */
export function createMockTransport(
	options: MockEmailTransportOptions = {},
): MockEmailTransport {
	const sentEmails: SentEmail[] = [];
	let counter = 0;

	const transport: MockEmailTransport = {
		name: "mock",
		sentEmails,
		verifyCount: 0,

		clear(): void {
			sentEmails.length = 0;
			transport.verifyCount = 0;
		},

		getLastEmail(): SentEmail | undefined {
			return sentEmails[sentEmails.length - 1];
		},

		async send(message: SendOptions): Promise<SendResult> {
			if (options.delay) {
				await new Promise((resolve) => setTimeout(resolve, options.delay));
			}
			if (options.failOnSend) {
				throw new Error(
					options.errorMessage ?? "Mock transport configured to fail",
				);
			}
			sentEmails.push({ ...message, sentAt: new Date() });
			counter += 1;
			return { externalId: `mock-${counter}` };
		},

		async verify(): Promise<void> {
			if (options.delay) {
				await new Promise((resolve) => setTimeout(resolve, options.delay));
			}
			transport.verifyCount += 1;
			if (options.failOnVerify) {
				throw new Error(
					options.errorMessage ?? "Mock transport configured to fail verify",
				);
			}
		},
	};

	return transport;
}
