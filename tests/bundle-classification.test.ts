import { canonicalSender, classifyThread, messageAssignment } from "../src/lib/bundles";
import { publicMessage } from "../src/lib/attachmentMetadata";
import { describe, expect, it } from "vitest";
import { aggregateThreads } from "../src/lib/threadSummary";
import type { MessageDoc } from "../src/index";
function message(i: number, overrides: Partial<MessageDoc> = {}): MessageDoc {
    const receivedAt = new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
    return { messageId: `<m${i}@example.com>`, threadId: "thread", direction: "inbound", from: "Shop <receipts@shop.example>", to: "owner@example.com", subject: "Your order confirmation", bodyText: "Thank you for your purchase", bodyHtml: null, bodyRaw: null, receivedAt, source: "inbound", status: "inbox", pinned: false, read: false, bundleId: null, sortAt: receivedAt, snoozeUntil: null, inReplyTo: null, ...overrides };
}
function assignment(messages: MessageDoc[]) { return aggregateThreads(messages.map((data, i) => ({ id: String(i), data })), "inbox", "")[0]?.bundle; }
describe("conservative bundle classification", () => {
    it("evolves a receipt into shipping and ignores outgoing replies and drafts", () => {
        expect(assignment([message(1)])).toMatchObject({ bundle: "orders", source: "builtin" });
        expect(assignment([message(1), message(2, { subject: "Your order has shipped" }), message(3, { direction: "outbound", subject: "Receipt thanks" }), message(4, { status: "draft", subject: "Sale 20% off" })])).toMatchObject({ bundle: "shipping", source: "builtin" });
    });
    it("leaves uncertain personal and relationship messages ordinary", () => {
        for (const subject of ["Can we talk?", "Commission question", "Your biggest fan", "Shipping ideas for our project"])
            expect(assignment([message(1, { subject, bodyText: "Hello" })])).toEqual({ bundle: null, source: "none" });
    });
});
it("parses a single exact mailbox and never a display-name address, group, or domain", () => {
    expect(canonicalSender('"Shop, Inc" <Receipts@Shop.Example>')).toBe("receipts@shop.example");
    expect(canonicalSender('"receipts@shop.example" <stranger@elsewhere.example>')).toBe("stranger@elsewhere.example");
    for (const input of ["shop.example", "Friends: receipts@shop.example;", "a@shop.example, b@shop.example", "a@shop.example\r\nBcc: b@shop.example"])
        expect(canonicalSender(input)).toBeNull();
});
it("manual no-bundle and persisted exact-sender evidence override matching built-ins", () => {
    const mail = message(1, { bundleEvidence: { version: 1, assignment: { bundle: "fans", source: "sender", sender: "receipts@shop.example", ruleId: "receipts@shop.example" } } });
    expect(messageAssignment(mail)).toMatchObject({ bundle: "fans", source: "sender" });
    expect(classifyThread([mail], { bundle: null })).toEqual({ bundle: null, source: "manual" });
    expect(messageAssignment({ ...mail, direction: "outbound" })).toEqual({ bundle: null, source: "none" });
});
it("keeps invalid stored classification evidence visible as ordinary mail", () => {
    expect(messageAssignment(message(1, { bundleEvidence: { version: 1, assignment: { bundle: "bad-category", source: "sender" } } as any }))).toEqual({ bundle: null, source: "none" });
});
it("recognizes clear dispatch and delivered notices without guessing general shipping discussions", () => {
    for (const subject of ["Your order has been dispatched", "Your package was delivered", "Your shipment is out for delivery"])
        expect(messageAssignment(message(1, { subject }))).toMatchObject({ bundle: "shipping" });
});
it("keeps internal ingestion evidence out of every public message serializer", () => {
    expect(publicMessage(message(1, { bundleEvidence: { version: 1, assignment: { bundle: "fans", source: "sender", ruleId: "receipts@shop.example" } } }))).not.toHaveProperty("bundleEvidence");
});
