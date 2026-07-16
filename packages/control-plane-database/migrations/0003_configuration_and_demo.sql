CREATE TABLE IF NOT EXISTS demo_account_catalogue (
  catalogue_entry_id CHAR(36) PRIMARY KEY,
  organisation_id CHAR(36) NOT NULL,
  membership_id CHAR(36) NOT NULL,
  display_label VARCHAR(255) NOT NULL,
  role_label VARCHAR(128) NOT NULL,
  username_display_value VARCHAR(255) NOT NULL,
  secret_reference VARCHAR(1024) NOT NULL,
  enabled TINYINT(1) NOT NULL DEFAULT 0,
  display_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_demo_catalogue_membership (membership_id),
  INDEX idx_demo_catalogue_org_display (organisation_id, enabled, display_order),
  CONSTRAINT fk_demo_catalogue_organisation FOREIGN KEY (organisation_id) REFERENCES organisations (organisation_id) ON DELETE RESTRICT,
  CONSTRAINT fk_demo_catalogue_membership FOREIGN KEY (membership_id) REFERENCES organisation_memberships (membership_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS organisation_feature_flags (
  scope_key VARCHAR(64) NOT NULL,
  organisation_id CHAR(36) NULL,
  flag_key VARCHAR(128) NOT NULL,
  value_type VARCHAR(32) NOT NULL,
  typed_value JSON NOT NULL,
  enabled TINYINT(1) NOT NULL DEFAULT 0,
  version INT UNSIGNED NOT NULL DEFAULT 1,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (scope_key, flag_key),
  INDEX idx_feature_flags_organisation (organisation_id, enabled),
  CONSTRAINT fk_feature_flag_organisation FOREIGN KEY (organisation_id) REFERENCES organisations (organisation_id) ON DELETE RESTRICT,
  CONSTRAINT chk_feature_flag_type CHECK (value_type IN ('boolean', 'string', 'number', 'json'))
);

CREATE TABLE IF NOT EXISTS organisation_branding (
  organisation_id CHAR(36) PRIMARY KEY,
  display_name VARCHAR(255) NOT NULL,
  logo_reference VARCHAR(1024) NULL,
  theme_metadata JSON NULL,
  login_subtitle VARCHAR(512) NULL,
  version INT UNSIGNED NOT NULL DEFAULT 1,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_branding_organisation FOREIGN KEY (organisation_id) REFERENCES organisations (organisation_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS deployment_configuration (
  config_key VARCHAR(128) PRIMARY KEY,
  value_type VARCHAR(32) NOT NULL,
  typed_value JSON NOT NULL,
  enabled TINYINT(1) NOT NULL DEFAULT 0,
  version INT UNSIGNED NOT NULL DEFAULT 1,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT chk_deployment_config_type CHECK (value_type IN ('boolean', 'string', 'number', 'json'))
);
