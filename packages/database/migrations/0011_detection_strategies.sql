CREATE TABLE `detection_strategies` (
  `id` int AUTO_INCREMENT NOT NULL,
  `tenant_id` varchar(64) NOT NULL,
  `strategy_type` varchar(64) NOT NULL DEFAULT 'deterministic_rules',
  `is_active` boolean NOT NULL DEFAULT true,
  `active_tenant_id` varchar(64)
    GENERATED ALWAYS AS (
      CASE WHEN `is_active` = 1 THEN `tenant_id` ELSE NULL END
    ) STORED,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL
    DEFAULT CURRENT_TIMESTAMP
    ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `detection_strategies_id`
    PRIMARY KEY (`id`),
  CONSTRAINT `detection_strategies_tenant_id_fk`
    FOREIGN KEY (`tenant_id`)
    REFERENCES `tenants` (`tenant_id`)
    ON DELETE RESTRICT
);

CREATE UNIQUE INDEX `uq_detection_strategies_active_tenant`
  ON `detection_strategies` (`active_tenant_id`);
