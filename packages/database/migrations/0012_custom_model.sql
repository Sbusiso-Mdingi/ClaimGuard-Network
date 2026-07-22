-- Add a column to store the Key Vault secret name for the custom model image (optional)
ALTER TABLE detection_strategies
ADD COLUMN custom_model_image_secret VARCHAR(255) NULL;
