/**
* Copyright © 2019 contains code contributed by Orange SA, authors: Denis Barbaron - Licensed under the Apache license 2.0
**/

var QueryParser = require('./util/query-parser')

module.exports = function DeviceListCtrl(
  $scope
, DeviceService
, DeviceColumnService
, GroupService
, ControlService
, SettingsService
, $location
) {
  $scope.tracker = DeviceService.trackAll($scope)
  $scope.control = ControlService.create($scope.tracker.devices, '*ALL')

  $scope.columnDefinitions = DeviceColumnService

  var defaultColumns = [
    {
      name: 'state'
    , selected: true
    }
  , {
      name: 'model'
    , selected: true
    }
  , {
      name: 'name'
    , selected: true
    }
  , {
      name: 'serial'
    , selected: false
    }
  , {
      name: 'operator'
    , selected: true
    }
  , {
      name: 'releasedAt'
    , selected: true
    }
  , {
      name: 'version'
    , selected: true
    }
  , {
      name: 'network'
    , selected: false
    }
  , {
      name: 'display'
    , selected: false
    }
  , {
      name: 'manufacturer'
    , selected: false
    }
  , {
      name: 'marketName'
    , selected: false
    }
  , {
      name: 'sdk'
    , selected: false
    }
  , {
      name: 'abi'
    , selected: false
    }
  , {
      name: 'cpuPlatform'
    , selected: false
    }
  , {
      name: 'openGLESVersion'
    , selected: false
    }
  , {
      name: 'browser'
    , selected: false
    }
  , {
      name: 'phone'
    , selected: false
    }
  , {
      name: 'imei'
    , selected: false
    }
  , {
      name: 'imsi'
    , selected: false
    }
  , {
      name: 'iccid'
    , selected: false
    }
  , {
      name: 'batteryHealth'
    , selected: false
    }
  , {
      name: 'batterySource'
    , selected: false
    }
  , {
      name: 'batteryStatus'
    , selected: false
    }
  , {
      name: 'batteryLevel'
    , selected: false
    }
  , {
      name: 'batteryTemp'
    , selected: false
    }
  , {
      name: 'provider'
    , selected: true
    }
  , {
      name: 'notes'
    , selected: true
    }
  , {
      name: 'owner'
    , selected: true
    }
  , {
      name: 'responsible'
    , selected: true
    }
  , {
      name: 'group'
    , selected: false
    }
  , {
      name: 'groupSchedule'
    , selected: false
    }
  , {
      name: 'groupStartTime'
    , selected: false
    }
  , {
      name: 'groupEndTime'
    , selected: false
    }
  , {
      name: 'groupRepetitions'
    , selected: false
    }
  , {
      name: 'groupOwner'
    , selected: false
    }
  , {
      name: 'groupOrigin'
    , selected: false
    }
  ]

  $scope.columns = defaultColumns

  SettingsService.bind($scope, {
    target: 'columns'
  , source: 'deviceListColumns'
  })

  var defaultSort = {
    fixed: [
      {
        name: 'state'
        , order: 'asc'
      }
    ]
    , user: [
      {
        name: 'name'
        , order: 'asc'
      }
    ]
  }

  $scope.sort = defaultSort

  SettingsService.bind($scope, {
    target: 'sort'
  , source: 'deviceListSort'
  })

  $scope.filter = []

  $scope.automationRecordsView = $location.path() === '/devices/automation'

  $scope.activeTabs = {
    icons: true
  , details: false
  , bulkClearCache: false
  , bulkInstall: false
  , bulkUninstall: false
  , bulkPush: false
  , bulkReboot: false
  , bulkShell: false
  , bulkMonkey: false
  , bulkReplay: false
  }

  $scope.batchSelection = {
    mode: 'all'
  , selected: {}
  }

  $scope.getBatchDevicesForUi = function() {
    return ($scope.tracker.devices || []).filter(function(device) {
      return device && device.present && device.ready
    })
  }

  $scope.isBatchSelectableDevice = function(device) {
    if (!device) {
      return false
    }
    return device.state === 'available' && device.usable && !device.using
  }

  $scope.batchDeviceNameText = function(device) {
    if (!device) {
      return ''
    }
    return device.name || device.marketName || device.serial || ''
  }

  $scope.batchDeviceModelText = function(device) {
    if (!device) {
      return ''
    }
    return device.model || device.serial || ''
  }

  $scope.batchDeviceStatusText = function(device) {
    if (!device) {
      return ''
    }
    return $scope.isBatchSelectableDevice(device) ? '可用' : '被占用'
  }

  $scope.toggleAllBatchCandidates = function(flag) {
    $scope.getBatchDevicesForUi().forEach(function(device) {
      if ($scope.isBatchSelectableDevice(device)) {
        $scope.batchSelection.selected[device.serial] = !!flag
      }
    })
  }

  var bulkTabKeys = [
    'bulkClearCache'
  , 'bulkInstall'
  , 'bulkUninstall'
  , 'bulkPush'
  , 'bulkReboot'
  , 'bulkShell'
  , 'bulkMonkey'
  , 'bulkReplay'
  ]

  $scope.activateBulkTab = function(name) {
    var wasActive = $scope.activeTabs[name]
    bulkTabKeys.forEach(function(k) {
      $scope.activeTabs[k] = false
    })
    if (!wasActive) {
      $scope.activeTabs[name] = true
    }
  }

  $scope.activateMainTab = function(name) {
    $scope.activeTabs.icons = (name === 'icons')
    $scope.activeTabs.details = (name === 'details')
  }

  SettingsService.bind($scope, {
    target: 'activeTabs'
  , source: 'deviceListActiveTabs'
  })

  if ($scope.activeTabs.hasOwnProperty('automationRecords')) {
    delete $scope.activeTabs.automationRecords
  }

  $scope.$on('$routeChangeSuccess', function() {
    $scope.automationRecordsView = $location.path() === '/devices/automation'
  })

  $scope.toggle = function(device) {
    if (device.using) {
      $scope.kick(device)
    } else {
      $location.path('/control/' + device.serial)
    }
  }

  $scope.invite = function(device) {
    return GroupService.invite(device).then(function() {
      $scope.$digest()
    })
  }

  $scope.applyFilter = function(query) {
    $scope.filter = QueryParser.parse(query)
  }

  $scope.search = {
    deviceFilter: '',
    focusElement: false
  }

  $scope.focusSearch = function() {
    if (!$scope.basicMode) {
      $scope.search.focusElement = true
    }
  }

  $scope.reset = function() {
    $scope.search.deviceFilter = ''
    $scope.filter = []
    $scope.sort = defaultSort
    $scope.columns = defaultColumns
  }
}
