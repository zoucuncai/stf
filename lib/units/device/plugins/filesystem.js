var Promise = require('bluebird')
var syrup = require('@devicefarmer/stf-syrup')
var path = require('path')
var stream = require('stream')
var request = require('@cypress/request')

var logger = require('../../../util/logger')
var wire = require('../../../wire')
var wireutil = require('../../../wire/util')

module.exports = syrup.serial()
  .dependency(require('../support/adb'))
  .dependency(require('../support/router'))
  .dependency(require('../support/push'))
  .dependency(require('../support/storage'))
  .define(function(options, adb, router, push, storage) {
    var log = logger.createLogger('device:plugins:filesystem')
    var plugin = Object.create(null)

    function resolveTarget(target, filename) {
      var safeTarget = String(target || '').trim()
      var safeFilename = String(filename || '').trim()
      if (!safeTarget) {
        throw new Error('target is required')
      }
      var targetLooksDir = /\/$/.test(safeTarget) || path.posix.basename(safeTarget).indexOf('.') === -1
      if (targetLooksDir) {
        return {
          dir: safeTarget.replace(/\/+$/, '') || '/'
        , file: path.posix.join(safeTarget, safeFilename || 'stf-upload.bin')
        }
      }
      return {
        dir: path.posix.dirname(safeTarget)
      , file: safeTarget
      }
    }

    function pushFromStorage(message, progressCb) {
      var href = String(message.href || '').trim()
      if (!href) {
        return Promise.reject(new Error('href is required'))
      }
      var storageUrl = /^https?:\/\//i.test(href)
        ? href
        : String(options.storageUrl || '').replace(/\/+$/, '') + href
      var resolved = resolveTarget(message.target, message.filename)

      return adb.shell(options.serial, 'mkdir -p "' + resolved.dir + '"')
        .timeout(15000)
        .then(function() {
          return new Promise(function(resolve, reject) {
            var req = request.get(storageUrl)
            req.on('response', function(res) {
              if (res.statusCode < 200 || res.statusCode >= 300) {
                reject(new Error('download failed status=' + res.statusCode))
                return
              }

              var contentLength = Number(res.headers['content-length'] || 0)
              var source = new stream.PassThrough()
              req.pipe(source)

              adb.push(options.serial, source, resolved.file)
                .then(function(transfer) {
                  var settled = false
                  var bytesTransferred = 0
                  function done(err) {
                    if (settled) {
                      return
                    }
                    settled = true
                    if (err) {
                      reject(err)
                    }
                    else {
                      resolve()
                    }
                  }
                  transfer.on('progress', function(stats) {
                    bytesTransferred = stats.bytesTransferred || 0
                    if (progressCb && contentLength > 0) {
                      progressCb({
                        progress: Math.max(0, Math.min(100, Math.floor((bytesTransferred / contentLength) * 100)))
                      , data: 'pushing_file'
                      })
                    }
                    if (contentLength > 0 && bytesTransferred >= contentLength) {
                      done()
                    }
                  })
                  transfer.on('end', function() {
                    done()
                  })
                  transfer.on('close', function() {
                    if (!contentLength || bytesTransferred >= contentLength) {
                      done()
                    }
                  })
                  transfer.on('error', function(err) {
                    done(err)
                  })
                })
                .catch(reject)
            })
            req.on('error', reject)
          })
        })
        .then(function() {
          return adb.stat(options.serial, resolved.file)
        })
        .then(function(st) {
          return {
            path: resolved.file
          , size: Number(st.size || 0)
          }
        })
    }

    plugin.retrieve = function(file) {
      log.info('Retrieving file "%s"', file)

      return adb.stat(options.serial, file)
        .then(function(stats) {
          return adb.pull(options.serial, file)
            .then(function(transfer) {
              // We may have add new storage plugins for various file types
              // in the future, and add proper detection for the mimetype.
              // But for now, let's just use application/octet-stream for
              // everything like it's 2001.
              return storage.store('blob', transfer, {
                filename: path.basename(file)
              , contentType: 'application/octet-stream'
              , knownLength: stats.size
              })
            })
        })
    }

    router.on(wire.FileSystemGetMessage, function(channel, message) {
      var reply = wireutil.reply(options.serial)
      plugin.retrieve(message.file)
        .then(function(file) {
          push.send([
            channel
          , reply.okay('success', file)
          ])
        })
        .catch(function(err) {
          log.warn('Unable to retrieve "%s"', message.file, err.stack)
          push.send([
            channel
          , reply.fail(err.message)
          ])
        })
    })

    router.on(wire.FileSystemListMessage, function(channel, message) {
      var reply = wireutil.reply(options.serial)
      adb.readdir(options.serial, message.dir)
        .then(function(files) {
          push.send([
            channel
          , reply.okay('success', files)
          ])
        })
        .catch(function(err) {
          log.warn('Unable to list directory "%s"', message.dir, err.stack)
          push.send([
            channel
          , reply.fail(err.message)
          ])
        })
    })

    router.on(wire.FileSystemPushMessage, function(channel, message) {
      var reply = wireutil.reply(options.serial)
      pushFromStorage(message, function(step) {
        push.send([
          channel
        , reply.progress(step.data, step.progress)
        ])
      })
        .then(function(result) {
          push.send([
            channel
          , reply.okay('success', result)
          ])
        })
        .catch(function(err) {
          log.warn('Unable to push file "%s" to "%s"', message.href, message.target, err.stack)
          push.send([
            channel
          , reply.fail(err.message)
          ])
        })
    })

    return plugin
  })
