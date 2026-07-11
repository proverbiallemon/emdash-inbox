import { describe, it, expect } from "vitest";
import { extractAddresses } from "./inboundAddresses";

describe("extractAddresses", () => {
	it("returns every non-empty address in order", () => {
		const r = extractAddresses([
			{ name: "PocketBear", address: "PocketBear@harildkyler.com" },
			{ name: "Bob", address: "bob@example.com" },
		]);
		expect(r).toEqual(["PocketBear@harildkyler.com", "bob@example.com"]);
	});

	it("skips entries with a missing address (mailing-list groups)", () => {
		const r = extractAddresses([
			{ name: "Some Group", group: [{ name: "Bob", address: "bob@example.com" }] },
			{ name: "Carol", address: "carol@example.com" },
		]);
		expect(r).toEqual(["carol@example.com"]);
	});

	it("returns [] for undefined input", () => {
		expect(extractAddresses(undefined)).toEqual([]);
	});
});
