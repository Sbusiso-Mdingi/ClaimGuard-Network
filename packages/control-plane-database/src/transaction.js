export async function withControlPlaneTransaction(pool, operation) {
  if (!pool || typeof pool.getConnection !== "function") throw new TypeError("A mysql2 pool is required.");
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const result = await operation(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

export function executorOr(defaultExecutor, explicitExecutor) {
  const executor = explicitExecutor || defaultExecutor;
  if (!executor || typeof executor.execute !== "function") {
    throw new TypeError("A mysql2 pool or transaction connection with execute support is required.");
  }
  return executor;
}
