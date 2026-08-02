import { INVESTIGATION_EVIDENCE_MAX_BYTES } from "../investigation-evidence-storage.js";

export const INVESTIGATION_EVIDENCE_MAX_REQUEST_BYTES =
  Math.ceil(INVESTIGATION_EVIDENCE_MAX_BYTES / 3) * 4 + 65_536;

function tooLarge(c) {
  return c.json({
    available: false,
    code: "EVIDENCE_BODY_TOO_LARGE",
    message: "The evidence upload request exceeds the 10 MiB file limit.",
  }, 413);
}

export function createEvidenceUploadBodyLimit() {
  return async (c, next) => {
    const body = c.req.raw.body;
    if (!body) return next();

    const lengthHeader = c.req.header("content-length");
    if (lengthHeader) {
      const length = Number(lengthHeader);
      if (!Number.isSafeInteger(length) || length < 0 || length > INVESTIGATION_EVIDENCE_MAX_REQUEST_BYTES) {
        return tooLarge(c);
      }
      return next();
    }

    const reader = c.req.raw.clone().body.getReader();
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > INVESTIGATION_EVIDENCE_MAX_REQUEST_BYTES) {
        await reader.cancel();
        return tooLarge(c);
      }
    }
    return next();
  };
}
