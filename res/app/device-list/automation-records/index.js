require('./automation-records.css')

module.exports = angular.module('device-list.automation-records', [])
  .directive('deviceListAutomationRecords', function() {
    return {
      restrict: 'E'
    , template: require('./automation-records.pug')
    , controller: 'DeviceListAutomationRecordsCtrl'
    }
  })
  .controller('DeviceListAutomationRecordsCtrl', function($scope, $http) {
    $scope.recordQuery = ''
    $scope.mergedRecords = []
    $scope.displayRows = []
    $scope.recordsLoading = true
    $scope.recordsPage = 1
    $scope.recordsPageSize = 30
    $scope.totalFiltered = 0
    $scope.totalPages = 1

    function statusLabel(s) {
      if (s === 'finished') {
        return '已完成'
      }
      if (s === 'running') {
        return '执行中'
      }
      if (s === 'failed') {
        return '失败'
      }
      return s || ''
    }

    function buildMerged(monkeyRuns, replayRuns, explorerRuns) {
      var rows = []
      ;(monkeyRuns || []).forEach(function(run) {
        var done = Number(run.progressDone || 0)
        var total = Number(run.totalDevices || 0)
        var displayStatus = run.status
        if (displayStatus === 'running' && total > 0 && done >= total) {
          displayStatus = (Number(run.failDevices || 0) > 0) ? 'failed' : 'finished'
        }
        rows.push({
          kind: 'monkey'
        , kindLabel: 'Monkey'
        , _track: 'm:' + run.id
        , id: run.id
        , title: run.packageName || ''
        , params: run.argsText || ''
        , owner: run.createdByName || run.createdByEmail || ''
        , statusText: statusLabel(displayStatus)
        , progressText: (run.progressDone || 0) + ' / ' + (run.totalDevices || 0)
        , successCount: Number(run.successDevices || 0)
        , failCount: Number(run.failDevices || 0)
        , passRate: Number(run.passRate || 0)
        , started: run.startedAt || run.createdAt || ''
        , ended: run.endedAt || ''
        , downloadUrl: '/api/v1/automation/monkey/runs/' + run.id + '/test-report'
        })
      })
      ;(replayRuns || []).forEach(function(run) {
        rows.push({
          kind: 'replay'
        , kindLabel: '回放'
        , _track: 'r:' + run.id
        , id: run.id
        , title: run.recordingName || ''
        , params: ''
        , owner: run.createdByName || run.createdByEmail || ''
        , statusText: statusLabel(run.status)
        , progressText: (run.progressDone || 0) + ' / ' + (run.totalDevices || 0)
        , successCount: Number(run.successDevices || 0)
        , failCount: Number(run.failDevices || 0)
        , passRate: Number(run.passRate || 0)
        , started: run.startedAt || run.createdAt || ''
        , ended: run.endedAt || ''
        , downloadUrl: '/api/v1/automation/replay/runs/' + run.id + '/test-report'
        })
      })
      ;(explorerRuns || []).forEach(function(run) {
        var totalSteps = Number(run.totalSteps || 0)
        var totalIssues = Number(run.totalIssues || 0)
        var successSteps = Math.max(0, totalSteps - totalIssues)
        var passRate = totalSteps > 0 ? Math.round((successSteps / totalSteps) * 10000) / 100 : 0
        rows.push({
          kind: 'explorer'
        , kindLabel: '探索测试'
        , _track: 'e:' + run.id
        , id: run.id
        , title: run.packageName || ''
        , params: '步数:' + totalSteps + ' 页面:' + (run.totalPages || 0)
        , owner: run.createdByName || run.createdByEmail || ''
        , statusText: statusLabel(run.status)
        , progressText: (run.targets ? run.targets.length : 1) + ' / ' + (run.targets ? run.targets.length : 1)
        , successCount: successSteps
        , failCount: totalIssues
        , passRate: passRate
        , started: run.startedAt || run.createdAt || ''
        , ended: run.endedAt || ''
        , downloadUrl: '/api/v1/automation/explorer/runs/' + run.id + '/test-report'
        })
      })
      rows.sort(function(a, b) {
        var ta = new Date(a.started).getTime()
        var tb = new Date(b.started).getTime()
        return tb - ta
      })
      $scope.mergedRecords = rows
    }

    function recomputePaged() {
      var filtered = ($scope.mergedRecords || []).filter(function(row) {
        return $scope.recordMatch(row)
      })
      $scope.totalFiltered = filtered.length
      $scope.totalPages = Math.max(1, Math.ceil(filtered.length / $scope.recordsPageSize))
      if ($scope.recordsPage > $scope.totalPages) {
        $scope.recordsPage = $scope.totalPages
      }
      if ($scope.recordsPage < 1) {
        $scope.recordsPage = 1
      }
      var start = ($scope.recordsPage - 1) * $scope.recordsPageSize
      $scope.displayRows = filtered.slice(start, start + $scope.recordsPageSize)
    }

    $scope.prevRecordsPage = function() {
      if ($scope.recordsPage <= 1) return
      $scope.recordsPage -= 1
      recomputePaged()
    }

    $scope.nextRecordsPage = function() {
      if ($scope.recordsPage >= $scope.totalPages) return
      $scope.recordsPage += 1
      recomputePaged()
    }

    $scope.recordMatch = function(row) {
      var q = ($scope.recordQuery || '').trim().toLowerCase()
      if (!q) {
        return true
      }
      var blob = [
        row.kindLabel
      , row.id
      , row.title
      , row.params
      , row.owner
      , row.statusText
      ].join(' ').toLowerCase()
      return blob.indexOf(q) !== -1
    }

    $scope.$watch('recordQuery', function() {
      $scope.recordsPage = 1
      recomputePaged()
    })

    $scope.$watchCollection('mergedRecords', function() {
      recomputePaged()
    })

    $scope.loadAll = function() {
      $scope.recordsLoading = true
      return $http.get('/api/v1/automation/monkey/runs', {params: {page: 1, pageSize: 500}})
        .then(function(mRes) {
          return $http.get('/api/v1/automation/replay/runs').then(function(rRes) {
            return $http.get('/api/v1/automation/explorer/runs', {params: {page: 1, pageSize: 500}}).then(function(eRes) {
              buildMerged(mRes.data.runs || [], rRes.data.runs || [], eRes.data.runs || [])
            })
          })
        })
        .finally(function() {
          $scope.recordsLoading = false
          recomputePaged()
        })
    }

    $scope.loadAll()
  })
