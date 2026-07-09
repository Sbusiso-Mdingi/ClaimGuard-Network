process.env.NEW_RELIC_NO_CONFIG_FILE = 'true'

const newrelic = require('newrelic')
const http = require('node:http')

const port = Number(process.env.PORT || 3003)

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ status: 'ok', service: 'api-newrelic-smoke' }))
    return
  }

  if (req.url === '/newrelic-test') {
    newrelic.recordCustomEvent('ClaimGuardSmoke', {
      source: 'api',
      kind: 'newrelic-test',
      appName: process.env.NEW_RELIC_APP_NAME || 'ClaimGuard API',
    })

    newrelic.noticeError(new Error('ClaimGuard New Relic smoke test error'))
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, message: 'newrelic_smoke_test_recorded' }))
    return
  }

  res.writeHead(404, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ error: 'not_found' }))
})

server.listen(port, () => {
  console.log(`New Relic smoke server listening on :${port}`)
})