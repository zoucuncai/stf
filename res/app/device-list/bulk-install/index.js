require('./bulk-install.css')
require('ng-file-upload')

module.exports = angular.module('device-list.bulk-install', [
  'ngFileUpload'
, require('../bulk-common').name
])
  .directive('deviceListBulkInstall', function() {
    return {
      restrict: 'E'
    , template: require('./bulk-install.pug')
    , controller: 'DeviceListBulkInstallCtrl'
    }
  })
  .controller('DeviceListBulkInstallCtrl', function($scope, $http, StorageService, BulkRunnerService, $timeout) {
    $scope.bulkInstallFiles = []
    $scope.bulkInstallResults = []
    $scope.bulkInstallRunning = false
    $scope.bulkInstallProgress = {done: 0, total: 0}
    $scope.bulkInstallUploadProgress = 0
    $scope.bulkInstallInstallPct = null

    $scope.onBulkInstallFiles = function($files) {
      $timeout(function() {
        $scope.bulkInstallFiles = ($files && $files.length) ? Array.prototype.slice.call($files) : []
      })
    }

    $scope.runBulkInstall = function() {
      if (!$scope.bulkInstallFiles.length || $scope.bulkInstallRunning) {
        return
      }
      $scope.bulkInstallRunning = true
      $scope.bulkInstallResults = []
      $scope.bulkInstallUploadProgress = 0
      $scope.bulkInstallInstallPct = null
      StorageService.storeFile('apk', $scope.bulkInstallFiles, {
        filter: function(file) {
          return /\.(apk|aab)$/i.test(file.name)
        }
      })
        .progressed(function(e) {
          if (e.lengthComputable) {
            $scope.bulkInstallUploadProgress = Math.floor((e.loaded / e.total) * 100)
          }
        })
        .then(function(res) {
          var fileRes = StorageService.getFileResourceFromResponse(res)
          if (!fileRes || !fileRes.href) {
            throw new Error('上传响应无效，缺少文件地址')
          }
          var href = fileRes.href
          return $http.get(href + '/manifest').then(function(manifestRes) {
            if (!manifestRes.data.success) {
              throw new Error('无法读取安装包manifest')
            }
            var manifest = manifestRes.data.manifest
            return BulkRunnerService.run($scope.tracker, $scope.batchSelection, function(control) {
              var p = control.install({
                href: href
              , manifest: manifest
              , launch: false
              , persist_after_session: true
              })
              if (p && typeof p.progressed === 'function') {
                p.progressed(function(result) {
                  $timeout(function() {
                    if (result && typeof result.progress === 'number') {
                      $scope.bulkInstallInstallPct = Math.floor(result.progress)
                    }
                  })
                })
              }
              return p
            }, function(update) {
              if (update && update.progress) {
                $scope.bulkInstallProgress = update.progress
              }
              if (update && update.status === 'running') {
                $scope.bulkInstallInstallPct = null
              }
            }, {releaseReason: 'bulk_task_release'})
          })
        })
        .then(function(results) {
          $timeout(function() {
            $scope.bulkInstallInstallPct = 100
            $scope.bulkInstallResults = results
          })
        })
        .finally(function() {
          $scope.bulkInstallRunning = false
        })
    }
  })

