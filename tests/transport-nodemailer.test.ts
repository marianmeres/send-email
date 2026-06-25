import { assert, assertEquals, assertFalse } from "@std/assert";
import {
	_toNodemailerMessage,
	_toTransportConfig,
	createNodemailerTransport,
	PROVIDER_OPTION_WHITELIST,
} from "../src/transport-nodemailer.ts";
import type { NodemailerTransportOptions } from "../src/transport-nodemailer.ts";
import type { SendOptions } from "../src/types.ts";

const baseOptions: NodemailerTransportOptions = { host: "smtp.example.com", port: 587 };

Deno.test("_toTransportConfig: secure defaults to (port === 465)", () => {
	assertEquals(_toTransportConfig({ host: "h", port: 465 }).secure, true);
	assertEquals(_toTransportConfig({ host: "h", port: 587 }).secure, false);
	assertEquals(_toTransportConfig({ host: "h", port: 25 }).secure, false);
});

Deno.test("_toTransportConfig: explicit secure overrides the port default", () => {
	assertEquals(
		_toTransportConfig({ host: "h", port: 465, secure: false }).secure,
		false,
	);
	assertEquals(_toTransportConfig({ host: "h", port: 587, secure: true }).secure, true);
});

Deno.test("_toTransportConfig: passes through auth, timeouts and tls", () => {
	const config = _toTransportConfig({
		host: "h",
		port: 587,
		auth: { user: "u", pass: "p" },
		connectionTimeout: 1234,
		socketTimeout: 5678,
		tls: { servername: "real.host", rejectUnauthorized: false },
	});
	assertEquals(config.auth, { user: "u", pass: "p" });
	assertEquals(config.connectionTimeout, 1234);
	assertEquals(config.socketTimeout, 5678);
	assertEquals(config.tls, { servername: "real.host", rejectUnauthorized: false });
});

Deno.test("_toTransportConfig: omits unset optional fields", () => {
	const config = _toTransportConfig(baseOptions);
	assertFalse("auth" in config);
	assertFalse("tls" in config);
	assertFalse("connectionTimeout" in config);
	assertFalse("socketTimeout" in config);
});

Deno.test("_toNodemailerMessage: maps camelCase body fields", () => {
	const msg = _toNodemailerMessage({
		to: "to@example.com",
		from: "from@example.com",
		subject: "Subj",
		html: "<p>h</p>",
		text: "t",
	}, baseOptions);
	assertEquals(msg.to, "to@example.com");
	assertEquals(msg.from, "from@example.com");
	assertEquals(msg.subject, "Subj");
	assertEquals(msg.html, "<p>h</p>");
	assertEquals(msg.text, "t");
});

Deno.test("_toNodemailerMessage: joins multi-recipient to/cc/bcc with ', '", () => {
	const msg = _toNodemailerMessage({
		to: ["a@example.com", "b@example.com"],
		from: "from@example.com",
		subject: "x",
		cc: ["c@example.com", "d@example.com"],
		bcc: ["e@example.com"],
	}, baseOptions);
	assertEquals(msg.to, "a@example.com, b@example.com");
	assertEquals(msg.cc, "c@example.com, d@example.com");
	assertEquals(msg.bcc, "e@example.com");
});

Deno.test("_toNodemailerMessage: replyTo falls back to defaultReplyTo", () => {
	const withFallback = _toNodemailerMessage(
		{ to: "t@x.com", from: "f@x.com", subject: "x" },
		{ ...baseOptions, defaultReplyTo: "fallback@x.com" },
	);
	assertEquals(withFallback.replyTo, "fallback@x.com");

	const explicit = _toNodemailerMessage(
		{ to: "t@x.com", from: "f@x.com", subject: "x", replyTo: "explicit@x.com" },
		{ ...baseOptions, defaultReplyTo: "fallback@x.com" },
	);
	assertEquals(explicit.replyTo, "explicit@x.com");
});

Deno.test("_toNodemailerMessage: maps attachments (content/path/contentType/cid)", () => {
	const msg = _toNodemailerMessage({
		to: "t@x.com",
		from: "f@x.com",
		subject: "x",
		attachments: [
			{ filename: "a.pdf", path: "/tmp/a.pdf", contentType: "application/pdf" },
			{ filename: "b.txt", content: "hello", cid: "logo" },
		],
	}, baseOptions);
	assertEquals(msg.attachments?.length, 2);
	assertEquals(msg.attachments?.[0], {
		filename: "a.pdf",
		path: "/tmp/a.pdf",
		contentType: "application/pdf",
	});
	assertEquals(msg.attachments?.[1], {
		filename: "b.txt",
		content: "hello",
		cid: "logo",
	});
});

Deno.test("_toNodemailerMessage: forwards only whitelisted providerOptions", () => {
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
	assertEquals(bag.headers, { "X-Custom": "1" });
	assertEquals(bag.priority, "high");
	// Core fields untouched by providerOptions:
	assertEquals(msg.to, "t@x.com");
	assertEquals(msg.from, "f@x.com");
	assertFalse("whatever" in bag);
});

Deno.test("PROVIDER_OPTION_WHITELIST never contains core fields", () => {
	for (const core of ["from", "to", "cc", "bcc", "subject", "text", "html"]) {
		assertFalse(PROVIDER_OPTION_WHITELIST.includes(core));
	}
});

Deno.test("createNodemailerTransport: exposes name + send + verify", () => {
	const transport = createNodemailerTransport(baseOptions);
	assertEquals(transport.name, "nodemailer-smtp");
	assertEquals(typeof transport.send, "function");
	assert(typeof transport.verify === "function");
});

Deno.test("createNodemailerTransport: send() maps messageId → externalId (offline seam)", async () => {
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
	assertEquals(result.externalId, "abc-123");
	// The factory received the resolved transport config (secure from port 465).
	assertEquals((calls.config as { secure: boolean }).secure, true);
	// send() passed the mapped nodemailer message through.
	assertEquals((calls.sent as { to: string }).to, "to@x.com");

	await transport.verify!();
	assertEquals(calls.verified, 1);
});

Deno.test("createNodemailerTransport: verify() rejects when the transporter rejects", async () => {
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
