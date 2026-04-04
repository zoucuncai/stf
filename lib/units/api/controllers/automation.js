var r = require('rethinkdb')
var uuid = require('uuid')
var Promise = require('bluebird')

var db = require('../../../db')
var apiutil = require('../../../util/apiutil')
var replayExecutor = require('../../../util/automation-replay-executor')

function isoNow() {
  return new Date().toISOString()
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

function csvRow(values) {
  return values.map(function(v) {
    var s = String(v == null ? '' : v)
    if (s.indexOf(',') !== -1 || s.indexOf('"') !== -1 || s.indexOf('\n') !== -1) {
      return '"' + s.replace(/"/g, '""') + '"'
    }
    return s
  }).join(',')
}

function buildMonkeyCsv(run, rows) {
  var lines = [
    csvRow(['运行ID', '包名', '参数', '执行人', '设备序列号', '设备名称', '设备型号', '状态', '事件数', '节流(ms)', 'Seed', '错误信息', '开始时间', '结束时间'])
  ]
  rows.forEach(function(item) {
    lines.push(csvRow([
      run.id,
      run.packageName,
      run.argsText || '',
      run.createdByName || run.createdByEmail,
      item.serial,
      item.deviceName || '',
      item.deviceModel || '',
      item.status,
      run.eventCount,
      run.throttleMs,
      run.seed || '',
      item.error || '',
      dateToIso(item.startedAt),
      dateToIso(item.endedAt)
    ]))
  })
  return lines.join('\n')
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
  var csv = buildMonkeyCsv(run, normalized)
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
      , reportCsv: csv
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

      return db.run(r.table('automationRecordings').insert(row))
        .then(function() {
          apiutil.respond(res, 201, 'Created (recording)', {recording: row})
        })
        .catch(function(err) {
          apiutil.internalError(res, 'Failed to create recording: ', err.stack)
        })
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

function downloadRecording(req, res) {
  var id = req.swagger.params.id.value
  return db.run(r.table('automationRecordings').get(id))
    .then(function(recording) {
      if (!recording) {
        return apiutil.respond(res, 404, 'Not Found (recording)')
      }
      var content = recording.pythonCode || '# empty recording\n'
      res.setHeader('Content-Type', 'text/x-python')
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
      , reportCsv: null
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
  return db.run(r.table('automationReplayRuns').orderBy(r.desc('createdAt')))
    .then(function(cursor) {
      return cursor.toArray()
    })
    .then(function(rows) {
      return Promise.map(rows, function(run) {
        return db.run(r.table('automationReplayRunDevices').getAll(run.id, {index: 'runId'}))
          .then(function(cursor) {
            return cursor.toArray()
          })
          .then(function(devices) {
            var total = devices.length
            var done = devices.filter(function(d) { return d.status === 'finished' || d.status === 'done' }).length
            var failed = devices.filter(function(d) { return d.status === 'failed' || d.result === '失败' || d.ok === false }).length
            var success = total - failed
            var totalCases = devices.reduce(function(sum, d) { return sum + (Number(d.totalCases) || 0) }, 0)
            var successCases = devices.reduce(function(sum, d) { return sum + (Number(d.successCases) || 0) }, 0)
            var caseSuccessRate = totalCases > 0 ? (successCases / totalCases) * 100 : 0

            run.totalDevices = total
            run.progressDone = done
            // UI list/export should use case-level success/fail.
            run.successDevices = successCases
            run.failDevices = (totalCases - successCases)
            run.passRate = caseSuccessRate
            run.caseSuccessRate = caseSuccessRate
            return run
          })
      }).then(function(runs) {
        apiutil.respond(res, 200, 'Replay runs', {runs: runs})
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

function downloadReplayCsv(req, res) {
  var runId = req.swagger.params.runId.value
  return db.run(r.table('automationReplayRuns').get(runId))
    .then(function(run) {
      if (!run) {
        return apiutil.respond(res, 404, 'Not Found (run)')
      }
      var content = run.reportCsv || '暂无数据\n'
      res.setHeader('Content-Type', 'text/csv; charset=utf-8')
      res.setHeader('Content-Disposition', 'attachment; filename="replay-' + runId + '.csv"')
      res.status(200).send('\ufeff' + content)
    })
    .catch(function(err) {
      apiutil.internalError(res, 'Failed to download replay csv: ', err.stack)
    })
}

function buildReplayCsv(run, items) {
  function csvRow(values) {
    return values.map(function(v) {
      var s = String(v == null ? '' : v)
      if (s.indexOf(',') !== -1 || s.indexOf('"') !== -1 || s.indexOf('\n') !== -1) {
        return '"' + s.replace(/"/g, '""') + '"'
      }
      return s
    }).join(',')
  }

  var header = [
    '运行ID',
    '录制ID',
    '录制名称',
    '设备序列号',
    '执行状态',
    '执行结果',
    '总Case',
    '成功Case',
    '失败Case',
    '成功率',
    '错误信息',
    '开始时间',
    '结束时间'
  ]

  var rows = (items || []).map(function(item) {
    var totalCases = Number(item.totalCases) || 0
    var successCases = Number(item.successCases) || 0
    var failedCases = Math.max(0, totalCases - successCases)
    var passRate = totalCases > 0 ?
      ((successCases / totalCases) * 100).toFixed(2) + '%' :
      '0.00%'

    return csvRow([
      run.id,
      run.recordingId,
      run.recordingName || '',
      item.serial,
      item.status,
      item.result || '',
      totalCases,
      successCases,
      failedCases,
      passRate,
      item.error || '',
      dateToIso(item.startedAt),
      dateToIso(item.endedAt)
    ])
  })

  return [csvRow(header)].concat(rows).join('\n')
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
            return db.run(r.table('automationReplayRunDevices').get(dbBySerial[serial].id).update({
              status: 'finished'
            , result: result
            , totalCases: totalCases
            , successCases: successCases
            , error: d.error != null ? d.error : null
            , endedAt: d.endedAt || nowIso
            , updatedAt: nowIso
            }))
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
                var csv = buildReplayCsv(run, updatedDeviceRows)

                return db.run(r.table('automationReplayRuns').get(run.id).update({
                  status: status
                , reportAvailable: true
                , reportCsv: csv
                , caseSuccessRate: caseSuccessRate
                , endedAt: endedAt
                , updatedAt: nowIso
                }))
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
  , reportCsv: null
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
  var query = r.table('automationMonkeyRuns')

  if (createdBy) {
    query = query.filter({createdByEmail: createdBy})
  }
  if (packageName) {
    query = query.filter(function(row) {
      return row('packageName').match('(?i)' + packageName)
    })
  }

  return db.run(query.orderBy(r.desc('createdAt')))
    .then(function(cursor) {
      return cursor.toArray()
    })
    .then(function(rows) {
      var total = rows.length
      var start = (page - 1) * pageSize
      var data = rows.slice(start, start + pageSize)
      return Promise.map(data, function(run) {
        return db.run(r.table('automationMonkeyRunDevices').getAll(run.id, {index: 'runId'}))
          .then(function(cursor) {
            return cursor.toArray()
          })
          .then(function(devices) {
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
            // Auto-heal stale "running" status if all devices have finished.
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
              })).then(function() {
                return run
              })
            }
            return run
          })
      }).then(function(runs) {
        apiutil.respond(res, 200, 'Monkey runs', {
          total: total
        , page: page
        , pageSize: pageSize
        , runs: runs
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

function downloadMonkeyCsv(req, res) {
  var runId = req.swagger.params.runId.value
  return db.run(r.table('automationMonkeyRuns').get(runId))
    .then(function(run) {
      if (!run) {
        return apiutil.respond(res, 404, 'Not Found (run)')
      }
      if (run.reportCsv) {
        res.setHeader('Content-Type', 'text/csv; charset=utf-8')
        res.setHeader('Content-Disposition', 'attachment; filename="monkey-' + runId + '.csv"')
        return res.status(200).send('\ufeff' + run.reportCsv)
      }
      return db.run(r.table('automationMonkeyRunDevices').getAll(runId, {index: 'runId'}))
        .then(function(cursor) {
          return cursor.toArray()
        })
        .then(function(rows) {
          var csv = buildMonkeyCsv(run, rows || [])
          return db.run(r.table('automationMonkeyRuns').get(runId).update({
            reportCsv: csv
          , reportAvailable: true
          , updatedAt: isoNow()
          }))
            .then(function() {
              res.setHeader('Content-Type', 'text/csv; charset=utf-8')
              res.setHeader('Content-Disposition', 'attachment; filename="monkey-' + runId + '.csv"')
              res.status(200).send('\ufeff' + csv)
            })
        })
    })
    .catch(function(err) {
      apiutil.internalError(res, 'Failed to download monkey csv: ', err.stack)
    })
}

module.exports = {
  createRecording: createRecording
, listRecordings: listRecordings
, getRecording: getRecording
, downloadRecording: downloadRecording
, createReplayRun: createReplayRun
, listReplayRuns: listReplayRuns
, getReplayRunReport: getReplayRunReport
, downloadReplayCsv: downloadReplayCsv
, completeReplayRun: completeReplayRun
, createMonkeyRun: createMonkeyRun
, listMonkeyRuns: listMonkeyRuns
, getMonkeyRunReport: getMonkeyRunReport
, downloadMonkeyCsv: downloadMonkeyCsv
, completeMonkeyRun: completeMonkeyRun
}

