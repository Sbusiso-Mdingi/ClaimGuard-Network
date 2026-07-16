import { requireOperationalDataPlaneContext } from "./data-plane-context.js";

export function createScopedReadRepositories(dataPlaneContext, pool) {
  const context = requireOperationalDataPlaneContext(dataPlaneContext);
  const tenantId = context.operationalTenantId;
  return Object.freeze({
    members: Object.freeze({
      async getById(memberId) {
        const [rows] = await pool.execute("SELECT * FROM members WHERE member_id = ? AND tenant_id = ? LIMIT 1", [memberId, tenantId]);
        return rows?.[0] || null;
      },
    }),
    providers: Object.freeze({
      async getById(providerId) {
        const [rows] = await pool.execute("SELECT * FROM providers WHERE provider_id = ? AND tenant_id = ? LIMIT 1", [providerId, tenantId]);
        return rows?.[0] || null;
      },
    }),
    reportSnapshots: Object.freeze({
      async loadCounts() {
        const [rows] = await pool.execute(
          `SELECT
             (SELECT COUNT(*) FROM claims WHERE tenant_id = ?) AS claims,
             (SELECT COUNT(*) FROM members WHERE tenant_id = ?) AS members,
             (SELECT COUNT(*) FROM providers WHERE tenant_id = ?) AS providers`,
          [tenantId, tenantId, tenantId],
        );
        return rows?.[0] || { claims: 0, members: 0, providers: 0 };
      },
    }),
  });
}
