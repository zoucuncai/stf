/**
* Copyright © 2024 contains code contributed by Orange SA, authors: Denis Barbaron - Licensed under the Apache license 2.0
**/

var util = require('util')

var syrup = require('@devicefarmer/stf-syrup')

var logger = require('../../../../util/logger')
var wire = require('../../../../wire')
var wireutil = require('../../../../wire/util')

module.exports = syrup.serial()
  .dependency(require('../../support/adb'))
  .dependency(require('../../support/router'))
  .dependency(require('../../support/push'))
  .dependency(require('../../support/storage'))
  .dependency(require('../../resources/minicap'))
  .dependency(require('../util/display'))
  .define(function(options, adb, router, push, storage, minicap, display) {
    var log = logger.createLogger('device:plugins:screen:capture')
    var plugin = Object.create(null)

    function projectionFormat() {
      return util.format(
        '%dx%d@%dx%d/%d'
      , display.properties.width
      , display.properties.height
      , display.properties.width
      , display.properties.height
      , display.properties.rotation
      )
    }

    function captureWithScreencap() {
      return adb.shell(options.serial, 'exec-out screencap -p')
        .then(adb.util.readAll)
        .then(function(buffer) {
          if (!buffer || buffer.length < 64) {
            throw new Error('screencap empty')
          }
          return storage.store('image', buffer, {
            filename: util.format('%s.png', options.serial)
          , contentType: 'image/png'
          , knownLength: buffer.length
          })
        })
    }

    function captureWithMinicap() {
      var file = util.format('/data/local/tmp/minicap_%d.jpg', Date.now())
      return minicap.run('minicap-apk', util.format(
          '-P %s -s >%s', projectionFormat(), file))
        .then(adb.util.readAll)
        .then(function() {
          return adb.stat(options.serial, file)
        })
        .then(function(stats) {
          if (stats.size === 0) {
            throw new Error('Empty screenshot; possibly secure screen?')
          }

          return adb.pull(options.serial, file)
            .then(function(transfer) {
              return storage.store('image', transfer, {
                filename: util.format('%s.jpg', options.serial)
              , contentType: 'image/jpeg'
              , knownLength: stats.size
              })
            })
        })
        .finally(function() {
          return adb.shell(options.serial, ['rm', '-f', file])
            .then(adb.util.readAll)
        })
    }

    plugin.capture = function() {
      log.info('Capturing screenshot')
      return captureWithScreencap()
        .catch(function(err) {
          log.warn('screencap capture failed (%s), using minicap', err.message)
          return captureWithMinicap()
        })
    }

    router.on(wire.ScreenCaptureMessage, function(channel) {
      var reply = wireutil.reply(options.serial)
      plugin.capture()
        .then(function(file) {
          push.send([
            channel
          , reply.okay('success', file)
          ])
        })
        .catch(function(err) {
          log.error('Screen capture failed', err.stack)
          push.send([
            channel
          , reply.fail(err.message)
          ])
        })
    })

    return plugin
  })
