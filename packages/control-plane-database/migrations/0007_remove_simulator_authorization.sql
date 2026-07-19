DELETE FROM role_permissions
WHERE permission_id IN ('simulator.status', 'simulator.control_own', 'simulator.control_platform');

DELETE FROM permissions
WHERE permission_id IN ('simulator.status', 'simulator.control_own', 'simulator.control_platform');

DELETE FROM worker_routing_status
WHERE worker_type = 'simulator-worker';
