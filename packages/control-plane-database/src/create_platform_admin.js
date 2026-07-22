import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import mysql from "mysql2/promise";
import { hashPassword } from "./password.js";

const SECRETS_DIR = "/Users/sbusisomdingi/ClaimGuard-Secrets";
const CREDENTIALS_FILE = path.join(SECRETS_DIR, "admin_credentials.txt");
const PLATFORM_ORG_SLUG = "platform-operations";
const ADMIN_USERNAME = "sysadmin";

async function run() {
  const controlUrl = process.env.CONTROL_PLANE_MYSQL_URL;
  if (!controlUrl) {
    console.error("❌ ERROR: CONTROL_PLANE_MYSQL_URL is required.");
    process.exit(1);
  }

  const pool = mysql.createPool(controlUrl);

  try {
    // 1. Ensure the platform-operations organisation exists
    const [orgRows] = await pool.execute(
      "SELECT organisation_id FROM organisations WHERE canonical_slug = ?",
      [PLATFORM_ORG_SLUG]
    );

    let organisationId = orgRows?.[0]?.organisation_id;
    if (!organisationId) {
      organisationId = crypto.randomUUID();
      await pool.execute(
        `INSERT INTO organisations (organisation_id, display_name, canonical_slug, deployment_class, organisation_type, status)
         VALUES (?, 'ClaimGuard Platform Operations', ?, 'production', 'platform_operations', 'active')`,
        [organisationId, PLATFORM_ORG_SLUG]
      );
      console.log(`✅ Created platform operations organisation (${organisationId})`);
    } else {
      console.log(`✅ Platform operations organisation already exists (${organisationId})`);
    }

    // 2. Ensure the sysadmin identity exists
    const [userRows] = await pool.execute(
      "SELECT identity_id FROM identities WHERE organisation_id = ? AND username = ?",
      [organisationId, ADMIN_USERNAME]
    );

    let identityId = userRows?.[0]?.identity_id;

    if (!identityId) {
      identityId = crypto.randomUUID();
      const rawPassword = crypto.randomBytes(16).toString("base64").replace(/[^a-zA-Z0-9]/g, "").slice(0, 16);
      const hashedPassword = await hashPassword(rawPassword);

      await pool.execute(
        `INSERT INTO identities (identity_id, organisation_id, username, display_name, role_labels, credential_hash)
         VALUES (?, ?, ?, 'System Administrator', 'platform_administrator', ?)`,
        [identityId, organisationId, ADMIN_USERNAME, hashedPassword]
      );
      console.log(`✅ Created ${ADMIN_USERNAME} account (${identityId})`);

      // 3. Save the credentials securely to the secrets directory
      await fs.mkdir(SECRETS_DIR, { recursive: true });
      
      const credentialText = `CLAIM GUARD PLATFORM ADMINISTRATOR
==================================
Generated: ${new Date().toISOString()}

Organisation Slug: ${PLATFORM_ORG_SLUG}
Username:          ${ADMIN_USERNAME}
Password:          ${rawPassword}

Keep this file safe and never commit it to source control.
`;

      await fs.writeFile(CREDENTIALS_FILE, credentialText, { mode: 0o600 });
      console.log(`\n🔐 Credentials securely saved to:\n   ${CREDENTIALS_FILE}`);
      console.log(`\nYou can now log in to the ClaimGuard web app using:\nOrg: ${PLATFORM_ORG_SLUG}\nUser: ${ADMIN_USERNAME}`);
    } else {
      console.log(`✅ ${ADMIN_USERNAME} account already exists (${identityId}). Password unchanged.`);
      console.log(`\nYou can log in to the ClaimGuard web app using:\nOrg: ${PLATFORM_ORG_SLUG}\nUser: ${ADMIN_USERNAME}`);
    }

  } catch (err) {
    console.error("❌ ERROR: Failed to provision platform admin", err);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

run();
