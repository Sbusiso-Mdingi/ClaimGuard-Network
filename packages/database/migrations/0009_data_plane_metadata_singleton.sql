ALTER TABLE data_plane_metadata
  ADD CONSTRAINT chk_data_plane_metadata_singleton CHECK (metadata_key = 'primary');
