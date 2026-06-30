require('./bulk-monkey.css')

module.exports = angular.module('device-list.bulk-monkey', [
  require('../bulk-common').name
])
  .directive('deviceListBulkMonkey', function() {
    return {
      restrict: 'E'
    , template: require('./bulk-monkey.pug')
    , controller: 'DeviceListBulkMonkeyCtrl'
    }
  })
  .controller('DeviceListBulkMonkeyCtrl', function($scope, $http, $interval, $timeout, $q, BulkRunnerService) {
    $scope.monkeyPackage = ''
    $scope.monkeyEventCount = 1000
    $scope.monkeyThrottleMs = 200
    $scope.monkeySeed = ''

    $scope.monkeyRunning = false
    $scope.monkeyAbort = false
    $scope.monkeyRuns = []
    $scope.monkeyPollingTimer = null
    $scope.activeMonkeyRunIds = {}
    $scope.monkeyCompleteError = ''

    function buildMonkeyCmd(pkg, eventCount, throttleMs, seed) {
      var args = ['monkey', '-p', pkg, '--throttle', String(throttleMs)]
      if (seed) {
        args.push('-s', String(seed))
      }
      args.push('-v', String(eventCount))
      return args.join(' ')
    }

    $scope.loadMonkeyRuns = function() {
      return $http.get('/api/v1/automation/monkey/runs', {params: {page: 1, pageSize: 200}})
        .then(function(res) {
          var all = res.data.runs || []
          var filtered = all.filter(function(run) {
            return !!$scope.activeMonkeyRunIds[run.id]
          })
          $scope.monkeyRuns = filtered
          var hasRunning = $scope.monkeyRuns.some(function(run) {
            return run.status === 'running'
          })
          if (!hasRunning) {
            $scope.stopMonkeyPolling()
          }
        })
    }

    $scope.startMonkeyPolling = function() {
      if ($scope.monkeyPollingTimer) {
        return
      }
      $scope.monkeyPollingTimer = $interval(function() {
        $scope.loadMonkeyRuns()
      }, 1500)
    }

    $scope.stopMonkeyPolling = function() {
      if ($scope.monkeyPollingTimer) {
        $interval.cancel($scope.monkeyPollingTimer)
        $scope.monkeyPollingTimer = null
      }
    }

    function extractRunId(res) {
      var body = res && res.data
      if (!body) {
        return null
      }
      if (body.run && body.run.id) {
        return body.run.id
      }
      if (body.id) {
        return body.id
      }
      return null
    }

    function postMonkeyComplete(runId, payload, attempt) {
      attempt = attempt || 0
      return $http.post('/api/v1/automation/monkey/runs/' + runId + '/complete', payload)
        .catch(function(err) {
          if (attempt < 4) {
            return $timeout(function() {
              return postMonkeyComplete(runId, payload, attempt + 1)
            }, 600 * (attempt + 1))
          }
          return $q.reject(err)
        })
    }

    $scope.startMonkeyRun = function() {
      var pkg = String($scope.monkeyPackage || '').trim()
      if (!pkg || $scope.monkeyRunning) {
        return
      }
      var targets = BulkRunnerService.getTargets($scope.tracker, $scope.batchSelection)
      var serials = targets.map(function(d) { return d.serial })
      if (!serials.length) {
        return
      }

      $scope.monkeyRunning = true
      $scope.monkeyAbort = false
      $scope.monkeyCompleteError = ''

      var payload = {
        packageName: pkg
      , targets: serials
      , eventCount: Number($scope.monkeyEventCount || 1000)
      , throttleMs: Number($scope.monkeyThrottleMs || 200)
      , seed: String($scope.monkeySeed || '')
      }

      var runId = null
      var startedAt = new Date().toISOString()

      $http.post('/api/v1/automation/monkey/runs', payload)
        .then(function(res) {
          runId = extractRunId(res)
          if (!runId) {
            throw new Error('创建任务失败：未返回 runId')
          }
          $scope.activeMonkeyRunIds[runId] = true
          $scope.startMonkeyPolling()
          $scope.loadMonkeyRuns()
          var cmd = buildMonkeyCmd(payload.packageName, payload.eventCount, payload.throttleMs, payload.seed)
          return BulkRunnerService.run($scope.tracker, $scope.batchSelection, function(control, joined) {
            var name = (joined && (joined.name || joined.marketName)) || ''
            var model = (joined && joined.model) || ''
            var p = control.shell(cmd, Math.max(30000, payload.eventCount * payload.throttleMs + 30000))
            return p.then(function(data) {
              return {
                shell: data
              , deviceName: name
              , deviceModel: model
              }
            })
          }, null, {
            releaseReason: 'bulk_task_release'
          , usage: 'automation'
          , shouldAbort: function() {
              return $scope.monkeyAbort
            }
          })
        })
        .then(function(results) {
          if (!runId) {
            return
          }
          var now = new Date().toISOString()
          var devices = (results || []).map(function(item) {
            var extra = item.data && typeof item.data === 'object' ? item.data : {}
            var shellRes = extra.shell
            var out = ''
            if (item.ok && shellRes && typeof shellRes === 'object') {
              out = BulkRunnerService.formatShellOutput(shellRes)
            }
            var row = {
              serial: item.serial
            , status: item.ok ? 'finished' : 'failed'
            , outputSnippet: out
            , deviceName: extra.deviceName || ''
            , deviceModel: extra.deviceModel || ''
            , startedAt: startedAt
            , endedAt: now
            }
            if (!item.ok) {
              row.error = item.error || 'failed'
            }
            return row
          })
          return postMonkeyComplete(runId, {devices: devices})
            .then(function() {
              $scope.monkeyCompleteError = ''
              $scope.loadMonkeyRuns()
            })
            .catch(function(err) {
              var msg = (err && err.data && err.data.description) || (err && err.status) || 'unknown'
              $scope.monkeyCompleteError = '上报结果失败（' + msg + '），请稍后刷新或重试'
              $scope.loadMonkeyRuns()
            })
        })
        .catch(function(err) {
          $scope.monkeyCompleteError = (err && err.message) ? String(err.message) : '任务失败'
        })
        .finally(function() {
          $scope.monkeyRunning = false
          $scope.monkeyAbort = false
          $scope.loadMonkeyRuns()
        })
    }

    $scope.stopMonkeyRun = function() {
      $scope.monkeyAbort = true
    }

    $scope.downloadMonkeyReport = function(run) {
      window.open('/api/v1/automation/monkey/runs/' + run.id + '/test-report')
    }

    $scope.$on('$destroy', function() {
      $scope.stopMonkeyPolling()
    })
  })
