// @vitest-environment node
import { expect, it } from "vitest";
import { passivePreview } from "../src/daylight/AttachmentPreview";
it("renders plain text as text and checks raster signatures before creating a typed image",async()=>{
 const html="<script>alert(1)</script>";
 expect(await passivePreview(new Blob([html]),"text/plain")).toEqual({text:html});
 await expect(passivePreview(new Blob([html]),"image/png")).rejects.toThrow("cannot be previewed");
 for(const mime of ["text/html","image/svg+xml","application/pdf"]) await expect(passivePreview(new Blob([html]),mime)).rejects.toThrow("cannot be previewed");
 const image=await passivePreview(new Blob([new Uint8Array([137,80,78,71,13,10,26,10])]),"image/png");
 expect(image.blob?.type).toBe("image/png");
});

