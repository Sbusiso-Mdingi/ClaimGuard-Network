-- Align trusted runtime authorization with system permissions introduced before
-- the PR 3 permission metadata catalogue. These permissions remain available
-- only through fixed system-role grants; tenants cannot assign or delegate them.

UPDATE permissions
SET category = 'platform',
    tenant_assignable = 0,
    elevated = 0,
    delegable = 0,
    system_only = 1,
    definition_version = GREATEST(definition_version, 2)
WHERE permission_key IN (
  'platform_releases.view',
  'platform_releases.request',
  'platform_releases.approve',
  'platform_administrators.manage'
);

UPDATE permissions
SET category = 'desktop_management',
    tenant_assignable = 0,
    elevated = 0,
    delegable = 0,
    system_only = 1,
    definition_version = GREATEST(definition_version, 2)
WHERE permission_key IN (
  'desktop_devices.manage',
  'desktop_fleet_policy.manage'
);
