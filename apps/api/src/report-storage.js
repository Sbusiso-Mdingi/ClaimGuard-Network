import path from "node:path";
import { readFile } from "node:fs/promises";

function parseJson(content, source) {
  try {
    return JSON.parse(content);
  } catch (error) {
    const wrapped = new Error(`Invalid JSON in ${source}.`);
    wrapped.cause = error;
    wrapped.code = "REPORT_JSON_INVALID";
    throw wrapped;
  }
}

export class FileReportStorage {
  constructor({ reportPath = null } = {}) {
    this.reportPath = reportPath;
  }

  async getLatestReport() {
    if (!this.reportPath) {
      return null;
    }

    const content = await readFile(this.reportPath, "utf-8");
    const report = parseJson(content, this.reportPath);
    return {
      report,
      metadata: {
        source: "file",
        location: this.reportPath,
        version: path.basename(this.reportPath),
      },
    };
  }
}

export class AzureBlobReportStorage {
  constructor({
    containerClient,
    latestPointerBlobName = "latest.json",
    fallbackReportBlobName = null,
  }) {
    if (!containerClient) {
      throw new Error("AzureBlobReportStorage requires a containerClient.");
    }

    this.containerClient = containerClient;
    this.latestPointerBlobName = latestPointerBlobName;
    this.fallbackReportBlobName = fallbackReportBlobName;
  }

  static async fromEnvironment({
    accountUrl = process.env.REPORT_STORAGE_ACCOUNT_URL,
    connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING,
    containerName = process.env.REPORT_STORAGE_CONTAINER,
    latestPointerBlobName = process.env.REPORT_STORAGE_LATEST_POINTER || "latest.json",
    fallbackReportBlobName = process.env.REPORT_STORAGE_REPORT_BLOB || null,
  } = {}) {
    if (!containerName) {
      throw new Error("REPORT_STORAGE_CONTAINER is required for Azure blob report storage.");
    }

    const { BlobServiceClient } = await import("@azure/storage-blob");

    let blobServiceClient = null;
    if (connectionString) {
      blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
    } else {
      if (!accountUrl) {
        throw new Error("REPORT_STORAGE_ACCOUNT_URL is required when AZURE_STORAGE_CONNECTION_STRING is not set.");
      }
      const { DefaultAzureCredential } = await import("@azure/identity");
      blobServiceClient = new BlobServiceClient(accountUrl, new DefaultAzureCredential());
    }

    const containerClient = blobServiceClient.getContainerClient(containerName);

    return new AzureBlobReportStorage({
      containerClient,
      latestPointerBlobName,
      fallbackReportBlobName,
    });
  }

  async getLatestReport() {
    const pointer = await this.#readPointer();
    const reportBlobName =
      pointer?.reportBlobName ||
      pointer?.report_blob_name ||
      pointer?.reportPath ||
      pointer?.report_path ||
      this.fallbackReportBlobName;

    if (!reportBlobName) {
      return null;
    }

    const reportContent = await this.#readBlobAsString(reportBlobName);
    if (!reportContent) {
      return null;
    }

    const report = parseJson(reportContent, reportBlobName);
    return {
      report,
      metadata: {
        source: "azure_blob",
        container: this.containerClient.containerName,
        pointerBlob: this.latestPointerBlobName,
        reportBlob: reportBlobName,
        version: pointer?.version || pointer?.reportVersion || null,
        generatedAt: pointer?.generatedAt || pointer?.generated_at || null,
      },
    };
  }

  async #readPointer() {
    const content = await this.#readBlobAsString(this.latestPointerBlobName);
    if (!content) {
      return null;
    }

    return parseJson(content, this.latestPointerBlobName);
  }

  async #readBlobAsString(blobName) {
    const blobClient = this.containerClient.getBlobClient(blobName);
    if (!(await blobClient.exists())) {
      return null;
    }

    const download = await blobClient.download();
    const stream = download.readableStreamBody;
    if (!stream) {
      return "";
    }

    return streamToString(stream);
  }
}

async function streamToString(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf-8");
}

export async function createReportStorageFromEnvironment({
  reportStorageBackend = process.env.REPORT_STORAGE_BACKEND || null,
  reportPath = process.env.DETECTION_REPORT_PATH || null,
  repoRoot,
} = {}) {
  const backend = (reportStorageBackend || "").trim().toLowerCase();

  if (backend === "azure_blob") {
    return AzureBlobReportStorage.fromEnvironment();
  }

  const resolvedReportPath = reportPath
    ? path.isAbsolute(reportPath)
      ? reportPath
      : path.resolve(repoRoot || process.cwd(), reportPath)
    : null;

  return new FileReportStorage({ reportPath: resolvedReportPath });
}
