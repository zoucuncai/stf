var r = require('rethinkdb')
var uuid = require('uuid')
var Promise = require('bluebird')

var db = require('../../../db')
var wire = require('../../../wire')
var wireutil = require('../../../wire/util')
var apiutil = require('../../../util/apiutil')
var logger = require('../../../util/logger')
var replayExecutor = require('../../../util/automation-replay-executor')
var explorerExecutor = require('../../../util/automation-explorer-executor')
var reportHtmlUtil = require('../../../util/automation-report-html')
var baselineHydrate = require('../../../util/automation-baseline-hydrate')
var recordingPyBundle = require('../../../util/automation-recording-py-bundle')

var log = logger.createLogger('api:controllers:automation')

function isoNow() {
  return new Date().toISOString()
}

function applyDateFilter(query, startDate, endDate, fieldName) {
  fieldName = fieldName || 'createdAt'
  // createdAt 存的是 ISO 字符串，ISO 8601 字符串按字典序即时间序，直接字符串比较即可
  if (startDate && endDate) {
    return query.filter(function(row) {
      return row(fieldName).ge(startDate).and(row(fieldName).le(endDate))
    })
  }
  if (startDate) {
    return query.filter(function(row) {
      return row(fieldName).ge(startDate)
    })
  }
  if (endDate) {
    return query.filter(function(row) {
      return row(fieldName).le(endDate)
    })
  }
  return query
}

function getBody(req, key, fallback) {
  if (!req || !req.body || typeof req.body[key] === 'undefined') {
    return fallback
  }
  return req.body[key]
}

function parseJsonSafe(value, fallback) {
  if (!value) {
    return fallback
  }
  try {
    return JSON.parse(value)
  }
  catch (e) {
    return fallback
  }
}

function dateToIso(value) {
  if (!value) {
    return ''
  }
  if (typeof value === 'string') {
    return value
  }
  return new Date(value).toISOString()
}

function finalizeMonkeyRunByRows(run, rows, endedAt) {
  endedAt = endedAt || isoNow()
  var normalized = (rows || []).map(function(item) {
    var row = {}
    var k
    for (k in item) {
      if (Object.prototype.hasOwnProperty.call(item, k)) {
        row[k] = item[k]
      }
    }
    if (row.status === 'running') {
      row.status = 'failed'
      row.error = row.error || 'CLIENT_RESULT_NOT_REPORTED'
      row.endedAt = row.endedAt || endedAt
      row.updatedAt = endedAt
    }
    return row
  })
  var failed = normalized.filter(function(d) {
    return d.status === 'failed' || (d.error != null && String(d.error).trim() !== '')
  }).length
  var newStatus = failed ? 'failed' : 'finished'
  // run.endedAt is not persisted until the update below — pass endedAt into the snapshot used for HTML.
  var runForReport = Object.assign({}, run, {endedAt: endedAt, status: newStatus})
  var htmlReport = reportHtmlUtil.buildMonkeyTestReportHtml(runForReport, normalized)
  return Promise.map(normalized, function(d) {
    if (!d.id) {
      return null
    }
    var patch = {
      status: d.status
    , error: d.error != null ? d.error : null
    , output: d.output != null ? d.output : null
    , endedAt: d.endedAt || endedAt
    , updatedAt: d.updatedAt || endedAt
    }
    if (d.startedAt) {
      patch.startedAt = d.startedAt
    }
    if (d.deviceName) {
      patch.deviceName = d.deviceName
    }
    if (d.deviceModel) {
      patch.deviceModel = d.deviceModel
    }
    return db.run(r.table('automationMonkeyRunDevices').get(d.id).update(patch))
  })
    .then(function() {
      return db.run(r.table('automationMonkeyRuns').get(run.id).update({
        status: newStatus
      , reportAvailable: true
      , reportHtml: htmlReport
      , endedAt: endedAt
      , updatedAt: endedAt
      }))
    })
}

function scheduleMonkeyRunWatchdog(run) {
  var expectedMs = Math.max(15000, (Number(run.eventCount || 0) * Number(run.throttleMs || 0)) + 30000)
  return Promise.delay(expectedMs)
    .then(function() {
      return db.run(r.table('automationMonkeyRuns').get(run.id))
    })
    .then(function(latestRun) {
      if (!latestRun || latestRun.status !== 'running') {
        return null
      }
      return db.run(r.table('automationMonkeyRunDevices').getAll(run.id, {index: 'runId'}))
        .then(function(cursor) { return cursor.toArray() })
        .then(function(rows) {
          return finalizeMonkeyRunByRows(latestRun, rows, isoNow())
        })
    })
    .catch(function() {})
}

function createRecording(req, res) {
  var now = isoNow()
  var name = getBody(req, 'name', '').trim()
  if (!name) {
    return apiutil.respond(res, 400, 'Bad Request (recording name required)')
  }
  return db.run(r.table('automationRecordings').filter({name: name}).count())
    .then(function(count) {
      if (count > 0) {
        apiutil.respond(res, 409, '录制名称已存在，请更换名称')
        return null
      }
      var row = {
        id: uuid.v4()
      , name: name
      , description: getBody(req, 'description', '')
      , createdByEmail: req.user.email
      , createdByName: req.user.name
      , stepsJson: getBody(req, 'stepsJson', [])
      , baselinesMeta: getBody(req, 'baselinesMeta', [])
      , pythonCode: getBody(req, 'pythonCode', '# generated later\n')
      , createdAt: now
      , updatedAt: now
      }

      return baselineHydrate.hydrateBaselinesMeta(row.baselinesMeta)
        .then(function(hydrated) {
          row.baselinesMeta = hydrated
          return db.run(r.table('automationRecordings').insert(row))
        })
        .then(function() {
          apiutil.respond(res, 201, 'Created (recording)', {recording: row})
        })
        .catch(function(err) {
          apiutil.internalError(res, 'Failed to create recording: ', err.stack)
        })
    })
}

/**
 * Import a recording from JSON (e.g. exported GET /recordings/:id).
 * id = zdy + random digits; name = creator + random digits; owner = current user; time = now.
 */
function importRecording(req, res) {
  var now = isoNow()
  var email = req.user && req.user.email ? String(req.user.email) : ''
  var creatorName = (req.user && req.user.name && String(req.user.name).trim()) ||
    (email.indexOf('@') !== -1 ? email.split('@')[0] : 'user')

  var raw = req.body || {}
  var inner = raw.recording && typeof raw.recording === 'object' ? raw.recording : null
  var stepsJson = raw.stepsJson != null ? raw.stepsJson : (inner && inner.stepsJson)
  var baselinesMeta = raw.baselinesMeta != null ? raw.baselinesMeta : (inner && inner.baselinesMeta)
  var pythonCode = raw.pythonCode != null ? raw.pythonCode : (inner && inner.pythonCode)
  var description = raw.description != null ? String(raw.description) : (inner && inner.description != null
    ? String(inner.description) : '')

  if (!Array.isArray(stepsJson)) {
    stepsJson = []
  }
  if (!Array.isArray(baselinesMeta)) {
    baselinesMeta = []
  }
  if (pythonCode == null || String(pythonCode).trim() === '') {
    pythonCode = '# imported\n'
  }

  if (typeof pythonCode === 'string' && pythonCode.indexOf('# ---STF_RECORDING_BUNDLE_V1---') !== -1) {
    var parsed = recordingPyBundle.parsePyBundle(pythonCode)
    if (parsed.bundle) {
      stepsJson = parsed.bundle.stepsJson || []
      baselinesMeta = parsed.bundle.baselinesMeta || []
      if (parsed.bundle.description != null && String(parsed.bundle.description).trim() !== '') {
        description = String(parsed.bundle.description)
      }
      pythonCode = parsed.pythonCodeStripped && String(parsed.pythonCodeStripped).trim() !== ''
        ? parsed.pythonCodeStripped
        : '# imported\n'
    }
  }

  function attemptInsert(tryNum) {
    if (tryNum > 24) {
      apiutil.respond(res, 500, '无法生成唯一录制 ID 或名称')
      return Promise.resolve()
    }
    var id = 'zdy' + String(Math.floor(Math.random() * 900000000) + 100000000)
    var name = creatorName + String(Math.floor(Math.random() * 900000) + 100000)

    return db.run(r.table('automationRecordings').get(id))
      .then(function(existing) {
        if (existing) {
          return attemptInsert(tryNum + 1)
        }
        return db.run(r.table('automationRecordings').filter({name: name}).count())
          .then(function(count) {
            if (count > 0) {
              return attemptInsert(tryNum + 1)
            }
            var row = {
              id: id
            , name: name
            , description: description
            , createdByEmail: email
            , createdByName: req.user.name || ''
            , stepsJson: stepsJson
            , baselinesMeta: baselinesMeta
            , pythonCode: pythonCode
            , createdAt: now
            , updatedAt: now
            }
            return baselineHydrate.hydrateBaselinesMeta(row.baselinesMeta)
              .then(function(hydrated) {
                row.baselinesMeta = hydrated
                return db.run(r.table('automationRecordings').insert(row))
              })
              .then(function() {
                apiutil.respond(res, 201, 'Imported (recording)', {recording: row})
              })
          })
      })
  }

  return attemptInsert(0)
    .catch(function(err) {
      apiutil.internalError(res, 'Failed to import recording: ', err.stack)
    })
}

function listRecordings(req, res) {
  return db.run(r.table('automationRecordings').orderBy(r.desc('createdAt')))
    .then(function(cursor) {
      return cursor.toArray()
    })
    .then(function(rows) {
      apiutil.respond(res, 200, 'Recordings', {recordings: rows})
    })
    .catch(function(err) {
      apiutil.internalError(res, 'Failed to list recordings: ', err.stack)
    })
}

function getRecording(req, res) {
  var id = req.swagger.params.id.value
  return db.run(r.table('automationRecordings').get(id))
    .then(function(recording) {
      if (!recording) {
        return apiutil.respond(res, 404, 'Not Found (recording)')
      }
      return apiutil.respond(res, 200, 'Recording', {recording: recording})
    })
    .catch(function(err) {
      apiutil.internalError(res, 'Failed to get recording: ', err.stack)
    })
}

function updateRecording(req, res) {
  var id = req.swagger.params.id.value
  var body = req.body || {}
  var now = isoNow()

  return db.run(r.table('automationRecordings').get(id))
    .then(function(rec) {
      if (!rec) {
        return apiutil.respond(res, 404, 'Not Found (recording)')
      }
      if (rec.createdByEmail !== req.user.email && req.user.privilege !== 'admin') {
        return apiutil.respond(res, 403, 'Forbidden (recording)')
      }

      var patch = {updatedAt: now}

      function applyMetaAndWrite() {
        if (body.description != null) {
          patch.description = String(body.description)
        }
        if (body.stepsJson != null) {
          if (!Array.isArray(body.stepsJson)) {
            return apiutil.respond(res, 400, 'Bad Request (stepsJson must be array)')
          }
          patch.stepsJson = body.stepsJson
        }
        if (body.pythonCode != null) {
          patch.pythonCode = String(body.pythonCode)
        }
        var metaPromise = Promise.resolve()
        if (body.baselinesMeta != null) {
          if (!Array.isArray(body.baselinesMeta)) {
            return apiutil.respond(res, 400, 'Bad Request (baselinesMeta must be array)')
          }
          metaPromise = baselineHydrate.hydrateBaselinesMeta(body.baselinesMeta)
            .then(function(hydrated) {
              patch.baselinesMeta = hydrated
            })
        }
        return metaPromise
          .then(function() {
            return db.run(r.table('automationRecordings').get(id).update(patch))
          })
          .then(function() {
            return db.run(r.table('automationRecordings').get(id))
          })
          .then(function(updated) {
            return apiutil.respond(res, 200, 'Updated (recording)', {recording: updated})
          })
      }

      if (body.name != null) {
        var name = String(body.name).trim()
        if (!name) {
          return apiutil.respond(res, 400, 'Bad Request (name required)')
        }
        return db.run(
          r.table('automationRecordings')
            .filter(r.row('name').eq(name))
            .filter(r.row('id').ne(id))
            .count()
        )
          .then(function(cnt) {
            if (cnt > 0) {
              return apiutil.respond(res, 409, '录制名称已存在，请更换名称')
            }
            patch.name = name
            return applyMetaAndWrite()
          })
      }

      return applyMetaAndWrite()
    })
    .catch(function(err) {
      apiutil.internalError(res, 'Failed to update recording: ', err.stack)
    })
}

function deleteRecording(req, res) {
  var id = req.swagger.params.id.value
  return db.run(r.table('automationRecordings').get(id))
    .then(function(recording) {
      if (!recording) {
        return apiutil.respond(res, 404, 'Not Found (recording)')
      }
      return db.run(r.table('automationRecordings').get(id).delete())
        .then(function() {
          apiutil.respond(res, 200, 'Deleted (recording)', {id: id})
        })
    })
    .catch(function(err) {
      apiutil.internalError(res, 'Failed to delete recording: ', err.stack)
    })
}

function downloadRecording(req, res) {
  var id = req.swagger.params.id.value
  return db.run(r.table('automationRecordings').get(id))
    .then(function(recording) {
      if (!recording) {
        return apiutil.respond(res, 404, 'Not Found (recording)')
      }
      var content = recordingPyBundle.buildPyDownloadContent(recording)
      res.setHeader('Content-Type', 'text/x-python; charset=utf-8')
      res.setHeader('Content-Disposition', 'attachment; filename="' + (recording.name || id) + '.py"')
      res.status(200).send(content)
    })
    .catch(function(err) {
      apiutil.internalError(res, 'Failed to download recording: ', err.stack)
    })
}

function createReplayRun(req, res) {
  var now = isoNow()
  var recordingId = getBody(req, 'recordingId', '')
  var targets = getBody(req, 'targets', [])
  var clientDriven = !!getBody(req, 'clientDriven', false)
  if (!recordingId || !targets.length) {
    return apiutil.respond(res, 400, 'Bad Request (recordingId/targets required)')
  }

  return db.run(r.table('automationRecordings').get(recordingId))
    .then(function(recording) {
      if (!recording) {
        return apiutil.respond(res, 404, 'Not Found (recording)')
      }
      var run = {
        id: uuid.v4()
      , recordingId: recordingId
      , recordingName: recording.name
      , clientDriven: clientDriven
      , createdByEmail: req.user.email
      , createdByName: req.user.name
      , targets: targets
      , status: 'running'
      , reportAvailable: false
      , reportHtml: null
      , createdAt: now
      , startedAt: now
      , endedAt: null
      , updatedAt: now
      }
      return db.run(r.table('automationReplayRuns').insert(run))
        .then(function() {
          replayExecutor.runReplay(run, targets)
          apiutil.respond(res, 201, 'Created (replay run)', {run: run})
        })
    })
    .catch(function(err) {
      apiutil.internalError(res, 'Failed to create replay run: ', err.stack)
    })
}

function listReplayRuns(req, res) {
  var page = Number(req.swagger.params.page && req.swagger.params.page.value || 1)
  var pageSize = Number(req.swagger.params.pageSize && req.swagger.params.pageSize.value || 20)
  var createdBy = req.swagger.params.createdBy && req.swagger.params.createdBy.value
  var startDate = req.swagger.params.startDate && req.swagger.params.startDate.value
  var endDate = req.swagger.params.endDate && req.swagger.params.endDate.value
  var start = (page - 1) * pageSize

  // 优先使用 createdByEmail 索引，避免全表扫描
  var dataQuery = createdBy ?
    r.table('automationReplayRuns').getAll(createdBy, {index: 'createdByEmail'}).orderBy(r.desc('createdAt')).without(['reportHtml']) :
    r.table('automationReplayRuns').orderBy({index: r.desc('createdAt')}).without(['reportHtml'])

  var filteredQuery = applyDateFilter(dataQuery, startDate, endDate)

  // count 单独走索引，不跟随 orderBy
  var countQuery = createdBy ?
    r.table('automationReplayRuns').getAll(createdBy, {index: 'createdByEmail'}) :
    r.table('automationReplayRuns')
  countQuery = applyDateFilter(countQuery, startDate, endDate).count()

  return Promise.all([
    db.run(countQuery)
  , db.run(filteredQuery.skip(start).limit(pageSize))
      .then(function(cursor) { return cursor.toArray() })
  ])
    .then(function(results) {
      var total = results[0]
      var rows  = results[1]
      if (!total || !rows.length) {
        return apiutil.respond(res, 200, 'Replay runs', {total: total, page: page, pageSize: pageSize, runs: []})
      }
      var runIds = rows.map(function(r) { return r.id })
      return db.run(
        r.table('automationReplayRunDevices').getAll(r.args(runIds), {index: 'runId'})
      )
        .then(function(devCursor) { return devCursor.toArray() })
        .then(function(allDevices) {
          var devicesByRun = {}
          allDevices.forEach(function(d) {
            if (!devicesByRun[d.runId]) devicesByRun[d.runId] = []
            devicesByRun[d.runId].push(d)
          })
          var runs = rows.map(function(run) {
            var devices = devicesByRun[run.id] || []
            var total = devices.length
            var done = devices.filter(function(d) { return d.status === 'finished' || d.status === 'done' }).length
            var failed = devices.filter(function(d) { return d.status === 'failed' || d.result === '失败' || d.ok === false }).length
            var success = total - failed
            var totalCases = devices.reduce(function(sum, d) { return sum + (Number(d.totalCases) || 0) }, 0)
            var successCases = devices.reduce(function(sum, d) { return sum + (Number(d.successCases) || 0) }, 0)
            var caseSuccessRate = totalCases > 0 ? (successCases / totalCases) * 100 : 0
            run.totalDevices = total
            run.progressDone = done
            run.successDevices = successCases
            run.failDevices = (totalCases - successCases)
            run.passRate = caseSuccessRate
            run.caseSuccessRate = caseSuccessRate
            return run
          })
          apiutil.respond(res, 200, 'Replay runs', {total: total, page: page, pageSize: pageSize, runs: runs})
        })
    })
    .catch(function(err) {
      apiutil.internalError(res, 'Failed to list replay runs: ', err.stack)
    })
}

function getReplayRunReport(req, res) {
  var runId = req.swagger.params.runId.value
  return db.run(r.table('automationReplayRuns').get(runId))
    .then(function(run) {
      if (!run) {
        return apiutil.respond(res, 404, 'Not Found (run)')
      }
      return db.run(r.table('automationReplayRunDevices').getAll(runId, {index: 'runId'}))
        .then(function(cursor) {
          return cursor.toArray()
        })
        .then(function(rows) {
          apiutil.respond(res, 200, 'Replay report', {
            run: run
          , devices: rows
          })
        })
    })
    .catch(function(err) {
      apiutil.internalError(res, 'Failed to get replay report: ', err.stack)
    })
}

function downloadReplayTestReport(req, res) {
  var runId = req.swagger.params.runId.value
  return db.run(r.table('automationReplayRuns').get(runId))
    .then(function(run) {
      if (!run) {
        return apiutil.respond(res, 404, 'Not Found (run)')
      }
      function sendHtml(html) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8')
        res.setHeader('Content-Disposition', 'attachment; filename="replay-report-' + runId + '.html"')
        res.status(200).send(html)
      }
      return db.run(r.table('automationReplayRunDevices').getAll(runId, {index: 'runId'}))
        .then(function(cursor) {
          return cursor.toArray()
        })
        .then(function(rows) {
          return db.run(r.table('automationRecordings').get(run.recordingId))
            .then(function(recording) {
              var rec = recording || {}
              return reportHtmlUtil.enrichReplayDevicesWithBaselineImages(rows, rec)
                .then(function() {
                  sendHtml(reportHtmlUtil.buildReplayTestReportHtml(run, rows, rec))
                })
            })
        })
    })
    .catch(function(err) {
      apiutil.internalError(res, 'Failed to download replay report: ', err.stack)
    })
}

function completeReplayRun(req, res) {
  var runId = req.swagger.params.runId.value
  var devices = getBody(req, 'devices', [])

  if (!runId) {
    return apiutil.respond(res, 400, 'Bad Request (runId required)')
  }
  if (!Array.isArray(devices) || !devices.length) {
    return apiutil.respond(res, 400, 'Bad Request (devices required)')
  }

  return db.run(r.table('automationReplayRuns').get(runId))
    .then(function(run) {
      if (!run) {
        return apiutil.respond(res, 404, 'Not Found (run)')
      }
      return db.run(r.table('automationReplayRunDevices').getAll(runId, {index: 'runId'}))
        .then(function(cursor) { return cursor.toArray() })
        .then(function(dbRows) {
          var dbBySerial = {}
          dbRows.forEach(function(row) {
            if (row && row.serial) {
              dbBySerial[String(row.serial).trim()] = row
            }
          })

          var nowIso = isoNow()
          return Promise.map(devices, function(d) {
            var serial = d && d.serial ? String(d.serial).trim() : ''
            if (!serial || !dbBySerial[serial]) {
              return null
            }
            var totalCases = Number(d.totalCases || 0)
            var successCases = Number(d.successCases || 0)
            var result = d.result || (successCases > 0 || totalCases === 0 ? '成功' : '失败')
            var patch = {
              status: 'finished'
            , result: result
            , totalCases: totalCases
            , successCases: successCases
            , error: d.error != null ? d.error : null
            , endedAt: d.endedAt || nowIso
            , updatedAt: nowIso
            }
            if (Array.isArray(d.reportArtifacts)) {
              patch.reportArtifacts = d.reportArtifacts
            }
            if (d.executionLog != null && d.executionLog !== '') {
              patch.executionLog = String(d.executionLog)
            }
            return db.run(r.table('automationReplayRunDevices').get(dbBySerial[serial].id).update(patch))
          }).then(function() {
            return db.run(r.table('automationReplayRunDevices').getAll(runId, {index: 'runId'}))
              .then(function(cursor) { return cursor.toArray() })
              .then(function(updatedDeviceRows) {
                var totalDevices = updatedDeviceRows.length
                var failedDevices = updatedDeviceRows.filter(function(d) {
                  return d.result === '失败' || d.status === 'failed' || d.ok === false
                }).length
                var successDevices = totalDevices - failedDevices

                var totalCases = updatedDeviceRows.reduce(function(sum, d) { return sum + (Number(d.totalCases) || 0) }, 0)
                var successCases = updatedDeviceRows.reduce(function(sum, d) { return sum + (Number(d.successCases) || 0) }, 0)
                var caseSuccessRate = totalCases > 0 ? (successCases / totalCases) * 100 : 0

                var status = failedDevices > 0 ? 'failed' : 'finished'
                var endedAt = nowIso

                return db.run(r.table('automationRecordings').get(run.recordingId))
                  .then(function(recording) {
                    var runForReport = Object.assign({}, run, {
                      status: status
                    , endedAt: endedAt
                    , caseSuccessRate: caseSuccessRate
                    })
                    var rec = recording || {}
                    return reportHtmlUtil.enrichReplayDevicesWithBaselineImages(updatedDeviceRows, rec)
                      .then(function() {
                        var html = reportHtmlUtil.buildReplayTestReportHtml(
                          runForReport
                        , updatedDeviceRows
                        , rec
                        )
                        return db.run(r.table('automationReplayRuns').get(run.id).update({
                          status: status
                        , reportAvailable: true
                        , reportHtml: html
                        , caseSuccessRate: caseSuccessRate
                        , endedAt: endedAt
                        , updatedAt: nowIso
                        }))
                      })
                  })
                  .then(function() {
                    apiutil.respond(res, 200, 'Replay run completed', {runId: run.id})
                  })
              })
          })
        })
    })
    .catch(function(err) {
      apiutil.internalError(res, 'Failed to complete replay run: ', err.stack)
    })
}

function createMonkeyRun(req, res) {
  var now = isoNow()
  var pkg = getBody(req, 'packageName', '')
  var targets = getBody(req, 'targets', [])
  var eventCount = Number(getBody(req, 'eventCount', 1000))
  var throttleMs = Number(getBody(req, 'throttleMs', 200))
  var seed = getBody(req, 'seed', '')
  if (!pkg || !targets.length) {
    return apiutil.respond(res, 400, 'Bad Request (packageName/targets required)')
  }

  var run = {
    id: uuid.v4()
  , packageName: pkg
  , createdByEmail: req.user.email
  , createdByName: req.user.name
  , targets: targets
  , eventCount: eventCount
  , throttleMs: throttleMs
  , seed: seed
  , argsText: ['-p ' + pkg, '--throttle ' + throttleMs, seed ? ('-s ' + seed) : '', '-v ' + eventCount].filter(Boolean).join(' ')
  , status: 'running'
  , reportAvailable: false
  , reportHtml: null
  , createdAt: now
  , startedAt: now
  , endedAt: null
  , updatedAt: now
  }

  var runDeviceRows = targets.map(function(serial) {
    return {
      id: uuid.v4()
    , runId: run.id
    , serial: serial
    , status: 'running'
    , error: null
    , startedAt: now
    , endedAt: null
    , createdAt: now
    , updatedAt: now
    }
  })

  return db.run(r.table('automationMonkeyRuns').insert(run))
    .then(function() {
      return db.run(r.table('automationMonkeyRunDevices').insert(runDeviceRows))
    })
    .then(function() {
      apiutil.respond(res, 201, 'Created (monkey run)', {run: run})
      scheduleMonkeyRunWatchdog(run)
    })
    .catch(function(err) {
      apiutil.internalError(res, 'Failed to create monkey run: ', err.stack)
    })
}

function mergeMonkeyDeviceRowsFromClient(dbRows, clientUpdates, endedAt) {
  endedAt = endedAt || isoNow()
  var bySerial = {}
  for (var i = 0; i < clientUpdates.length; i++) {
    var u = clientUpdates[i]
    var s = u && u.serial ? String(u.serial).trim() : ''
    if (s) {
      bySerial[s] = u
    }
  }
  return dbRows.map(function(row) {
    var serial = String(row.serial || '').trim()
    var cu = bySerial[serial]
    var next = {}
    var k
    for (k in row) {
      if (Object.prototype.hasOwnProperty.call(row, k)) {
        next[k] = row[k]
      }
    }
    if (cu) {
      next.status = cu.status || 'finished'
      next.error = cu.error != null && cu.error !== '' ? cu.error : null
      next.output = cu.output || cu.outputSnippet || null
      var endFromClient = cu.endedAt || cu.endDate
      var startFromClient = cu.startedAt || cu.startDate
      next.endedAt = endFromClient || endedAt
      next.updatedAt = endedAt
      if (startFromClient) {
        next.startedAt = startFromClient
      }
      if (cu.deviceName) {
        next.deviceName = String(cu.deviceName)
      }
      if (cu.deviceModel) {
        next.deviceModel = String(cu.deviceModel)
      }
    }
    return next
  })
}

function completeMonkeyRun(req, res) {
  var runId = req.swagger.params.runId.value
  var devices = getBody(req, 'devices', [])
  if (!runId) {
    return apiutil.respond(res, 400, 'Bad Request (runId required)')
  }
  var updates = Array.isArray(devices) ? devices : []
  if (!updates.length) {
    return apiutil.respond(res, 400, 'Bad Request (devices required)')
  }

  return db.run(r.table('automationMonkeyRuns').get(runId))
    .then(function(run) {
      if (!run) {
        return apiutil.respond(res, 404, 'Not Found (run)')
      }
      return db.run(r.table('automationMonkeyRunDevices').getAll(runId, {index: 'runId'}))
        .then(function(cursor) { return cursor.toArray() })
        .then(function(rows) {
          if (!rows.length) {
            return apiutil.respond(res, 400, 'Bad Request (no device rows for this run)')
          }
          if (updates.length !== rows.length) {
            return apiutil.respond(res, 400, 'Bad Request (devices length must match target devices)')
          }
          var clientSerials = {}
          for (var j = 0; j < updates.length; j++) {
            var sj = updates[j] && updates[j].serial ? String(updates[j].serial).trim() : ''
            if (sj) {
              clientSerials[sj] = true
            }
          }
          if (Object.keys(clientSerials).length !== rows.length) {
            return apiutil.respond(res, 400, 'Bad Request (duplicate or missing serial in devices)')
          }
          var dbSerials = {}
          for (var d = 0; d < rows.length; d++) {
            dbSerials[String(rows[d].serial || '').trim()] = true
          }
          for (var cs in clientSerials) {
            if (Object.prototype.hasOwnProperty.call(clientSerials, cs) && !dbSerials[cs]) {
              return apiutil.respond(res, 400, 'Bad Request (unknown device serial)')
            }
          }
          var endedAt = isoNow()
          var merged = mergeMonkeyDeviceRowsFromClient(rows, updates, endedAt)
          return finalizeMonkeyRunByRows(run, merged, endedAt)
            .then(function() {
              return apiutil.respond(res, 200, 'Monkey run completed', {runId: runId})
            })
        })
    })
    .catch(function(err) {
      apiutil.internalError(res, 'Failed to complete monkey run: ', err.stack)
    })
}

function listMonkeyRuns(req, res) {
  var page = Number(req.swagger.params.page && req.swagger.params.page.value || 1)
  var pageSize = Number(req.swagger.params.pageSize && req.swagger.params.pageSize.value || 20)
  var createdBy = req.swagger.params.createdBy && req.swagger.params.createdBy.value
  var packageName = req.swagger.params.packageName && req.swagger.params.packageName.value
  var startDate = req.swagger.params.startDate && req.swagger.params.startDate.value
  var endDate = req.swagger.params.endDate && req.swagger.params.endDate.value
  var start = (page - 1) * pageSize

  // 优先使用 createdByEmail 索引，避免全表扫描
  var dataQuery = createdBy ?
    r.table('automationMonkeyRuns').getAll(createdBy, {index: 'createdByEmail'}).orderBy(r.desc('createdAt')) :
    r.table('automationMonkeyRuns').orderBy({index: r.desc('createdAt')})

  var filteredQuery = dataQuery
  if (packageName) {
    filteredQuery = filteredQuery.filter(function(row) {
      return row('packageName').match('(?i)' + packageName)
    })
  }
  filteredQuery = applyDateFilter(filteredQuery, startDate, endDate)

  // count 单独走索引，不跟随 orderBy，避免排序开销
  var countQuery = createdBy ?
    r.table('automationMonkeyRuns').getAll(createdBy, {index: 'createdByEmail'}) :
    r.table('automationMonkeyRuns')
  if (packageName) {
    countQuery = countQuery.filter(function(row) {
      return row('packageName').match('(?i)' + packageName)
    })
  }
  countQuery = applyDateFilter(countQuery, startDate, endDate).count()

  // count 与分页数据并行查询，减少串行等待
  return Promise.all([
    db.run(countQuery)
  , db.run(filteredQuery.without(['reportHtml']).skip(start).limit(pageSize))
      .then(function(cursor) { return cursor.toArray() })
  ])
    .then(function(results) {
      var total = results[0]
      var data  = results[1]
      if (!total || !data.length) {
        return apiutil.respond(res, 200, 'Monkey runs', {
          total: total, page: page, pageSize: pageSize, runs: []
        })
      }
          // 批量查询
          var runIds = data.map(function(run) { return run.id })
          return db.run(
            r.table('automationMonkeyRunDevices').getAll(r.args(runIds), {index: 'runId'})
          )
            .then(function(devCursor) { return devCursor.toArray() })
            .then(function(allDevices) {
              var devicesByRun = {}
              allDevices.forEach(function(d) {
                if (!devicesByRun[d.runId]) devicesByRun[d.runId] = []
                devicesByRun[d.runId].push(d)
              })
              return Promise.map(data, function(run) {
                var devices = devicesByRun[run.id] || []
                var totalDevices = devices.length
                function hasErr(d) {
                  return d.error != null && String(d.error).trim() !== ''
                }
                var done = devices.filter(function(d) {
                  return d.status === 'finished' || d.status === 'done' || d.status === 'failed' || !!d.endedAt
                }).length
                var failed = devices.filter(function(d) {
                  return d.status === 'failed' || hasErr(d)
                }).length
                var success = devices.filter(function(d) {
                  if (d.status === 'failed' || hasErr(d)) {
                    return false
                  }
                  return d.status === 'finished' || d.status === 'done' || !!d.endedAt
                }).length
                done = devices.filter(function(d) {
                  return d.status === 'finished' || d.status === 'done' || !!d.endedAt
                }).length
                run.totalDevices = totalDevices
                run.progressDone = done
                run.successDevices = success
                run.failDevices = failed
                run.passRate = totalDevices > 0 ? Math.round((success / totalDevices) * 1000) / 10 : 0
                if (!run.endedAt && totalDevices > 0 && (run.status === 'finished' || run.status === 'failed')) {
                  var ends = devices.map(function(d) { return d.endedAt }).filter(Boolean).sort()
                  if (ends.length) {
                    run.endedAt = ends[ends.length - 1]
                  }
                }
                if (run.status === 'running' && totalDevices > 0 && done >= totalDevices) {
                  var endedAt = run.endedAt || isoNow()
                  var nextStatus = failed > 0 ? 'failed' : 'finished'
                  run.status = nextStatus
                  run.endedAt = endedAt
                  run.updatedAt = isoNow()
                  return db.run(r.table('automationMonkeyRuns').get(run.id).update({
                    status: nextStatus
                  , endedAt: endedAt
                  , updatedAt: run.updatedAt
                  })).then(function() { return run })
                }
                return run
              })
            })
            .then(function(runs) {
              apiutil.respond(res, 200, 'Monkey runs', {
                total: total, page: page, pageSize: pageSize, runs: runs
              })
            })
    })
    .catch(function(err) {
      apiutil.internalError(res, 'Failed to list monkey runs: ', err.stack)
    })
}

function getMonkeyRunReport(req, res) {
  var runId = req.swagger.params.runId.value
  return db.run(r.table('automationMonkeyRuns').get(runId))
    .then(function(run) {
      if (!run) {
        return apiutil.respond(res, 404, 'Not Found (run)')
      }
      return db.run(r.table('automationMonkeyRunDevices').getAll(runId, {index: 'runId'}))
        .then(function(cursor) {
          return cursor.toArray()
        })
        .then(function(rows) {
          apiutil.respond(res, 200, 'Monkey report', {
            run: run
          , devices: rows
          })
        })
    })
    .catch(function(err) {
      apiutil.internalError(res, 'Failed to get monkey report: ', err.stack)
    })
}

function downloadMonkeyTestReport(req, res) {
  var runId = req.swagger.params.runId.value
  return db.run(r.table('automationMonkeyRuns').get(runId))
    .then(function(run) {
      if (!run) {
        return apiutil.respond(res, 404, 'Not Found (run)')
      }
      function sendHtml(html) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8')
        res.setHeader('Content-Disposition', 'attachment; filename="monkey-report-' + runId + '.html"')
        res.status(200).send(html)
      }
      // Always rebuild HTML so template/stats stay current and header 结束时间 uses run.endedAt or device max.
      return db.run(r.table('automationMonkeyRunDevices').getAll(runId, {index: 'runId'}))
        .then(function(cursor) {
          return cursor.toArray()
        })
        .then(function(rows) {
          sendHtml(reportHtmlUtil.buildMonkeyTestReportHtml(run, rows || []))
        })
    })
    .catch(function(err) {
      apiutil.internalError(res, 'Failed to download monkey report: ', err.stack)
    })
}

module.exports = {
  createRecording: createRecording
, importRecording: importRecording
, listRecordings: listRecordings
, getRecording: getRecording
, updateRecording: updateRecording
, deleteRecording: deleteRecording
, downloadRecording: downloadRecording
, createReplayRun: createReplayRun
, listReplayRuns: listReplayRuns
, getReplayRunReport: getReplayRunReport
, downloadReplayTestReport: downloadReplayTestReport
, completeReplayRun: completeReplayRun
, createMonkeyRun: createMonkeyRun
, listMonkeyRuns: listMonkeyRuns
, getMonkeyRunReport: getMonkeyRunReport
, downloadMonkeyTestReport: downloadMonkeyTestReport
, completeMonkeyRun: completeMonkeyRun
, createExplorerRun: createExplorerRun
, listExplorerRuns: listExplorerRuns
, getExplorerRunReport: getExplorerRunReport
, downloadExplorerTestReport: downloadExplorerTestReport
, convertExplorerToRecording: convertExplorerToRecording
, stopExplorerRun: stopExplorerRun
, getExplorerRunProgress: getExplorerRunProgress
, getExplorerLastMemory: getExplorerLastMemory
}

/* ---------- Explorer Handlers ---------- */

function createExplorerRun(req, res) {
  var now = isoNow()
  var pkg = getBody(req, 'packageName', '')
  var targets = getBody(req, 'targets', [])
  var maxSteps = Number(getBody(req, 'maxSteps', 80))
  var maxMinutes = Number(getBody(req, 'maxMinutes', 8))
  var maxTriesPerDoor = Number(getBody(req, 'maxTriesPerDoor', 1))
  var includeRisky = !!getBody(req, 'includeRisky', false)
  var stuckThreshold = Number(getBody(req, 'stuckThreshold', 4))
  var errorKeywords = getBody(req, 'errorKeywords', null)
  var captureEverySteps = Number(getBody(req, 'captureEverySteps', 5))
  var credentials = getBody(req, 'credentials', null)
  var preSteps = getBody(req, 'preSteps', null)
  var skipLaunch = !!getBody(req, 'skipLaunch', false)
  var continueMemory = getBody(req, 'continueMemory', null)
  var source = getBody(req, 'source', 'bulk')

  if (!pkg || !targets.length) {
    return apiutil.respond(res, 400, 'Bad Request (packageName/targets required)')
  }

  var run = {
    id: uuid.v4()
  , packageName: pkg
  , createdByEmail: req.user.email
  , createdByName: req.user.name
  , targets: targets
  , maxSteps: maxSteps
  , maxMinutes: maxMinutes
  , maxTriesPerDoor: maxTriesPerDoor
  , includeRisky: includeRisky
  , stuckThreshold: stuckThreshold
  , errorKeywords: Array.isArray(errorKeywords) ? errorKeywords : null
  , captureEverySteps: captureEverySteps
  , credentials: credentials
  , preSteps: Array.isArray(preSteps) ? preSteps : []
  , skipLaunch: skipLaunch
  , source: source
  , initialMemory: (function() {
      if (!continueMemory) return null
      try { return typeof continueMemory === 'string' ? JSON.parse(continueMemory) : continueMemory }
      catch(e) { return null }
    })()
  , status: 'running'
  , reportAvailable: false
  , reportHtml: null
  , totalPages: 0
  , totalSteps: 0
  , createdAt: now
  , startedAt: now
  , endedAt: null
  , updatedAt: now
  }

  return db.run(r.table('automationExplorerRuns').insert(run))
    .then(function() {
      apiutil.respond(res, 201, 'Created (explorer run)', {run: run})

      var ownerMsg = new wire.OwnerMessage(
        req.user.email
      , req.user.name
      , req.user.group
      )

      // 1) 通过正常 STF group 流程占用设备：发送 GroupMessage 到设备 channel
      //    设备插件收到后会回传 JoinGroupMessage，processor 更新 DB，WebSocket 广播 device.change
      db.run(r.table('devices').getAll(r.args(targets)))
        .then(function(cursor) { return cursor.toArray() })
        .then(function(devices) {
          devices.forEach(function(device) {
            if (!device.channel) {
              return
            }
            req.options.push.send([
              device.channel
            , wireutil.envelope(new wire.GroupMessage(
                ownerMsg
              , null
              , wireutil.toDeviceRequirements({
                  serial: {
                    value: device.serial
                  , match: 'exact'
                  }
                })
              , 'automation'
              ))
            ])
          })
        })
        .catch(function(err) {
          log.error('Failed to lock devices for explorer run: ', err.stack)
        })

      // 2) 启动 executor；它负责运行结束后通过 Wire 释放设备
      explorerExecutor.runExplorer(run, targets, req.options.push, ownerMsg)
    })
    .catch(function(err) {
      apiutil.internalError(res, 'Failed to create explorer run: ', err.stack)
    })
}

function listExplorerRuns(req, res) {
  var page = Number(req.swagger.params.page && req.swagger.params.page.value || 1)
  var pageSize = Number(req.swagger.params.pageSize && req.swagger.params.pageSize.value || 20)
  var createdBy = req.swagger.params.createdBy && req.swagger.params.createdBy.value
  var packageName = req.swagger.params.packageName && req.swagger.params.packageName.value
  var source = req.swagger.params.source && req.swagger.params.source.value
  var startDate = req.swagger.params.startDate && req.swagger.params.startDate.value
  var endDate = req.swagger.params.endDate && req.swagger.params.endDate.value
  var start = (page - 1) * pageSize

  // 优先使用 createdByEmail 索引，避免全表扫描
  var dataQuery = createdBy ?
    r.table('automationExplorerRuns').getAll(createdBy, {index: 'createdByEmail'}).orderBy(r.desc('createdAt')) :
    r.table('automationExplorerRuns').orderBy({index: r.desc('createdAt')})

  var filteredQuery = dataQuery
  if (source) {
    filteredQuery = filteredQuery.filter({source: source})
  }
  if (packageName) {
    filteredQuery = filteredQuery.filter(function(row) {
      return row('packageName').match('(?i)' + packageName)
    })
  }
  filteredQuery = applyDateFilter(filteredQuery, startDate, endDate)

  // count 单独走索引，不跟随 orderBy
  var countQuery = createdBy ?
    r.table('automationExplorerRuns').getAll(createdBy, {index: 'createdByEmail'}) :
    r.table('automationExplorerRuns')
  if (source) {
    countQuery = countQuery.filter({source: source})
  }
  if (packageName) {
    countQuery = countQuery.filter(function(row) {
      return row('packageName').match('(?i)' + packageName)
    })
  }
  countQuery = applyDateFilter(countQuery, startDate, endDate).count()

  // count 与分页数据并行查询，减少串行等待
  return Promise.all([
    db.run(countQuery)
  , db.run(filteredQuery.without(['reportHtml', 'initialMemory']).skip(start).limit(pageSize))
      .then(function(cursor) { return cursor.toArray() })
  ])
    .then(function(results) {
      var total = results[0]
      var data  = results[1]
      if (!total || !data.length) {
        return apiutil.respond(res, 200, 'Explorer runs', {
          total: total, page: page, pageSize: pageSize, runs: []
        })
      }

          // 批量一次性查询当前页所有 run 的设备记录，避免 N+1
          var runIds = data.map(function(run) { return run.id })
          return db.run(
            r.table('automationExplorerRunDevices').getAll(r.args(runIds), {index: 'runId'})
          )
            .then(function(devCursor) { return devCursor.toArray() })
            .then(function(allDevices) {
              var devicesByRun = {}
              allDevices.forEach(function(d) {
                if (!devicesByRun[d.runId]) {
                  devicesByRun[d.runId] = []
                }
                devicesByRun[d.runId].push(d)
              })

              var runs = data.map(function(run) {
                var devices = devicesByRun[run.id] || []
                run.totalDevices = devices.length
                run.totalPages = devices.reduce(function(s, d) { return s + (Number(d.pagesDiscovered) || 0) }, 0)
                run.totalSteps = devices.reduce(function(s, d) { return s + (Number(d.stepsExecuted) || 0) }, 0)
                var crashes = devices.reduce(function(s, d) { return s + (Number(d.crashCount) || 0) }, 0)
                var anrs = devices.reduce(function(s, d) { return s + (Number(d.anrCount) || 0) }, 0)
                var kw = devices.reduce(function(s, d) { return s + (Number(d.errorKeywordCount) || 0) }, 0)
                var stuck = devices.reduce(function(s, d) { return s + (Number(d.stuckCount) || 0) }, 0)
                run.totalIssues = crashes + anrs + kw + stuck
                // Auto-heal stale "running" status
                if (run.status === 'running' && devices.length > 0) {
                  var allDone = devices.every(function(d) {
                    return d.status === 'finished' || d.status === 'failed'
                  })
                  if (allDone) {
                    var endedAt = run.endedAt || isoNow()
                    var hasFail = devices.some(function(d) { return d.status === 'failed' || (d.crashCount || 0) > 0 })
                    var nextStatus = hasFail ? 'failed' : 'finished'
                    run.status = nextStatus
                    run.endedAt = endedAt
                    db.run(r.table('automationExplorerRuns').get(run.id).update({
                      status: nextStatus, endedAt: endedAt, updatedAt: isoNow()
                    })).catch(function() {})
                  }
                }
                return run
              })

              apiutil.respond(res, 200, 'Explorer runs', {
                total: total, page: page, pageSize: pageSize, runs: runs
              })
            })
    })
    .catch(function(err) {
      apiutil.internalError(res, 'Failed to list explorer runs: ', err.stack)
    })
}

function getExplorerRunReport(req, res) {
  var runId = req.swagger.params.runId.value
  return db.run(r.table('automationExplorerRuns').get(runId))
    .then(function(run) {
      if (!run) {
        return apiutil.respond(res, 404, 'Not Found (explorer run)')
      }
      return db.run(r.table('automationExplorerRunDevices').getAll(runId, {index: 'runId'}))
        .then(function(cursor) { return cursor.toArray() })
        .then(function(rows) {
          apiutil.respond(res, 200, 'Explorer report', { run: run, devices: rows })
        })
    })
    .catch(function(err) {
      apiutil.internalError(res, 'Failed to get explorer report: ', err.stack)
    })
}

function downloadExplorerTestReport(req, res) {
  var runId = req.swagger.params.runId.value
  return db.run(r.table('automationExplorerRuns').get(runId))
    .then(function(run) {
      if (!run) {
        return apiutil.respond(res, 404, 'Not Found (explorer run)')
      }
      return db.run(r.table('automationExplorerRunDevices').getAll(runId, {index: 'runId'}))
        .then(function(cursor) { return cursor.toArray() })
        .then(function(rows) {
          var html = reportHtmlUtil.buildExplorerTestReportHtml(run, rows || [])
          res.setHeader('Content-Type', 'text/html; charset=utf-8')
          res.setHeader('Content-Disposition', 'attachment; filename="explorer-report-' + runId + '.html"')
          res.status(200).send(html)
        })
    })
    .catch(function(err) {
      apiutil.internalError(res, 'Failed to download explorer report: ', err.stack)
    })
}

/**
 * Convert an explorer device's actionHistory into an automationRecordings record
 * so the failure path can be replayed via the existing replay system.
 */
function convertExplorerToRecording(req, res) {
  var runId = getBody(req, 'runId', '') || (req.swagger.params.runId && req.swagger.params.runId.value) || ''
  var serial = getBody(req, 'serial', '')
  var name = getBody(req, 'name', '')
  if (!runId || !serial) {
    return apiutil.respond(res, 400, 'Bad Request (runId/serial required)')
  }

  return db.run(r.table('automationExplorerRunDevices').getAll(runId, {index: 'runId'}))
    .then(function(cursor) { return cursor.toArray() })
    .then(function(rows) {
      var deviceRow = rows.filter(function(d) { return d.serial === serial })[0]
      if (!deviceRow) {
        return apiutil.respond(res, 404, 'Not Found (device row for serial ' + serial + ')')
      }
      var history = Array.isArray(deviceRow.actionHistory) ? deviceRow.actionHistory : []
      if (!history.length) {
        return apiutil.respond(res, 400, 'No action history available for this device')
      }

      // Convert actionHistory to stepsJson format compatible with replay-executor
      var stepsJson = history.map(function(h, idx) {
        var step = {
          index: idx
        , action: h.type
        , timestamp: h.timestamp || null
        , description: (h.doorLabel || h.type) + ' @ step ' + h.step
        }
        if (h.type === 'tap') {
          step.action = 'tap'
          step.x = h.x
          step.y = h.y
        }
        else if (h.type === 'longTap') {
          step.action = 'longTap'
          step.x = h.x
          step.y = h.y
          step.duration = h.durationMs || 700
        }
        else if (h.type === 'swipe') {
          step.action = 'swipe'
          step.x = h.x1
          step.y = h.y1
          step.x2 = h.x2
          step.y2 = h.y2
          step.duration = h.durationMs || 350
        }
        else if (h.type === 'input') {
          step.action = 'tap'
          step.x = h.x
          step.y = h.y
          step.inputText = h.text || ''
        }
        else if (h.type === 'back') {
          step.action = 'keyevent'
          step.keyCode = 4
        }
        else if (h.type === 'home') {
          step.action = 'keyevent'
          step.keyCode = 3
        }
        else if (h.type === 'restart') {
          step.action = 'launchApp'
          step.packageName = deviceRow.packageName || ''
        }
        else {
          step.action = h.type
        }
        return step
      })

      var now = isoNow()
      var recording = {
        id: uuid.v4()
      , name: name || ('Explorer探索转录制 - ' + serial + ' - ' + runId.slice(0, 8))
      , createdByEmail: req.user.email
      , createdByName: req.user.name
      , stepsJson: stepsJson
      , sourceType: 'explorer'
      , sourceRunId: runId
      , sourceSerial: serial
      , createdAt: now
      , updatedAt: now
      }

      return db.run(r.table('automationRecordings').insert(recording))
        .then(function() {
          apiutil.respond(res, 201, 'Recording created from explorer path', {recording: recording})
        })
    })
    .catch(function(err) {
      apiutil.internalError(res, 'Failed to convert explorer to recording: ', err.stack)
    })
}

/**
 * Stop a running explorer run by marking it as 'stopping' in DB.
 * The executor checks this flag every step and will terminate gracefully.
 */
function stopExplorerRun(req, res) {
  var runId = (req.swagger.params.runId && req.swagger.params.runId.value) || ''
  if (!runId) {
    return apiutil.respond(res, 400, 'Bad Request (runId required)')
  }
  return db.run(r.table('automationExplorerRuns').get(runId).update({
    status: 'stopping'
  , updatedAt: new Date().toISOString()
  }))
    .then(function() {
      apiutil.respond(res, 200, 'Run marked as stopping')
    })
    .catch(function(err) {
      apiutil.internalError(res, 'Failed to stop explorer run: ', err.stack)
    })
}

/**
 * Get real-time progress of an explorer run.
 * Returns aggregated progress from all devices in the run.
 */
function getExplorerRunProgress(req, res) {
  var runId = (req.swagger.params.runId && req.swagger.params.runId.value) || ''
  if (!runId) {
    return apiutil.respond(res, 400, 'Bad Request (runId required)')
  }
  return db.run(r.table('automationExplorerRuns').get(runId))
    .then(function(run) {
      if (!run) {
        return apiutil.respond(res, 404, 'Run not found')
      }
      return db.run(r.table('automationExplorerRunDevices').getAll(runId, {index: 'runId'}))
        .then(function(result) {
          var devices = Array.isArray(result) ? result : []
          if (result && typeof result.toArray === 'function') {
            return result.toArray().then(function(arr) { return arr })
          }
          return devices
        })
        .then(function(devices) {
          var totalSteps = devices.reduce(function(s, d) { return s + (d.stepsExecuted || 0) }, 0)
          var totalPages = devices.reduce(function(s, d) { return s + (d.pagesDiscovered || 0) }, 0)
          var totalIssues = devices.reduce(function(s, d) {
            return s + (d.crashCount || 0) + (d.anrCount || 0) + (d.errorKeywordCount || 0) + (d.stuckCount || 0)
          }, 0)
          var logs = []
          var errors = []
          devices.forEach(function(d) {
            if (d.executionLog) {
              var lines = String(d.executionLog).split('\n').slice(-30)
              logs = logs.concat(lines)
            }
            // Collect error details from reportArtifacts
            if (Array.isArray(d.reportArtifacts)) {
              d.reportArtifacts.forEach(function(a) {
                errors.push({
                  step: a.stepIndex != null ? a.stepIndex : null
                , code: a.code || a.type || ''
                , title: a.title || ''
                , detail: a.detail || ''
                , activity: a.activity || ''
                })
              })
            }
            // Also include device-level error
            if (d.error) {
              errors.push({
                step: null
              , code: 'DEVICE_ERROR'
              , title: '设备异常'
              , detail: String(d.error)
              , activity: ''
              })
            }
          })
          res.json({
            status: run.status
          , totalSteps: totalSteps
          , totalPages: totalPages
          , totalIssues: totalIssues
          , crashCount: devices.reduce(function(s, d) { return s + (d.crashCount || 0) }, 0)
          , anrCount: devices.reduce(function(s, d) { return s + (d.anrCount || 0) }, 0)
          , stuckCount: devices.reduce(function(s, d) { return s + (d.stuckCount || 0) }, 0)
          , errorKeywordCount: devices.reduce(function(s, d) { return s + (d.errorKeywordCount || 0) }, 0)
          , logs: logs.slice(-50)
          , errors: errors
          , devices: devices.map(function(d) {
              return {
                serial: d.serial
              , status: d.status
              , stepsExecuted: d.stepsExecuted || 0
              , pagesDiscovered: d.pagesDiscovered || 0
              , currentActivity: d.currentActivity || ''
              }
            })
          })
        })
    })
    .catch(function(err) {
      apiutil.internalError(res, 'Failed to get explorer progress: ', err.stack)
    })
}

/**
 * Task 5: Get the last memory for a given package+serial combination.
 * Allows "continue from last exploration" by reloading saved memory.
 */
function getExplorerLastMemory(req, res) {
  var pkg = req.swagger.params.packageName && req.swagger.params.packageName.value
  var serial = req.swagger.params.serial && req.swagger.params.serial.value
  if (!pkg || !serial) {
    return apiutil.respond(res, 400, 'Bad Request (packageName and serial required)')
  }
  return db.run(
    r.table('automationExplorerRuns')
      .filter({ packageName: pkg })
      .filter(function(row) {
        return row('status').eq('finished').or(row('status').eq('failed'))
      })
      .orderBy(r.desc('createdAt'))
      .limit(1)
  )
    .then(function(cursor) { return cursor.toArray() })
    .then(function(runs) {
      if (!runs || !runs.length) {
        return res.json({ hasMemory: false })
      }
      var run = runs[0]
      return db.run(
        r.table('automationExplorerRunDevices')
          .getAll(run.id, { index: 'runId' })
          .filter({ serial: serial })
      )
        .then(function(cursor) { return cursor.toArray() })
        .then(function(devices) {
          if (!devices || !devices.length || !devices[0].explorerMemory) {
            return res.json({ hasMemory: false })
          }
          var memStr = devices[0].explorerMemory
          var memObj = null
          try {
            memObj = typeof memStr === 'string' ? JSON.parse(memStr) : memStr
          } catch(e) {
            return res.json({ hasMemory: false })
          }
          var pagesCount = memObj && memObj.pages ? Object.keys(memObj.pages).length : 0
          res.json({
            hasMemory: true
          , memory: memObj
          , runId: run.id
          , createdAt: run.createdAt
          , pagesCount: pagesCount
          , totalSteps: devices[0].stepsExecuted || 0
          })
        })
    })
    .catch(function(err) {
      apiutil.internalError(res, 'Failed to get explorer memory: ', err.stack)
    })
}
