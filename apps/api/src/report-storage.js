import path from "node:path";
import { access, readFile } from "node:fs/promises";

import { getActiveTenantContext } from "@claimguard/database";

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
  constructor({
    reportPath = null,
    tenantReportsRoot = null,
    latestPointerFileName = "latest.json",
  } = {}) {
    this.reportPath = reportPath;
    this.tenantReportsRoot = tenantReportsRoot;
    this.latestPointerFileName = latestPointerFileName;
  }

  #getResolvedReportsRoot() {
    if (this.tenantReportsRoot) {
      return this.tenantReportsRoot;
    }

    if (!this.reportPath) {
      return null;
    }

    return path.dirname(this.reportPath);
  }

  async getLatestReport({ tenantContext = getActiveTenantContext() } = {}) {
    const reportsRoot = this.#getResolvedReportsRoot();
    const tenantCandidates = buildTenantCandidates(tenantContext);

    for (const tenantCandidate of tenantCandidates) {
      const prefixed = await this.#loadTenantScopedReport({
        reportsRoot,
        tenantSegment: tenantCandidate,
      });

      if (prefixed) {
        return prefixed;
      }
    }

    return null;
  }

  async checkReadiness({ tenantContext = getActiveTenantContext() } = {}) {
    const reportsRoot = this.#getResolvedReportsRoot();
    const tenantCandidates = buildTenantCandidates(tenantContext);

    for (const tenantCandidate of tenantCandidates) {
      const reportPathCandidate = await this.#resolveTenantScopedReportPath({
        reportsRoot,
        tenantSegment: tenantCandidate,
      });

      if (reportPathCandidate) {
        return {
          reachable: true,
          available: await this.#fileExists(reportPathCandidate),
        };
      }
    }

    return {
      reachable: true,
      available: false,
    };
  }

  async #resolveTenantScopedReportPath({ reportsRoot, tenantSegment }) {
    if (!reportsRoot || !tenantSegment) {
      return null;
    }

    const tenantRoot = path.join(reportsRoot, tenantSegment);
    const pointerPath = path.join(tenantRoot, this.latestPointerFileName);
    const pointerContent = await this.#readFileIfExists(pointerPath);
    if (!pointerContent) {
      return null;
    }

    const pointer = parseJson(pointerContent, pointerPath);
    return resolveReportReference({
      reference:
        pointer?.reportBlobName ||
        pointer?.report_blob_name ||
        pointer?.reportPath ||
        pointer?.report_path ||
        null,
      rootPath: reportsRoot,
      tenantRootPath: tenantRoot,
    });
  }

  async #loadTenantScopedReport({ reportsRoot, tenantSegment }) {
    if (!reportsRoot || !tenantSegment) {
      return null;
    }

    const tenantRoot = path.join(reportsRoot, tenantSegment);
    const pointerPath = path.join(tenantRoot, this.latestPointerFileName);
    const pointerContent = await this.#readFileIfExists(pointerPath);
    if (!pointerContent) {
      return null;
    }

    const pointer = parseJson(pointerContent, pointerPath);
    const reportPathCandidate = resolveReportReference({
      reference:
        pointer?.reportBlobName ||
        pointer?.report_blob_name ||
        pointer?.reportPath ||
        pointer?.report_path ||
        null,
      rootPath: reportsRoot,
      tenantRootPath: tenantRoot,
    });

    if (!reportPathCandidate) {
      return null;
    }

    const reportContent = await this.#readFileIfExists(reportPathCandidate);
    if (!reportContent) {
      return null;
    }

    return {
      report: parseJson(reportContent, reportPathCandidate),
      metadata: {
        source: "file",
        location: reportPathCandidate,
        pointer: pointerPath,
        version: pointer?.version || pointer?.reportVersion || path.basename(reportPathCandidate),
        generatedAt: pointer?.generatedAt || pointer?.generated_at || null,
        tenant: tenantSegment,
      },
    };
  }

  async #readFileIfExists(filePath) {
    try {
      return await readFile(filePath, "utf-8");
    } catch (error) {
      if (error?.code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  async #fileExists(filePath) {
    try {
      await access(filePath);
      return true;
    } catch (error) {
      if (error?.code === "ENOENT") {
        return false;
      }
      throw error;
    }
  }
}

export class AzureBlobReportStorage {
  constructor({
    containerClient,
    latestPointerBlobName = "latest.json",
  }) {
    if (!containerClient) {
      throw new Error("AzureBlobReportStorage requires a containerClient.");
    }

    this.containerClient = containerClient;
    this.latestPointerBlobName = latestPointerBlobName;
  }

  static async fromEnvironment({
    accountUrl = process.env.REPORT_STORAGE_ACCOUNT_URL,
    connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING,
    containerName = process.env.REPORT_STORAGE_CONTAINER,
    latestPointerBlobName = process.env.REPORT_STORAGE_LATEST_POINTER || "latest.json",
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
    });
  }

  async getLatestReport({ tenantContext = getActiveTenantContext() } = {}) {
    const tenantCandidates = buildTenantCandidates(tenantContext);

    for (const tenantCandidate of tenantCandidates) {
      const tenantScoped = await this.#readTenantScopedReport(tenantCandidate);
      if (tenantScoped) {
        return tenantScoped;
      }
    }

    return null;
  }

  async checkReadiness({ tenantContext = getActiveTenantContext() } = {}) {
    const tenantCandidates = buildTenantCandidates(tenantContext);

    for (const tenantCandidate of tenantCandidates) {
      const reportBlobName = await this.#resolveTenantScopedReportBlob(tenantCandidate);
      if (!reportBlobName) {
        continue;
      }

      return {
        reachable: true,
        available: await this.#blobExists(reportBlobName),
      };
    }

    return {
      reachable: true,
      available: false,
    };
  }

  async #resolveTenantScopedReportBlob(tenantSegment) {
    if (!tenantSegment) {
      return null;
    }

    const tenantPrefix = `${tenantSegment}/`;
    const pointerBlobName = `${tenantPrefix}${this.latestPointerBlobName}`;
    const pointer = await this.#readPointer(pointerBlobName);
    if (!pointer) {
      return null;
    }

    return resolveBlobReference({
      reference:
        pointer?.reportBlobName ||
        pointer?.report_blob_name ||
        pointer?.reportPath ||
        pointer?.report_path ||
        null,
      tenantPrefix,
    });
  }

  async #readPointer(pointerBlobName) {
    const content = await this.#readBlobAsString(pointerBlobName);
    if (!content) {
      return null;
    }

    return parseJson(content, pointerBlobName);
  }

  async #readTenantScopedReport(tenantSegment) {
    if (!tenantSegment) {
      return null;
    }

    const tenantPrefix = `${tenantSegment}/`;
    const pointerBlobName = `${tenantPrefix}${this.latestPointerBlobName}`;
    const pointer = await this.#readPointer(pointerBlobName);
    if (!pointer) {
      return null;
    }

    const reportBlobName = resolveBlobReference({
      reference:
        pointer?.reportBlobName ||
        pointer?.report_blob_name ||
        pointer?.reportPath ||
        pointer?.report_path ||
        null,
      tenantPrefix,
    });

    if (!reportBlobName) {
      return null;
    }

    const reportContent = await this.#readBlobAsString(reportBlobName);
    if (!reportContent) {
      return null;
    }

    return {
      report: parseJson(reportContent, reportBlobName),
      metadata: {
        source: "azure_blob",
        container: this.containerClient.containerName,
        pointerBlob: pointerBlobName,
        reportBlob: reportBlobName,
        version: pointer?.version || pointer?.reportVersion || null,
        generatedAt: pointer?.generatedAt || pointer?.generated_at || null,
        tenant: tenantSegment,
      },
    };
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

  async #blobExists(blobName) {
    const blobClient = this.containerClient.getBlobClient(blobName);
    return blobClient.exists();
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
  tenantReportsRoot = process.env.REPORT_STORAGE_ROOT || null,
  latestPointerFileName = process.env.REPORT_STORAGE_LATEST_POINTER || "latest.json",
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

  const resolvedTenantReportsRoot = tenantReportsRoot
    ? path.isAbsolute(tenantReportsRoot)
      ? tenantReportsRoot
      : path.resolve(repoRoot || process.cwd(), tenantReportsRoot)
    : null;

  return new FileReportStorage({
    reportPath: resolvedReportPath,
    tenantReportsRoot: resolvedTenantReportsRoot,
    latestPointerFileName,
  });
}

function buildTenantCandidates(tenantContext = getActiveTenantContext()) {
  const activeTenant = tenantContext || null;
  const candidates = [
    activeTenant?.tenant_slug || null,
    activeTenant?.tenant_id || null,
  ].filter(Boolean);

  return [...new Set(candidates)];
}

function resolveReportReference({ reference, rootPath, tenantRootPath }) {
  if (!reference || typeof reference !== "string") {
    return null;
  }

  const candidate = path.isAbsolute(reference)
    ? path.resolve(reference)
    : path.resolve(rootPath, reference);
  const tenantRelativePath = path.relative(tenantRootPath, candidate);

  if (!tenantRelativePath.startsWith("..") && !path.isAbsolute(tenantRelativePath)) {
    return candidate;
  }

  if (!path.isAbsolute(reference) && !reference.split(/[\\/]+/).includes("..")) {
    const tenantRelativeCandidate = path.resolve(tenantRootPath, reference.replace(/^\.\//, ""));
    const relativePath = path.relative(tenantRootPath, tenantRelativeCandidate);
    if (!relativePath.startsWith("..") && !path.isAbsolute(relativePath)) {
      return tenantRelativeCandidate;
    }
  }

  return null;
}

function resolveBlobReference({ reference, tenantPrefix }) {
  if (!reference || typeof reference !== "string") {
    return null;
  }

  const normalized = reference.replace(/^\.\//, "").replace(/^\/+/, "");
  if (normalized.split("/").includes("..")) {
    return null;
  }

  return normalized.startsWith(tenantPrefix) ? normalized : `${tenantPrefix}${normalized}`;
}
