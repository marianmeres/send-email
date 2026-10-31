import assert from "node:assert/strict";
import { test } from "node:test";
import {
	_toNodemailerMessage,
	_toTransportConfig,
	createNodemailerTransport,
	PROVIDER_OPTION_WHITELIST,
} from "../src/transport-nodemailer.ts";
import type { NodemailerTransportOptions } from "../src/transport-nodemailer.ts";
import type { SendOptions } from "../src/types.ts";

const baseOptions: NodemailerTransportOptions = { host: "smtp.example.com", port: 587 };

test("_toTransportConfig: secure defaults to (port === 465)", () => {
	assert.equal(_toTransportConfig({ host: "h", port: 465 }).secure, true);
	assert.equal(_toTransportConfig({ host: "h", port: 587 }).secure, false);
	assert.equal(_toTransportConfig({ host: "h", port: 25 }).secure, false);
});

test("_toTransportConfig: explicit secure overrides the port default", () => {
	assert.deepEqual(
		_toTransportConfig({ host: "h", port: 465, secure: false }).secure,
		false,
	);
	assert.equal(_toTransportConfig({ host: "h", port: 587, secure: true }).secure, true);
});

test("_toTransportConfig: passes through auth, timeouts and tls", () => {
	const config = _toTransportConfig({
		host: "h",
		port: 587,
		auth: { user: "u", pass: "p" },
		connectionTimeout: 1234,
		socketTimeout: 5678,
		tls: { servername: "real.host", rejectUnauthorized: false },
	});
	assert.deepEqual(config.auth, { user: "u", pass: "p" });
	assert.equal(config.connectionTimeout, 1234);
	assert.equal(config.socketTimeout, 5678);
	assert.deepEqual(config.tls, { servername: "real.host", rejectUnauthorized: false });
});

test("_toTransportConfig: omits unset optional fields", () => {
	const config = _toTransportConfig(baseOptions);
	assert.equal("auth" in config, false);
	assert.equal("tls" in config, false);
	assert.equal("connectionTimeout" in config, false);
	assert.equal("socketTimeout" in config, false);
});

test("_toNodemailerMessage: maps camelCase body fields", () => {
	const msg = _toNodemailerMessage({
		to: "to@example.com",
		from: "from@example.com",
		subject: "Subj",
		html: "<p>h</p>",
		text: "t",
	}, baseOptions);
	assert.equal(msg.to, "to@example.com");
	assert.equal(msg.from, "from@example.com");
	assert.equal(msg.subject, "Subj");
	assert.equal(msg.html, "<p>h</p>");
	assert.equal(msg.text, "t");
});

test("_toNodemailerMessage: joins multi-recipient to/cc/bcc with ', '", () => {
	const msg = _toNodemailerMessage({
		to: ["a@example.com", "b@example.com"],
		from: "from@example.com",
		subject: "x",
		cc: ["c@example.com", "d@example.com"],
		bcc: ["e@example.com"],
	}, baseOptions);
	assert.equal(msg.to, "a@example.com, b@example.com");
	assert.equal(msg.cc, "c@example.com, d@example.com");
	assert.equal(msg.bcc, "e@example.com");
});

test("_toNodemailerMessage: replyTo falls back to defaultReplyTo", () => {
	const withFallback = _toNodemailerMessage(
		{ to: "t@x.com", from: "f@x.com", subject: "x" },
		{ ...baseOptions, defaultReplyTo: "fallback@x.com" },
	);
	assert.equal(withFallback.replyTo, "fallback@x.com");

	const explicit = _toNodemailerMessage(
		{ to: "t@x.com", from: "f@x.com", subject: "x", replyTo: "explicit@x.com" },
		{ ...baseOptions, defaultReplyTo: "fallback@x.com" },
	);
	assert.equal(explicit.replyTo, "explicit@x.com");
});

test("_toNodemailerMessage: maps attachments (content/path/contentType/cid)", () => {
	const msg = _toNodemailerMessage({
		to: "t@x.com",
		from: "f@x.com",
		subject: "x",
		attachments: [
			{ filename: "a.pdf", path: "/tmp/a.pdf", contentType: "application/pdf" },
			{ filename: "b.txt", content: "hello", cid: "logo" },
		],
	}, baseOptions);
	assert.equal(msg.attachments?.length, 2);
	assert.deepEqual(msg.attachments?.[0], {
		filename: "a.pdf",
		path: "/tmp/a.pdf",
		contentType: "application/pdf",
	});
	assert.deepEqual(msg.attachments?.[1], {
		filename: "b.txt",
		content: "hello",
		cid: "logo",
	});
});

test("_toNodemailerMessage: forwards only whitelisted providerOptions", () => {
	const msg = _toNodemailerMessage({
		to: "t@x.com",
		from: "f@x.com",
		subject: "x",
		providerOptions: {
			headers: { "X-Custom": "1" },
			priority: "high",
			// Not whitelisted — must be dropped:
			to: "evil@x.com",
			from: "evil@x.com",
			whatever: true,
		},
	}, baseOptions);
	const bag = msg as unknown as Record<string, unknown>;
	assert.deepEqual(bag.headers, { "X-Custom": "1" });
	assert.equal(bag.priority, "high");
	// Core fields untouched by providerOptions:
	assert.equal(msg.to, "t@x.com");
	assert.equal(msg.from, "f@x.com");
	assert.equal("whatever" in bag, false);
});

test("PROVIDER_OPTION_WHITELIST never contains core fields", () => {
	for (const core of ["from", "to", "cc", "bcc", "subject", "text", "html"]) {
		assert.equal(PROVIDER_OPTION_WHITELIST.includes(core), false);
	}
});

test("createNodemailerTransport: exposes name + send + verify", () => {
	const transport = createNodemailerTransport(baseOptions);
	assert.equal(transport.name, "nodemailer-smtp");
	assert.equal(typeof transport.send, "function");
	assert(typeof transport.verify === "function");
});

test("createNodemailerTransport: send() maps messageId → externalId (offline seam)", async () => {
	const calls: { config?: unknown; sent?: unknown; verified: number } = { verified: 0 };
	const transport = createNodemailerTransport(
		{ host: "h", port: 465, auth: { user: "u", pass: "p" } },
		(config) => {
			calls.config = config;
			return {
				sendMail: (message) => {
					calls.sent = message;
					return Promise.resolve({ messageId: "abc-123" });
				},
				verify: () => {
					calls.verified += 1;
					return Promise.resolve(true);
				},
			};
		},
	);

	const result = await transport.send({
		to: "to@x.com",
		from: "from@x.com",
		subject: "S",
		text: "body",
	});
	assert.equal(result.externalId, "abc-123");
	// The factory received the resolved transport config (secure from port 465).
	assert.equal((calls.config as { secure: boolean }).secure, true);
	// send() passed the mapped nodemailer message through.
	assert.equal((calls.sent as { to: string }).to, "to@x.com");

	await transport.verify!();
	assert.equal(calls.verified, 1);
});

test("createNodemailerTransport: verify() rejects when the transporter rejects", async () => {
	const transport = createNodemailerTransport(baseOptions, () => ({
		sendMail: () => Promise.resolve({ messageId: "x" }),
		verify: () => Promise.reject(new Error("nope")),
	}));
	let threw = false;
	try {
		await transport.verify!();
	} catch (e) {
		threw = e instanceof Error && e.message === "nope";
	}
	assert(threw, "expected verify() to reject");
});

// Type-only sanity: SendOptions is the input shape for the mapper.
const _typecheck: SendOptions = { to: "a@b.com", from: "c@d.com", subject: "s" };
void _typecheck;
