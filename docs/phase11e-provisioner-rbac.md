# Phase 11E provisioner RBAC

The provisioning worker runs under the user-assigned identity
`claimguard-provisioner-identity`. The API and web application must not receive
these permissions.

## Runtime permissions

The worker performs MySQL database and principal provisioning through the
`MYSQL_SERVER_ADMIN_URL` SQL data-plane credential supplied to its Container
Apps Job from Key Vault. It does not call Azure Resource Manager for MySQL.
Consequently, Azure `Contributor` on the MySQL Flexible Server is not required
by the current worker implementation and should have no replacement role.

The worker currently requires:

- `AcrPull` on `claimguardacr11e` to pull its immutable image.
- Key Vault secret `get`, metadata read, and `set` data actions on
  `claimguard-kv-ufs`. Delete, purge, recover, backup, restore, key, certificate,
  role-assignment, and vault-management actions are not required.

The current implementation records the approved report container resource ID
and tenant prefix in the control plane. It does not call Blob Storage, so
`Storage Blob Data Contributor` is not required. It also does not enumerate
the resource group, so resource-group `Reader` is not required at runtime.

## Controlled replacement and rollback

Replace `Key Vault Secrets Officer` with the custom
`ClaimGuard Provisioner Secret Writer` role, assigned only at the existing vault.
Keep the old role until a Container Apps Job execution has successfully read its
two bootstrap references and written/re-read tenant runtime secrets. Then remove
the old assignment.

After a successful job execution, remove the unused MySQL `Contributor`, storage
data contributor, and resource-group reader assignments. Rollback consists of
reassigning the previous built-in role at its previous resource scope; no
subscription-wide assignment is required.

Private routes remain inactive throughout Phase 11E. Role changes do not
authorize the API or browser to invoke Azure Resource Manager.
