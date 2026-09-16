// @vitest-environment node
import { describe, expect, it } from "vitest";
import DependencyPostalMime from "postal-mime";
import VendorPostalMime from "../src/lib/mimeParser";

const bytes = (value: string) => Buffer.from(value, "utf8");
const headers = (encoding = "7bit", type = "application/octet-stream", name = "file.bin") =>
	`Content-Type: ${type}\r\nContent-Disposition: attachment; filename="${name}"\r\nContent-Transfer-Encoding: ${encoding}\r\n\r\n`;
function multipart(content: Uint8Array | string, encoding = "7bit", type = "application/octet-stream", name = "file.bin") {
	return Buffer.concat([
		bytes(`MIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="outer"\r\n\r\n--outer\r\n${headers(encoding, type, name)}`),
		typeof content === "string" ? bytes(content) : content,
		bytes("\r\n--outer--\r\n"),
	]);
}
describe.each([["patched dependency", DependencyPostalMime], ["production vendor", VendorPostalMime]])("%s preserves decoded attachment bytes", (_name, PostalMime) => {
async function content(raw: Uint8Array | string) {
	const parsed = await PostalMime.parse(raw);
	expect(parsed.attachments).toHaveLength(1);
	return Buffer.from(parsed.attachments[0].content as ArrayBuffer);
}

	it.each(["", "abc", "abc\n", "abc\r\n", "abc\r\n\r\n", "abc\n\n", "abc\r\ndef", "abc\r", "abc\r\r\n"])(
		"excludes only the multipart separator from a 7bit payload %j", async (payload) => {
			expect(await content(multipart(payload, "7bit", "text/plain"))).toEqual(bytes(payload));
		},
	);
	it.each(["7bit", "8bit", "binary"])("preserves arbitrary bytes with %s transfer encoding", async (encoding) => {
		const payload = Buffer.from([0, 255, 13, 10, 1, 2, 13, 13, 10, 128, 13]);
		expect(await content(multipart(payload, encoding))).toEqual(payload);
	});
	it("accepts LF-only MIME separators without manufacturing a content newline", async () => {
		const raw = `Content-Type: multipart/mixed; boundary="outer"\n\n--outer\n${headers().replaceAll("\r\n", "\n")}abc\n\n--outer--\n`;
		expect(await content(raw)).toEqual(bytes("abc\n"));
	});
	it.each([
		["abc", "abc"],
		["abc\r\ndef", "abc\r\ndef"],
		["abc\ndef\n", "abc\ndef\n"],
		["abc=\r\ndef=\nghi", "abcdefghi"],
		["=00=ff=0D=0A=80=3D", "hex:00ff0d0a803d"],
		["x=0D=0A", "x\r\n"],
		["x=", "x="],
		["abc \t\r\ndef\t\nend ", "abc\r\ndef\nend"],
		["abc=20=09", "abc \t"],
	])("decodes quoted-printable %j without altering hard line breaks", async (encoded, decoded) => {
		const expected = decoded.startsWith("hex:") ? Buffer.from(decoded.slice(4), "hex") : bytes(decoded);
		expect(await content(multipart(encoded, "quoted-printable"))).toEqual(expected);
	});
	it("does not transcode literal quoted-printable octets through the declared charset", async () => {
		const encoded = Buffer.from([0xe9, 0x3d, 0x32, 0x30, 0xff]);
		expect(await content(multipart(encoded, "quoted-printable", "text/plain; charset=iso-8859-1"))).toEqual(Buffer.from([0xe9, 0x20, 0xff]));
	});
	it.each(["", "\n", "\r\n", "\r", "=\r\n"])("preserves EOF bytes %j without a closing boundary", async (ending) => {
		const payload = `abc${ending}`;
		expect(await content(headers("binary") + payload)).toEqual(bytes(payload));
	});
	it("decodes a quoted-printable soft break at EOF", async () => {
		expect(await content(headers("quoted-printable") + "abc=\r\n")).toEqual(bytes("abc"));
	});
	it("preserves files inside nested multipart containers and sibling boundaries", async () => {
		const raw = `Content-Type: multipart/mixed; boundary="outer"\r\n\r\n--outer\r\nContent-Type: multipart/related; boundary="inner"\r\n\r\n--inner\r\n${headers()}first\r\n\r\n--inner\r\n${headers("8bit")}second\n\r\n--inner--\r\n\r\n--outer\r\n${headers()}third\r\n--outer--\r\n`;
		const parsed = await PostalMime.parse(raw);
		expect(parsed.attachments.map((attachment) => Buffer.from(attachment.content as ArrayBuffer))).toEqual([bytes("first\r\n"), bytes("second\n"), bytes("third")]);
	});
	it("preserves an attached .eml byte for byte", async () => {
		const eml = "From: reader@example.com\r\nSubject: Forwarded\r\nContent-Type: text/plain\r\n\r\nOriginal\r\n";
		expect(await content(multipart(eml, "7bit", "message/rfc822", "forwarded.eml"))).toEqual(bytes(eml));
	});
	it("closes an unterminated nested part at its parent boundary without double trimming", async () => {
		const raw = `Content-Type: multipart/mixed; boundary="outer"\r\n\r\n--outer\r\nContent-Type: multipart/mixed; boundary="inner"\r\n\r\n--inner\r\n${headers()}abc\r\n\r\n--outer--\r\n`;
		expect(await content(raw)).toEqual(bytes("abc\r\n"));
	});
	it("accepts boundary transport padding and retains lines that only share its prefix", async () => {
		const raw = multipart("abc\r\n--outer-prefix\r\nxyz").toString().replace("--outer--\r\n", "--outer-- \t\r\n");
		expect(await content(raw)).toEqual(bytes("abc\r\n--outer-prefix\r\nxyz"));
	});
	it("uses the patched decoder recursively for attachments in inline forwarded messages", async () => {
		const inner = multipart("nested\r\n", "7bit", "text/plain");
		const outer = multipart(inner, "7bit", "message/rfc822", "forwarded.eml").toString().replace('Content-Disposition: attachment; filename="forwarded.eml"', "Content-Disposition: inline");
		expect(await content(outer)).toEqual(bytes("nested\r\n"));
	});
	it.each(["text/calendar; method=request; charset=iso-8859-1", "application/ics"])("preserves calendar bytes for %s", async (type) => {
		const calendar = Buffer.concat([bytes("BEGIN:VCALENDAR\r\nSUMMARY:Caf"), Buffer.from([0xe9]), bytes("\r\nEND:VCALENDAR\r\n\r\n")]);
		const parsed = await PostalMime.parse(multipart(calendar, "8bit", type, "invite.ics"));
		expect(Buffer.from(parsed.attachments[0].content as ArrayBuffer)).toEqual(calendar);
		if (type.startsWith("text/calendar")) expect(parsed.attachments[0].method).toBe("REQUEST");
	});
	it("leaves base64 decoding unchanged, including base64 calendar content", async () => {
		const payload = Buffer.from([0, 255, 13, 10, 1, 2, 13]);
		for (const type of ["application/octet-stream", "text/plain", "text/calendar"]) {
			expect(await content(multipart(payload.toString("base64"), "base64", type))).toEqual(payload);
		}
	});
});
