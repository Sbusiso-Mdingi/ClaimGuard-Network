import crypto from "node:crypto";
import path from "node:path";

const MAX_EVIDENCE_BYTES = 10 * 1024 * 1024;
const ALLOWED_CONTENT = Object.freeze({
  "application/pdf": { extensions: [".pdf"], signature: (content) => content.subarray(0, 5).toString("ascii") === "%PDF-" },
  "image/png": { extensions: [".png"], signature: (content) => content.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  "image/jpeg": { extensions: [".jpg", ".jpeg"], signature: (content) => content.length >= 3 && content[0] === 0xff && content[1] === 0xd8 && content[2] === 0xff },
  "text/plain": { extensions: [".txt"], signature: (content) => !content.includes(0) },
  "text/csv": { extensions: [".csv"], signature: (content) => !content.includes(0) },
});

export class InvestigationEvidenceStorageError extends Error {
  constructor(message, code = "EVIDENCE_UPLOAD_INVALID", status = 400) {
    super(message);
    this.name = "InvestigationEvidenceStorageError";
    this.code = code;
    this.status = status;
  }
}

function safeIdentifier(value, fieldName, maximum = 128) {
  const normalized = String(value || "").trim();
  if (!normalized || normalized.length > maximum || !/^[A-Za-z0-9_.:-]+$/.test(normalized)) {
    throw new InvestigationEvidenceStorageError(`${fieldName} is invalid.`);
  }
  return normalized;
}

function safeFilename(value) {
  const supplied = String(value || "").trim().normalize("NFKC");
  const normalized = path.basename(supplied);
  if (!normalized || normalized === "." || normalized !== supplied || /[\\/]/.test(supplied)
    || normalized.length > 255 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new InvestigationEvidenceStorageError("The evidence filename is invalid.");
  }
  return normalized;
}

function decodeContent(value) {
  const encoded = String(value || "");
  if (!encoded || encoded.length > Math.ceil(MAX_EVIDENCE_BYTES / 3) * 4 + 8 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
    throw new InvestigationEvidenceStorageError("The evidence content is invalid.");
  }
  const content = Buffer.from(encoded, "base64");
  if (content.length < 1 || content.length > MAX_EVIDENCE_BYTES || content.toString("base64") !== encoded) {
    throw new InvestigationEvidenceStorageError(`Evidence files must be between 1 byte and ${MAX_EVIDENCE_BYTES} bytes.`);
  }
  return content;
}

export function validateEvidenceUpload({ filename, contentType, contentBase64 }) {
  const normalizedFilename = safeFilename(filename);
  const normalizedContentType = String(contentType || "").trim().toLowerCase();
  const rule = ALLOWED_CONTENT[normalizedContentType];
  const extension = path.extname(normalizedFilename).toLowerCase();
  if (!rule || !rule.extensions.includes(extension)) {
    throw new InvestigationEvidenceStorageError("Only PDF, PNG, JPEG, TXT, and CSV evidence files are accepted.");
  }
  const content = decodeContent(contentBase64);
  if (!rule.signature(content)) {
    throw new InvestigationEvidenceStorageError("The evidence content does not match its declared file type.");
  }
  return {
    filename: normalizedFilename,
    contentType: normalizedContentType,
    content,
    byteSize: content.length,
    contentSha256: crypto.createHash("sha256").update(content).digest("hex"),
  };
}

export class AzureBlobInvestigationEvidenceStorage {
  constructor({ containerClient }) {
    if (!containerClient) throw new TypeError("A private Azure Blob container client is required.");
    this.containerClient = containerClient;
  }

  static async fromEnvironment({
    accountUrl = process.env.EVIDENCE_STORAGE_ACCOUNT_URL || process.env.REPORT_STORAGE_ACCOUNT_URL,
    connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING,
    containerName = process.env.EVIDENCE_STORAGE_CONTAINER,
  } = {}) {
    if (!containerName) throw new Error("EVIDENCE_STORAGE_CONTAINER is required for evidence storage.");
    const { BlobServiceClient } = await import("@azure/storage-blob");
    let service;
    if (connectionString) {
      service = BlobServiceClient.fromConnectionString(connectionString);
    } else {
      if (!accountUrl) throw new Error("EVIDENCE_STORAGE_ACCOUNT_URL is required for evidence storage.");
      const { DefaultAzureCredential } = await import("@azure/identity");
      service = new BlobServiceClient(accountUrl, new DefaultAzureCredential());
    }
    return new AzureBlobInvestigationEvidenceStorage({
      containerClient: service.getContainerClient(containerName),
    });
  }

  async store({ tenantId, investigationId, evidenceId, filename, contentType, content, contentSha256 }) {
    const tenant = safeIdentifier(tenantId, "tenantId");
    const investigation = safeIdentifier(investigationId, "investigationId");
    const evidence = safeIdentifier(evidenceId, "evidenceId");
    const objectKey = `${tenant}/investigations/${investigation}/${evidence}`;
    const blob = this.containerClient.getBlockBlobClient(objectKey);
    await blob.uploadData(content, {
      conditions: { ifNoneMatch: "*" },
      blobHTTPHeaders: {
        blobContentType: contentType,
        blobCacheControl: "no-store, private",
        blobContentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
      },
      metadata: {
        tenant_id: tenant,
        investigation_id: investigation,
        evidence_id: evidence,
        content_sha256: contentSha256,
      },
    });
    return { objectKey };
  }

  async delete(objectKey) {
    await this.containerClient.deleteBlob(objectKey, { deleteSnapshots: "include" });
  }
}

export async function createInvestigationEvidenceStorageFromEnvironment({
  backend = process.env.EVIDENCE_STORAGE_BACKEND || null,
} = {}) {
  if (!backend) return null;
  if (String(backend).trim().toLowerCase() !== "azure_blob") {
    throw new Error("EVIDENCE_STORAGE_BACKEND must be azure_blob when configured.");
  }
  return AzureBlobInvestigationEvidenceStorage.fromEnvironment();
}

export const INVESTIGATION_EVIDENCE_MAX_BYTES = MAX_EVIDENCE_BYTES;
