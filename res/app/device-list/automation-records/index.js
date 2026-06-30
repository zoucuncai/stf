require('./automation-records.css')

module.exports = angular.module('device-list.automation-records', [
  require('../../components/stf/user').name
])
  .directive('deviceListAutomationRecords', function() {
    return {
      restrict: 'E'
    , template: require('./automation-records.pug')
    , controller: 'DeviceListAutomationRecordsCtrl'
    }
  })
  .controller('DeviceListAutomationRecordsCtrl', function($scope, $http, $q, UserService) {
    $scope.recordQuery = ''
    $scope.mergedRecords = []
    $scope.displayRows = []
    $scope.recordsLoading = false
    $scope.recordsPage = 1
    $scope.recordsPageSize = 30
    $scope.totalFiltered = 0
    $scope.totalPages = 1
    $scope.onlyMine = true
    $scope.recent7Days = true

    // 服务端分页状态：已加载到第几页
    var loadedServerPage = 1
    var serverTotals = { monkey: 0, replay: 0, explorer: 0 }

    function createdByParam() {
      return $scope.onlyMine && UserService.currentUser ? UserService.currentUser.email : null
    }

    function dateParams() {
      if (!$scope.recent7Days) {
        return {}
      }
      var end = new Date()
      var start = new Date(end.getTime() - 7 * 24 * 60 * 60 * 1000)
      return {
        startDate: start.toISOString()
      , endDate: end.toISOString()
      }
    }

    function pageParams(pageNum) {
      var ps = $scope.recordsPageSize
      var cb = createdByParam()
      var dates = dateParams()
      var params = {page: pageNum, pageSize: ps}
      if (cb) {
        params.createdBy = cb
      }
      if (dates.startDate) {
        params.startDate = dates.startDate
        params.endDate = dates.endDate
      }
      return params
    }

    // UTC ISO 字符串 → 本地时区可读格式
    function formatDateTime(isoStr) {
      if (!isoStr) return ''
      var d = new Date(isoStr)
      if (isNaN(d.getTime())) return isoStr
      var pad = function(n) { return n < 10 ? '0' + n : String(n) }
      return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
             ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds())
    }

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

    // 将三种运行记录转成统一格式并写入 rows 数组
    function buildRowsFromData(rows, monkeyRuns, replayRuns, explorerRuns) {
      ;(monkeyRuns || []).forEach(function(run) {
        var done = Number(run.progressDone || 0)
        var total = Number(run.totalDevices || 0)
        var displayStatus = run.status
        if (displayStatus === 'running' && total > 0 && done >= total) {
          displayStatus = (Number(run.failDevices || 0) > 0) ? 'failed' : 'finished'
        }
        var raw = run.startedAt || run.createdAt || ''
        rows.push({
          kind: 'monkey'
        , kindLabel: 'Monkey'
        , _track: 'm:' + run.id
        , _rawStarted: raw
        , id: run.id
        , title: run.packageName || ''
        , params: run.argsText || ''
        , owner: run.createdByName || run.createdByEmail || ''
        , statusText: statusLabel(displayStatus)
        , progressText: (run.progressDone || 0) + ' / ' + (run.totalDevices || 0)
        , successCount: Number(run.successDevices || 0)
        , failCount: Number(run.failDevices || 0)
        , passRate: Number(run.passRate || 0)
        , started: formatDateTime(raw)
        , ended: formatDateTime(run.endedAt || '')
        , downloadUrl: '/api/v1/automation/monkey/runs/' + run.id + '/test-report'
        })
      })
      ;(replayRuns || []).forEach(function(run) {
        var raw = run.startedAt || run.createdAt || ''
        rows.push({
          kind: 'replay'
        , kindLabel: '回放'
        , _track: 'r:' + run.id
        , _rawStarted: raw
        , id: run.id
        , title: run.recordingName || ''
        , params: ''
        , owner: run.createdByName || run.createdByEmail || ''
        , statusText: statusLabel(run.status)
        , progressText: (run.progressDone || 0) + ' / ' + (run.totalDevices || 0)
        , successCount: Number(run.successDevices || 0)
        , failCount: Number(run.failDevices || 0)
        , passRate: Number(run.passRate || 0)
        , started: formatDateTime(raw)
        , ended: formatDateTime(run.endedAt || '')
        , downloadUrl: '/api/v1/automation/replay/runs/' + run.id + '/test-report'
        })
      })
      ;(explorerRuns || []).forEach(function(run) {
        var totalSteps = Number(run.totalSteps || 0)
        var totalIssues = Number(run.totalIssues || 0)
        var successSteps = Math.max(0, totalSteps - totalIssues)
        var passRate = totalSteps > 0 ? Math.round((successSteps / totalSteps) * 10000) / 100 : 0
        var raw = run.startedAt || run.createdAt || ''
        rows.push({
          kind: 'explorer'
        , kindLabel: '探索测试'
        , _track: 'e:' + run.id
        , _rawStarted: raw
        , id: run.id
        , title: run.packageName || ''
        , params: '步数:' + totalSteps + ' 页面:' + (run.totalPages || 0)
        , owner: run.createdByName || run.createdByEmail || ''
        , statusText: statusLabel(run.status)
        , progressText: (run.targets ? run.targets.length : 1) + ' / ' + (run.targets ? run.targets.length : 1)
        , successCount: successSteps
        , failCount: totalIssues
        , passRate: passRate
        , started: formatDateTime(raw)
        , ended: formatDateTime(run.endedAt || '')
        , downloadUrl: '/api/v1/automation/explorer/runs/' + run.id + '/test-report'
        })
      })
    }

    function buildMerged(monkeyRuns, replayRuns, explorerRuns) {
      var rows = []
      buildRowsFromData(rows, monkeyRuns, replayRuns, explorerRuns)
      rows.sort(function(a, b) {
        return new Date(b._rawStarted).getTime() - new Date(a._rawStarted).getTime()
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

    // 判断服务端是否还有更多数据未加载
    function canLoadMoreFromServer() {
      var loaded = loadedServerPage * $scope.recordsPageSize
      return loaded < serverTotals.monkey ||
             loaded < serverTotals.replay ||
             loaded < serverTotals.explorer
    }

    // 加载指定服务端页并追加到 mergedRecords
    function loadServerPage(pageNum) {
      $scope.recordsLoading = true
      var params = pageParams(pageNum)
      return $q.all([
        $http.get('/api/v1/automation/monkey/runs', {params: params})
      , $http.get('/api/v1/automation/replay/runs', {params: params})
      , $http.get('/api/v1/automation/explorer/runs', {params: params})
      ])
        .then(function(results) {
          serverTotals.monkey  = results[0].data.total || 0
          serverTotals.replay  = results[1].data.total || 0
          serverTotals.explorer = results[2].data.total || 0
          // 新记录追加到已加载列表并重新排序
          var newRows = []
          buildRowsFromData(newRows, results[0].data.runs || [], results[1].data.runs || [], results[2].data.runs || [])
          var allRows = $scope.mergedRecords.concat(newRows)
          allRows.sort(function(a, b) {
            return new Date(b._rawStarted).getTime() - new Date(a._rawStarted).getTime()
          })
          $scope.mergedRecords = allRows
        })
        .finally(function() {
          $scope.recordsLoading = false
          recomputePaged()
        })
    }

    $scope.nextRecordsPage = function() {
      var nextPage = $scope.recordsPage + 1
      var neededRecords = nextPage * $scope.recordsPageSize
      // 如果本地数据不够且服务端还有更多，先拉取下一服务端页
      if (neededRecords > $scope.mergedRecords.length && canLoadMoreFromServer()) {
        loadedServerPage += 1
        loadServerPage(loadedServerPage).then(function() {
          $scope.recordsPage = nextPage
          recomputePaged()
        })
        return
      }
      if ($scope.recordsPage >= $scope.totalPages) return
      $scope.recordsPage = nextPage
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

    $scope.toggleOnlyMine = function() {
      $scope.recordsPage = 1
      $scope.mergedRecords = []
      $scope.loadAll()
    }

    $scope.toggleRecent7Days = function() {
      $scope.recordsPage = 1
      $scope.mergedRecords = []
      $scope.loadAll()
    }

    $scope.loadAll = function() {
      $scope.recordsLoading = true
      loadedServerPage = 1
      var params = pageParams(1)
      return $q.all([
        $http.get('/api/v1/automation/monkey/runs', {params: params})
      , $http.get('/api/v1/automation/replay/runs', {params: params})
      , $http.get('/api/v1/automation/explorer/runs', {params: params})
      ])
        .then(function(results) {
          serverTotals.monkey   = results[0].data.total || 0
          serverTotals.replay   = results[1].data.total || 0
          serverTotals.explorer = results[2].data.total || 0
          buildMerged(
            results[0].data.runs || []
          , results[1].data.runs || []
          , results[2].data.runs || []
          )
        })
        .finally(function() {
          $scope.recordsLoading = false
          recomputePaged()
        })
    }

    $scope.loadAll()
  })
