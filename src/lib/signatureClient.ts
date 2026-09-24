import { postInbox } from "./attachmentClient";
import { isEmailSignature, type EmailSignature } from "./signature";

export async function getSignature(): Promise<{ signature: EmailSignature; canSave: boolean }> {
	const data = await postInbox<{ signature: EmailSignature; canSave: boolean }>("signature/get", {});
	if (!data || !isEmailSignature(data.signature) || typeof data.canSave !== "boolean") throw new Error("Could not load your email signature. Try again.");
	return data;
}
