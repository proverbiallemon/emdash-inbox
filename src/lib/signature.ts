/** A signature belongs to an EmDash user, independently of the shared sender. */
export interface EmailSignature {
	text: string;
	html?: string;
	newMessages: boolean;
	replies: boolean;
}

export const MAX_SIGNATURE_LENGTH = 10_000;
export const MAX_SIGNATURE_HTML_LENGTH = 128 * 1024;
export const defaultSignature: EmailSignature = { text: "", newMessages: true, replies: true };

export function isEmailSignature(value: unknown): value is EmailSignature {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const signature = value as Partial<EmailSignature>;
	return typeof signature.text === "string" && signature.text.length <= MAX_SIGNATURE_LENGTH &&
		(signature.html === undefined || typeof signature.html === "string" && signature.html.length <= MAX_SIGNATURE_HTML_LENGTH) &&
		!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(signature.text) &&
		typeof signature.newMessages === "boolean" && typeof signature.replies === "boolean";
}
