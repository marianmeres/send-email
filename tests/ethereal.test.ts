/**
 * Opt-in real-SMTP integration tests via Ethereal (a fake SMTP service that
 * captures messages without delivering them).
 *
 * These require network access and are SKIPPED by default. To run them, flip
 * `ignore` to `false` below (or delete it) and run:
 *
 *   deno test -A tests/ethereal.test.ts
 *
 * Sent messages are viewable at https://ethereal.email using the logged
 * credentials.
 */

import { assert, assertRejects } from "@std/assert";
import nodemailer from "nodemailer";
import { createNodemailerTransport } from "../src/transport-nodemailer.ts";
import { send } from "../src/send-email.ts";

// Set to `false` to actually run these tests.
const ignore = true;

/** Per-test timeout — `Deno.test` has none, and SMTP sockets can hang. */
const TEST_TIMEOUT_MS = 15_000;

/** Rejects if `promise` does not settle within `ms`. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
	});
	return Promise.race([promise, timeout]).finally(() => {
		if (timer !== undefined) clearTimeout(timer);
	}) as Promise<T>;
}

Deno.test({
	name: "ethereal: send() delivers and returns an externalId",
	ignore,
	fn: async () => {
		const account = await nodemailer.createTestAccount();
		console.log(`\nEthereal user: ${account.user} (https://ethereal.email)\n`);

		const transport = createNodemailerTransport({
			host: account.smtp.host,
			port: account.smtp.port,
			secure: account.smtp.secure,
			auth: { user: account.user, pass: account.pass },
			connectionTimeout: 10_000,
			socketTimeout: 10_000,
		});

		const result = await withTimeout(
			send({
				to: "recipient@example.com",
				from: account.user,
				subject: "Test from @marianmeres/send-email",
				html: "<h1>Hello!</h1><p>Sent via Ethereal.</p>",
				text: "Hello! Sent via Ethereal.",
				attachments: [{ filename: "note.txt", content: "an attachment" }],
			}, { transport }),
			TEST_TIMEOUT_MS,
		);

		assert(result.externalId, "expected an externalId");
		console.log(`Message id: ${result.externalId}`);
	},
});

Deno.test({
	name: "ethereal: verify() succeeds with valid credentials",
	ignore,
	fn: async () => {
		const account = await nodemailer.createTestAccount();
		const transport = createNodemailerTransport({
			host: account.smtp.host,
			port: account.smtp.port,
			secure: account.smtp.secure,
			auth: { user: account.user, pass: account.pass },
			connectionTimeout: 10_000,
		});
		await withTimeout(transport.verify!(), TEST_TIMEOUT_MS);
	},
});

Deno.test({
	name: "ethereal: verify() rejects with invalid credentials",
	ignore,
	fn: async () => {
		const transport = createNodemailerTransport({
			host: "smtp.ethereal.email",
			port: 587,
			secure: false,
			auth: { user: "invalid@ethereal.email", pass: "invalid-password" },
			connectionTimeout: 5_000,
		});
		await withTimeout(
			assertRejects(() => transport.verify!(), Error),
			TEST_TIMEOUT_MS,
		);
	},
});
