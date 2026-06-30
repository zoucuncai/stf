module.exports = function DashboardCtrl($scope, DeviceService, $interval) {
  $scope.tracker = DeviceService.trackAll($scope)

  // 状态过滤
  $scope.stateFilter = 'all'

  $scope.setFilter = function(state) {
    $scope.stateFilter = state
  }

  $scope.isVisible = function(device) {
    if ($scope.stateFilter === 'all') {
      return true
    }
    if ($scope.stateFilter === 'offline') {
      return device.state === 'offline' || device.state === 'absent'
    }
    if ($scope.stateFilter === 'available') {
      return device.state === 'available' && (!device.group || device.group.class === 'standard')
    }
    if ($scope.stateFilter === 'busy') {
      return device.group && device.group.class !== 'standard' &&
             device.state !== 'using' && device.state !== 'automation'
    }
    return device.state === $scope.stateFilter
  }

  // 统计数据
  $scope.stats = {
    total: 0, available: 0, busy: 0, using: 0, offline: 0, automation: 0
  }

  $scope.updateStats = function() {
    var devices = $scope.tracker.devices
    $scope.stats = {
      total: devices.length
    , available: devices.filter(function(d) {
        // 可用：设备在线且无预约群组
        return d.state === 'available' && (!d.group || d.group.class === 'standard')
      }).length
    , busy: devices.filter(function(d) {
        // 已预约：属于非 standard 群组（有预约），且没有人正在使用
        return d.group && d.group.class !== 'standard' &&
               d.state !== 'using' && d.state !== 'automation'
      }).length
    , using: devices.filter(function(d) { return d.state === 'using' }).length
    , offline: devices.filter(function(d) {
        return d.state === 'offline' || d.state === 'absent'
      }).length
    , automation: devices.filter(function(d) { return d.state === 'automation' }).length
    }
  }

  // 设备添加/删除时立即更新统计
  $scope.$watchCollection('tracker.devices', function() {
    $scope.updateStats()
  })

  // 每3秒刷新一次，使电量/温度等低优先级数据实时更新
  // trackAll 使用 digest:false，需要 $interval 触发 Angular digest
  var refreshTimer = $interval(function() {
    $scope.updateStats()
  }, 3000)

  $scope.$on('$destroy', function() {
    $interval.cancel(refreshTimer)
  })

  // ─── 工具函数 ───────────────────────────────────────────────

  // 电池电量百分比
  $scope.getBatteryPercent = function(device) {
    if (!device.battery || !device.battery.scale) {
      return 0
    }
    return Math.floor(device.battery.level / device.battery.scale * 100)
  }

  // 电量进度条颜色
  $scope.getBatteryBarClass = function(device) {
    var pct = $scope.getBatteryPercent(device)
    if (pct <= 20) {
      return 'progress-bar-danger'
    }
    if (pct <= 50) {
      return 'progress-bar-warning'
    }
    return 'progress-bar-success'
  }

  // 温度文字颜色
  $scope.getTempClass = function(device) {
    if (!device.battery) {
      return 'text-muted'
    }
    var temp = device.battery.temp
    if (temp >= 45) {
      return 'dashboard-danger'
    }
    if (temp >= 35) {
      return 'dashboard-warning'
    }
    return 'dashboard-normal'
  }

  // 卡片左边框颜色 class
  $scope.getCardClass = function(device) {
    var classMap = {
      available: 'device-card--available'
    , using: 'device-card--using'
    , busy: 'device-card--busy'
    , automation: 'device-card--automation'
    , offline: 'device-card--offline'
    , absent: 'device-card--offline'
    , preparing: 'device-card--preparing'
    , unauthorized: 'device-card--unauthorized'
    }
    return classMap[device.state] || 'device-card--offline'
  }

  // 设备状态中文名
  $scope.getStateName = function(device) {
    var nameMap = {
      available: '可用'
    , using: '使用中'
    , busy: '已预约'
    , automation: '自动化'
    , offline: '离线'
    , absent: '离线'
    , preparing: '准备中'
    , unauthorized: '未授权'
    , present: '已连接'
    }
    return nameMap[device.state] || device.state
  }

  // 网络信息
  $scope.getNetworkStr = function(device) {
    if (!device.network || !device.network.connected) {
      return null
    }
    var type = (device.network.type || '').toUpperCase()
    var sub = device.network.subtype ? ' (' + device.network.subtype + ')' : ''
    return type + sub
  }

  // 是否正在充电
  $scope.isCharging = function(device) {
    return device.battery && device.battery.status === 'charging'
  }

  // ── CPU / 内存 ──────────────────────────────────────────

  // CPU 进度条颜色
  $scope.getCpuBarClass = function(device) {
    if (!device.performance) {
      return 'progress-bar-default'
    }
    var pct = device.performance.cpu
    if (pct >= 80) {
      return 'progress-bar-danger'
    }
    if (pct >= 50) {
      return 'progress-bar-warning'
    }
    return 'progress-bar-success'
  }

  // 内存进度条颜色
  $scope.getMemBarClass = function(device) {
    if (!device.performance) {
      return 'progress-bar-default'
    }
    var pct = device.performance.mem
    if (pct >= 80) {
      return 'progress-bar-danger'
    }
    if (pct >= 60) {
      return 'progress-bar-warning'
    }
    return 'progress-bar-info'
  }

  // 内存已用 / 总量（MB 或 GB）
  $scope.getMemLabel = function(device) {
    if (!device.performance || !device.performance.memTotal) {
      return '--'
    }
    var usedMb  = Math.round(device.performance.memUsed  / 1024)
    var totalMb = Math.round(device.performance.memTotal / 1024)
    if (totalMb >= 1024) {
      return (usedMb / 1024).toFixed(1) + 'G / ' + (totalMb / 1024).toFixed(1) + 'G'
    }
    return usedMb + 'M / ' + totalMb + 'M'
  }
}