require('./bulk-replay.css')

module.exports = angular.module('device-list.bulk-replay', [
  require('../bulk-common').name
])
  .directive('deviceListBulkReplay', function() {
    return {
      restrict: 'E'
    , template: require('./bulk-replay.pug')
    , controller: 'DeviceListBulkReplayCtrl'
    }
  })
  .controller('DeviceListBulkReplayCtrl', function($scope, $http, $interval, $q, BulkRunnerService, GroupService) {
    // recordingsAll: all recordings from server
    // recordings: filtered list (used by dropdown)
    // recordingsPage: paginated slice for the list table
    $scope.recordingsAll = []
    $scope.recordings = []
    $scope.recordingsPage = []
    $scope.recordQuery = ''
    $scope.recordingPage = 1
    $scope.recordingPageSize = 5
    $scope.recordingTotalPages = 1
    $scope.selectedRecordingId = ''
    $scope.replayRuns = []
    $scope.activeReplayRunIds = {}
    $scope.replayPollingTimer = null
    $scope.replayJoinedDevices = []

    function normalizeStr(v) {
      return String(v == null ? '' : v).toLowerCase().trim()
    }

    function applyRecordingFilterAndPagination() {
      var q = normalizeStr($scope.recordQuery)
      var list = $scope.recordingsAll || []
      if (q) {
        list = list.filter(function(item) {
          if (!item) return false
          var id = normalizeStr(item.id)
          var name = normalizeStr(item.name)
          var owner = normalizeStr(item.createdByName || item.createdByEmail)
          return id.indexOf(q) !== -1 || name.indexOf(q) !== -1 || owner.indexOf(q) !== -1
        })
      }

      $scope.recordings = list
      if ($scope.selectedRecordingId) {
        var selectedStillInList = list.some(function(item) {
          return item && String(item.id || '').trim() === String($scope.selectedRecordingId).trim()
        })
        if (!selectedStillInList && list.length) {
          $scope.selectedRecordingId = list[0].id
        }
      }
      var total = list.length
      var pageSize = Number($scope.recordingPageSize) || 5
      var totalPages = Math.max(1, Math.ceil(total / pageSize))
      $scope.recordingTotalPages = totalPages
      if ($scope.recordingPage > totalPages) {
        $scope.recordingPage = totalPages
      }
      if ($scope.recordingPage < 1) {
        $scope.recordingPage = 1
      }

      var start = ($scope.recordingPage - 1) * pageSize
      $scope.recordingsPage = list.slice(start, start + pageSize)
    }

    $scope.onRecordingQueryChange = function() {
      $scope.recordingPage = 1
      applyRecordingFilterAndPagination()
    }

    $scope.prevRecordingPage = function() {
      if ($scope.recordingPage <= 1) return
      $scope.recordingPage -= 1
      applyRecordingFilterAndPagination()
    }

    $scope.nextRecordingPage = function() {
      if ($scope.recordingPage >= $scope.recordingTotalPages) return
      $scope.recordingPage += 1
      applyRecordingFilterAndPagination()
    }

    $scope.loadRecordings = function() {
      return $http.get('/api/v1/automation/recordings')
        .then(function(res) {
          $scope.recordingsAll = res.data.recordings || []
          if (!$scope.selectedRecordingId && $scope.recordingsAll.length) {
            $scope.selectedRecordingId = $scope.recordingsAll[0].id
          }
          applyRecordingFilterAndPagination()
        })
    }

    $scope.loadReplayRuns = function() {
      var ids = Object.keys($scope.activeReplayRunIds || {})
      if (!ids.length) {
        $scope.replayRuns = []
        $scope.stopReplayPolling()
        $scope.releaseReplayDevices()
        return $q.when([])
      }

      return $q.all(ids.map(function(runId) {
        return $http.get('/api/v1/automation/replay/runs/' + encodeURIComponent(runId) + '/report')
          .then(function(res) {
            var data = res.data || {}
            var run = data.run || {}
            var devices = data.devices || []
            var totalDevices = devices.length
            var progressDone = devices.filter(function(d) {
              return d.status === 'finished' || d.status === 'done' || d.status === 'failed'
            }).length
            var totalCases = devices.reduce(function(sum, d) { return sum + (Number(d.totalCases) || 0) }, 0)
            var successCases = devices.reduce(function(sum, d) { return sum + (Number(d.successCases) || 0) }, 0)
            var failCases = Math.max(0, totalCases - successCases)
            var caseSuccessRate = totalCases > 0 ? (successCases / totalCases) * 100 : 0
            var hasPendingClientAssertion = devices.some(function(d) {
              return String((d && d.result) || '').trim() === '待客户端断言'
            })
            var finalized = !!run.reportAvailable && !hasPendingClientAssertion

            run.totalDevices = totalDevices
            run.progressDone = progressDone
            run.successDevices = successCases
            run.failDevices = failCases
            run.caseSuccessRate = caseSuccessRate
            run._finalized = finalized
            return run
          })
          .catch(function() {
            return null
          })
      }))
        .then(function(runs) {
          $scope.replayRuns = runs.filter(Boolean).sort(function(a, b) {
            var ta = new Date(a.startedAt || a.createdAt || 0).getTime()
            var tb = new Date(b.startedAt || b.createdAt || 0).getTime()
            return tb - ta
          })

          var allFinalized = $scope.replayRuns.length > 0 && $scope.replayRuns.every(function(run) {
            return run._finalized
          })
          if (allFinalized) {
            $scope.stopReplayPolling()
            $scope.releaseReplayDevices()
          }
        })
    }

    $scope.startReplayPolling = function() {
      if ($scope.replayPollingTimer) {
        return
      }
      $scope.replayPollingTimer = $interval(function() {
        $scope.loadReplayRuns()
      }, 1000)
    }

    $scope.stopReplayPolling = function() {
      if ($scope.replayPollingTimer) {
        $interval.cancel($scope.replayPollingTimer)
        $scope.replayPollingTimer = null
      }
    }

    $scope.releaseReplayDevices = function() {
      var devices = $scope.replayJoinedDevices.splice(0, $scope.replayJoinedDevices.length)
      devices.forEach(function(device) {
        GroupService.kick(device, true, 'bulk_task_release').catch(function() {})
      })
    }

    $scope.startReplay = function() {
      var targetDevices = BulkRunnerService.getTargets($scope.tracker, $scope.batchSelection)
      var targets = targetDevices.map(function(d) { return d.serial })
      if (!$scope.selectedRecordingId || !targets.length) {
        return
      }
      // Occupy selected devices during replay.
      $q.all(targetDevices.map(function(device) {
        return GroupService.invite(device)
      }))
        .then(function(joinedDevices) {
          $scope.replayJoinedDevices = joinedDevices || []
          return $http.post('/api/v1/automation/replay/runs', {
            recordingId: $scope.selectedRecordingId
          , targets: targets
          })
        })
        .then(function(res) {
          var run = res && res.data && res.data.run
          if (run && run.id) {
            $scope.activeReplayRunIds[run.id] = true
          }
          $scope.startReplayPolling()
          $scope.loadReplayRuns()
        })
        .catch(function() {
          $scope.releaseReplayDevices()
        })
    }

    $scope.downloadReplayCsv = function(run) {
      window.open('/api/v1/automation/replay/runs/' + run.id + '/csv')
    }

    $scope.replayRecordingOnBatch = function(item) {
      if (!item || !item.id) {
        return
      }
      $scope.selectedRecordingId = item.id
      $scope.startReplay()
    }

    $scope.$on('$destroy', function() {
      $scope.stopReplayPolling()
      $scope.releaseReplayDevices()
    })

    $scope.loadRecordings()
  })

