var events = require('events')

var Promise = require('bluebird')
var syrup = require('@devicefarmer/stf-syrup')

var logger = require('../../../util/logger')
var wire = require('../../../wire')
var wireutil = require('../../../wire/util')
var grouputil = require('../../../util/grouputil')
var lifecycle = require('../../../util/lifecycle')

// Must match lib/units/device/resources/service.js (STF agent package).
var STF_AGENT_PKG = 'jp.co.cyberagent.stf'

module.exports = syrup.serial()
  .dependency(require('./solo'))
  .dependency(require('./util/identity'))
  .dependency(require('../support/adb'))
  .dependency(require('./service'))
  .dependency(require('../support/router'))
  .dependency(require('../support/push'))
  .dependency(require('../support/sub'))
  .dependency(require('../support/channels'))
  .define(function(options, solo, ident, adb, service, router, push, sub, channels) {
    var log = logger.createLogger('device:plugins:group')
    var currentGroup = null
    var plugin = new events.EventEmitter()

    plugin.get = Promise.method(function() {
      if (!currentGroup) {
        throw new grouputil.NoGroupError()
      }

      return currentGroup
    })

    plugin.join = function(newGroup, timeout, usage) {
      return plugin.get()
        .then(function() {
          if (currentGroup.group !== newGroup.group) {
            throw new grouputil.AlreadyGroupedError()
          }

          return currentGroup
        })
        .catch(grouputil.NoGroupError, function() {
          currentGroup = newGroup

          log.important('Now owned by "%s"', currentGroup.email)
          log.info('Subscribing to group channel "%s"', currentGroup.group)

          channels.register(currentGroup.group, {
            timeout: timeout || options.groupTimeout
          , alias: solo.channel
          })

          sub.subscribe(currentGroup.group)

          push.send([
            wireutil.global
          , wireutil.envelope(new wire.JoinGroupMessage(
              options.serial
            , currentGroup
            , usage
            ))
          ])

          plugin.emit('join', currentGroup)

          return currentGroup
        })
    }

    plugin.keepalive = function() {
      if (currentGroup) {
        channels.keepalive(currentGroup.group)
      }
    }

    plugin.leave = function(reason) {
      return plugin.get()
        .then(function(group) {
          log.important('No longer owned by "%s" (reason: %s)', group.email, reason)
          log.info('Unsubscribing from group channel "%s"', group.group)

          channels.unregister(group.group)
          sub.unsubscribe(group.group)

          push.send([
            wireutil.global
          , wireutil.envelope(new wire.LeaveGroupMessage(
              options.serial
            , group
            , reason
            ))
          ])

          currentGroup = null
          plugin.emit('leave', group, reason)

          return group
        })
    }

    plugin.on('join', function() {
      service.wake()
      service.acquireWakeLock()
    })

    plugin.on('leave', function() {
      if (options.screenReset) {
        var killApps = options.killAppsOnRelease !== false
        // One HOME is often not enough (nested activities / overlays). Follow with
        // CATEGORY_HOME so the default launcher is brought up reliably on release.
        var killShell =
          'am kill-all >/dev/null 2>&1; ' +
          'pm list packages -3 2>/dev/null | while IFS= read -r line; do ' +
          'pkg=${line#package:}; ' +
          '[ -z "$pkg" ] && continue; ' +
          'case "$pkg" in ' + STF_AGENT_PKG + ') continue ;; esac; ' +
          'am force-stop "$pkg" >/dev/null 2>&1; ' +
          'done'
        Promise.resolve()
          .then(function() {
            service.pressKey('home')
          })
          .delay(320)
          .then(function() {
            service.pressKey('home')
          })
          .delay(320)
          .then(function() {
            return adb.shell(
                options.serial
              , 'am start -a android.intent.action.MAIN -c android.intent.category.HOME'
              )
              .then(adb.util.readAll)
          })
          .then(function() {
            if (!killApps) {
              return
            }
            log.info('Stopping third-party app processes after release')
            return adb.shell(options.serial, killShell)
              .then(adb.util.readAll)
              .timeout(120000)
          })
          .catch(Promise.TimeoutError, function() {
            log.warn('Kill apps on release timed out')
          })
          .catch(function(err) {
            log.warn('Screen reset / kill apps failed: %s', err.message)
          })
          .finally(function() {
            service.thawRotation()
          })
      }
      service.releaseWakeLock()
    })

    router
      .on(wire.GroupMessage, function(channel, message) {
        var reply = wireutil.reply(options.serial)
        grouputil.match(ident, message.requirements)
          .then(function() {
            return plugin.join(message.owner, message.timeout, message.usage)
          })
          .then(function() {
            push.send([
              channel
            , reply.okay()
            ])
          })
          .catch(grouputil.RequirementMismatchError, function(err) {
            push.send([
              channel
            , reply.fail(err.message)
            ])
          })
          .catch(grouputil.AlreadyGroupedError, function(err) {
            push.send([
              channel
            , reply.fail(err.message)
            ])
          })
      })
      .on(wire.AutoGroupMessage, function(channel, message) {
        return plugin.join(message.owner, message.timeout, message.identifier)
          .then(function() {
            plugin.emit('autojoin', message.identifier, true)
          })
          .catch(grouputil.AlreadyGroupedError, function() {
            plugin.emit('autojoin', message.identifier, false)
          })
      })
      .on(wire.UngroupMessage, function(channel, message) {
        var reply = wireutil.reply(options.serial)
        grouputil.match(ident, message.requirements)
          .then(function() {
            var leaveReason =
              (message.reason && String(message.reason)) || 'ungroup_request'
            return plugin.leave(leaveReason)
          })
          .then(function() {
            push.send([
              channel
            , reply.okay()
            ])
          })
          .catch(grouputil.NoGroupError, function(err) {
            push.send([
              channel
            , reply.fail(err.message)
            ])
          })
      })

    channels.on('timeout', function(channel) {
      if (currentGroup && channel === currentGroup.group) {
        plugin.leave('automatic_timeout')
      }
    })

    lifecycle.observe(function() {
      return plugin.leave('device_absent')
        .catch(grouputil.NoGroupError, function() {
          return true
        })
    })

    return plugin
  })
