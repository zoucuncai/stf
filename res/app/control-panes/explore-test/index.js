require('./explore-test.css')

module.exports = angular.module('stf.explore-test', [])
  .run(['$templateCache', function($templateCache) {
    $templateCache.put(
      'control-panes/explore-test/explore-test.pug'
    , require('./explore-test.pug')
    )
  }])
  .controller('ExploreTestCtrl', function($scope, $http, $interval) {
    $scope.etPackage = ''
    $scope.etMaxSteps = null
    $scope.etMaxMinutes = null
    $scope.etMaxTriesPerDoor = null
    $scope.etIncludeRisky = false

    $scope.etRunning = false
    $scope.etRunId = ''
    $scope.etStatus = ''
    $scope.etSteps = 0
    $scope.etPages = 0
    $scope.etLogs = []
    $scope.etErrors = []
    $scope.etIssues = 0

    // Task 5: Continue from last memory
    $scope.etHasMemory = false
    $scope.etMemoryInfo = ''
    $scope.etLastMemory = null

    var pollTimer = null

    function getSerial() {
      if ($scope.device && $scope.device.serial) {
        return $scope.device.serial
      }
      // fallback: try parent scope
      var s = $scope.$parent && $scope.$parent.device && $scope.$parent.device.serial
      return s || ''
    }

    function startPolling() {
      stopPolling()
      pollTimer = $interval(function() {
        if (!$scope.etRunId) { return }
        $http.get('/api/v1/automation/explorer/runs/' + $scope.etRunId + '/progress')
          .then(function(res) {
            var d = res.data || {}
            $scope.etStatus = d.status || $scope.etStatus
            $scope.etSteps = Number(d.totalSteps || 0)
            $scope.etPages = Number(d.totalPages || 0)
            $scope.etIssues = Number(d.totalIssues || 0)
            if (d.logs && d.logs.length) {
              $scope.etLogs = d.logs.slice(-50)
            }
            if (d.errors && d.errors.length) {
              $scope.etErrors = d.errors
            }
            if (d.status === 'finished' || d.status === 'stopped' || d.status === 'failed') {
              $scope.etRunning = false
              stopPolling()
            }
          })
          .catch(function() {
            // API error - try to get run status directly
            $http.get('/api/v1/automation/explorer/runs')
              .then(function(listRes) {
                var runs = (listRes.data && listRes.data.runs) || []
                var found = runs.filter(function(r) { return r.id === $scope.etRunId })[0]
                if (found && (found.status === 'finished' || found.status === 'stopped' || found.status === 'failed')) {
                  $scope.etRunning = false
                  $scope.etStatus = found.status === 'stopped' ? '已停止' : (found.status === 'finished' ? '已完成' : '失败')
                  stopPolling()
                }
              })
          })
      }, 2000)
    }

    function stopPolling() {
      if (pollTimer) {
        $interval.cancel(pollTimer)
        pollTimer = null
      }
    }

    $scope.startExploreTest = function(continueFromLast) {
      var serial = getSerial()
      if (!serial) {
        alert('未获取到设备序列号')
        return
      }
      var pkg = ($scope.etPackage || '').trim()
      if (!pkg) {
        alert('请输入包名')
        return
      }

      var body = {
        packageName: pkg
      , targets: [serial]
      , maxSteps: Number($scope.etMaxSteps || 80)
      , maxMinutes: Number($scope.etMaxMinutes || 8)
      , maxTriesPerDoor: Number($scope.etMaxTriesPerDoor || 1)
      , includeRisky: !!$scope.etIncludeRisky
      , skipLaunch: true
      , source: 'detail'
      }

      // Task 5: Pass memory if continuing
      if (continueFromLast && $scope.etLastMemory) {
        body.continueMemory = JSON.stringify($scope.etLastMemory)
      }

      $scope.etRunning = true
      $scope.etStatus = '正在创建…'
      $scope.etLogs = []

      $http.post('/api/v1/automation/explorer/runs', body)
        .then(function(res) {
          var data = res.data || {}
          $scope.etRunId = (data.run && data.run.id) || data.runId || ''
          $scope.etStatus = '执行中'
          startPolling()
        })
        .catch(function(err) {
          $scope.etRunning = false
          $scope.etStatus = '创建失败'
          alert('创建探索任务失败: ' + (err.data && err.data.description || err.statusText))
        })
    }

    $scope.stopExploreTest = function() {
      if (!$scope.etRunId) { return }
      $http.post('/api/v1/automation/explorer/runs/' + $scope.etRunId + '/stop')
        .then(function() {
          $scope.etStatus = '正在停止…'
        })
        .catch(function() {
          // If stop API fails, force end on frontend
          $scope.etRunning = false
          $scope.etStatus = '停止失败'
          stopPolling()
        })
    }

    // Task 5: Check for last memory when package name changes
    $scope.checkLastMemory = function() {
      var serial = getSerial()
      var pkg = ($scope.etPackage || '').trim()
      if (!serial || !pkg) {
        $scope.etHasMemory = false
        return
      }
      $http.get('/api/v1/automation/explorer/memory?packageName=' + encodeURIComponent(pkg) + '&serial=' + encodeURIComponent(serial))
        .then(function(res) {
          var d = res.data || {}
          if (d.hasMemory && d.memory) {
            $scope.etHasMemory = true
            $scope.etLastMemory = d.memory
            $scope.etMemoryInfo = '上次探索: ' + (d.pagesCount || 0) + '页面, ' + (d.totalSteps || 0) + '步'
          } else {
            $scope.etHasMemory = false
            $scope.etLastMemory = null
          }
        })
        .catch(function() {
          $scope.etHasMemory = false
        })
    }

    // Auto-check memory when package name changes
    var debounceTimer = null
    $scope.$watch('etPackage', function(newVal) {
      if (debounceTimer) { clearTimeout(debounceTimer) }
      if (newVal && newVal.trim()) {
        debounceTimer = setTimeout(function() {
          $scope.checkLastMemory()
          $scope.$apply()
        }, 800)
      } else {
        $scope.etHasMemory = false
      }
    })

    $scope.$on('$destroy', function() {
      stopPolling()
      if (debounceTimer) { clearTimeout(debounceTimer) }
    })
  })
