require('./bulk-explorer.css')

module.exports = angular.module('device-list.bulk-explorer', [
  require('../bulk-common').name
])
  .directive('deviceListBulkExplorer', function() {
    return {
      restrict: 'E'
    , template: require('./bulk-explorer.pug')
    , controller: 'DeviceListBulkExplorerCtrl'
    }
  })
  .controller('DeviceListBulkExplorerCtrl', function($scope, $http, $interval, BulkRunnerService, AppState) {
    $scope.explorerPackage = ''
    $scope.explorerAccount = ''
    $scope.explorerPassword = ''
    $scope.explorerPreStepsJson = ''
    $scope.explorerMaxSteps = 80
    $scope.explorerMaxMinutes = 8
    $scope.explorerMaxTriesPerDoor = 1
    $scope.explorerIncludeRisky = false
    $scope.explorerSkipLaunch = false

    $scope.explorerRunning = false
    $scope.explorerRuns = []
    $scope.explorerRunningRuns = []
    $scope.explorerDevices = []
    $scope.explorerCurrentRun = null
    $scope.explorerError = ''
    var pollingTimer = null
    var userEmail = (AppState.user && AppState.user.email) || ''

    $scope.loadExplorerRuns = function() {
      var params = {page: 1, pageSize: 50, source: 'bulk'}
      if (userEmail) { params.createdBy = userEmail }
      return $http.get('/api/v1/automation/explorer/runs', {params: params})
        .then(function(res) {
          $scope.explorerRuns = res.data.runs || []
          var running = $scope.explorerRuns.filter(function(r) { return r.status === 'running' })
          $scope.explorerRunningRuns = running
          if (running.length) {
            $scope.explorerCurrentRun = running[0]
            $scope.explorerRunning = true
            startPolling()
            // Fetch device-level details for real-time progress
            $http.get('/api/v1/automation/explorer/runs/' + running[0].id + '/report')
              .then(function(rpt) {
                $scope.explorerDevices = rpt.data.devices || []
              })
              .catch(function() { $scope.explorerDevices = [] })
          }
          else {
            $scope.explorerCurrentRun = null
            $scope.explorerRunningRuns = []
            $scope.explorerDevices = []
            $scope.explorerRunning = false
            stopPolling()
          }
        })
    }

    function startPolling() {
      if (pollingTimer) {
        return
      }
      pollingTimer = $interval(function() {
        $scope.loadExplorerRuns()
      }, 2000)
    }

    function stopPolling() {
      if (pollingTimer) {
        $interval.cancel(pollingTimer)
        pollingTimer = null
      }
    }

    $scope.startExplorerRun = function() {
      var pkg = String($scope.explorerPackage || '').trim()
      if (!pkg || $scope.explorerRunning) {
        return
      }
      var targets = BulkRunnerService.getTargets($scope.tracker, $scope.batchSelection)
        .map(function(d) { return d.serial })
      if (!targets.length) {
        $scope.explorerError = '请先选择设备'
        return
      }

      $scope.explorerRunning = true
      $scope.explorerError = ''

      var payload = {
        packageName: pkg
      , targets: targets
      , maxSteps: Number($scope.explorerMaxSteps || 80)
      , maxMinutes: Number($scope.explorerMaxMinutes || 8)
      , maxTriesPerDoor: Number($scope.explorerMaxTriesPerDoor || 1)
      , includeRisky: !!$scope.explorerIncludeRisky
      , skipLaunch: !!$scope.explorerSkipLaunch
      , source: 'bulk'
      }
      var acct = String($scope.explorerAccount || '').trim()
      var pwd = String($scope.explorerPassword || '').trim()
      if (acct || pwd) {
        payload.credentials = { account: acct, password: pwd }
      }
      // Parse preSteps JSON
      var preStepsRaw = String($scope.explorerPreStepsJson || '').trim()
      if (preStepsRaw) {
        try {
          var parsed = JSON.parse(preStepsRaw)
          if (Array.isArray(parsed)) {
            payload.preSteps = parsed
          }
        }
        catch (e) {
          $scope.explorerError = '预置步骤 JSON 格式错误: ' + e.message
          return
        }
      }

      $http.post('/api/v1/automation/explorer/runs', payload)
        .then(function() {
          startPolling()
          $scope.loadExplorerRuns()
        })
        .catch(function(err) {
          $scope.explorerRunning = false
          var msg = (err && err.data && err.data.description) || (err && err.statusText) || '创建失败'
          $scope.explorerError = String(msg)
        })
    }

    $scope.stopExplorerRun = function() {
      if (!$scope.explorerCurrentRun || !$scope.explorerCurrentRun.id) {
        $scope.explorerRunning = false
        stopPolling()
        return
      }
      $http.post('/api/v1/automation/explorer/runs/' + $scope.explorerCurrentRun.id + '/stop')
        .then(function() {
          $scope.explorerRunning = false
          stopPolling()
          $scope.loadExplorerRuns()
        })
        .catch(function() {
          $scope.explorerRunning = false
          stopPolling()
        })
    }

    $scope.downloadExplorerReport = function(run) {
      window.open('/api/v1/automation/explorer/runs/' + run.id + '/test-report')
    }

    $scope.convertToRecording = function(run) {
      if (!run || !run.id) {
        return
      }
      // Pick first device (or the one with most issues)
      var targets = run.targets || []
      var serial = targets[0] || ''
      if (!serial) {
        $scope.explorerError = '无法确定目标设备'
        return
      }
      $http.post('/api/v1/automation/explorer/runs/' + run.id + '/convert-recording', {
        serial: serial
      , name: '探索转录制 - ' + run.packageName + ' - ' + serial
      })
        .then(function(res) {
          var rec = res.data.recording || {}
          window.alert('已成功转为录制\nID: ' + (rec.id || '') + '\n名称: ' + (rec.name || '') + '\n\n可在“批量回放”中重放此路径。')
        })
        .catch(function(err) {
          var msg = (err && err.data && err.data.description) || '转录制失败'
          $scope.explorerError = String(msg)
        })
    }

    // Initial load
    $scope.loadExplorerRuns()

    $scope.$on('$destroy', function() {
      stopPolling()
    })
  })
