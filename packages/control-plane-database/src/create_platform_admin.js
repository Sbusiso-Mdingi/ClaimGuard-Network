import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import mysql from "mysql2/promise";
import { hashPassword, passwordParametersRecord, ARGON2ID_VERSION } from "./password.js";
import { buildControlPlaneConnectionOptions, createControlPlanePool } from "./client.js";
import { createControlPlaneRepositories } from "./repositories.js";
import { createControlPlaneService } from "./control-plane-service.js";

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

  const pool = createControlPlanePool(controlUrl);
  const repositories = createControlPlaneRepositories(pool);
  const service = createControlPlaneService({ pool, repositories });

  try {
    let organisation;
    try {
      organisation = await repositories.organisations.getBySlug(PLATFORM_ORG_SLUG);
    } catch (e) {}

    if (!organisation) {
      const [orgRows] = await pool.execute(
        "SELECT organisation_id FROM organisations WHERE canonical_slug = ?",
        [PLATFORM_ORG_SLUG]
      );
      if (orgRows.length > 0) {
        organisation = { organisationId: orgRows[0].organisation_id };
        console.log(`✅ Platform operations organisation already exists (${organisation.organisationId}) (raw lookup)`);
      } else {
        organisation = await service.createDraftOrganisation({
          displayName: "ClaimGuard Platform Operations",
          canonicalSlug: PLATFORM_ORG_SLUG,
          organisationType: "platform",
          deploymentClass: "production",
        }, { type: "system", id: "admin-provisioner", source: "admin-provisioner" });
        
        await service.transitionOrganisation(organisation.organisationId, "provisioning");
        await service.transitionOrganisation(organisation.organisationId, "ready_for_activation");
        organisation = await service.transitionOrganisation(organisation.organisationId, "active");
        
        console.log(`✅ Created platform operations organisation (${organisation.organisationId})`);
      }
    } else {
      console.log(`✅ Platform operations organisation already exists (${organisation.organisationId})`);
    }

    // 2. Ensure the sysadmin identity exists
    let credential = await repositories.authentication.getInternalCredential({ 
      organisationId: organisation.organisationId, 
      username: ADMIN_USERNAME 
    });

    if (!credential) {
      const rawPassword = crypto.randomBytes(16).toString("base64").replace(/[^a-zA-Z0-9]/g, "").slice(0, 16);
      const passwordHash = await hashPassword(rawPassword);
      
      const user = await repositories.identity.createUser({
        displayName: "System Administrator", 
        canonicalContact: `${ADMIN_USERNAME}@${PLATFORM_ORG_SLUG}.invalid`, 
        status: "active",
      });
      
      const membership = await repositories.identity.createMembership({
        userId: user.userId, 
        organisationId: organisation.organisationId, 
        status: "active", 
        validFrom: new Date(),
      });
      
      await repositories.identity.createCredential({
        userId: user.userId, 
        organisationId: organisation.organisationId, 
        username: ADMIN_USERNAME, 
        status: "active",
        passwordHash, 
        passwordAlgorithm: "argon2id", 
        passwordParameters: passwordParametersRecord(), 
        passwordVersion: ARGON2ID_VERSION,
      });

      await service.assignMembershipRole({
        membershipId: membership.membershipId, 
        roleKey: "platform_administrator",
        actorRoleKeys: ["platform_administrator"],
      }, { type: "system", id: "admin-provisioner", source: "admin-provisioner" });

      console.log(`✅ Created ${ADMIN_USERNAME} account (${user.userId})`);

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
      console.log(`✅ ${ADMIN_USERNAME} account already exists (${credential.userId}). Password unchanged.`);
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
