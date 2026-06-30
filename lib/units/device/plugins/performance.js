var syrup = require('@devicefarmer/stf-syrup')
var Promise = require('bluebird')

var lifecycle = require('../../../util/lifecycle')
var logger = require('../../../util/logger')
var wire = require('../../../wire')
var wireutil = require('../../../wire/util')

var COLLECT_INTERVAL = 15000  // 15秒采集一次
var INIT_DELAY       = 15000  // 启动延迟15秒，等设备所有插件完全就绪

// 一次 ADB 调用同时读 loadavg + meminfo + cpu核心数
// 避免多次 shell 连接抢占设备 ADB 通道
var COLLECT_CMD = [
  'cat /proc/loadavg'
, 'grep -E "^(MemTotal|MemFree):" /proc/meminfo'
, 'grep -c "^processor" /proc/cpuinfo'
].join(' && ')

module.exports = syrup.serial()
  .dependency(require('../support/adb'))
  .dependency(require('../support/push'))
  .define(function(options, adb, push) {
    var log = logger.createLogger('device:plugins:performance')

    var cpuCount = 4  // CPU 核心数，首次成功读取后更新并缓存

    function collect() {
      return adb.shell(options.serial, COLLECT_CMD)
        .timeout(8000)
        .then(adb.util.readAll)
        .then(function(buffer) {
          var lines = buffer.toString('utf8')
            .split('\n')
            .map(function(l) { return l.trim() })
            .filter(Boolean)

          // 第 1 行：loadavg，格式 "0.23 0.45 0.38 1/234 5678"
          var loadAvg1min = parseFloat(lines[0]) || 0

          // 后续行：MemTotal/MemFree（kB）和核心数
          var memTotal = 1
          var memFree  = 0

          for (var i = 1; i < lines.length; i++) {
            var m = lines[i].match(/^(\w+):\s+(\d+)/)
            if (m) {
              if (m[1] === 'MemTotal') { memTotal = parseInt(m[2], 10) || 1 }
              if (m[1] === 'MemFree')  { memFree  = parseInt(m[2], 10) || 0 }
            }
            else {
              // 纯数字行 = grep -c 输出的 CPU 核心数
              var n = parseInt(lines[i], 10)
              if (n > 0) { cpuCount = n }
            }
          }

          // CPU 使用率：loadAvg(1min) / 核心数 × 100，上限 100%
          var cpuPercent = Math.max(0, Math.min(100,
            Math.round(loadAvg1min / cpuCount * 100)
          ))

          // 内存已用 = MemTotal - MemFree，与 `free -h` 第一行 used 列一致
          var memUsed    = Math.max(0, memTotal - memFree)
          var memPercent = Math.round(memUsed / memTotal * 100)

          push.send([
            wireutil.global
          , wireutil.envelope(new wire.PerformanceEvent(
              options.serial
            , cpuPercent
            , memPercent
            , memTotal
            , memUsed
            ))
          ])
        })
        .catch(function(err) {
          log.warn('Performance collection failed: %s', err.message)
        })
    }

    // 串行调度：上次采集 Promise 完成后才安排下次，永不并发
    var timer = null

    function scheduleNext() {
      timer = setTimeout(function() {
        collect().finally(scheduleNext)
      }, COLLECT_INTERVAL)
    }

    var initTimer = setTimeout(function() {
      collect().finally(scheduleNext)
    }, INIT_DELAY)

    lifecycle.observe(function() {
      clearTimeout(initTimer)
      clearTimeout(timer)
    })

    log.info('Performance monitor started (interval=%dms)', COLLECT_INTERVAL)
  })
var syrup = require('@devicefarmer/stf-syrup')
var Promise = require('bluebird')

var lifecycle = require('../../../util/lifecycle')
var logger = require('../../../util/logger')
var wire = require('../../../wire')
var wireutil = require('../../../wire/util')

var COLLECT_INTERVAL = 15000  // 15秒采集一次（减少 ADB 频率）
var INIT_DELAY       = 15000  // 启动后延迟15秒，等设备完全就绪

// 将 loadavg + meminfo + CPU 核心数一次 ADB 调用全部读取
// 避免多次 shell 连接对设备 ADB 通道造成干扰
var COLLECT_CMD = [
  'cat /proc/loadavg'
, 'grep -E "^(MemTotal|MemFree):" /proc/meminfo'
, 'grep -c "^processor" /proc/cpuinfo'
].join(' && ')

module.exports = syrup.serial()
  .dependency(require('../support/adb'))
  .dependency(require('../support/push'))
  .define(function(options, adb, push) {
    var log = logger.createLogger('device:plugins:performance')

    // CPU 核心数缓存，第一次成功读取后不再重复读
    var cpuCount = 4

    // ── 单次 ADB 调用采集全部数据 ────────────────────────────
    function collect() {
      return adb.shell(options.serial, COLLECT_CMD)
        .timeout(8000)
        .then(adb.util.readAll)
        .then(function(buffer) {
          var lines = buffer.toString('utf8').split('\n')
            .map(function(l) { return l.trim() })
            .filter(Boolean)

          // ── 解析 loadavg（第一行）──────────────────────────
          // 格式: "0.23 0.45 0.38 1/234 5678"
          var loadAvg1min = parseFloat(lines[0]) || 0

          // ── 解析 MemTotal / MemFree ───────────────────────
          var memTotal = 1, memFree = 0
          for (var i = 1; i < lines.length; i++) {
            var m = lines[i].match(/^(\w+):\s+(\d+)/)
            if (!m) {
              // 最后一行是 CPU 核心数
              var n = parseInt(lines[i], 10)
              if (n > 0) {
                cpuCount = n
              }
              continue
            }
            if (m[1] === 'MemTotal') { memTotal = parseInt(m[2], 10) || 1 }
            if (m[1] === 'MemFree')  { memFree  = parseInt(m[2], 10) || 0 }
          }

          // ── 计算指标 ──────────────────────────────────────
          // CPU: 1分钟负载均值 / CPU核心数，转百分比（限0~100）
          var cpuPercent = Math.max(0, Math.min(100,
            Math.round(loadAvg1min / cpuCount * 100)
          ))

          // 内存: MemTotal - MemFree，与 `free` 命令 used 列一致
          var memUsed    = Math.max(0, memTotal - memFree)
          var memPercent = Math.round(memUsed / memTotal * 100)

          push.send([
            wireutil.global
          , wireutil.envelope(new wire.PerformanceEvent(
              options.serial
            , cpuPercent
            , memPercent
            , memTotal
            , memUsed
            ))
          ])
        })
        .catch(function(err) {
          log.warn('Performance collection failed: %s', err.message)
        })
    }

    // 串行调度：上次采集完成后再安排下次，绝不并发
    var timer = null

    function scheduleNext() {
      timer = setTimeout(function() {
        collect().finally(scheduleNext)
      }, COLLECT_INTERVAL)
    }

    var initTimer = setTimeout(function() {
      collect().finally(scheduleNext)
    }, INIT_DELAY)

    lifecycle.observe(function() {
      clearTimeout(initTimer)
      clearTimeout(timer)
    })

    log.info('Performance monitor started (interval=%dms)', COLLECT_INTERVAL)
  })
var syrup = require('@devicefarmer/stf-syrup')
var Promise = require('bluebird')

var lifecycle = require('../../../util/lifecycle')
var logger = require('../../../util/logger')
var wire = require('../../../wire')
var wireutil = require('../../../wire/util')

var COLLECT_INTERVAL = 10000  // 10秒采集一次
var INIT_DELAY       = 5000   // 启动后延迟5秒再开始采集

module.exports = syrup.serial()
  .dependency(require('../support/adb'))
  .dependency(require('../support/push'))
  .define(function(options, adb, push) {
    var log = logger.createLogger('device:plugins:performance')

    var prevCpu = null  // 上次 CPU 累计值（用于计算增量百分比）

    // ── 读取 /proc/stat 中 CPU 累计 ticks ──────────────────
    function readCpuStats() {
      return adb.shell(options.serial, 'cat /proc/stat')
        .timeout(5000)
        .then(adb.util.readAll)
        .then(function(buffer) {
          var text = buffer.toString('utf8')
          // 第一行格式：cpu  user nice system idle iowait irq softirq steal ...
          var parts = text.split('\n')[0].trim().split(/\s+/)
          return {
            user:    parseInt(parts[1], 10) || 0
          , nice:    parseInt(parts[2], 10) || 0
          , system:  parseInt(parts[3], 10) || 0
          , idle:    parseInt(parts[4], 10) || 0
          , iowait:  parseInt(parts[5], 10) || 0
          , irq:     parseInt(parts[6], 10) || 0
          , softirq: parseInt(parts[7], 10) || 0
          }
        })
    }

    // ── 读取 /proc/meminfo ──────────────────────────────────
    function readMemInfo() {
      return adb.shell(options.serial, 'cat /proc/meminfo')
        .timeout(5000)
        .then(adb.util.readAll)
        .then(function(buffer) {
          var text = buffer.toString('utf8')
          var info = {}
          text.split('\n').forEach(function(line) {
            var m = line.match(/^(\w+):\s+(\d+)/)
            if (m) {
              info[m[1]] = parseInt(m[2], 10)
            }
          })
          return info
        })
    }

    // ── 根据两次采集计算 CPU 使用率 ────────────────────────
    function calcCpuPercent(prev, curr) {
      var prevTotal = prev.user + prev.nice + prev.system +
                      prev.idle + prev.iowait + prev.irq + prev.softirq
      var currTotal = curr.user + curr.nice + curr.system +
                      curr.idle + curr.iowait + curr.irq + curr.softirq
      var totalDelta = currTotal - prevTotal
      var idleDelta  = curr.idle - prev.idle
      if (totalDelta <= 0) {
        return 0
      }
      return Math.max(0, Math.min(100,
        Math.round((totalDelta - idleDelta) / totalDelta * 100)
      ))
    }

    // ── 采集并通过 wire 发送 ────────────────────────────────
    // 返回 Promise，供串行调度使用
    function collect() {
      return Promise.all([readCpuStats(), readMemInfo()])
        .spread(function(currCpu, memInfo) {
          var cpuPercent = 0
          if (prevCpu) {
            cpuPercent = calcCpuPercent(prevCpu, currCpu)
          }
          prevCpu = currCpu

          var memTotal     = memInfo.MemTotal || 1
          var memAvailable = memInfo.MemAvailable !== undefined
            ? memInfo.MemAvailable
            : (memInfo.MemFree || 0)
          var memUsed    = Math.max(0, memTotal - memAvailable)
          var memPercent = Math.round(memUsed / memTotal * 100)

          push.send([
            wireutil.global
          , wireutil.envelope(new wire.PerformanceEvent(
              options.serial
            , cpuPercent
            , memPercent
            , memTotal
            , memUsed
            ))
          ])
        })
        .catch(function(err) {
          log.warn('Performance collection failed: %s', err.message)
        })
    }

    // 串行执行：上次采集完成后再安排下一次，避免并发 ADB 连接冲击设备
    var timer = null

    function scheduleNext() {
      timer = setTimeout(function() {
        collect().finally(scheduleNext)
      }, COLLECT_INTERVAL)
    }

    // 延迟后开始第一次采集并启动循环
    var initTimer = setTimeout(function() {
      collect().finally(scheduleNext)
    }, INIT_DELAY)

    lifecycle.observe(function() {
      clearTimeout(initTimer)
      clearTimeout(timer)
    })

    log.info('Performance monitor started (interval=%dms)', COLLECT_INTERVAL)
  })
var syrup = require('@devicefarmer/stf-syrup')
var Promise = require('bluebird')

var lifecycle = require('../../../util/lifecycle')
var logger = require('../../../util/logger')
var wire = require('../../../wire')
var wireutil = require('../../../wire/util')

var COLLECT_INTERVAL = 10000  // 10秒采集一次
var INIT_DELAY       = 5000   // 启动后延迟5秒再开始采集

module.exports = syrup.serial()
  .dependency(require('../support/adb'))
  .dependency(require('../support/push'))
  .define(function(options, adb, push) {
    var log = logger.createLogger('device:plugins:performance')

    var prevCpu = null  // 上次 CPU 累计值（用于计算增量百分比）

    // ── 读取 /proc/stat 中 CPU 累计 ticks ──────────────────
    function readCpuStats() {
      return adb.shell(options.serial, 'cat /proc/stat')
        .then(adb.util.readAll)
        .then(function(buffer) {
          var text = buffer.toString('utf8')
          // 第一行格式：cpu  user nice system idle iowait irq softirq steal ...
          var parts = text.split('\n')[0].trim().split(/\s+/)
          return {
            user:    parseInt(parts[1], 10) || 0
          , nice:    parseInt(parts[2], 10) || 0
          , system:  parseInt(parts[3], 10) || 0
          , idle:    parseInt(parts[4], 10) || 0
          , iowait:  parseInt(parts[5], 10) || 0
          , irq:     parseInt(parts[6], 10) || 0
          , softirq: parseInt(parts[7], 10) || 0
          }
        })
    }

    // ── 读取 /proc/meminfo ──────────────────────────────────
    function readMemInfo() {
      return adb.shell(options.serial, 'cat /proc/meminfo')
        .then(adb.util.readAll)
        .then(function(buffer) {
          var text = buffer.toString('utf8')
          var info = {}
          text.split('\n').forEach(function(line) {
            var m = line.match(/^(\w+):\s+(\d+)/)
            if (m) {
              info[m[1]] = parseInt(m[2], 10)
            }
          })
          return info
        })
    }

    // ── 根据两次采集计算 CPU 使用率 ────────────────────────
    function calcCpuPercent(prev, curr) {
      var prevTotal = prev.user + prev.nice + prev.system +
                      prev.idle + prev.iowait + prev.irq + prev.softirq
      var currTotal = curr.user + curr.nice + curr.system +
                      curr.idle + curr.iowait + curr.irq + curr.softirq
      var totalDelta = currTotal - prevTotal
      var idleDelta  = curr.idle - prev.idle
      if (totalDelta <= 0) {
        return 0
      }
      return Math.max(0, Math.min(100,
        Math.round((totalDelta - idleDelta) / totalDelta * 100)
      ))
    }

    // ── 采集并通过 wire 发送 ────────────────────────────────
    function collect() {
      Promise.all([readCpuStats(), readMemInfo()])
        .spread(function(currCpu, memInfo) {
          var cpuPercent = 0
          if (prevCpu) {
            cpuPercent = calcCpuPercent(prevCpu, currCpu)
          }
          prevCpu = currCpu

          var memTotal     = memInfo.MemTotal || 1
          var memAvailable = memInfo.MemAvailable !== undefined
            ? memInfo.MemAvailable
            : (memInfo.MemFree || 0)
          var memUsed    = Math.max(0, memTotal - memAvailable)
          var memPercent = Math.round(memUsed / memTotal * 100)

          push.send([
            wireutil.global
          , wireutil.envelope(new wire.PerformanceEvent(
              options.serial
            , cpuPercent
            , memPercent
            , memTotal
            , memUsed
            ))
          ])
        })
        .catch(function(err) {
          log.warn('Performance collection failed: %s', err.message)
        })
    }

    // 延迟后开始第一次采集（等设备稳定）
    var initTimer = setTimeout(function() {
      collect()
    }, INIT_DELAY)

    var timer = setInterval(collect, COLLECT_INTERVAL)

    lifecycle.observe(function() {
      clearTimeout(initTimer)
      clearInterval(timer)
    })

    log.info('Performance monitor started (interval=%dms)', COLLECT_INTERVAL)
  })
