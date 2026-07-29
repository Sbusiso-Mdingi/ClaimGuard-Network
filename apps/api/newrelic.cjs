'use strict';

module.exports = {
  config: {
    app_name: [process.env.NEW_RELIC_APP_NAME || 'ClaimGuard API'],
    license_key: process.env.NEW_RELIC_LICENSE_KEY,
    distributed_tracing: {
      enabled: true
    },
    transaction_tracer: {
      record_sql: 'obfuscated'
    },
    slow_sql: {
      enabled: true
    },
    application_logging: {
      forwarding: {
        // Azure Log Analytics owns structured application logs. Do not duplicate
        // potentially sensitive claim context into New Relic log forwarding.
        enabled: false
      }
    },
    logging: {
      level: process.env.NEW_RELIC_LOG_LEVEL || 'info',
      filepath: process.env.NEW_RELIC_LOG || 'stdout'
    },
    allow_all_headers: true,
    attributes: {
      exclude: [
        'request.parameters.*',
        'request.headers.*',
        'request.headers.cookie',
        'request.headers.authorization',
        'request.headers.proxyAuthorization',
        'request.headers.setCookie*',
        'request.headers.x*',
        'response.headers.cookie',
        'response.headers.authorization',
        'response.headers.proxyAuthorization',
        'response.headers.setCookie*',
        'response.headers.x*'
      ]
    },
    labels: {
      environment: process.env.CLAIMGUARD_ENVIRONMENT || process.env.NODE_ENV || 'development',
      service: 'api'
    }
  }
};
