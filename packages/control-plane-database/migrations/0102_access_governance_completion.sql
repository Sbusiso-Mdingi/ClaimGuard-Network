-- Sequrin PR 3: complete elevated-access governance linkage and intent matching.
-- Additive only. Historical rows are preserved; ambiguous pending/approved rows fail closed.

ALTER TABLE access_elevated_requests
  ADD COLUMN target_version INT UNSIGNED NULL AFTER target_id,
  ADD COLUMN requester_membership_id CHAR(36) NULL AFTER requested_by,
  ADD COLUMN target_membership_id CHAR(36) NULL AFTER target_user_id,
  ADD COLUMN reviewed_by_membership_id CHAR(36) NULL AFTER reviewed_by,
  ADD COLUMN effective_from TIMESTAMP(3) NULL AFTER requested_at,
  ADD COLUMN expires_at TIMESTAMP(3) NULL AFTER effective_from,
  ADD COLUMN idempotency_key VARCHAR(128) NULL AFTER intent_hash,
  ADD COLUMN superseded_by_request_id CHAR(36) NULL AFTER idempotency_key,
  ADD UNIQUE KEY uq_access_elevated_idempotency (organisation_id, idempotency_key),
  ADD INDEX idx_access_elevated_target_current
    (organisation_id, target_type, target_id, decision, target_version),
  ADD INDEX idx_access_elevated_target_membership
    (organisation_id, target_membership_id, decision),
  ADD CONSTRAINT fk_access_elevated_requester_membership
    FOREIGN KEY (requester_membership_id)
    REFERENCES organisation_memberships (membership_id) ON DELETE RESTRICT,
  ADD CONSTRAINT fk_access_elevated_target_membership
    FOREIGN KEY (target_membership_id)
    REFERENCES organisation_memberships (membership_id) ON DELETE RESTRICT,
  ADD CONSTRAINT fk_access_elevated_reviewer_membership
    FOREIGN KEY (reviewed_by_membership_id)
    REFERENCES organisation_memberships (membership_id) ON DELETE RESTRICT,
  ADD CONSTRAINT fk_access_elevated_superseded_by
    FOREIGN KEY (superseded_by_request_id)
    REFERENCES access_elevated_requests (request_id) ON DELETE RESTRICT,
  ADD CONSTRAINT chk_access_elevated_target_version
    CHECK (target_version IS NULL OR target_version > 0),
  ADD CONSTRAINT chk_access_elevated_window
    CHECK (expires_at IS NULL OR effective_from IS NULL OR expires_at > effective_from);

-- Requests created before target-version, membership and bounded-intent linkage
-- cannot be proven to match current authority. Preserve the evidence but make
-- pending or approved ambiguous requests non-authoritative.
UPDATE access_elevated_requests
SET decision = 'stale',
    decided_at = COALESCE(decided_at, CURRENT_TIMESTAMP(3)),
    decision_reason = COALESCE(
      decision_reason,
      'Invalidated by access governance completion because the original target version was not recorded.'
    ),
    version = version + 1
WHERE target_version IS NULL
  AND decision IN ('pending', 'approved');
