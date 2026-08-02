import assert from "node:assert/strict";
import test from "node:test";

import {
  AzureBlobInvestigationEvidenceStorage,
  InvestigationEvidenceStorageError,
  validateEvidenceUpload,
} from "../src/investigation-evidence-storage.js";
import { createInvestigationService } from "../src/services/investigation-service.js";

test("evidence validation accepts declared content, computes integrity metadata, and rejects disguised or unsafe files", () => {
  const valid = validateEvidenceUpload({
    filename: "provider invoice.pdf",
    contentType: "application/pdf",
    contentBase64: Buffer.from("%PDF-1.7\nClaimGuard evidence").toString("base64"),
  });

  assert.equal(valid.filename, "provider invoice.pdf");
  assert.equal(valid.contentType, "application/pdf");
  assert.equal(valid.byteSize, valid.content.length);
  assert.match(valid.contentSha256, /^[0-9a-f]{64}$/);

  assert.throws(
    () => validateEvidenceUpload({
      filename: "../provider-invoice.pdf",
      contentType: "application/pdf",
      contentBase64: Buffer.from("%PDF-1.7\nunsafe name").toString("base64"),
    }),
    (error) => error instanceof InvestigationEvidenceStorageError && error.code === "EVIDENCE_UPLOAD_INVALID",
  );
  assert.throws(
    () => validateEvidenceUpload({
      filename: "provider-invoice.pdf",
      contentType: "application/pdf",
      contentBase64: Buffer.from("This is not a PDF").toString("base64"),
    }),
    /does not match its declared file type/,
  );
  assert.throws(
    () => validateEvidenceUpload({
      filename: "provider-invoice.exe",
      contentType: "application/octet-stream",
      contentBase64: Buffer.from("MZ").toString("base64"),
    }),
    /Only PDF, PNG, JPEG, TXT, and CSV/,
  );
});

test("Azure evidence storage writes private no-store blobs with tenant-scoped immutable keys", async () => {
  const calls = [];
  const storage = new AzureBlobInvestigationEvidenceStorage({
    containerClient: {
      getBlockBlobClient(objectKey) {
        calls.push(["client", objectKey]);
        return {
          async uploadData(content, options) {
            calls.push(["upload", Buffer.from(content).toString("utf8"), options]);
          },
        };
      },
      async deleteBlob(objectKey, options) {
        calls.push(["delete", objectKey, options]);
      },
    },
  });

  const result = await storage.store({
    tenantId: "tenant-alpha",
    investigationId: "investigation-1",
    evidenceId: "evidence-1",
    filename: "provider invoice.txt",
    contentType: "text/plain",
    content: Buffer.from("invoice"),
    contentSha256: "a".repeat(64),
  });

  assert.equal(result.objectKey, "tenant-alpha/investigations/investigation-1/evidence-1");
  assert.equal(calls[1][2].conditions.ifNoneMatch, "*");
  assert.equal(calls[1][2].blobHTTPHeaders.blobCacheControl, "no-store, private");
  assert.equal(calls[1][2].metadata.tenant_id, "tenant-alpha");
  assert.equal(Object.hasOwn(result, "url"), false);

  await storage.delete(result.objectKey);
  assert.deepEqual(calls[2], ["delete", result.objectKey, { deleteSnapshots: "include" }]);
});

test("evidence upload compensates the private blob when the versioned database write loses a race", async () => {
  const deleted = [];
  const repositoryError = Object.assign(new Error("stale"), { code: "stale_record_version" });
  const service = createInvestigationService({
    investigationRepository: {
      async registerEvidence() { throw repositoryError; },
    },
    evidenceStorage: {
      async store() { return { objectKey: "tenant-alpha/investigations/investigation-1/evidence-1/file.txt" }; },
      async delete(objectKey) { deleted.push(objectKey); },
    },
  });

  await assert.rejects(
    () => service.uploadEvidence({
      tenantId: "tenant-alpha",
      investigationId: "investigation-1",
      filename: "file.txt",
      contentType: "text/plain",
      contentBase64: Buffer.from("evidence").toString("base64"),
      evidenceType: "DOCUMENT",
      uploadedBy: "investigator-alpha",
      expectedRecordVersion: 3,
    }),
    repositoryError,
  );
  assert.deepEqual(deleted, ["tenant-alpha/investigations/investigation-1/evidence-1/file.txt"]);
});
