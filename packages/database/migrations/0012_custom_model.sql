-- Store only the infrastructure-approved deployment identifier. Model image
-- locations, service origins, and credentials are never tenant configuration.
ALTER TABLE detection_strategies
ADD COLUMN model_deployment_id VARCHAR(128) NULL;
