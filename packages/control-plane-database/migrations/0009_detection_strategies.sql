-- Table to configure which detection strategy a tenant is actively using (Deterministic Rules vs ML Endpoint)
CREATE TABLE `detection_strategies` (
  `id` int AUTO_INCREMENT NOT NULL,
  `tenant_id` varchar(128) NOT NULL,
  `strategy_type` varchar(64) NOT NULL DEFAULT 'deterministic_rules',
  `endpoint_url` varchar(512),
  `is_active` boolean NOT NULL DEFAULT true,
  `created_at` timestamp NOT NULL DEFAULT (now()),
  `updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `detection_strategies_id` PRIMARY KEY(`id`),
  CONSTRAINT `detection_strategies_tenant_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`tenant_id`) ON DELETE cascade ON UPDATE cascade
);

-- Ensure only one active strategy per tenant
CREATE UNIQUE INDEX `active_tenant_strategy_idx` ON `detection_strategies` (`tenant_id`, `is_active`);
