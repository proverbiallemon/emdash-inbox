export const MAX_SIGNATURE_IMAGE_BYTES = 64 * 1024;
export const SIGNATURE_IMAGE_TYPES = "image/png,image/jpeg,image/gif,image/webp";

export function decodeSignatureImage(src: string): { bytes: Uint8Array; type: string } | null {
	if (!/^data:image\/(png|jpeg|gif|webp);base64,/i.test(src)) return null;
	const comma = src.indexOf(",");
	const type = src.slice(5, comma - 7).toLowerCase();
	const base64 = src.slice(comma + 1);
	if (base64.length > 4 * Math.ceil(MAX_SIGNATURE_IMAGE_BYTES / 3)) throw new Error("Signature images must total at most 64 KiB. Use a smaller logo.");
	if (!base64 || base64.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) throw new Error("The signature image is not valid base64.");
	const binary = atob(base64);
	if (btoa(binary) !== base64) throw new Error("The signature image is not valid base64.");
	const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
	const matches = type === "image/png" ? [137,80,78,71,13,10,26,10].every((v,i) => bytes[i] === v)
		: type === "image/jpeg" ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
		: type === "image/gif" ? /^GIF8[79]a/.test(binary)
		: binary.startsWith("RIFF") && binary.slice(8,12) === "WEBP";
	if (!matches) throw new Error("Use a valid PNG, JPEG, GIF or WebP image.");
	if (bytes.length > MAX_SIGNATURE_IMAGE_BYTES) throw new Error("Signature images must total at most 64 KiB. Use a smaller logo.");
	return { bytes, type };
}

export async function readSignatureImage(file: File): Promise<string> {
	if (!SIGNATURE_IMAGE_TYPES.split(",").includes(file.type)) throw new Error("Choose a PNG, JPEG, GIF or WebP image.");
	if (file.size > MAX_SIGNATURE_IMAGE_BYTES) throw new Error("Choose an image smaller than 64 KiB.");
	const src = await new Promise<string>((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(String(reader.result));
		reader.onerror = () => reject(new Error("Could not read this image. Try again."));
		reader.readAsDataURL(file);
	});
	if (!decodeSignatureImage(src)) throw new Error("Choose a supported image.");
	return src;
}
